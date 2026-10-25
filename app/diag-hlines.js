/**
 * 诊断：主区里**所有通栏横线**的位置与颜色。
 *
 * ## 为什么必须这么找
 *
 * 2026-10-16 羽毛菌两次指认"输入框上方还有一根粗的分割线"：
 *   第一次我认定是输入框卡片的 `box-shadow`（量出来确实是）→ 去掉了 → **他还在说**。
 *   所以那条线**不止一处**，或者根本不是那一处。
 *   第二次他说"要么做无痕，要么弄成细点，1px那种，**要和两端连接**" ——
 *   "两端连接"= 横贯整宽、连到左右边界 = **通栏**，
 *   而输入框卡片有 `px-5` 内边距，本来就**不可能**通栏。
 *   ⚠⚠ 这句话本身就把"输入框卡片"排除掉了 —— 我盯错了地方。
 *
 * → 唯一靠得住的办法：**逐像素扫描整列**，把每一行"与上一行差异很大且贯穿整宽"的
 *   位置全列出来，连颜色一起打印。自己认，别猜。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe diag-hlines.js
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hline-'));
app.setPath('userData', TMP);

require(path.join(__dirname, 'electron', 'main.js'));

const px = (buf, i) => ({ b: buf[i], g: buf[i + 1], r: buf[i + 2] });

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) { console.log('没有窗口'); app.exit(1); return; }
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 3500));
  const j = (c) => win.webContents.executeJavaScript(c);

  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p-d', name: '诊断' });
    await window.api.config.set({ currentProject: 'p-d' });
  })()`).catch(() => {});
  win.webContents.reload();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await j(`!!window.api && !!document.querySelector('textarea')`).catch(() => false)) break;
  }
  await new Promise((r) => setTimeout(r, 1500));

  // 主区（中间那一栏）的位置
  const rect = await j(`(() => {
    const ta = document.querySelector('textarea');
    const surface = document.querySelector('.chat-surface');
    const host = surface.closest('[data-pane]') || surface.parentElement;
    const r = host.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y),
             width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  console.log('主区：' + JSON.stringify(rect));

  // ⚠ 多试几次：capturePage 会偶发返回旧帧/抛错
  let bmp = null, size = null, dpr = 1;
  for (let i = 0; i < 5; i++) {
    try {
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage(rect);
      bmp = img.toBitmap();
      size = img.getSize();
      dpr = win.webContents.getZoomFactor() || 1;
      break;
    } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!bmp) { console.log('截图失败'); app.exit(1); return; }
  const W = size.width, H = size.height;
  console.log(`位图 ${W}x${H}`);

  // ⚠⚠ 逐行扫描：数这一行与上一行有多少像素不同。
  //   差异占比 > 70% 就算"通栏横线"。
  const lines = [];
  for (let y = 1; y < H; y++) {
    let diff = 0;
    let firstCol = null, lastCol = null;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = px(bmp, (y - 1) * W * 4 + x * 4);
      const b = px(bmp, i);
      const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      if (d > 10) {
        diff++;
        if (firstCol === null) firstCol = x;
        lastCol = x;
      }
    }
    const ratio = diff / W;
    if (ratio > 0.7) {
      const c = px(bmp, (y * W + Math.floor(W / 2)) * 4);
      lines.push({
        y, yCss: Math.round(rect.y + y / (H / rect.height)),
        ratio: +ratio.toFixed(2),
        color: `rgb(${c.r},${c.g},${c.b})`,
        span: `${firstCol}..${lastCol}`,
      });
    }
  }
  console.log(`\n通栏横线（占比>70%）：${lines.length} 条`);
  // 合并相邻行（1~3px 粗的一条线会扫出好几行）
  const groups = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last && l.y - last.y1 <= 2) { last.y1 = l.y; last.rows.push(l); }
    else groups.push({ y0: l.y, y1: l.y, rows: [l] });
  }
  for (const g of groups) {
    const r0 = g.rows[0];
    console.log(`  y=${g.y0}..${g.y1}（CSS y≈${r0.yCss}，粗 ${g.y1 - g.y0 + 1}px）`
      + `  色=${r0.color}  横跨=${r0.span}/${W}  占比=${r0.ratio}`);
  }

  // 顺便把候选元素列出来：谁在这个 y 附近、谁身上有 border
  const near = await j(`(() => {
    const out = [];
    const ys = ${JSON.stringify(groups.map((g) => Math.round(rect.y + g.rows[0].yCss)))};
    for (const y of ys) {
      for (let dy = -3; dy <= 3; dy++) {
        const el = document.elementFromPoint(Math.round(rect.x + rect.width / 2), y + dy);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const key = el.tagName + '|' + (el.className || '').toString().slice(0, 40);
        if (out.some((o) => o.key === key && o.y === y + dy)) continue;
        out.push({
          y: y + dy, key,
          // ⚠⚠⚠ 这里**不能**用反引号模板：整个 evaluate 的参数本身就是
          //   一个反引号模板字符串，内部再开反引号会把外层提前闭合，
          //   报出来的位置却指向**外层开头那一行**（今天栽了两次）。
          //   一律用普通字符串拼接。
          bb: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
          sh: cs.boxShadow.slice(0, 30),
          bg: cs.backgroundColor,
          tag: el.tagName,
          parent: el.parentElement ? el.parentElement.tagName + '|'
            + (el.parentElement.className || '').toString().slice(0, 34) : '',
        });
      }
    }
    return out;
  })()`);
  console.log('\n附近的元素：');
  for (const n of near) {
    console.log(`  y=${n.y} ${n.tag}.${n.key.slice(0, 46)}`
      + `  border-top=${n.bb}  shadow=${n.sh}  bg=${n.bg}\n      父=${n.parent}`);
  }

  // ==============================================================
  // ⚠⚠ 逐套主题 × 你的窗口尺寸，扫「消息区底部」那一带
  // ==============================================================
  /**
   * 2026-10-16 19:23 用户给了全屏截图（安装版 1080x645）：
   * 消息区（灰底）内容结束后，在 y≈518 处有一条横贯消息区宽度的浅灰线，
   * 输入框卡片在它下方（他说"悬浮了、颜色跟随主题、没问题"）。
   *
   * ⚠⚠ 所以要盯的是**消息区底边**，不是输入框边框（我前几轮一直在错的地方）。
   * ⚠ 也不能只量一套主题：他那条线的颜色偏蓝灰，而 `.chat-surface` 的
   *   背景是**写死的 #f5f6f8**（浅色主题下不跟随主题）——
   *   穷举一遍才能确定"是哪两块的色差"或"是哪条 border"。
   */
  win.setSize(1080, 645);
  await new Promise((r) => setTimeout(r, 1200));

  const region = await j(`(() => {
    const s = document.querySelector('.chat-surface');
    const ta = document.querySelector('textarea');
    const card = ta.parentElement;
    const composer = card.parentElement.parentElement;
    const sr = s.getBoundingClientRect();
    return { x: Math.round(sr.x), y: Math.round(sr.bottom) - 30,
             width: Math.round(sr.width), height: 60 };
  })()`);

  const themeIds = await j(`(() => {
    const raw = ${JSON.stringify(fs.readFileSync(path.join(__dirname, 'src', 'themes.js'), 'utf8'))};
    return [...new Set([...raw.matchAll(/^\\s*'?([a-z0-9-]+)'?\\s*:\\s*\\{/gmi)].map((m) => m[1]))];
  })()`).catch(() => []);
  console.log('\n主题：' + JSON.stringify(themeIds));

  for (const th of themeIds) {
    await j(`(() => {
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(th)});
      document.documentElement.setAttribute(
        'data-dark', /night|contrast/.test(${JSON.stringify(th)}) ? '1' : '0');
    })()`);
    await new Promise((r) => setTimeout(r, 350));

    const layers = await j(`(() => {
      const s = document.querySelector('.chat-surface');
      const ta = document.querySelector('textarea');
      const card = ta.parentElement;
      const composer = card.parentElement.parentElement;
      const pane = composer.closest('[data-pane]') || composer.parentElement;
      const bg = (e) => getComputedStyle(e).backgroundColor;
      return {
        surface: bg(s),
        composer: bg(composer),
        pane: bg(pane),
        card: bg(card),
        cardShadow: getComputedStyle(card).boxShadow.slice(0, 40),
      };
    })()`);

    let pix = null;
    for (let k = 0; k < 4 && !pix; k++) {
      try {
        await win.webContents.capturePage();
        await new Promise((r) => setTimeout(r, 350));
        const img = await win.webContents.capturePage(region);
        const b = img.toBitmap();
        const W = img.getSize().width, H = img.getSize().height;
        const rows = [];
        for (let y = 0; y < H; y++) {
          const i = (y * W + Math.floor(W / 2)) * 4;
          rows.push([b[i + 2], b[i + 1], b[i]].join(','));
        }
        pix = rows;
      } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
    }
    // 找出颜色发生变化的行（= 交界线在哪）
    const jumps = [];
    if (pix) {
      for (let y = 1; y < pix.length; y++) {
        if (pix[y] !== pix[y - 1]) {
          jumps.push('行' + y + ': ' + pix[y - 1] + ' → ' + pix[y]);
        }
      }
    }
    console.log('  ' + th.padEnd(11)
      + ' surface=' + layers.surface + ' composer=' + layers.composer
      + ' pane=' + layers.pane + ' card=' + layers.card);
    console.log('      交界：' + (jumps.length ? jumps.join(' | ') : '无'));
  }

  setTimeout(() => app.exit(0), 200);
}).catch((e) => { console.error('崩了：', e && e.message); app.exit(1); });
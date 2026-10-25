/**
 * 截图 + 判据：输入框那一条（2026-10-16 羽毛菌要求）。
 *
 *   「这个地方的分割条弄成白色，隐形的，让输入框单独悬浮在卡片上」
 *
 * ## 为什么必须真渲染
 *
 * 这是**看得见**的要求：那条通栏 `border-top` 在不在、输入框有没有浮起来，
 * 扫源码只能验"我删掉了" —— 验不出删完之后是不是糊成一片。
 *
 * ⚠ 判据取 `getBoundingClientRect` 的值域里**逐行扫像素**：
 *   输入框上沿往上 20px 那一条带子里，横向颜色必须**基本一致**（没有一条横线）。
 *   直接断言"没有 border-top"是废话——换个写法（比如 ::before、外层 div 加线）
 *   就绕过去了。
 *
 * 运行：.\electron-run.cmd shoot-composer.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0; const failures = []; const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

const PID = 'p-composer';
const CONV = 'cv-composer';
const CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'ink', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
};

for (const ch of ALL) {
  h(ch, (p) => {
    if (ch === 'config:get') return CFG;
    if (ch === 'provider:modelCapability') return null;
    if (ch === 'provider:connParams') return { numCtx: 8192, maxOutput: 4096, reserve: 2048, isLocal: true };
    if (ch === 'conv:messages') {
      return [
        { id: 'm1', role: 'user', content: '第一章写完了，帮我看下节奏。' },
        { id: 'm2', role: 'assistant', content: '前半段推进偏慢，第三段开始有力。' },
      ];
    }
    if (/list$|tree$/.test(ch)) return [];
    return null;
  });
}
h('app:version', () => ({ version: '1.0.8' }));
h('project:list', () => [{ id: PID, name: '测试项目' }]);
h('conv:list', () => [{ id: CONV, projectId: PID, title: '第一章', messageCount: 2 }]);
h('provider:listConnections', () => [{ id: 'c1', name: '本地 Ollama', protocol: 'ollama', model: 'qwen3:latest' }]);
h('bg:get', () => ({ enabled: false, url: '' }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2 && /ReferenceError|TypeError/.test(String(message))) errors.push(String(message).split('\n')[0]);
  });

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));
  const j = (c) => win.webContents.executeJavaScript(c);

  // 选上那个对话，让消息流 + 输入框都出来
  await j(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /第一章/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  win.showInactive();
  win.focus();
  await new Promise((r) => setTimeout(r, 900));

  console.log('\n一、输入框那一条横线没了');
  const geo = await j(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return null;
    const box = ta.closest('div[class*="rounded-lg"]') || ta.parentElement;
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check('★ 找到输入框', () => assert(geo && geo.w > 100, `没找到输入框：${JSON.stringify(geo)}`));

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();          // 原始 BGRA，不用解 PNG 滤波器

  /**
   * ⚠⚠ 坐标必须**换算**：`getBoundingClientRect()` 给的是 CSS px，
   *   而 `toBitmap()` 是**设备像素**（这台机缩放 1.69 → 2534x1478）。
   *   直接拿 CSS 坐标去索引位图 = 量到完全不相干的地方。
   *   我第一版就是这么写的，量出来"有一条 20 的跳变"，其实那是别处的文字。
   */
  const vp = await j(`({ w: window.innerWidth, h: window.innerHeight })`);
  const sc = size.width / vp.w;
  const px = (cx, cy) => {
    const x = Math.min(size.width - 1, Math.max(0, Math.round(cx * sc)));
    const y = Math.min(size.height - 1, Math.max(0, Math.round(cy * sc)));
    const i = (y * size.width + x) * 4;
    return [bmp[i], bmp[i + 1], bmp[i + 2]];
  };

  check('★★ 输入框上方 16px 那一条带子里没有横线', () => {
    assert(geo, '没有输入框，验不了');
    const y0 = Math.round(geo.y - 16);
    const x0 = Math.round(geo.x + geo.w * 0.1);
    const x1 = Math.round(geo.x + geo.w * 0.9);
    // ⚠ 逐**像素**扫（不是每 3px）：一条 1px 的线很细，跳着采样会漏掉它
    let minL = 999, maxL = -1;
    for (let x = x0; x <= x1; x += 1) {
      const [r, g, b] = px(x, y0);
      const l = (r + g + b) / 3;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    // 一条 1px 的 --line（#e3e0db，亮度约 224）压在同色底上，
    // 行内亮度会被拉到差 10 以上；真没线时横向基本是一条水平线。
    assert(maxL - minL < 12,
      `输入框上方有一条横向的深浅跳变（最暗 ${Math.round(minL)} / 最亮 ${Math.round(maxL)}）—— 线还在`);
  });

  // 诊断用：把输入框上方 60px 逐行的亮度打出来 —— 到底是哪一行有线
  if (geo) {
    const rows = [];
    for (let y = geo.y - 40; y <= geo.y + 4; y += 1) {
      let mn = 999, mx = -1;
      for (let x = Math.round(geo.x + geo.w * 0.15); x <= Math.round(geo.x + geo.w * 0.85); x += 1) {
        const [r, g, b] = px(x, y);
        const l = (r + g + b) / 3;
        if (l < mn) mn = l;
        if (l > mx) mx = l;
      }
      rows.push(`y=${y}${y < geo.y ? '' : '  <-- 框内'} min=${Math.round(mn)} max=${Math.round(mx)} 横向差=${Math.round(mx - mn)}`);
    }
    console.log('  [诊断] 输入框上方逐行横向亮度差：');
    console.log(rows.map((r) => '    ' + r).join('\n'));
  }

  check('★ 全程没有渲染报错', () => assert(errors.length === 0, errors.slice(0, 3).join(' | ')));

  await Promise.all(pending);

  // ⚠ 整窗存下来就够了（同时存一份裁好的）。capturePage 带 clip 时会抛
  //   UnknownVizError，必须 try/catch —— 否则脚本在这儿无声死掉。
  try { fs.writeFileSync(path.join(OUT, 'composer.png'), img.toPNG()); } catch (_) { /* 存不下就算了 */ }
  try {
    const full = await win.webContents.capturePage({ x: 0, y: size.height - 260, width: size.width, height: 260 });
    fs.writeFileSync(path.join(OUT, 'composer-crop.png'), full.toPNG());
  } catch (_) { /* 裁剪版拿不到不影响判据 */ }
  console.log(`  输入框 top=${geo && geo.y} / 窗口 ${size.width}x${size.height}`);
  console.log(`  截图：shots/composer.png`);

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `输入框：${passed} 通过 / ${failures.length} 失败` : `输入框：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => { console.error('脚本崩了：', e && e.message); setTimeout(() => app.exit(1), 300); });

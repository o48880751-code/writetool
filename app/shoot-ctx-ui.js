/**
 * 截图：设置页「长度」组 + 聊天区（输入框上方那条横条消失之后）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE \
 *   ./node_modules/electron/dist/electron.exe shoot-ctx-ui.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PID = 'p1';
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failed = [];
/** ⚠ 这个脚本原来没有 assert，于是前两条判据里的 assert(...) 直接 ReferenceError */
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
/**
 * 断言。
 *
 * ⚠⚠⚠ 这里原来写的是 `check(name, ok, extra)` —— **只接布尔值**，
 *   而我在下面大量传的是函数（`() => { assert(...) }`）。
 *   函数是 truthy → **每一条都直接算通过**。
 *   现场：两条"输入区是 1px 细线 / 与两端连接"的判据，
 *   在 `composerLine = null`（压根没扫到线）的情况下依然打 ✓ ——
 *   **判据自己骗了自己，而我差点据此宣布"做到了"**。
 *   和产品代码那次「判据红 ≠ 功能坏」正好相反：**判据绿 ≠ 判据对**。
 *
 * → 现在既接布尔值也接函数；接函数就执行它，抛异常即失败。
 *
 * ⚠⚠ 执行结果 **undefined 算通过**：`() => { assert(x); }` 这种写法**没有 return**，
 *   返回 undefined。如果把 undefined 当失败，那么**每一条"用抛异常表达失败"的判据都会红**
 *   ——而它其实什么都没说。约定：断言型判据一律"抛异常 = 失败、正常返回 = 通过"。
 */
function check(name, ok, extra) {
  if (typeof ok === 'function') {
    try { const r = ok(); ok = (r === undefined) ? true : !!r; }
    catch (e) { ok = false; extra = String((e && e.message) || e); }
  }
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else {
    failed.push(name);
    console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  }
}

const CFG = {
  model: 'qwen3:latest', chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'gold', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
  connParams: { c1: { numCtx: 32768, maxOutput: 8192, reserve: 4096 } },
  scopeStrikes: 0, scopeLocked: false,
};
const CP = { numCtx: 32768, maxOutput: 8192, reserve: 4096 };
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; } catch (e) { return { ok: false, error: e.message }; }
  });
};
for (const ch of ALL) {
  h(ch, (p) => {
    if (ch === 'config:get') return CFG;
    if (ch === 'config:set') { Object.assign(CFG, p || {}); return null; }
    if (ch === 'provider:modelCapability') return { contextLength: 40960, parameterSize: '8.2B' };
    if (ch === 'provider:connParams') return { ...CP, isLocal: false };
    if (/list$|messages$|tree$/.test(ch)) return [];
    if (ch === 'scope:status') return { locked: false, strikes: 0 };
    if (ch === 'scope:agreement') return { version: '1.0.10', text: '协议正文' };
    return null;
  });
}
ipcMain.removeHandler('provider:setConnParams');
ipcMain.handle('provider:setConnParams', async (_e, payload) => {
  const p = payload || {};
  for (const k of ['numCtx', 'maxOutput', 'reserve']) {
    if (p[k] !== undefined && p[k] !== null) CP[k] = Math.round(Number(p[k]));
  }
  return { ok: true, data: { ok: true, params: { ...CP, isLocal: false } } };
});
h('app:version', () => ({ version: '1.0.10' }));
h('project:list', () => [{ id: PID, name: '武侠小说' }]);
h('conv:list', () => [{ id: 'c1', projectId: PID, title: '第一章', messageCount: 2 }]);
h('conv:messages', () => [
  { id: 'm1', role: 'user', content: '继续写第二章，主角下山' },
  { id: 'm2', role: 'assistant', content: '第二章　下山\n\n天还没亮，山门外的雾就散了。' },
]);
h('provider:listConnections', () => [
  { id: 'c1', name: '硅基流动', protocol: 'openai', model: 'Qwen/Qwen3-8B' },
]);
h('style:profile', () => ({ available: false }));
h('trash:list', () => ({ stats: { count: 0 } }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // ⚠⚠ 用**用户那张截图的窗口尺寸**（1080x645），不是 1500x900。
    //   栏宽是按比例分配的，窗口不同 → 每一栏的宽度不同 → 「对齐」问题的
    //   复现条件也不同（1500 下量到的"没有溢出"，在他 1080 下就溢出了）。
    width: 1080, height: 645, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));
  win.showInactive();
  const j = (c) => win.webContents.executeJavaScript(c);

  // 打开设置 → 参数
  await j(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await j(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.trim().endsWith('参数'));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  const shot = async (name, sel) => {
    for (let i = 0; i < 3; i++) {
      try {
        await win.webContents.capturePage();
        await new Promise((r) => setTimeout(r, 250));
        const box = await j(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
                   width: Math.round(r.width), height: Math.round(r.height) };
        })()`);
        if (!box || box.width < 60) { await new Promise((r) => setTimeout(r, 400)); continue; }
        fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage(box)).toPNG());
        console.log('  → shots/' + name);
        return true;
      } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
    }
    return false;
  };

  /**
   * ⚠⚠ **先把设置页截完并关掉，后面所有测量都在聊天区可见时做**。
   *   设置页是 z-40 的整页覆盖：量像素时它盖在聊天区上面，
   *   扫出来的"通栏线"全是设置页里的，而 textarea 顶边是关掉之后量的 ——
   *   两者差 80 多个位图像素，判据于是报"没扫到线"。
   *   ⚠ 与"变异跑完还全绿"同类：**量东西的时机不对，量到的就不是那个东西。**
   */
  {
    const okLen = await shot('ctx-length-group.png', '[data-testid="settings-body"]');
    check('截到「长度」组', okLen);
    await j(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /返回|关闭|←/.test(x.textContent));
      if (b) b.click();
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * 「1px 通栏细线」的判据（2026-10-16 羽毛菌第二次指认：
   * 「还是有一根粗的分割线，你要么做无痕，要么弄成细点，1px 那种，要和两端连接」）。
   *
   * ⚠⚠⚠ 必须量**像素**，量 CSS 是不行的：
   *   我前一版量到 boxShadow 为空就宣布"做到了"，他还在说 ——
   *   因为那条线**根本不是阴影**，是卡片自己的 border。
   *   而 getComputedStyle().borderTopWidth 会告诉你"1px"，
   *   可屏幕上那条看着就是比 1px 粗 —— 只有"这一行有多少像素与上一行不同"才说得出真相。
   */
  const trace = await j(`(() => { try {
    const ta = document.querySelector('textarea');
    // ⚠⚠ 不能用 closest('.rounded-lg')：输入区卡片为了"通栏"已经把圆角去掉了，
    //   而这一栏 CSS 量到的是 **none** —— 元素选错，后面全部读空。
    //   （判据自己报错时，先怀疑"我找的元素没了"，别急着判产品坏。）
    const card = ta.parentElement;
    const cs = getComputedStyle(card);
    const cr = card.getBoundingClientRect();
    // ⚠ 卡片**上方 14px** 内逐行命中测试：不能有任何 cursor:resize 的东西
    const offenders = [];
    for (let dy = -2; dy >= -14; dy -= 2) {
      const el = document.elementFromPoint(Math.round(cr.x + cr.width / 2), Math.round(cr.y) + dy);
      if (el && /resize/.test(getComputedStyle(el).cursor)) {
        offenders.push({ dy, cursor: getComputedStyle(el).cursor });
      }
    }
    // ⚠⚠ **不要**再扫"聊天区内侧 8px"那种坐标基准的判据了（第一版写过，已删）。
    //   它恒绿：那一带被输入框容器（relative + z-20）压着，
    //   elementFromPoint 根本命中不到分隔条 —— 改没改都绿，等于没有防护。
    //   要验就**直接量命中区元素本身的宽度**，它不依赖任何基准点。
    //
    // ⚠⚠⚠ 上面这段注释曾经害得整个脚本报 "missing ) after argument list"：
    //   我在注释里用反引号括了 "relative z-20" —— **反引号会把外层的模板字符串提前闭合**，
    //   剩下的内容全被当成 JS 解析。同一类错误第三次了：
    //   写在这类 executeJavaScript 模板里的注释，绝不出现 反引号 / 注释起止符。
    //   （而且我"修"它的时候第一版又把反引号写回去了 —— 改完必须 node --check 一次。）
    const hitWidths = [...new Set([...document.querySelectorAll('*')]
      .filter((e) => /col-resize|row-resize/.test(getComputedStyle(e).cursor))
      .map((e) => Math.round(e.getBoundingClientRect().width)))].sort((a, b) => a - b);
    return {
      shadow: cs.boxShadow,
      above: offenders,
      hitWidths,
    };
  } catch (e) { return { err: String((e && e.message) || e) }; } })()`);
  /**
   * 「1px 通栏细线」的两条判据（2026-10-16 羽毛菌第二次指认：
   * 「还是有一根粗的分割线，你要么做无痕，要么弄成细点，1px 那种，要和两端连接」）。
   *
   * ⚠⚠⚠ 这次**必须量像素**，量 CSS 是不行的：
   *   我前一版量到 `boxShadow === 'none'` 就宣布"做到了"，他还在说 ——
   *   因为那条线**根本不是阴影**，是卡片自己的 border。
   *   而 `getComputedStyle().borderTopWidth` 会告诉你"1px"，
   *   可屏幕上那条看着就是比 1px 粗 —— 因为上下相邻像素一起变色。
   *   只有"这一行有多少像素与上一行不同"才说得出真相。
   */
  const shotRect = await j(`(() => {
    const surface = document.querySelector('.chat-surface');
    const host = surface.closest('[data-pane]') || surface.parentElement;
    const r = host.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y),
             width: Math.round(r.width), height: Math.round(r.height) };
  })()`);

  /**
 * ⚠⚠ 采样区只取**卡片上方**那一段（消息区底部 20px + 中间 8px 间隙）。
 *
 * 19:49 羽毛菌：「无痕那里倒是没问题了，但输入框能不能像它这样有个范围」
 * ⚠⚠ **「无痕」与「有范围」是两件独立的事**：
 *   · 无痕 = 消息区 ↔ 输入区之间不能有线（判据量这一段）
 *   · 有范围 = 输入框自己要有白底/圆角/边框（判据量卡片本身）
 *   ⚠ 我前几轮一直混着做，结果两头都没做对。
 *   ⚠⚠ 所以**不能再把卡片上边缘算进"应该无缝"的区间** ——
 *   那是卡片自己的边界，白底与灰底的分界是**应该看得见的**。
 */
  const edgeRect = await j(`(() => {
    const s = document.querySelector('.chat-surface');
    const ta = document.querySelector('textarea');
    const card = ta.parentElement;
    const sr = s.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      x: Math.round(sr.x), width: Math.round(sr.width),
      y: Math.round(sr.bottom) - 20, height: 20 + Math.max(0, cr.top - sr.bottom),
    };
  })()`);
  /**
 * ⚠⚠⚠ 先造几条消息再量。
 *   我前几轮一直在**空对话**里量，而用户截图里是有内容的（一条用户消息 + 一条模型消息）。
 *   「有没有内容」会改变消息区底部的渲染（滚动、渐隐、最后一条的间距），这是最大的变量。
 */
await j(`(async () => {
  const l = await window.api.project.list();
  const pid = (l && l[0] && l[0].id) || 'p1';
  const cs = await window.api.conv.list({ projectId: pid });
  let cid = cs && cs[0] && cs[0].id;
  if (!cid) {
    const c = await window.api.conv.create({ projectId: pid, title: '诊断' });
    cid = c.id;
  }
  await window.api.conv.send({ conversationId: cid, projectId: pid, text: '111' });
})()`).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

const layers = await j(`(() => {
    const s = document.querySelector('.chat-surface');
    const ta = document.querySelector('textarea');
    const card = ta.parentElement;
    const composer = card.parentElement.parentElement;
    const bg = (e) => getComputedStyle(e).backgroundColor;
    const sr = s.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      surface: bg(s), composer: bg(composer), card: bg(card),
      shadow: getComputedStyle(card).boxShadow.slice(0, 46),
      radius: getComputedStyle(card).borderTopLeftRadius,
      border: getComputedStyle(card).borderTopWidth + ' ' + getComputedStyle(card).borderTopStyle,
      surfaceBottom: Math.round(sr.bottom), cardTop: Math.round(cr.top),
      gap: Math.round(cr.top - sr.bottom),
    };
  })()`);
  console.log('  层次：' + JSON.stringify(layers));

  let edgeRows = null;
  for (let k = 0; k < 4 && !edgeRows; k++) {
    try {
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage(edgeRect);
      const b = img.toBitmap();
      const W = img.getSize().width, H = img.getSize().height;
      edgeRows = [];
      for (let y = 0; y < H; y++) {
        const i = (y * W + Math.floor(W / 2)) * 4;
        edgeRows.push(b[i + 2] + ',' + b[i + 1] + ',' + b[i]);
      }
    } catch (_) { await new Promise((r) => setTimeout(r, 500)); }
  }
  const jumpList = [];
  const visibleJumps = [];
  if (edgeRows) {
    for (let y = 1; y < edgeRows.length; y++) {
      if (edgeRows[y] === edgeRows[y - 1]) continue;
      const a = edgeRows[y - 1].split(',').map(Number);
      const b = edgeRows[y].split(',').map(Number);
      // ⚠⚠ 判据原来要求"零突变"，那太死了：阴影最上边缘会有
      //   色差 1,1,1 的抗锯齿过渡（实测 245,246,248 → 244,245,247），
      //   肉眼根本看不见，却会让判据永远红 —— 于是"改好了"和"没改"看起来一样。
      // ⚠ 正确的口径是**色差够不够看得见**，不是"有没有变化"。
      //   阈值取 8（三通道差值和）：真那条线是 #f5f6f8 ↔ #e3e0db，差值 16 以上。
      const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      const rec = '#' + y + ' ' + edgeRows[y - 1] + '→' + edgeRows[y] + '（差' + delta + '）';
      jumpList.push(rec);
      if (delta >= 8) visibleJumps.push(rec);
    }
    console.log('  缝隙颜色变化：' + (jumpList.length ? jumpList.join(' | ') : '无')
      + '  其中看得见的：' + (visibleJumps.length ? visibleJumps.join(' | ') : '无'));
  }
  check('★★★ 消息区与输入区之间无缝（没有**看得见**的颜色突变）', () => {
    if (!edgeRows) throw new Error('没拿到像素');
    assert(visibleJumps.length === 0,
      '缝隙里有 ' + visibleJumps.length + ' 处可见突变：' + visibleJumps.join(' | ')
      + '（surface=' + layers.surface + ' composer=' + layers.composer
      + ' 间距=' + layers.gap + 'px）');
  });
  // ⚠ 与上一条**成对**：无缝 ≠ 卡片没有边界。卡片必须有白底/圆角/边框，
  //   否则就退化成"输入框糊进背景里"，那是上一版的问题。
  check('★★★ 输入框有范围（白底 + 圆角 + 边框）', () => {
    assert(layers.card !== 'rgba(0, 0, 0, 0)',
      '输入框是透明的 —— 糊进背景里了，没有「范围」');
    assert(layers.radius !== '0px', `圆角是 ${layers.radius}`);
    assert(!!layers.border && layers.border !== '0px none rgb(31, 35, 40)',
      '没有边框：' + layers.border);
  });

  /**
   * ⚠⚠ 对话列表栏右缘的错位（2026-10-16 19:49 羽毛菌：「能对齐吗，看着难受」，
   *   截图里红圈圈的是「111」那条右端一块白色，越过了分隔线）。
   *
   * ⚠ 这里的量法：**逐个容器量左右边界**，看有没有谁的右边界越过了它所在的栏。
   *   根因候选：flex 子项默认 `min-width: auto`，
   *   `flex-1` 不会自动变成 0 —— 内部 `w-full` 的元素能把整栏撑开。
   *   （`.conversation-list` 那层的滚动容器写的是 `flex-1 overflow-y-auto`，
   *   又是同一条 CSS 规则：横向被算成 auto。）
   */
  const rail = await j(`(() => {
    const out = [];
    const pane = document.querySelector('[data-pane]');
    const paneList = pane ? pane.getBoundingClientRect() : null;
    const list = document.querySelector('.conversation-list')
      || (paneList ? document.querySelectorAll('[data-pane]')[0] : null);
    // 找对话列表栏：从有 "对话列表" 标题的那一栏开始
    const host = document.querySelectorAll('[data-pane]')[0];
    const hr = host ? host.getBoundingClientRect() : null;
    const out2 = {
      paneRight: paneList ? Math.round(paneList.right) : null,
      paneLeft: paneList ? Math.round(paneList.left) : null,
    };
    const rows = [];
    let worst = null;
    for (const el of host.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = Math.round(r.right - hr.right);
      if (over > 1) {
        rows.push({ tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 46),
          over, w: Math.round(r.width),
          text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 20) });
        if (!worst || over > worst.over) worst = rows[rows.length - 1];
      }
      if (rows.length >= 6) break;
    }
    out2.overflowers = rows;
    out2.worst = worst;
    out2.scrollW = host.scrollWidth;
    out2.clientW = host.clientWidth;
    out2.overflowingX = host.scrollWidth > host.clientWidth + 1;
    out2.overflowX = getComputedStyle(host).overflowX;
    return out2;
  })()`);
  console.log('  对话列表栏：' + JSON.stringify(rail));
    /**
   * ⚠⚠ 标题行下边那条线要**齐平**（2026-10-16 20:04 羽毛菌：
   *   「他们上边那一条是连着的同一个水平，而下面那一条有高低差」）。
   *
   * ⚠⚠⚠ **量法试错了两次，这次是对的**：
   *   ① 按 `[data-pane]` 的 children 猜"哪个是标题行" → 筛选稍严一个都找不到；
   *   ② 像素扫各栏标题带找通栏线 → 扫描区 70px，量到的 y 已在区外，
   *      **变异后仍然全绿**（假绿）。教训：像素扫描的**取景框**必须先自证
   *      （框内确实含有要找的那条线），否则扫到的是别的东西。
   * ⚠ 现在靠 `data-testid` 精确定位，直接比三个栏标题行的**窗口坐标 bottom**。
   */
  const railBottoms = await j(`(() => {
    const ids = ['rail-head-conv', 'rail-head-main', 'rail-head-tree'];
    return ids.map((id) => {
      const el = document.querySelector('[data-testid="' + id + '"]');
      if (!el) return { id: id, missing: true };
      const r = el.getBoundingClientRect();
      return { id: id, top: Math.round(r.top), bottom: Math.round(r.bottom),
               h: Math.round(r.height) };
    });
  })()`);
  console.log('  标题行：' + JSON.stringify(railBottoms));
  check('★★★ 各栏标题行下边缘在同一水平（下面那条分隔线齐平）', () => {
    const got = railBottoms.filter((r) => !r.missing);
    assert(got.length === 3,
      '只找到 ' + got.length + ' 个标题行：' + JSON.stringify(railBottoms));
    const bs = got.map((r) => r.bottom);
    const diff = Math.max(...bs) - Math.min(...bs);
    assert(diff === 0,
      '标题分隔线不齐：' + JSON.stringify(got)
      + '，最大差 ' + diff + 'px');
  });

  check('★★ 对话列表内容没有越过它那一栏的右缘', () => {
    assert(rail.paneRight !== null, '找不到 [data-pane]');
    assert(!rail.overflowingX,
      `容器横向溢出（scrollWidth=${rail.scrollW} > clientWidth=${rail.clientW}，overflow-x=${rail.overflowX}）`
      + ' —— 这会让内容越过分栏线');
    assert((rail.overflowers || []).length === 0,
      '有 ' + rail.overflowers.length + ' 个元素越界：'
      + JSON.stringify(rail.overflowers).slice(0, 200));
  });

  /**
   * ⚠⚠ 直接把「对话列表栏顶部」截出来（2026-10-16 19:49 用户圈的就是这块：
   *   「111」那项右端有一块白色、越过了分隔线）。
   *
   * ⚠ 这块**不是"某个元素越界"** 那么简单 —— 判据在 1500 宽下量到"没有溢出"，
   *   用户 1080 宽下却看得见错位。所以**必须用他的窗口尺寸截图**才能对上。
   * ⚠ 顺带把那一带**所有元素**（含不可见的）连位置一起打出来，
   *   这样"那块白色"是什么，看一眼就能定。
   */
  {
    const r = await j(`(() => {
      const host = document.querySelectorAll('[data-pane]')[0];
      const b = host.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y),
               width: Math.round(b.width), height: Math.min(170, Math.round(b.height)) };
    })()`);
    for (let k = 0; k < 4; k++) {
      try {
        await win.webContents.capturePage();
        await new Promise((z) => setTimeout(z, 350));
        fs.writeFileSync(path.join(OUT, 'conv-rail-top.png'),
          (await win.webContents.capturePage(r)).toPNG());
        console.log('  → shots/conv-rail-top.png（对话列表栏顶部 170px）');
        break;
      } catch (_) { await new Promise((z) => setTimeout(z, 450)); }
    }
    const who2 = await j(`(() => {
      const host = document.querySelectorAll('[data-pane]')[0];
      const b = host.getBoundingClientRect();
      const out = [];
      for (const el of host.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.y > b.y + 170) break;
        const cs = getComputedStyle(el);
        out.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 40),
          l: Math.round(r.x), r: Math.round(r.right),
          w: Math.round(r.width), y: Math.round(r.y - b.y),
          bg: cs.backgroundColor, op: cs.opacity,
          txt: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 14),
        });
      }
      return { paneRight: Math.round(b.right), items: out.slice(0, 26) };
    })()`);
    console.log('  栏右缘 x=' + who2.paneRight + '，该带内的元素：');
    for (const it of who2.items) {
      const flag = it.r > who2.paneRight + 1 ? '  ⚠越界' + (it.r - who2.paneRight) : '';
      console.log('    y=' + String(it.y).padStart(3) + ' x=' + it.l + '..' + it.r
        + ' w=' + it.w + ' bg=' + it.bg + ' op=' + it.op
        + ' ' + it.tag + '.' + it.cls + ' 「' + it.txt + '」' + flag);
    }
  }

  // ⚠ 直接把那一块截出来看 —— 数字会告诉你"变了"，但只有图能告诉你是**什么**变了
  {
    const r = await j(`(() => {
      const s = document.querySelector('.chat-surface');
      const sr = s.getBoundingClientRect();
      return { x: Math.round(sr.x), y: Math.round(sr.bottom) - 30,
               width: Math.round(sr.width), height: 70 };
    })()`);
    for (let k = 0; k < 4; k++) {
      try {
        await win.webContents.capturePage();
        await new Promise((z) => setTimeout(z, 350));
        fs.writeFileSync(path.join(OUT, 'surface-bottom.png'),
          (await win.webContents.capturePage(r)).toPNG());
        console.log('  → shots/surface-bottom.png（消息区底部 70px）');
        break;
      } catch (_) { await new Promise((z) => setTimeout(z, 450)); }
    }
  }
  // 那几条线上分别命中什么元素
  const who = await j(`(() => {
    const s = document.querySelector('.chat-surface');
    const sr = s.getBoundingClientRect();
    const out = [];
    for (const dy of [-10, -6, -2, 2, 6]) {
      const el = document.elementFromPoint(
        Math.round(sr.x + sr.width / 2), Math.round(sr.bottom) + dy);
      if (!el) { out.push({ dy: dy, tag: 'null' }); continue; }
      const cs = getComputedStyle(el);
      out.push({
        dy: dy, tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 46),
        bg: cs.backgroundColor,
        sh: cs.boxShadow.slice(0, 34),
        bt: cs.borderTopWidth + ' ' + cs.borderTopColor,
      });
    }
    return out;
  })()`);
  console.log('  底边附近命中的元素：');
  for (const w of who) console.log('    dy=' + w.dy + ' ' + w.tag + '.' + w.cls
    + ' bg=' + w.bg + ' sh=' + (w.sh || '-') + ' bt=' + (w.bt || '-'));

  let bmp = null, bw = 0, bh = 0, scale = 1;
  for (let i = 0; i < 5; i++) {
    try {
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage(shotRect);
      bmp = img.toBitmap();
      bw = img.getSize().width;
      bh = img.getSize().height;
      scale = bh / shotRect.height;
      break;
    } catch (_) { await new Promise((r) => setTimeout(r, 500)); }
  }
  const groups = [];
  if (bmp) {
    const rows = [];
    for (let y = 1; y < bh; y++) {
      let diff = 0, first = null, last = null;
      for (let x = 0; x < bw; x++) {
        const a = ((y - 1) * bw + x) * 4;
        const b = (y * bw + x) * 4;
        const d = Math.abs(bmp[a + 2] - bmp[b + 2])
          + Math.abs(bmp[a + 1] - bmp[b + 1])
          + Math.abs(bmp[a] - bmp[b]);
        if (d > 10) { diff++; if (first === null) first = x; last = x; }
      }
      if (diff / bw > 0.7) rows.push({ y, ratio: diff / bw, span: first + '..' + last });
    }
    for (const r of rows) {
      const lastG = groups[groups.length - 1];
      if (lastG && r.y - lastG.y1 <= 2) { lastG.y1 = r.y; lastG.hit++; }
      else groups.push({ y0: r.y, y1: r.y, hit: 1, ratio: r.ratio, span: r.span });
    }
  }
  console.log('  通栏线：' + JSON.stringify(groups));
  console.log('  ' + JSON.stringify(trace));

  /**
   * ⚠⚠⚠ 下面三条判据（"卡片没有投影 / 顶部是 1px 细线 / 与两端连接"）已删除。
   *
   * 它们是 19:41–19:49 之间我**理解错了需求**时写的：
   *   · 「没有投影」—— 恰恰相反，19:49 用户要「输入框像参照图那样**有个范围**」，
   *     范围感就来自白底 + 圆角 + 边框 + 一点点向下的影。
   *   · 「与两端连接（通栏）」—— 也反了：卡片**必须两端留白**，
   *     通栏之后它的上边缘就读作"一条横贯的线"，而不是"一张卡片"。
   * ⚠⚠ 留着的两条**互补**判据（别再删）：
   *   ① 缝隙无可见色突变（= 无痕）
   *   ② 卡片有白底/圆角/边框（= 有范围）
   * 一条管"线没了"，一条管"框还在"，缺一条就退回上一版的问题。
   */
  check('★★★ 输入框上方没有任何可拖区域', trace.above.length === 0,
    JSON.stringify(trace.above));
  check('★★ 分隔条命中区宽度 ≤ 6px（"为什么还能左右拖动"）',
    (trace.hitWidths || []).every((w) => w <= 6),
    `实测命中区宽度：${JSON.stringify(trace.hitWidths)}`);

  const above = await j(`(() => {
    const ta = document.querySelector('textarea');
    const card = ta.parentElement;
    return [...card.parentElement.children].filter((el) => el !== card).length;
  })()`);
  check('输入框上方是空的（没有常驻横条）', above === 0, `上面还有 ${above} 个元素`);
  const okChat = await shot('composer-clean.png', '.chat-surface');
  check('截到聊天区', okChat);

  console.log(`\n截图：${passed} 通过${failed.length ? ' / ' + failed.length + ' 失败' : ''}`);
  if (failed.length) for (const f of failed) console.log('  失败：' + f);
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error('崩了：', e); app.exit(1); });
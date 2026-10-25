/**
 * 聊天区在深色主题下必须**跟着主题变深**。
 *
 * 2026-10-16 羽毛菌：「使用夜黛主题时，别的卡片都是黑色，为什么聊天框卡片是白色的」。
 *
 * 根因：`.chat-surface` 整块是**写死的浅色**（还有两个 chip 的色写死在 JSX 里）。
 * 那次改动的理由写在注释里 —— 10-15 他要的是「浅色界面里聊天区别杵着两块深色气泡」。
 * 两条不矛盾：**浅色主题维持 workbuddy 那套，深色主题跟着主题走**。
 *
 * ⚠ 判据必须**按主题清单逐套跑**，不能只测夜黛：
 *   写死一个主题 id 的选择器，加新主题时就会漏（`themes.js` 加一条、CSS 忘了跟上）。
 *   这里直接读 `src/themes.js` 的 THEMES，新增主题自动进判据。
 *
 * 运行：.\electron-run.cmd test-theme-chat.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PID = 'p-th';

let passed = 0; const failures = []; const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

/** 去掉注释再扫源码 —— 注释里就写着那些色值当反面教材，不剥会永远命中 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---- 主题清单：从源码里读，别手抄 ----
const themesSrc = fs.readFileSync(path.join(APPDIR, 'src', 'themes.js'), 'utf8');
const THEMES = [...themesSrc.matchAll(
  /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'[^}]*?dark:\s*(true|false)/g,
)].map((m) => ({ id: m[1], name: m[2], dark: m[3] === 'true' }));
console.log(`主题清单（读自 themes.js）：${THEMES.length} 套，其中深色 ${THEMES.filter(t => t.dark).length} 套`);

console.log('\n一、源码静态：颜色不能写死在 JSX 里');
check('★★ ChatPanel 里没有写死的 chip 色（剥掉注释再扫）', () => {
  const src = stripComments(fs.readFileSync(path.join(APPDIR, 'src', 'components', 'ChatPanel.jsx'), 'utf8'));
  const bad = ['#f3e8ff', '#dcfce7', '#6b21a8', '#166534', '#faf5ff', '#f0fdf4', '#a78bca', '#7ba88a']
    .filter((h) => src.includes(h));
  assert(!bad.length, `还写死着：${bad.join(' ')} —— 深色主题下它们会是贴在深色卡片上的荧光块`);
});
check('★★ index.css 有 [data-dark] 分支，且动了聊天区那几个变量', () => {
  const css = stripComments(fs.readFileSync(path.join(APPDIR, 'src', 'index.css'), 'utf8'));
  const at = css.indexOf("[data-dark='1'] .chat-surface");
  assert(at > 0, "没有 [data-dark='1'] .chat-surface 这段 —— 深色主题下聊天卡片会保持浅色");
  const seg = css.slice(at, at + 500);
  for (const v of ['--chat-user-bg', '--chat-ai-bg', '--chat-ink']) {
    assert(seg.includes(v), `${v} 没跟着主题走：${seg.slice(0, 120)}`);
  }
  /**
   * ⚠ 这句原来找的是**注释里的字**（`:root[data-dark='1'] {\n  /* 深色下…`）——
   *   而上面刚把注释剥掉了，当然找不到 → 判据红得莫名其妙。
   *   （同类错今天第三次：**剥了注释就别再拿注释当锚点**。）
   *   改成找 `[data-dark='1']` 的每个块，看有没有哪个块里设了 chip 变量。
   */
  // ⚠ 只匹配 `:root[data-dark='1'] { … }` 这种**自身**带变量的块；
  //   后代选择器（`[data-dark='1'] .chat-surface { }`）由上面那条覆盖，
  //   别把 `>= 2` 写成期望值 —— 那样只会红得莫名其妙。
  const blocks = [...css.matchAll(/:root\[data-dark='1'\]\s*\{([\s\S]{0,600}?)\}/g)].map((m) => m[1]);
  assert(blocks.length >= 1, "没有 `:root[data-dark='1'] { … }` 这样的变量块");
  assert(blocks.some((b) => b.includes('--chip-skill-bg')),
    '没有哪个深色分支设了 --chip-skill-bg —— 深色下 chip 还是浅色荧光块');
});
check('★ applyTheme 会写 data-dark（CSS 才拿得到"这是深色主题"）', () => {
  const src = stripComments(themesSrc);
  assert(/setAttribute\('data-dark'/.test(src), 'applyTheme 没写 data-dark');
  assert(/t\.dark/.test(src) || /\.dark\b/.test(src), 'data-dark 没按主题的 dark 标记来');
});

// ---- 真渲染：逐套主题跑 ----
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

let CFG = {
  model: 'q', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'gold', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
};
for (const ch of ALL) {
  h(ch, () => {
    if (ch === 'config:get') return CFG;
    if (ch === 'ctx:status') return null;
    if (/list$|tree$/.test(ch)) return [];
    if (ch === 'conv:messages') {
      return [
        { id: 'm1', role: 'user', content: '这一句是用户气泡。' },
        { id: 'm2', role: 'assistant', content: '这一句是模型气泡。' },
      ];
    }
    return null;
  });
}
h('app:version', () => ({ version: '1.0.9' }));
h('project:list', () => [{ id: PID, name: '主题验证' }]);
h('conv:list', () => [{ id: 'c1', projectId: PID, title: '主题', messageCount: 2 }]);

/**
 * 把颜色统一解析成 [r,g,b]。
 *
 * ⚠⚠ 这里栽过一次：`getComputedStyle().backgroundColor` 给的是 `rgb(20, 23, 28)`，
 *   而 `--paper` 是**十六进制** `#14171c` ——
 *   直接字符串比会永远不等（判据红，产品其实是对的）；
 *   而只认 `rgb()` 的亮度函数喂十六进制会回 NaN，`NaN < 0.5` 又恒为 false
 *   （判据绿，问题其实还在）。**两种格式都得认。**
 */
function parseColor(s) {
  const t = String(s || '').trim();
  let m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  return null;
}
/** 相对亮度（0=黑 1=白） */
function lum(c) {
  const p = parseColor(c);
  if (!p) return NaN;
  return (p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114) / 255;
}
/** 两个颜色是否"看起来同一个"（每通道容差 2） */
function sameColor(a, b) {
  const p = parseColor(a); const q = parseColor(b);
  if (!p || !q) return false;
  return p.every((v, i) => Math.abs(v - q[i]) <= 2);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  win.showInactive();
  await new Promise((r) => setTimeout(r, 1600));
  const j = (c) => win.webContents.executeJavaScript(c);

  const probe = () => j(`(() => {
    const surf = document.querySelector('.chat-surface');
    if (!surf) return { err: '没有 .chat-surface' };
    const cs = getComputedStyle(surf);
    const root = getComputedStyle(document.documentElement);
    const ai = document.querySelector('.chat-surface .msg-ai');
    const user = document.querySelector('.chat-surface .msg-user');
    return {
      paper: root.getPropertyValue('--paper').trim(),
      surfaceBg: cs.backgroundColor,
      surfaceInk: cs.color,
      aiBg: ai ? getComputedStyle(ai).backgroundColor : '',
      aiInk: ai ? getComputedStyle(ai).color : '',
      userBg: user ? getComputedStyle(user).backgroundColor : '',
      userInk: user ? getComputedStyle(user).color : '',
      bubbleAiVar: root.getPropertyValue('--bubble-ai').trim(),
      bubbleUserVar: root.getPropertyValue('--bubble-user').trim(),
      chatAiVar: cs.getPropertyValue('--chat-ai-bg').trim(),
      chipSkill: root.getPropertyValue('--chip-skill-bg').trim(),
      dataTheme: document.documentElement.getAttribute('data-theme'),
      dataDark: document.documentElement.getAttribute('data-dark'),
    };
  })()`);

  console.log('\n二、逐套主题真渲染（走产品路径：改 config.theme → 重载）');
  const seen = [];
  for (const t of THEMES) {
    CFG = { ...CFG, theme: t.id };
    win.webContents.reload();
    // 等界面起来（.chat-surface 在）
    let got = null;
    for (let i = 0; i < 30 && !got; i++) {
      await new Promise((r) => setTimeout(r, 400));
      got = await probe().catch(() => null);
      if (got && got.err) got = null;
    }
    assert(got, `${t.name}（${t.id}）下没找到聊天区`);
    const L = lum(got.surfaceBg);
    seen.push({ ...t, ...got, L });
    console.log(`  ${t.name.padEnd(4)}（${t.id.padEnd(10)}）底色=${got.surfaceBg.padEnd(22)} 亮度=${L.toFixed(2)}`
      + ` data-dark=${got.dataDark || '无'}`);

    check(`★★ ${t.name}：聊天卡片跟着主题（${t.dark ? '深色要变深' : '浅色要保持浅'}）`, () => {
      assert(got.dataTheme === t.id, `data-theme 是 ${got.dataTheme}，不是 ${t.id}`);
      if (t.dark) {
        assert(got.dataDark === '1', 'data-dark 没写上 —— CSS 拿不到"深色主题"这件事');
        assert(L < 0.5, `聊天区底色亮度 ${L.toFixed(2)}，还是浅色（${got.surfaceBg}）`);
        // 卡片底色必须就是主题的 paper —— 不是就说明还有一层固定色盖着
        assert(sameColor(got.surfaceBg, got.paper),
          `聊天区底色 ${got.surfaceBg} ≠ 主题 paper ${got.paper}`);
        assert(lum(got.surfaceInk) > 0.5, `深色底上文字还是深的：${got.surfaceInk}`);
        assert(lum(got.aiBg) < 0.5, `模型气泡还是浅色：${got.aiBg}`);
      } else {
        assert(!got.dataDark, `浅色主题不该有 data-dark（${got.dataDark}）`);
        assert(L > 0.6, `聊天区底色 ${got.surfaceBg} 变深了 —— 10-15 的要求是浅色界面下保持浅色`);
        assert(lum(got.surfaceInk) < 0.5, `浅色底上文字应该是深的：${got.surfaceInk}`);
      }
    });
  }

  console.log('\n三、气泡与 chip 的色也要跟着主题');
  const dark = seen.find((x) => x.dark);
  const light = seen.find((x) => !x.dark);
  check('★★ 深色下气泡跟着主题的 --bubble-*，字与底气够对比', () => {
    /**
     * ⚠ 别用"气泡必须是深色"当判据：深色主题也可能故意用一个**亮色**气泡
     *   （夜墨的 `--bubble-user: #c9a86a` 就是亮金 + 深字，那是设计）。
     *   要钉的是三条：跟主题变量一致、气泡与卡片能分开、自己的字看得清。
     */
    assert(sameColor(dark.userBg, dark.bubbleUserVar),
      `用户气泡 ${dark.userBg} 没跟着 --bubble-user（${dark.bubbleUserVar}）`);
    assert(sameColor(dark.aiBg, dark.bubbleAiVar),
      `模型气泡 ${dark.aiBg} 没跟着 --bubble-ai（${dark.bubbleAiVar}）`);
    assert(!sameColor(dark.aiBg, '#ffffff'),
      `模型气泡还是纯白 ${dark.aiBg} —— 写死的那套没清掉`);
    assert(!sameColor(dark.aiBg, dark.surfaceBg), '模型气泡和卡片同色，看不出气泡');
    assert(Math.abs(lum(dark.userInk) - lum(dark.userBg)) > 0.35,
      `用户气泡字色 ${dark.userInk} 与底色 ${dark.userBg} 对比不够`);
    assert(Math.abs(lum(dark.aiInk) - lum(dark.aiBg)) > 0.35,
      `模型气泡字色 ${dark.aiInk} 与底色 ${dark.aiBg} 对比不够`);
    assert(!sameColor(dark.userBg, dark.aiBg), '两个气泡同色，分不出谁说的');
  });
  check('★★ chip 颜色深浅两套（写死在 JSX 里那种已经清掉）', () => {
    assert(light.chipSkill && dark.chipSkill, 'chip 变量没读到');
    assert(light.chipSkill !== dark.chipSkill,
      `深浅两个主题的 chip 色一样：${light.chipSkill} —— 说明深色那套没生效`);
    assert(lum(dark.chipSkill) < 0.5, `深色下 chip 底色还是浅的：${dark.chipSkill}`);
  });

  // 留一张夜黛的图给人看
  const OUT = path.join(APPDIR, 'shots');
  fs.mkdirSync(OUT, { recursive: true });
  CFG = { ...CFG, theme: 'night-ink' };
  win.webContents.reload();
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 3; i++) {
    try {
      const box = await j(`(() => {
        const r = document.querySelector('.chat-surface').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) - 40, width: Math.round(r.width), height: Math.min(560, Math.round(r.height) + 40) };
      })()`);
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 260));
      const img = await win.webContents.capturePage(box);
      fs.writeFileSync(path.join(OUT, 'theme-dark-chat.png'), img.toPNG());
      console.log('  → shots/theme-dark-chat.png（夜黛下的聊天区）');
      break;
    } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
  }

  await Promise.all(pending);
  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `主题 · 聊天区：${passed} 通过 / ${failures.length} 失败` : `主题 · 聊天区：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => { console.error('脚本崩了：', e && e.message); setTimeout(() => app.exit(1), 300); });

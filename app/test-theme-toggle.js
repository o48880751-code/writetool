/**
 * 判据：顶栏「一键切深浅」按钮（2026-11-02）。
 *
 * ## 判据为什么这么定
 *
 * - **只看 `data-dark` 变了不够**：那只证明 DOM 属性被改了。
 *   真正会坏的是"改了属性没存盘"（重启又回浅色）和"存了盘没改属性"（点了没反应）。
 *   所以每点一次都同时断言 **DOM 属性** + **config.mode** + **按钮自己的 title/图标**。
 * - **图标要能验**：月亮是「一条 path」，太阳是「一个 circle + 一条 path」。
 *   数一下 svg 里的 circle 就能区分，不用去比 path 字面量（那种断言一改形状就崩）。
 * - **往返**：点两次必须回到原点。只测单向的话，"点一次切深、点第二次没反应"
 *   这种 bug 会漏掉（切深成功了，判据就绿了）。
 * - **system 档要单独测**：停在"跟随系统"时点一下，必须落到**固定档**，
 *   否则跟随系统 + 点击 = 看起来没反应。
 *
 * 运行：./electron-run.cmd test-theme-toggle.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'test-theme-toggle.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const PID = 'tt-1';
pfs.ensureProject(PID);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '主题切换验证', kind: 'long' });
pfs.write(PID, '章节/第01章.md', '# 第一章\n\n雪下了三日。\n');

// ---- IPC 桩 ----
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
const fallbackFor = (ch) => {
  if (/_list$|_get$/.test(ch)) return [];
  if (ch === 'config:get') return null;
  return null;
};
for (const ch of ALL_CHANNELS) {
  const fb = fallbackFor(ch);
  h(ch, () => (typeof fb === 'function' ? fb() : fb));
}

/** ⚠ 起点是**浅色**：这样"点一下变深"才是有意义的断言，而不是"本来就是深色" */
let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui',
  notify: 'window', currentProject: null, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
  mode: 'light',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.6.2', full: 'v1.6.2' }));
h('project:list', () => db.listProjectsWithKind());
h('project:stat', (p) => {
  const c = pfs.countTree(p.id);
  return { ok: true, id: p.id, chars: c.charCount || 0, files: c.fileCount || 0, dirs: c.dirCount || 0,
           chapters: 1, todayChars: 100, streakDays: 1, intro: '' };
});
h('project:open', () => CFG);
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => db.listSkills(PID));
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('fs:tree', (p) => pfs.tree(p.projectId, { sort: p.sort }));
h('conv:list', () => []);

const CHECKS = [];
function t(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.log('  ✗ 90 秒没跑完，判定为卡死');
    app.exit(1);
  }, 90000);

  const { width: screenW, height: screenH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1400, screenW - 40);
  const winH = Math.min(950, screenH - 60);

  const win = new BrowserWindow({
    width: winW, height: winH, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.showInactive();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(2800);

  async function js(code) {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { return { __err: e.message }; }
  }

  const shot = async (name) => {
    await sleep(400);
    let buf = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try { buf = (await win.webContents.capturePage()).toPNG(); }
      catch (e) { console.log(`  [重试 ${i + 1}] capturePage 失败：${e.message}`); await sleep(400); }
    }
    if (!buf) { console.log(`  ✗ ${name} 没拍成`); return; }
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
    console.log(`  ✓ ${name}`);
  };

  /** 按钮的全部可观测状态 */
  const probe = () => js(`
    (() => {
      var b = document.querySelector('[data-testid="theme-toggle"]');
      if (!b) return { missing: true };
      var r = b.getBoundingClientRect();
      var svg = b.querySelector('svg');
      var head = document.querySelector('header');
      var hr = head ? head.getBoundingClientRect() : null;
      var wc = document.querySelector('[data-testid="win-controls"]');
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top),
        inHeader: !!head && head.contains(b),
        insideHeaderBox: !!hr && r.top >= hr.top - 1 && r.bottom <= hr.bottom + 1,
        beforeWinControls: !!wc && !!(b.compareDocumentPosition(wc) & Node.DOCUMENT_POSITION_FOLLOWING),
        hasSvg: !!svg,
        // 月亮=一条 path；太阳=circle + path。数 circle 比比对 path 字符串稳
        circles: svg ? svg.querySelectorAll('circle').length : -1,
        paths: svg ? svg.querySelectorAll('path').length : -1,
        title: b.getAttribute('title') || '',
        aria: b.getAttribute('aria-label') || '',
        bg: getComputedStyle(b).backgroundColor,
        // 按钮自身不能是透明的 —— 参考图里它是有底色的圆角方块
        dark: document.documentElement.getAttribute('data-dark'),
        mode: null,
      };
    })()
  `);

  const click = () => js(`
    (() => {
      var b = document.querySelector('[data-testid="theme-toggle"]');
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  console.log('\n=== 一、按钮存在且位置对 ===');
  let p = await probe();
  if (p.__err || p.missing) {
    console.log('  ✗ 按钮没渲染出来：', JSON.stringify(p).slice(0, 300));
    t('按钮存在', false);
    clearTimeout(watchdog);
    win.destroy();
    app.exit(1);
  }
  console.log('  ', JSON.stringify({ w: p.w, h: p.h, x: p.x, y: p.y, circles: p.circles, paths: p.paths, title: p.title }));
  t('顶栏有切深浅按钮', true);
  t('在 header 里', p.inHeader === true);
  t('落在 header 的高度范围内（没跑到外面）', p.insideHeaderBox === true);
  t('在窗口控制按钮**左边**（不会挤到最小化/关闭）', p.beforeWinControls === true);
  t('尺寸和旁边那几个开关一致（28×28）', p.w === 28 && p.h === 28, `${p.w}×${p.h}`);
  t('按钮有自己的底色（不是透明贴纸）', !!p.bg && p.bg !== 'rgba(0, 0, 0, 0)', String(p.bg));

  console.log('\n=== 二、起点是浅色，图标是月亮 ===');
  t('起点 data-dark 没挂', p.dark === null, String(p.dark));
  t('起点图标是月亮（没有 circle，一条 path）', p.circles === 0 && p.paths === 1,
    `circle=${p.circles} path=${p.paths}`);
  t('title 说的是「切到深色」', p.title.indexOf('切到深色') >= 0, p.title);
  t('有 aria-label（纯图标必须有无障碍名）', p.aria.length > 0, p.aria);

  console.log('\n=== 三、点一下 → 深色（DOM + 存盘 + 图标 三处都要变） ===');
  console.log('  点击:', await click());
  await sleep(800);
  p = await probe();
  console.log('  ', JSON.stringify({ dark: p.dark, circles: p.circles, paths: p.paths, title: p.title, cfgMode: CFG.mode }));
  t('data-dark 挂上了', p.dark === '1', String(p.dark));
  t('config.mode 存成了 dark（不是只改了界面）', CFG.mode === 'dark', String(CFG.mode));
  t('图标换成太阳（有 circle）', p.circles === 1 && p.paths >= 1, `circle=${p.circles} path=${p.paths}`);
  t('title 跟着改成「切到浅色」', p.title.indexOf('切到浅色') >= 0, p.title);
  t('深色下按钮底色仍然是深色调（跟着主题走，不是写死白）',
    (function () {
      const c = (String(p.bg).match(/[\d.]+/g) || []).map(Number);
      // rgba(255,255,255,0.05) 这种"叠在深色上的浅色"也算对：它 alpha 很低
      return c.length >= 4 ? c[3] < 0.2 : (c[0] + c[1] + c[2]) / 3 < 90;
    })(), String(p.bg));
  await shot('t1-深色');

  console.log('\n=== 四、再点一下 → 回到浅色（往返） ===');
  console.log('  点击:', await click());
  await sleep(800);
  p = await probe();
  console.log('  ', JSON.stringify({ dark: p.dark, circles: p.circles, cfgMode: CFG.mode }));
  t('data-dark 摘掉了', p.dark === null, String(p.dark));
  t('config.mode 回到 light', CFG.mode === 'light', String(CFG.mode));
  t('图标回到月亮', p.circles === 0 && p.paths === 1, `circle=${p.circles} path=${p.paths}`);
  await shot('t2-浅色');

  console.log('\n=== 五、停在「跟随系统」档时点一下，要落到固定档 ===');
  /**
   * ⚠ 这是最容易漏的一条：不处理的话，跟随系统时点按钮会写成 `mode: 'system'`，
   *   界面纹丝不动 —— 用户以为按钮坏了。
   */
  CFG = { ...CFG, mode: 'system' };
  await win.webContents.reload();
  await sleep(2800);
  const sysDark0 = await js("window.matchMedia('(prefers-color-scheme: dark)').matches");
  console.log('  本机系统当前深色?', sysDark0);
  console.log('  点击:', await click());
  await sleep(800);
  p = await probe();
  const want = sysDark0 ? 'light' : 'dark';
  console.log('  ', JSON.stringify({ cfgMode: CFG.mode, dark: p.dark }));
  t(`跟随系统时点一下会切成固定的 ${want}（不是留在 system）`, CFG.mode === want, String(CFG.mode));
  t('界面也跟着变了（没有"点了没反应"）', p.dark === (want === 'dark' ? '1' : null), String(p.dark));

  console.log('\n=== 六、重启后还是上次选的档（持久化） ===');
  await win.webContents.reload();
  await sleep(2800);
  p = await probe();
  t('重载后仍是刚才那个档', p.dark === (want === 'dark' ? '1' : null),
    `data-dark=${p.dark} 期望=${want === 'dark' ? '1' : 'null'}`);

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
  clearTimeout(watchdog);
  win.destroy();
  app.exit(bad.length ? 1 : 0);
});

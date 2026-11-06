/**
 * 判据：Apple 风格微交互（2026-11-03）。
 *
 * ## 为什么要有这份判据
 *
 * 羽毛菌截图问「这三个折叠卡片的按钮，动画效果怎么没了」。
 * 查下来真相是：**从来没生效过**。那三个按钮写了
 * `transition: background-color 140ms`，但**没有任何 hover / active 状态**，
 * 过渡是空转的（唯一会变的是开关那一瞬间的底色，140ms 快得像瞬切）。
 *
 * 所以这里不能只断言"CSS 里有 transition"——那正是原来就有的、看着对的东西。
 * 必须断言**真的动了**：
 *   1. 鼠标移上去，按钮的**计算后的底色**必须变（`:hover` 真的命中）；
 *   2. 鼠标移开，必须回到原值（否则"移开还亮着"）；
 *   3. 点一下，`data-on` 翻转 + 底色与字色都变（开关态可见）；
 *   4. 过渡里必须含 `transform`（按下回弹靠它，只有 background 就是旧版）；
 *   5. `section[data-pane]` 上真的挂着 paneIn 动画（栏出现时淡入）；
 *   6. `.modal-card` 上真的挂着 sheetIn 动画（弹层弹入）。
 *
 * ## 为什么第 1 条要用 sendInputEvent 而不是 `el.dispatchEvent(new MouseEvent('mouseover'))`
 *
 * 合成事件**不触发 CSS :hover**。必须让 Chromium 真的认为指针在那个坐标上，
 * 所以走 `webContents.sendInputEvent({type:'mouseMove'})`。
 * ⚠ 窗口必须 `show: true`（或 showInactive），隐藏窗口收不到输入事件。
 *
 * 运行：./electron-run.cmd test-motion.js
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

const db = new Store(path.join(os.tmpdir(), 'test-motion.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const PID = 'mo-1';
pfs.ensureProject(PID);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '动效验证', kind: 'long' });
pfs.write(PID, '章节/第01章.md', '# 第一章\n\n雪下了三日。\n');

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => null);

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui',
  notify: 'window', currentProject: PID, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
  mode: 'light',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: require('./package.json').version, full: 'v' + require('./package.json').version }));
h('project:list', () => db.listProjectsWithKind());
h('project:stat', (p) => {
  const c = pfs.countTree(p.id);
  return { ok: true, id: p.id, chars: c.charCount || 0, files: c.fileCount || 0, dirs: c.dirCount || 0,
           chapters: 1, todayChars: 1200, streakDays: 3, intro: '' };
});
h('project:open', () => CFG);
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('thread:list', () => []);
h('conv:list', () => []);
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
h('fs:read', (p) => pfs.read(p.projectId, p.path));

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
  const win = new BrowserWindow({
    width: Math.min(1400, screenW - 40),
    height: Math.min(950, screenH - 60),
    show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.showInactive();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(2600);

  async function js(code) {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { return { __err: e.message }; }
  }
  const shot = async (name) => {
    await sleep(350);
    let buf = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try { buf = (await win.webContents.capturePage()).toPNG(); }
      catch (e) { await sleep(400); }
    }
    if (buf) { fs.writeFileSync(path.join(OUT, `${name}.png`), buf); console.log(`  ✓ ${name}`); }
  };

  console.log('\n=== 一、先进编辑器（栏开关只在编辑器里出现） ===');
  const entered = await js(`
    (() => {
      const b = document.querySelector('[data-testid="shelf-hero-continue"]');
      if (b) { b.click(); return 'hero'; }
      const c = document.querySelector('[data-testid="bookshelf-card"]');
      if (c) { c.click(); return 'card'; }
      return 'none';
    })()
  `);
  await sleep(1600);
  console.log('  进入方式:', entered);
  t('进了编辑器（栏开关才可能有）', entered === 'hero' || entered === 'card', String(entered));

  console.log('\n=== 二、四个按钮都用同一套类 ===');
  const base = await js(`
    (() => {
      var all = [].slice.call(document.querySelectorAll('.tb-btn'));
      var toggles = [].slice.call(document.querySelectorAll('[data-card-toggle]'));
      var one = all[0];
      var cs = one ? getComputedStyle(one) : null;
      return {
        count: all.length,
        toggles: toggles.length,
        props: cs ? cs.transitionProperty : '',
        dur: cs ? cs.transitionDuration : '',
        timing: cs ? cs.transitionTimingFunction : '',
        // ⚠ 旧版只过渡 background-color，没有 transform → 按下没有回弹
        hasTransform: cs ? cs.transitionProperty.indexOf('transform') >= 0 : false,
        // 不能还是 inline style（那样 :hover 盖不过）
        inlineBg: one ? one.style.backgroundColor : '',
        dataOn: toggles.map(function (x) { return x.getAttribute('data-on'); }),
      };
    })()
  `);
  console.log('  ', JSON.stringify(base));
  t('顶栏至少 4 个按钮共用 .tb-btn（主题 + 3 个栏开关）', base.count >= 4, `count=${base.count}`);
  t('三个栏开关都在', base.toggles === 3, `toggles=${base.toggles}`);
  t('过渡里含 transform（按下回弹靠它）', base.hasTransform === true, base.props);
  t('底色不再写在 inline style 里（否则 :hover 盖不过）', !base.inlineBg, `inline=${base.inlineBg}`);

  console.log('\n=== 三、鼠标移上去，底色真的变（:hover 命中） ===');
  const rect = await js(`
    (() => {
      var b = document.querySelector('[data-card-toggle="main"]');
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);
  const bgOf = () => js(`
    (() => {
      var b = document.querySelector('[data-card-toggle="main"]');
      return b ? getComputedStyle(b).backgroundColor : null;
    })()
  `);
  const before = await bgOf();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  await sleep(360);
  const hovered = await bgOf();
  t('悬停时底色变化', before !== hovered, `${before} → ${hovered}`);

  // 移开：坐标放到顶栏空白处
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: Math.min(300, rect.y + 300) });
  await sleep(360);
  const after = await bgOf();
  t('移开后底色回到原值（不会一直亮着）', after === before, `${hovered} → ${after}`);
  await shot('m1-顶栏按钮');

  console.log('\n=== 四、点一下：状态翻转 + 底色字色都变 ===');
  const st1 = await js(`
    (() => {
      var b = document.querySelector('[data-card-toggle="files"]');
      var cs = getComputedStyle(b);
      var pane = document.querySelector('section[data-pane="files"]');
      return { on: b.getAttribute('data-on'), pressed: b.getAttribute('aria-pressed'),
               bg: cs.backgroundColor, color: cs.color,
               paneW: pane ? Math.round(pane.getBoundingClientRect().width) : -1 };
    })()
  `);
  await js(`document.querySelector('[data-card-toggle="files"]').click()`);

  /**
   * ⚠⚠ 退场动画（2026-11-03 补）。
   *
   * 羽毛菌：「你只做了入场的动画，消失的没有」。
   * 这一节必须**在动画进行中取样**（70ms），不能等 500ms 再看 ——
   * 那时候已经移除了，"有没有退场"根本测不出来（这正是之前漏掉它的原因：
   * 所有断言都在 500ms 之后，退场有没有都一样）。
   */
  await sleep(70);
  const during = await js(`
    (() => {
      var s = document.querySelector('section[data-pane="files"]');
      if (!s) return { gone: true };
      var cs = getComputedStyle(s);
      return {
        gone: false,
        closing: s.getAttribute('data-pane-closing'),
        w: Math.round(s.getBoundingClientRect().width),
        opacity: Number(cs.opacity),
      };
    })()
  `);
  console.log('  收起中(70ms):', JSON.stringify(during));
  t('点收起后不是立刻消失（有退场时间）', during.gone === false, JSON.stringify(during));
  t('那一栏被打上 data-pane-closing', during.closing === '1', String(during.closing));
  t('宽度真的在收窄（不是只淡出——否则邻居会跳）',
    during.w >= 0 && during.w < st1.paneW, `${st1.paneW} → ${during.w}`);
  t('同时在淡出', during.opacity < 1, String(during.opacity));

  await sleep(400);
  const st2 = await js(`
    (() => {
      var b = document.querySelector('[data-card-toggle="files"]');
      var cs = getComputedStyle(b);
      var panes = [].slice.call(document.querySelectorAll('section[data-pane]')).map(function (s) { return s.getAttribute('data-pane'); });
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem('wt.hiddenPanes') || '[]'); } catch (_) {}
      return { on: b.getAttribute('data-on'), pressed: b.getAttribute('aria-pressed'),
               bg: cs.backgroundColor, color: cs.color, panes: panes, saved: saved };
    })()
  `);
  console.log('  收起前:', JSON.stringify(st1));
  console.log('  收起后:', JSON.stringify(st2));
  t('点一下 aria-pressed 翻转', st1.pressed !== st2.pressed, `${st1.pressed} → ${st2.pressed}`);
  t('data-on 跟着翻（CSS 靠它上色）', st1.on !== st2.on, `${st1.on} → ${st2.on}`);
  t('底色变了（开关态看得见）', st1.bg !== st2.bg, `${st1.bg} → ${st2.bg}`);
  t('字色也变了（不只是底）', st1.color !== st2.color, `${st1.color} → ${st2.color}`);
  t('动画结束后那一栏真的收起了', st2.panes.indexOf('files') < 0, st2.panes.join(','));
  t('收起状态写进了 localStorage（重启后保持）',
    Array.isArray(st2.saved) && st2.saved.indexOf('files') >= 0, JSON.stringify(st2.saved));

  // 收回来，顺便验"栏出现时有 paneIn 动画"
  await js(`document.querySelector('[data-card-toggle="files"]').click()`);
  await sleep(120);
  const anim = await js(`
    (() => {
      var s = document.querySelector('section[data-pane="files"]');
      if (!s) return null;
      var cs = getComputedStyle(s);
      return { name: cs.animationName, dur: cs.animationDuration };
    })()
  `);
  t('栏重新出现时挂着 paneIn 动画', !!anim && anim.name === 'paneIn', JSON.stringify(anim));
  await sleep(400);

  console.log('\n=== 五、弹层动画 ===');
  const sheet = await js(`
    (() => {
      var d = document.createElement('div');
      d.className = 'modal-card';
      document.body.appendChild(d);
      var cs = getComputedStyle(d);
      var out = { name: cs.animationName, dur: cs.animationDuration };
      d.remove();
      return out;
    })()
  `);
  t('.modal-card 上挂着 sheetIn（弹层弹入）', sheet.name === 'sheetIn', JSON.stringify(sheet));

  const mask = await js(`
    (() => {
      var d = document.createElement('div');
      d.className = 'modal-mask';
      document.body.appendChild(d);
      var cs = getComputedStyle(d);
      var out = { name: cs.animationName };
      d.remove();
      return out;
    })()
  `);
  t('.modal-mask 上挂着 maskIn（遮罩淡入）', mask.name === 'maskIn', JSON.stringify(mask));

  console.log('\n=== 六、尊重「减少动态效果」 ===');
  const css = fs.readFileSync(path.join(APPDIR, 'src', 'index.css'), 'utf8');
  t('有 prefers-reduced-motion 兜底', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css));
  t('兜底里真的把 animation/transition 停了', /animation:\s*none\s*!important/.test(css) && /transition:\s*none\s*!important/.test(css));

  console.log('\n=== 七、裁一块顶栏看效果 ===');
  const r2 = await js(`
    (() => {
      var h = document.querySelector('header');
      if (!h) return null;
      var r = h.getBoundingClientRect();
      var bs = [].slice.call(document.querySelectorAll('.tb-btn')).map(function (b) {
        var x = b.getBoundingClientRect();
        return { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom) };
      });
      return { h: Math.round(r.height), right: Math.round(r.right), bs: bs };
    })()
  `);
  console.log('  ', JSON.stringify(r2));
  t('顶栏里能找到按钮矩形（用于截图核对）', !!r2 && r2.bs.length >= 4);

  clearTimeout(watchdog);
  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  app.exit(bad.length ? 1 : 0);
});

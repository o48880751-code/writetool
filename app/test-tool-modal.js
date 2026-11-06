/**
 * 判据：起名 / 脑洞 / 灵感碎片的弹窗（2026-11-03）。
 *
 * 运行：./electron-run.cmd test-tool-modal.js
 *
 * ## 羽毛菌的原话
 *
 *   「起名，脑洞，灵感碎片都应该做单独的交互而不是和备忘录一样。
 *     起名可以做个弹窗，弹出来会给一些基础灵感还有用户自己的要求，然后 ai 生成名字。
 *     脑洞也是，弹出一个卡片先填写主要信息，可以保存到脑洞文件里。
 *     灵感碎片就更应该做成交互式了，先写灵感，可以选择 ai 整理，扩散，存储」
 *
 * ## 这里在防什么
 *
 * 1. **入口还是那个通用模板** —— 点「起名」结果又打开了那个 md 的 textarea。
 *    所以断言的是"弹窗出现 + 有表单字段"，不是"有这个工具"。
 * 2. **preload 丢嵌套字段** —— `fields` 是对象套对象，这一层栽过四次
 *    （kind / list / stat / import）。所以判据不是"界面填进去了"，
 *    而是**主进程收到的 fields 里每一项都对**。
 * 3. **保存覆盖旧内容** —— 同一个工具会用很多次，覆盖等于删掉上一次的想法。
 *    所以先放一段旧内容，存完断言"旧的还在 + 新的是追加"。
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

const { Store, setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'test-tool-modal.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const PID = 'tm-1';
pfs.ensureProject(PID);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '墨染仙途', kind: 'long' });
pfs.write(PID, '设定/世界观.md', '# 世界观\n\n沈砚自幼被弃于雪原。\n');
/** 起名备忘里**先放一段旧内容**，用来验证保存是追加不是覆盖 */
pfs.write(PID, '起名备忘.md', '# 起名备忘\n\n> 旧内容：沈砚（已定）\n');

const CALLS = [];
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', mode: 'light',
  notify: 'window', currentProject: PID, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
};
const PKG_VERSION = require(path.join(APPDIR, 'package.json')).version;

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: PKG_VERSION, full: 'v' + PKG_VERSION }));
h('project:list', () => db.listProjectsWithKind());
h('project:stat', (p) => {
  const c = pfs.countTree(p.id);
  return { ok: true, id: p.id, chars: c.charCount || 0, files: c.fileCount || 0, dirs: c.dirCount || 0,
           chapters: 1, todayChars: 100, streakDays: 2, intro: '' };
});
h('project:open', () => CFG);
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('conv:list', () => []);
h('skill:list', () => db.listSkills(PID));
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '' }));
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('fs:tree', (p) => pfs.tree(p.projectId, { sort: p.sort }));

/** 真读写项目目录 —— 保存判据要看磁盘上的结果，不能用内存桩糊弄 */
h('fs:read', (p) => pfs.read(p.projectId, p.path));
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));

/**
 * ★ 核心桩：AI 生成。
 * ⚠ 把**收到的参数**记下来 —— preload 丢字段只有在这里才看得出来
 *   （界面上填了、主进程收到的却是 undefined，界面看起来完全正常）。
 */
h('tool:gen', (p) => {
  CALLS.push(p);
  if (p.mode === 'brain') {
    return { text: '## 这条线怎么走\n1. 因为 A，所以 B\n## 反转在哪\n读者以为是 X', ms: 900 };
  }
  if (p.mode === 'idea' && p.action === 'expand') {
    return { text: '1. 反向走\n2. 拖延法\n3. 换主角', ms: 800 };
  }
  return { text: '沈砚 —— 砚台沉稳\n沈知白 —— 知白守黑\n叶青梧 —— 疏朗', ms: 1200 };
});

let win;
const failures = [];
let passed = 0;
/**
 * ⚠ 支持两种写法：`check(name, () => assert(...))` 和 `check(name, 布尔, 说明)`。
 *   第一版只认函数，而我全程传的是布尔 —— 于是每条都报 `fn is not a function`，
 *   看着像产品坏了，其实是判据自己的签名没对上。
 */
const check = (name, cond, detail) => {
  try {
    const ok = typeof cond === 'function' ? cond() : !!cond;
    if (!ok) throw new Error(detail || '断言失败');
    passed++; console.log('  ✓', name);
  } catch (e) {
    failures.push(name); console.log('  ✗', name, '\n     ', e.message);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  const watchdog = setTimeout(() => { console.log('  ✗ 120 秒没跑完'); app.exit(1); }, 120000);

  const { width: sw, height: sh } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1400, sw - 40), height: Math.min(950, sh - 60),
    show: false,
    webPreferences: { preload: path.join(APPDIR, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(2600);

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  };
  const clickSel = (sel) => js(`
    (() => {
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'not-found';
      el.click();
      return 'ok';
    })()
  `);
  const val = (id) => js(`(document.querySelector('[data-testid="${id}"]') || {}).value`);

  /**
   * 点快捷工具。⚠ 那一排**放不下就收进「⋯」菜单**，而菜单里的按钮
   * 只有打开菜单才挂载 —— 直接 `querySelector('[data-qt="name"]')` 会 not-found。
   * 所以先直接点，点不到再开「⋯」。
   */
  const openQt = async (key) => {
    let r = await clickSel(`[data-qt="${key}"]`);
    if (r === 'ok') return 'direct';
    const more = await js(`
      (() => {
        var b = [].slice.call(document.querySelectorAll('button')).find(function (x) {
          var t = (x.getAttribute('title') || '') + (x.textContent || '');
          return t.indexOf('还有') >= 0 || t.indexOf('⋯') >= 0;
        });
        if (!b) return 'no-more';
        b.click();
        return 'opened';
      })()
    `);
    await sleep(500);
    r = await clickSel(`[data-qt="${key}"]`);
    return `${more}/${r}`;
  };

  /** 给 input / textarea 赋值（React 受控必须走原生 setter + input 事件） */
  const typeInto = async (id, value, isArea) => {
    return js(`
      (() => {
        var el = document.querySelector('[data-testid="${id}"]');
        if (!el) return 'not-found';
        var proto = ${isArea ? 'window.HTMLTextAreaElement' : 'window.HTMLInputElement'}.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `);
  };

  // ---- 进编辑器（点书架卡片或继续写作）----
  if (await clickSel('[data-testid="bookshelf-card"]') === 'not-found') {
    await clickSel('[data-testid="shelf-hero-continue"]');
  }
  await sleep(1800);

  // ============================================================
  console.log('\n=== 一、起名：点工具 → 弹窗（不是那个 md 模板） ===');
  const dbg = await js("JSON.stringify({ qts: [].slice.call(document.querySelectorAll('[data-qt]')).map(function(x){return x.getAttribute('data-qt');}), panes: document.querySelectorAll('[data-pane]').length, ta: !!document.querySelector('textarea'), text: document.body.innerText.slice(0,90) })");
  console.log('  [dbg]', dbg);
  const opened = await openQt('name');
  await sleep(900);
  const nameState = await js(`
    (() => {
      var m = document.querySelector('[data-testid="tool-modal"]');
      return {
        clicked: ${JSON.stringify(opened)},
        modal: !!m,
        mode: m ? m.getAttribute('data-mode') : null,
        hasKind: !!document.querySelector('[data-testid="tool-kind-person"]'),
        hasCount: !!document.querySelector('[data-testid="tool-count"]'),
        hasSeed: !!document.querySelector('[data-testid="tool-seed"]'),
        hasMust: !!document.querySelector('[data-testid="tool-must"]'),
        /** ⚠ 反证：如果还是那个通用模板，页面上会出现 md 的 textarea */
        stillTemplate: document.body.innerText.indexOf('打开 起名备忘.md') >= 0,
        title: m ? (m.innerText.split('\\n')[0] || '') : '',
      };
    })()
  `);
  console.log('  ', JSON.stringify(nameState));
  check('点了「起名」真的弹出窗口', nameState.modal === true, JSON.stringify(nameState));
  check('弹窗是起名模式', nameState.mode === 'name', String(nameState.mode));
  check('★ 不再是那个「打开 xxx.md」的模板', nameState.stillTemplate === false);
  check('四个输入都在（起什么名 / 数量 / 基础灵感 / 额外要求）',
    nameState.hasKind && nameState.hasCount && nameState.hasSeed && nameState.hasMust,
    JSON.stringify(nameState));

  // ---- 填字段 ----
  console.log('\n=== 二、填字段 → 生成（验 preload 没丢嵌套字段） ===');
  CALLS.length = 0;
  await clickSel('[data-testid="tool-kind-place"]');
  console.log('  填数量:', await typeInto('tool-count', '3'));
  console.log('  填灵感:', await typeInto('tool-seed', '北境、雪原'));
  await sleep(200);
  await clickSel('[data-testid="tool-run-gen"]');
  await sleep(1400);

  const got = CALLS[0] || {};
  const gf = got.fields || {};
  console.log('  主进程收到:', JSON.stringify(got));
  check('★ 主进程真的收到了全部字段（preload 没丢）',
    got.mode === 'name' && got.action === 'gen'
      && gf.kind === 'place' && String(gf.count) === '3' && gf.seed === '北境、雪原',
    JSON.stringify(got));
  check('题材从项目带过来，用户不用再选', typeof gf.genre === 'string', String(gf.genre));

  const res1 = await val('tool-result');
  check('★ 结果填进了结果框', !!res1 && res1.indexOf('沈砚') >= 0, String(res1).slice(0, 40));
  await shot('t1-起名弹窗');

  // ---- 保存 ----
  console.log('\n=== 三、保存：追加，不覆盖 ===');
  const before = pfs.read(PID, '起名备忘.md').content;
  await clickSel('[data-testid="tool-save"]');
  await sleep(1200);
  const after = pfs.read(PID, '起名备忘.md').content;
  check('★ 旧内容还在（不是整份覆盖）', after.indexOf('旧内容：沈砚（已定）') >= 0, after.slice(0, 80));
  check('★ 新结果追加进去了', after.indexOf('沈知白') >= 0, after.slice(-120));
  check('追加时带了分隔线（能看出是不同批次）', after.indexOf('---') > before.indexOf('---'), after.slice(-200));
  check('长度确实变长了', after.length > before.length, `${before.length} → ${after.length}`);

  // ---- 返回 ----
  console.log('\n=== 四、返回：唯一的出口 ===');
  await clickSel('[data-testid="tool-modal-back"]');
  await sleep(600);
  const closed = await js('!!document.querySelector(\'[data-testid="tool-modal"]\')');
  check('点「返回」能关掉弹窗', closed === false);

  // ============================================================
  console.log('\n=== 五、脑洞：另一个模式，字段不一样 ===');
  CALLS.length = 0;
  await openQt('brain');
  await sleep(800);
  const brainState = await js(`
    (() => {
      var m = document.querySelector('[data-testid="tool-modal"]');
      return {
        mode: m ? m.getAttribute('data-mode') : null,
        hasIdea: !!document.querySelector('[data-testid="tool-idea"]'),
        /** 起名的字段不该出现在脑洞里（两套配置不能串） */
        hasKind: !!document.querySelector('[data-testid="tool-kind-person"]'),
      };
    })()
  `);
  check('脑洞是独立的一套字段', brainState.mode === 'brain' && brainState.hasIdea === true, JSON.stringify(brainState));
  check('起名的字段没串进来', brainState.hasKind === false);

  const runDisabled = await js(`
    (() => {
      var b = document.querySelector('[data-testid="tool-run-gen"]');
      return b ? b.disabled : 'no-btn';
    })()
  `);
  check('★ 必填项空着时生成按钮是灰的（不能发空请求）', runDisabled === true, String(runDisabled));

  console.log('  填想法:', await typeInto('tool-idea', '主角重生回高三', true));
  await sleep(200);
  await clickSel('[data-testid="tool-run-gen"]');
  await sleep(1200);
  const res2 = await val('tool-result');
  check('脑洞结果进了结果框', !!res2 && res2.indexOf('这条线怎么走') >= 0, String(res2).slice(0, 40));
  check('脑洞的 fields 也送到了', (CALLS[0] || {}).mode === 'brain', JSON.stringify(CALLS[0]));
  await shot('t2-脑洞弹窗');
  await clickSel('[data-testid="tool-modal-back"]');
  await sleep(500);

  // ============================================================
  console.log('\n=== 六、灵感碎片：两个动作，语义不同 ===');
  CALLS.length = 0;
  await openQt('idea');
  await sleep(800);
  const ideaState = await js(`
    (() => ({
      mode: (document.querySelector('[data-testid="tool-modal"]') || {}).getAttribute
        ? document.querySelector('[data-testid="tool-modal"]').getAttribute('data-mode') : null,
      tidy: !!document.querySelector('[data-testid="tool-run-tidy"]'),
      expand: !!document.querySelector('[data-testid="tool-run-expand"]'),
    }))()
  `);
  check('灵感碎片有「整理」和「扩散」两个动作', ideaState.tidy && ideaState.expand, JSON.stringify(ideaState));

  console.log('  填灵感:', await typeInto('tool-text', '雨夜，有人在敲门', true));
  await sleep(200);
  await clickSel('[data-testid="tool-run-expand"]');
  await sleep(1200);
  const call3 = CALLS[0] || {};
  check('★ 点「扩散」传的是 action=expand（不是 gen/tidy）', call3.action === 'expand', JSON.stringify(call3));
  const res3 = await val('tool-result');
  check('扩散结果进了结果框', !!res3 && res3.indexOf('反向走') >= 0, String(res3).slice(0, 40));
  await shot('t3-灵感碎片弹窗');

  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `工具弹窗：${passed} 通过 / ${failures.length} 失败`
    : `工具弹窗：${passed} 通过`);
  if (failures.length) failures.forEach((f) => console.log('  ✗', f));
  clearTimeout(watchdog);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本崩了：', e);
  app.exit(1);
});

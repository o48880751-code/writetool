/**
 * 判据：欢迎页两套入口 + 六个动作 + 使用教程弹窗（2026-11-05）。
 *
 * 运行：./electron-run.cmd test-welcome.js
 *
 * ## 这里在防什么
 *
 * 1. **进项目就自动打开上次对话** —— 这条最阴。原来 effect 里写的是
 *    loadConversations(projectId, true)，消息流立刻有内容，空状态根本不渲染，
 *    于是「第二次从书架进来」的三个按钮**永远看不见**。
 *    判据直接数 conv:messages 的调用次数，要求进编辑器时是 0。
 * 2. **按钮只换了皮、点了不干活** —— 每个动作都断言真的打到 IPC 上：
 *    conv:send 的 text / refs，conv:messages 的 conversationId。
 * 3. **查询冲突拿错卷纲** —— 造三卷，让「按文件名最后一个」和「按 mtime 最新」
 *    指向**不同文件**（按名字排到的是卷二/卷十，mtime 最新的是卷三），判据只认 mtime 那个。
 * 4. **教程关不掉** —— × / 知道了 / 遮罩 / Esc 四条路逐条点。
 *
 * ⚠ 桩注册在通用循环**之后**：h() 内部 removeHandler，注册早了会被覆盖成 return null。
 * ⚠ 参数形状照 preload 抄；整串透传，不挑字段。
 * ⚠ executeJavaScript 的代码串里**不许出现反引号**，Node 侧模板会被提前闭合。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PKG_VERSION = require(path.join(APPDIR, 'package.json')).version;

const CALLS = [];
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

// ① 通用兜底：所有 call('xxx') 通道先铺一遍
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));

// ② 具体桩（一定在循环之后）
let CFG = {
  model: 'qwen3:latest', numCtx: 8192, temperature: 0.3,
  fontSize: 15, fontFamily: 'system-ui', mode: 'light',
  notify: 'window', currentProject: null, thinkLevel: 'off',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
  toolsEnabled: false, penName: '羽某',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: PKG_VERSION, full: 'v' + PKG_VERSION }));
h('project:list', () => ([
  { id: 'p1', name: '测试书', kind: 'long', audience: '', updated_at: '2026-11-05T10:00:00.000Z', cover_path: null },
]));
h('project:stat', () => ({
  id: 'p1', chars: 3200, files: 6, dirs: 3, chapters: 1,
  todayChars: 300, streakDays: 2, intro: '一个关于雪原山门的故事。',
}));
h('project:open', (p) => { CFG.currentProject = p.id; return CFG; });
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '' }));
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('scope:get', () => ({ locked: false }));
h('web:ready', () => ({ ready: false }));

/**
 * 项目树：四卷卷纲，mtime 最新的是「卷三.md」。
 * ⚠ 故意不让它当「按名字排最前/最后」的那一个：
 *   升序首项是卷二/卷一、降序首项是卷十/卷一，怎么排都不会是卷三。
 *   否则「按名字取」和「按 mtime 取」结果一样，变异验证会假绿。
 */
const TREE = {
  name: '', type: 'dir', path: '', children: [
    {
      name: '设定', type: 'dir', path: '设定', children: [
        { name: '世界观.md', type: 'file', path: '设定/世界观.md', ext: '.md', size: 120, mtime: '2026-09-01T00:00:00.000Z' },
        { name: '人物库.md', type: 'file', path: '设定/人物库.md', ext: '.md', size: 90, mtime: '2026-09-02T00:00:00.000Z' },
      ],
    },
    {
      name: '卷纲', type: 'dir', path: '卷纲', children: [
        { name: '卷一.md', type: 'file', path: '卷纲/卷一.md', ext: '.md', size: 60, mtime: '2026-08-01T00:00:00.000Z' },
        { name: '卷二.md', type: 'file', path: '卷纲/卷二.md', ext: '.md', size: 70, mtime: '2026-11-04T00:00:00.000Z' },
        { name: '卷三.md', type: 'file', path: '卷纲/卷三.md', ext: '.md', size: 80, mtime: '2026-11-05T00:00:00.000Z' },
        { name: '卷十.md', type: 'file', path: '卷纲/卷十.md', ext: '.md', size: 40, mtime: '2026-10-01T00:00:00.000Z' },
      ],
    },
    {
      name: '章节', type: 'dir', path: '章节', children: [
        { name: '章节摘要.md', type: 'file', path: '章节/章节摘要.md', ext: '.md', size: 30, mtime: '2026-11-03T00:00:00.000Z' },
      ],
    },
  ],
};
h('fs:tree', () => TREE);
h('fs:read', (p) => ({ path: p.path, content: '# 测试内容\n' }));

let CONVS = [];
let MSGS = [];
let createSeq = 0;
h('conv:list', () => CONVS);
h('conv:messages', (p) => {
  CALLS.push({ ch: 'conv:messages', payload: p });
  return MSGS;
});
h('conv:create', (p) => {
  createSeq += 1;
  const c = { id: 'c-new-' + createSeq, project_id: p.projectId, title: p.title || '' };
  CALLS.push({ ch: 'conv:create', payload: p, id: c.id });
  // ⚠ 桩要真的把新对话放进列表，否则下一次 loadConversations 又回到空列表
  CONVS = [c, ...CONVS];
  return c;
});
h('conv:send', (p) => {
  CALLS.push({ ch: 'conv:send', payload: p });
  return { started: true, ok: true };
});

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, ok: !!ok });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callsOf = (ch) => CALLS.filter((c) => c.ch === ch);
const clearCalls = () => { CALLS.length = 0; };

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 120 秒没跑完'); app.exit(1); }, 120000);

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  win.focus();

  async function js(code) {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { return { __err: e.message }; }
  }
  const click = (sel) => js(`
    (() => {
      var b = document.querySelector(${JSON.stringify(sel)});
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);
  const welcomeState = () => js(`
    (() => {
      var p = document.querySelector('[data-testid="welcome-panel"]');
      if (!p) return { present: false, keys: [], mode: null };
      var bs = [...p.querySelectorAll('[data-welcome]')];
      return {
        present: true,
        mode: p.getAttribute('data-welcome-mode'),
        keys: bs.map(function (b) { return b.getAttribute('data-welcome'); }),
        labels: bs.map(function (b) {
          var x = b.querySelector('.welcome-card-title');
          return x ? x.textContent.trim() : '';
        }),
      };
    })()
  `);

  /** 重新加载 = 干净的 React 状态；再从书架点进编辑器 */
  async function enterEditor() {
    clearCalls();
    await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
    await sleep(1200);
    const a = await click('[data-testid="bookshelf-card"]');
    if (a === 'not-found') await click('[data-testid="shelf-hero-continue"]');
    await sleep(1100);
  }

  const shot = async (name) => {
    await sleep(320);
    try {
      const out = path.join(APPDIR, 'shots');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, name + '.png'), (await win.capturePage()).toPNG());
    } catch (_) { /* 截图失败不影响判据 */ }
  };

  // ==========================================================
  console.log('\n=== 一、第一次进来：三个按钮 ===');
  CONVS = []; MSGS = [];
  await enterEditor();
  const w1 = await welcomeState();
  console.log('  ', JSON.stringify(w1));
  t('进编辑器后欢迎页出现，且是「首次」模式',
    w1.present === true && w1.mode === 'first', 'mode=' + w1.mode);
  t('首次恰好三个按钮，顺序是 新书启航 → 搭建大纲 → 使用教程',
    w1.keys.length === 3 && w1.keys.join(',') === 'newbook,build,guide', (w1.keys || []).join(','));
  t('首次按钮文字是点名给的那三个',
    (w1.labels || []).join(',') === '新书启航,搭建大纲,使用教程', (w1.labels || []).join(','));
  t('首次不出现「继续写作 / 规划章纲 / 查询冲突」',
    !(w1.keys || []).some((k) => ['continue', 'outline', 'conflict'].includes(k)));
  t('⚠⚠ 进项目时没有自动打开上次对话（conv:messages 调用数为 0）',
    callsOf('conv:messages').length === 0, '实际=' + callsOf('conv:messages').length);
  await shot('welcome-first');

  console.log('\n=== 二、使用教程弹窗：开、内容、四条关闭路径 ===');
  await click('[data-welcome="guide"]');
  await sleep(420);
  const g1 = await js(`
    (() => {
      var m = document.querySelector('[data-testid="guide-modal"]');
      if (!m) return { present: false };
      return {
        present: true,
        text: (m.innerText || m.textContent || ''),
        hasX: !!m.querySelector('[data-testid="guide-close"]'),
        hasDone: !!m.querySelector('[data-testid="guide-done"]'),
        jumps: [...m.querySelectorAll('[data-guide-jump]')].map(function (b) { return b.getAttribute('data-guide-jump'); }),
      };
    })()
  `);
  t('点「使用教程」弹出窗口', g1.present === true);
  t('教程讲了配置 API / 下载技能 / 文件夹 / 快捷功能',
    ['API Key', '广场', '设定', '卷纲', '备忘录'].every((k) => (g1.text || '').indexOf(k) >= 0),
    '长度=' + (g1.text || '').length);
  t('教程里有「去配置」「去广场」两个真实入口',
    (g1.jumps || []).join(',') === 'provider,skill', (g1.jumps || []).join(','));
  t('弹窗有 × 和「知道了」两个关闭按钮', g1.hasX === true && g1.hasDone === true);
  await shot('welcome-guide');

  await click('[data-testid="guide-done"]');
  await sleep(260);
  t('点「知道了」能关掉', (await js(`!!document.querySelector('[data-testid="guide-modal"]')`)) === false);

  await click('[data-testid="guide-open"]');
  await sleep(260);
  t('顶栏「教程」是常驻入口（写过之后也进得来）',
    (await js(`!!document.querySelector('[data-testid="guide-modal"]')`)) === true);
  await click('[data-testid="guide-close"]');
  await sleep(260);
  t('点 × 能关掉', (await js(`!!document.querySelector('[data-testid="guide-modal"]')`)) === false);

  await click('[data-testid="guide-open"]');
  await sleep(220);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  await sleep(260);
  t('按 Esc 能关掉', (await js(`!!document.querySelector('[data-testid="guide-modal"]')`)) === false);

  await click('[data-testid="guide-open"]');
  await sleep(220);
  await js(`
    (() => { var m = document.querySelector('[data-testid="guide-mask"]') || document.querySelector('.guide-mask'); if (m) m.click(); })()
  `);
  await sleep(260);
  t('点遮罩能关掉', (await js(`!!document.querySelector('[data-testid="guide-modal"]')`)) === false);

  await click('[data-testid="guide-open"]');
  await sleep(220);
  await click('[data-guide-jump="provider"]');
  await sleep(900);
  const jump = await js(`
    (() => {
      var b = document.querySelector('[data-testid="settings-body"]');
      return {
        guideGone: !document.querySelector('[data-testid="guide-modal"]'),
        settingsOpen: !!b,
      };
    })()
  `);
  t('教程里「去配置」会关掉弹窗并打开设置页（不是死按钮）',
    jump.guideGone === true && jump.settingsOpen === true, JSON.stringify(jump));
  // 设置页是整页覆盖，后面还要点欢迎页按钮 → 重载回干净状态
  await enterEditor();

  console.log('\n=== 三、新书启航 / 搭建大纲：真发消息，不是只切界面 ===');
  const s1before = callsOf('conv:send').length;
  await click('[data-welcome="newbook"]');
  await sleep(700);
  const s1 = callsOf('conv:send').slice(-1)[0];
  t('「新书启航」打到 conv:send', callsOf('conv:send').length === s1before + 1 && !!s1);
  t('「新书启航」的提问会问怎么写、并说明随后给基础大纲',
    !!s1 && s1.payload.text.indexOf('基础大纲') >= 0 && s1.payload.text.indexOf('只提问') >= 0,
    s1 ? s1.payload.text.slice(0, 30) : 'null');
  t('「新书启航」不硬塞文件引用', !!s1 && (s1.payload.refs || []).length === 0);

  // 上一步 send 新建了对话，welcomeMode 会翻成 returning；这里把桩恢复成零对话再重载
  CONVS = []; MSGS = [];
  await enterEditor();
  await click('[data-welcome="build"]');
  await sleep(700);
  const s2 = callsOf('conv:send').slice(-1)[0];
  t('「搭建大纲」打到 conv:send，且问的是已有大纲 / 想细化哪层',
    !!s2 && s2.payload.text.indexOf('现成的大纲') >= 0 && s2.payload.text.indexOf('分卷') >= 0,
    s2 ? s2.payload.text.slice(0, 30) : 'null');

  // ==========================================================
  console.log('\n=== 四、第二次从书架进来：另外三个按钮 ===');
  CONVS = [
    { id: 'c1', title: '上次那段', updated_at: '2026-11-05T09:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' },
    { id: 'c2', title: '更早那段', updated_at: '2026-11-02T09:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z' },
  ];
  MSGS = [
    { id: 'm1', role: 'user', content: '接着写', created_at: '2026-11-05T09:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: '好，接着上一段。', created_at: '2026-11-05T09:00:01.000Z' },
  ];
  await enterEditor();
  const w2 = await welcomeState();
  console.log('  ', JSON.stringify(w2));
  t('有对话时欢迎页是「再次」模式', w2.present === true && w2.mode === 'returning', 'mode=' + w2.mode);
  t('再次恰好三个按钮，顺序是 继续写作 → 规划章纲 → 查询冲突',
    w2.keys.length === 3 && w2.keys.join(',') === 'continue,outline,conflict', (w2.keys || []).join(','));
  t('再次按钮文字是点名给的那三个',
    (w2.labels || []).join(',') === '继续写作,规划章纲,查询冲突', (w2.labels || []).join(','));
  t('再次不出现「新书启航 / 搭建大纲 / 使用教程」',
    !(w2.keys || []).some((k) => ['newbook', 'build', 'guide'].includes(k)));
  t('⚠⚠ 有对话时也没被自动打开（conv:messages 调用数为 0）',
    callsOf('conv:messages').length === 0, '实际=' + callsOf('conv:messages').length);
  await shot('welcome-returning');

  console.log('\n=== 五、继续写作：打开的是最近那条对话 ===');
  await click('[data-welcome="continue"]');
  await sleep(650);
  const mc = callsOf('conv:messages').slice(-1)[0];
  t('「继续写作」按 conversations[0] 打开最近对话',
    !!mc && mc.payload.conversationId === 'c1', mc ? mc.payload.conversationId : 'null');
  t('「继续写作」之后欢迎页让位给消息流',
    (await js(`!document.querySelector('[data-testid="welcome-panel"]')`)) === true);

  console.log('\n=== 六、规划章纲：展开卷纲 + AI 先问 ===');
  await enterEditor();
  await click('[data-welcome="outline"]');
  await sleep(700);
  const s3 = callsOf('conv:send').slice(-1)[0];
  t('「规划章纲」打到 conv:send，且这一轮只问下一章怎么生成',
    !!s3 && s3.payload.text.indexOf('下一章') >= 0 && s3.payload.text.indexOf('不要生成章纲') >= 0,
    s3 ? s3.payload.text.slice(0, 30) : 'null');
  t('「规划章纲」把最新卷纲与章节摘要作为文件引用带上',
    !!s3 && (s3.payload.refs || []).some((r) => r.id === '卷纲/卷三.md')
      && (s3.payload.refs || []).some((r) => r.id === '章节/章节摘要.md'),
    s3 ? (s3.payload.refs || []).map((r) => r.id).join(',') : 'null');
  t('「规划章纲」接在最近那条对话里，没有另起一条',
    !!s3 && s3.payload.conversationId === 'c1', s3 ? s3.payload.conversationId : 'null');
  const expanded = await js(`
    !!document.querySelector('[data-tree-row][title="卷纲/卷三.md"]')
  `);
  t('第 4 栏真的把「卷纲」文件夹展开了（子节点已渲染）', expanded === true);
  await shot('welcome-outline');

  console.log('\n=== 七、查询冲突：读世界观 / 人物库 / 最新卷纲 ===');
  await enterEditor();
  await click('[data-welcome="conflict"]');
  await sleep(700);
  const s4 = callsOf('conv:send').slice(-1)[0];
  const ids = s4 ? (s4.payload.refs || []).map((r) => r.id) : [];
  console.log('  refs=', JSON.stringify(ids));
  t('「查询冲突」打到 conv:send，text 明确要求逐条比对、不改文件',
    !!s4 && s4.payload.text.indexOf('冲突') >= 0 && s4.payload.text.indexOf('不要改文件') >= 0);
  t('「查询冲突」带世界观与人物库',
    ids.indexOf('设定/世界观.md') >= 0 && ids.indexOf('设定/人物库.md') >= 0);
  t('⚠⚠ 「最新卷纲」取的是 mtime 最新的卷三，不是按名字排出来的任何一卷',
    ids.indexOf('卷纲/卷三.md') >= 0
      && ids.indexOf('卷纲/卷十.md') < 0
      && ids.indexOf('卷纲/卷二.md') < 0
      && ids.indexOf('卷纲/卷一.md') < 0);
  t('文件引用形状对得上 ChatPanel.toggleRef（kind=file / id=相对路径）',
    !!s4 && (s4.payload.refs || []).every((r) => r.kind === 'file' && r.key === 'file:' + r.id && 'content' in r));

  console.log('\n=== 八、静态护栏：没动 IPC 边界、没退回自动选对话 ===');
  const appSrc = fs.readFileSync(path.join(APPDIR, 'src', 'App.jsx'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const appCode = strip(appSrc);
  t('进项目的 effect 不再自动 selectConversation',
    appCode.indexOf('loadConversations(projectId, false)') >= 0);
  t('从书架进来时显式清空 convId / messages',
    appCode.indexOf('setConvId(null)') >= 0 && appCode.indexOf('convSeq.current += 1') >= 0);
  const welcomeSrc = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'Welcome.jsx'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'ChatPanel.jsx'), 'utf8');
  const allUi = appSrc + welcomeSrc + chatSrc;
  t('六个动作没新增任何 IPC 通道（渲染层不出现 ipc / 新 api 域）',
    allUi.indexOf('ipcRenderer') < 0
      && allUi.indexOf('window.api.welcome') < 0
      && allUi.indexOf('window.api.guide') < 0);
  const preloadNow = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
  t('preload.js 全脚本期间未被改写', preloadNow === preloadSrc);

  const failed = CHECKS.filter((c) => !c.ok);
  console.log('\n========== ' + (CHECKS.length - failed.length) + '/' + CHECKS.length + ' 通过 ==========');
  for (const f of failed) console.log('  ✗ ' + f.name);
  clearTimeout(watchdog);
  app.exit(failed.length ? 1 : 0);
});

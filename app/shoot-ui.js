/**
 * 界面验证：逐个页签截图。
 *
 * 主进程自带的 WRITETOOL_SHOT 只能截首屏，看不到侧栏的
 * 检索 / 状态编辑 / 伏笔新增——那些是这轮补的功能。
 * 所以这里用 executeJavaScript 驱动 React 切页签再截。
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

const OUT = path.join(__dirname, 'shots');
const PRODUCT = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];

/**
 * ⚠ 这个脚本必须自己注册 IPC。
 *
 * 第一版直接加载页面截图，结果所有元素都"not-found"——
 * 因为 App.jsx 开头是 `if (!config) return 加载中…`，
 * 而 `config:get` 没人应答，React 根本没渲染出界面。
 *
 * **截图全空白 ≠ 界面不存在。** 渲染进程起不来时，
 * 元素查询当然全部落空——要区分这两种情况。
 *
 * 这里注册最小桩：只够让 React 走完初始化，不碰真实数据。
 */
const ROOT = PRODUCT ? path.join(PRODUCT, 'resources', 'modules') : path.resolve(__dirname, '..');
const { Store } = require(path.join(ROOT, 'db', 'store.js'));
const { summarizeBible } = require(path.join(ROOT, 'memory', 'context-budget.js'));

/**
 * 用**真实用户库**而不是临时库——临时库是空的，界面全是空状态，
 * 截出来看不出新加的检索框、编辑按钮到底长什么样。
 */
const DB = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'writetool', 'writetool.db')
  : path.join(os.tmpdir(), 'writetool-shoot.db');
const dbStore = new Store(DB);
console.log('  数据源:', DB);
try {
  fs.mkdirSync(path.join(DB, '..'), { recursive: true });
} catch (_) { /* 已存在 */ }

const stub = (fn) => ipcMain.handle.bind(ipcMain);
/**
 * ⚠ 桩必须把 payload 透传给 fn。
 * 第一版写成 `async () => fn()`，参数直接丢掉，
 * bible:query 的 `{ query, entityType, topK }` 全解构成 undefined，
 * 于是「检索「夜枫」返回 0 条」——看起来像检索功能坏了，其实是桩没传参。
 */
const h = (ch, fn) => ipcMain.handle(ch, async (_evt, payload) => {
  try { return { ok: true, data: await fn(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

h('config:get', () => ({
  model: 'qwen3:latest', numCtx: 8192, temperature: 0.3, fontSize: 16,
  theme: 'light', ollamaBase: 'http://127.0.0.1:11434', currentProject: 'demo-verify',
}));
h('config:set', () => {});
h('ollama:check', () => ({ connected: true, version: '0.40.2' }));
h('project:list', () => dbStore.listProjects());
h('project:create', () => dbStore.listProjects());
h('project:open', () => ({}));
h('chapter:list', () => dbStore.listChapters('demo-verify'));
h('chapter:get', () => null);
h('chapter:create', () => ({}));
h('chapter:save', () => ({}));
h('chapter:delete', () => ({}));
h('settings:list', () => dbStore.loadSettings('demo-verify'));
h('settings:summary', () => summarizeBible(dbStore.loadSettings('demo-verify'), { maxChars: 1200 }));
h('settings:upsert', () => ({}));
h('settings:importBible', () => ({ canceled: true }));
h('bible:query', ({ query, entityType, topK }) => {
  const settings = dbStore.loadSettings('demo-verify');
  const q = String(query || '').toLowerCase();
  const scored = [];
  for (const s of settings) {
    if (entityType && s.type !== entityType) continue;
    const name = String(s.name || '').toLowerCase();
    const aliases = (s.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q) || q.includes(name)) score = 80;
    else if (aliases.some((a) => a === q)) score = 70;
    else if (String(s.note || '').toLowerCase().includes(q) && q.length >= 2) score = 40;
    if (score > 0) scored.push({ ...s, _score: score });
  }
  scored.sort((a, b) => b._score - a._score || a.name.length - b.name.length);
  const k = topK || 8;
  return { ok: true, count: scored.length, hits: scored.slice(0, k).map(({ _score, ...s }) => s) };
});
h('state:list', () => dbStore.listEntityStates('demo-verify'));
h('state:writeback', () => ({ updated: [], conflicts: [] }));
h('state:set', () => ({}));
h('thread:list', () => dbStore.listOpenThreads('demo-verify'));
h('thread:create', () => dbStore.listOpenThreads('demo-verify'));
h('thread:resolve', () => ({ ok: true }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节，风格基准只能来自你自己的历史正文' }));
h('style:check', () => ({ ok: false, error: '无画像' }));
h('app:info', () => ({ version: '0.1.0' }));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const distPath = PRODUCT
    ? path.join(PRODUCT, 'resources', 'app.asar', 'dist', 'index.html')
    : path.join(__dirname, 'dist', 'index.html');

  await win.loadFile(distPath);
  await new Promise((r) => setTimeout(r, 2500));   // 等 React 挂载

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, `${name}.png`);
    fs.writeFileSync(p, img.toPNG());
    console.log(`  ✓ ${name}.png  ${Math.round(fs.statSync(p).size / 1024)} KB`);
  };

  /**
   * 按可见文本点按钮。
   *
   * ⚠ 用 startsWith 而不是 === —— 页签上带计数（「设定 3」），
   * 精确匹配会 not-found，看起来像"功能不存在"，其实是选择器不对。
   */
  const clickByText = async (text) => win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || btns.find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return 'not-found: ' + btns.map(x=>x.textContent.trim()).join('|').slice(0,200);
      b.click();
      return 'clicked: ' + b.textContent.trim();
    })()
  `);

  // 选中「界面验证」项目
  const picked = await win.webContents.executeJavaScript(`
    (() => {
      const sel = document.querySelector('select');
      if (!sel) return 'no-select';
      const opt = [...sel.options].find(o => o.textContent.includes('界面验证'));
      if (!opt) return 'no-option: ' + [...sel.options].map(o=>o.textContent).join('|');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'picked:' + opt.value;
    })()
  `);
  console.log('  项目切换:', picked);
  await new Promise((r) => setTimeout(r, 1200));

  await shot('01-chapters');

  // 设定页：先看全量，再看检索
  console.log('  切页签「设定」:', await clickByText('设定'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('02-settings-list');

  // 打开新增设定表单
  console.log('  点「+ 新增设定」:', await clickByText('+ 新增设定'));
  await new Promise((r) => setTimeout(r, 400));
  await shot('03-settings-add');
  await clickByText('取消');
  await new Promise((r) => setTimeout(r, 300));

  // 检索：必须用**真实键盘输入**。
  // 程序化 setter + 合成 input 事件不会触发 React 的 onChange，
  // 组件状态一直是空串 → 检索返回 0 条。
  // 「截图显示没结果」和「检索功能坏了」是两回事，这里必须分清。
  console.log('  聚焦检索框:', await win.webContents.executeJavaScript(`
    (() => {
      const i = [...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('检索设定'));
      if (!i) return 'no-input';
      i.focus();
      return 'focused';
    })()
  `));
  // sendInputEvent 的 char 事件只支持单个 ASCII 字符，中文要靠 keyDown/keyUp。
  for (const ch of '夜枫') {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log('  输入后框内值:', await win.webContents.executeJavaScript(`
    (() => {
      const i = [...document.querySelectorAll('input')].find(x => x.placeholder && x.placeholder.includes('检索设定'));
      return i ? i.value : 'no-input';
    })()
  `));
  console.log('  点「检索」:', await clickByText('检索'));
  await new Promise((r) => setTimeout(r, 900));
  await shot('04-settings-search');

  // 状态页
  console.log('  切页签「状态」:', await clickByText('状态'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('05-state-list');

  console.log('  点「改」:', await clickByText('改'));
  await new Promise((r) => setTimeout(r, 400));
  await shot('06-state-edit');

  // 伏笔页
  await clickByText('取消');
  console.log('  切页签「伏笔」:', await clickByText('伏笔'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('07-threads-list');

  console.log('  点「+ 新增伏笔」:', await clickByText('+ 新增伏笔'));
  await new Promise((r) => setTimeout(r, 400));
  await shot('08-threads-add');

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
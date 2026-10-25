/**
 * 首次启动检查：把主进程的**初始化路径**真的跑一遍，然后调界面真正会调的通道。
 *
 * ## 为什么要有这个
 *
 * 2026-10-13 羽毛菌报：「新建对话项目都不行」。
 *
 * 查库发现根因：
 *   writetool.db 里 projects 表 **0 条**、config.currentProject = null。
 *   于是 App.jsx 的 projectId 恒为 null，而
 *
 *     const createConversation = useCallback(async (title) => {
 *       if (!projectId) return;        // ← 静默返回
 *       ...
 *
 *   点「＋ 新对话」**什么都不发生**，不报错、不提示。
 *
 * ## 既有测试为什么没抓到
 *
 *   - db/test-db.js 用 :memory: 库，自己先 createProject 再 createConversation，
 *     **从不测"零项目"这个初始状态**
 *   - test-main-boot.js 只跑加载期（whenReady 永不 resolve），
 *     建库、建文件夹、通道注册后的行为全都没进过
 *   - test-ipc-contract.js 检查 preload 与 main 的通道**名单**是否对得上，
 *     不检查通道被调用后会不会抛
 *
 * ## 做法
 *
 * 与 test-main-boot.js 同一套 electron 桩，区别有两点：
 *   1. whenReady **真的 resolve**，于是建库、建项目文件夹、
 *      seed 内置技能、建菜单、建窗口全都真跑一遍
 *   2. 把 ipcMain.handle 注册的**函数**存下来，之后直接调用它们——
 *      走的就是渲染进程点按钮时走的那条路
 *
 * 运行：node app/test-first-run.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-first-'));
const USER_DIR = path.join(TMP, 'userData');

/**
 * ⚠⚠ 必须**在装桩之前**用真实 electron 加 GPU 开关。
 *
 * 2026-10-13 踩到：这个文件把 BrowserWindow 整个桩掉了，于是渲染进程不会起，
 * 但 GPU 子进程照样会被 Electron 拉起来 —— 在这台机器上它崩掉之后
 * Electron 直接 FATAL 退出（gpu_data_manager_impl_private.cc: GPU process
 * isn't usable），后面所有用例一条都没跑，只剩一屏 GPU 报错。
 *
 * 为什么 main.js 里那几行不管用：下面 appStub 把
 * `commandLine.appendSwitch` 定义成了空函数，主进程调的是一个空函数，
 * 真进程的开关一个都没加上。要加就得绕过这个桩。
 *
 * 症状有迷惑性：上午同一份代码还能跑，下午就崩——
 * 它跟"机器有没有别的程序占着 GPU"有关，不是代码问题。
 */
{
  const realApp = require('electron').app;
  realApp.disableHardwareAcceleration();
  realApp.commandLine.appendSwitch('no-sandbox');
  realApp.commandLine.appendSwitch('disable-gpu');
  realApp.commandLine.appendSwitch('disable-software-rasterizer');
  realApp.commandLine.appendSwitch('in-process-gpu');
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function section(t) { console.log('\n' + t); }

/** 通道名 → 实现函数。界面点按钮走的就是这些。 */
const handlers = new Map();

const appStub = {
  isPackaged: false,
  getVersion: () => '1.0.0',
  getName: () => 'writetool',
  getPath: () => USER_DIR,
  getLocale: () => 'zh-CN',
  disableHardwareAcceleration: () => {},
  commandLine: { appendSwitch: () => {} },
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
};

const ipcMainStub = {
  handle: (ch, fn) => {
    if (handlers.has(ch)) throw new Error(`同一个通道注册了两次：${ch}`);
    handlers.set(ch, fn);
  },
  on: () => {},
  removeHandler: () => {},
};

/** 没显式桩掉的成员兜底成"什么都不做"的函数 */
function swallow(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toStringTag) return 'Stub';
      void name;
      return (...args) => { void args; return undefined; };
    },
  });
}

class BrowserWindowStub {
  constructor() {
    this.webContents = {
      on: () => {}, send: () => {}, openDevTools: () => {},
      setWindowOpenHandler: () => {}, once: () => {}, isDestroyed: () => false,
    };
  }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  maximize() {}
  show() {}
  hide() {}
  focus() {}
  isDestroyed() { return false; }
  isMinimized() { return false; }
  on() {}
  once() {}
  static getAllWindows() { return []; }
}

const menuStub = {
  buildFromTemplate: () => ({ popup: () => {}, items: [] }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
};

const safeStorageStub = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8'),
};

const dialogStub = {
  showMessageBox: async () => ({ response: 0 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
};

const shellStub = {
  openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {},
};

function installStubs() {
  const electronStub = new Proxy({}, {
    get(_, prop) {
      if (prop === 'app') return appStub;
      if (prop === 'ipcMain') return ipcMainStub;
      if (prop === 'BrowserWindow') return BrowserWindowStub;
      if (prop === 'safeStorage') return safeStorageStub;
      if (prop === 'Menu') return menuStub;
      if (prop === 'dialog') return dialogStub;
      if (prop === 'shell') return shellStub;
      return swallow('electron.' + String(prop));
    },
  });
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return origLoad.call(this, request, ...rest);
  };
  return () => { Module._load = origLoad; };
}

/**
 * 调一个通道，并把主进程包的那层 {ok,data} 拆掉。
 *
 * ⚠ 必须拆：`handle()` 把所有实现包成了
 *   `{ ok: true, data }` / `{ ok: false, error }`，
 *   不拆的话拿到的永远是那个信封，
 *   "列表里应该有 1 条，实际 undefined" 这种报错会把人带到错方向。
 *   （第一版就是这么写的，8 条里 5 条是被信封骗出来的假红。）
 */
async function call(ch, arg) {
  const fn = handlers.get(ch);
  assert.ok(fn, `通道 ${ch} 没有注册 —— 界面点下去就是「方法不存在」`);
  const r = await fn(undefined, arg);
  if (r && r.ok === false) throw new Error(r.error || '通道返回失败');
  return r ? r.data : undefined;
}

(async () => {
  /**
   * ⚠ 桩要**一直装着**，不能在 require 之后就摘掉。
   *
   * whenReady 的回调里还有 `require('electron')`（buildMenu 内部那行
   * `const { Menu, shell, dialog } = require('electron')`）——
   * 摘早了那边拿到的就是真 electron，在纯 node 下直接
   * 「Cannot read properties of undefined」。
   * 第一版就是这么挂的，而且报错位置在 main.js 里，
   * 看起来像是产品代码的问题。
   */
  installStubs();
  let loadErr = null;
  try {
    const entry = path.join(ROOT, 'app', 'electron', 'main.js');
    delete require.cache[entry];
    require(entry);
  } catch (e) {
    loadErr = e;
  }

  console.log('userData 临时目录：' + USER_DIR);

  section('一、初始化真的跑完了（不是只加载了模块）');
  await check('★ main.js 加载不抛错', () => {
    if (loadErr) throw loadErr;
  });
  // whenReady 是微任务链，让事件循环转几圈把建库那一段跑完
  await new Promise((r) => setTimeout(r, 500));
  await check('★ 数据库真的建出来了', () => {
    const db = path.join(USER_DIR, 'writetool.db');
    assert.ok(fs.existsSync(db), `没建库：${db}`);
  });
  await check('★ 注册的通道都有实现函数（≥ 60）', () => {
    assert.ok(handlers.size >= 60, `只注册了 ${handlers.size} 个通道`);
  });

  section('一、五、内置技能真的种进去了（2026-10-15 事故：注入口写错，被 catch 吞掉）');
  /**
   * ⚠⚠ 这一段是这次事故的判据，**必须走这条真实路径**。
   *
   * 现场：main.js 启动流程里写的是 `store.setSkillFormat(skillFormat)`，
   * 而 skillFormat 这个变量根本没声明、setSkillFormat 也只是 db/store.js 的
   * 模块级函数 —— 这一句 100% 抛异常，被外层 catch 吞成一行日志。
   * 结果**内置技能一次都没种进用户的库**：
   * 用户的技能列表停在几个月前那 6 条 legacy（无 frontmatter、进不了
   * skill:index、enabled 全是 0），1.0.6 重做的 6 条一条都没到过用户手上。
   *
   * 为什么当时全绿：所有技能相关的用例都**自己** require 了解析器、
   * 自己调种子函数 —— 从来没跑过 main.js 里那一行。
   * 判据不碰真东西，就永远发现不了。
   *
   * 所以这里只做一件事：boot 完之后去问**真实通道**库里有什么。
   */
  const NEW_IDS = ['sk-novel-writer', 'sk-novel-revisor', 'sk-novel-sync',
    'sk-novel-dialogue', 'sk-novel-polish', 'sk-skill-creator'];
  const LEGACY_IDS = ['sk-builtin-outline', 'sk-builtin-dialogue',
    'sk-builtin-rewrite', 'sk-builtin-check', 'sk-builtin-plan', 'sk-builtin-char'];

  await check('★ 六条新版内置技能都在库里', async () => {
    const list = await call('skill:list', { projectId: null });
    const ids = list.map((x) => x.id);
    const missing = NEW_IDS.filter((id) => !ids.includes(id));
    assert.strictEqual(missing.length, 0,
      `少了 ${missing.join('、')} —— 说明种内置技能那一步又没跑起来。`
      + `库里现在有：${ids.join('、') || '(空)'}`);
  });
  await check('★ 老的 6 条 legacy 已被退役（它们永远进不了索引）', async () => {
    const list = await call('skill:list', { projectId: null });
    const left = list.map((x) => x.id).filter((id) => LEGACY_IDS.includes(id));
    assert.strictEqual(left.length, 0, `这些僵尸条目还在：${left.join('、')}`);
  });
  await check('★ skill:index 里内置技能都在（"装了"≠"模型能用"）', async () => {
    // ⚠ 这才是真正的指标：skillIndex 唯一的硬过滤是「必须有 description」，
    //   没有 frontmatter 的技能会被它滤掉，模型永远看不见。
    //
    // ⚠⚠ **不要写死数量**。2026-10-16 内置技能从 6 条变 7 条，
    //   这条判据当场红成「7 !== 6」—— 而产品一点问题都没有。
    //   要验的是「清单里的每一条都在索引里」，不是「恰好 N 条」。
    const idx = await call('skill:index', { projectId: null });
    const inIdx = idx.map((x) => x.id);
    const lost = NEW_IDS.filter((id) => !inIdx.includes(id));
    assert.strictEqual(lost.length, 0,
      `这些内置技能不在索引里 —— 缺 description 的技能等于没装：${lost.join('、')}`
      + `。索引现有：${JSON.stringify(inIdx)}`);
    for (const x of idx) {
      assert.ok(x.description && x.description.length > 10,
        `${x.id} 的 description 太短，模型没法判断该不该用它`);
    }
  });
  await check('★ 内置技能默认是开着的', async () => {
    const list = await call('skill:list', { projectId: null });
    const off = list.filter((x) => NEW_IDS.includes(x.id) && !x.enabled).map((x) => x.id);
    assert.strictEqual(off.length, 0, `这些内置技能是关着的：${off.join('、')}`);
  });
  await check('★ 目录式技能的配套文件也落库了', async () => {
    const files = await call('skill:files', { id: 'sk-novel-writer' });
    const paths = files.map((f) => f.path);
    assert.ok(paths.some((p) => p === 'references/templates.md'),
      `配套文件没入库：${paths.join('、') || '(空)'}`);
  });
  await check('★ skill:import 走得通（原来必抛 skillFormat is not defined）', async () => {
    const r = await call('skill:import', {
      content: '---\nname: probe\ndescription: 一条用来验证解析器注入了的临时技能\n---\n正文\n',
    });
    assert.ok(r && r.ok, `导入校验没通过：${JSON.stringify(r)}`);
    assert.strictEqual(r.name, 'probe');
    assert.ok(/临时技能/.test(r.description), `description 没解析出来：${r.description}`);
  });

  section('二、零项目时的初始状态（这次事故的现场）');
  await check('★ 全新库里一个项目都没有', async () => {
    const projects = await call('project:list');
    assert.ok(Array.isArray(projects), 'project:list 没返回数组');
    assert.strictEqual(projects.length, 0, `期望 0 个，实际 ${projects.length}`);
  });

  section('三、新建项目这条路必须通');
  await check('★ project:create 成功建项目', async () => {
    const r = await call('project:create', { id: 'p-first', name: '首启测试' });
    assert.ok(r && Array.isArray(r.projects), `返回不正常：${JSON.stringify(r)}`);
    assert.strictEqual(r.projects.length, 1, '建完列表里应该有 1 个');
  });
  await check('★ 项目文件夹与初始模板真的落盘了', () => {
    const dir = path.join(USER_DIR, 'projects', 'p-first');
    assert.ok(fs.existsSync(dir), `文件夹没建：${dir}`);
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('设定'), '初始目录没建');
    // ⚠ 章节摘要.md 在 章节/ 里面（2026-10-16 从根挪进去的，见 project-fs.js）
    const chap = fs.readdirSync(path.join(dir, '章节'));
    assert.ok(chap.includes('章节摘要.md'), `章节/ 里没章节摘要：${chap.join(', ')}`);
    // ⚠ 世界观.md 在 设定/ 里面，不是根目录下（见 project-fs.js 的 TEMPLATE_FILES）。
    //   这条断言原来写的是 files.includes('世界观.md') —— 它**一直是红的**，
    //   因为根目录下本来就没有这个文件。判据写错了位置。
    const shezhi = fs.readdirSync(path.join(dir, '设定'));
    assert.ok(shezhi.includes('世界观.md'), `设定/ 里没世界观：${shezhi.join(', ')}`);
    assert.ok(shezhi.includes('人物库.md'), `设定/ 里没人物库：${shezhi.join(', ')}`);
  });

  section('四、新建对话这条路必须通');
  let conv = null;
  await check('★ 有项目时 conv:create 能建出对话', async () => {
    conv = await call('conv:create', { projectId: 'p-first', title: '新对话' });
    assert.ok(conv && conv.id, `没返回对话 id：${JSON.stringify(conv)}`);
  });
  await check('★ 建完能在列表里查到', async () => {
    const list = await call('conv:list', { projectId: 'p-first' });
    assert.strictEqual(list.length, 1, `列表里应该有 1 条，实际 ${list.length}`);
  });

  section('五、思考强度要能存在对话上（切对话要跟着变）');
  await check('★ conv:setThink 通道存在', () => {
    assert.ok(handlers.has('conv:setThink'),
      '没有 conv:setThink —— 档位只能存全局，切换对话不会跟着变');
  });
  await check('★ 设过的档位读得回来', async () => {
    await call('conv:setThink', { conversationId: conv.id, level: 'high' });
    const list = await call('conv:list', { projectId: 'p-first' });
    assert.strictEqual(list[0].thinkLevel, 'high',
      `列表里读回来是 ${list[0].thinkLevel}，期望 high`);
  });
  await check('★ 零项目时 conv:create 的报错要指得出路', async () => {
    // 通道层只是兜底：真正卡住用户的是界面那一层静默 return。
    // 但通道的文案不能是「先创建或选择一个项目」这种
    // —— 用户不知道去哪"创建或选择"。
    let msg = '';
    try {
      await call('conv:create', { projectId: null, title: 'x' });
    } catch (e) { msg = e.message; }
    assert.ok(msg, '零项目时居然没报错');
    assert.ok(/新建项目|第 ?4 栏|项目切换/.test(msg),
      `报错没告诉用户去哪建项目：「${msg}」`);
  });

  section('六、连接要有记忆：断开 ≠ 删除，断了就真断');
  await check('★ provider:disconnect 通道存在', () => {
    assert.ok(handlers.has('provider:disconnect'),
      '没有 provider:disconnect —— 用户想换服务商只能删连接，密钥跟着一起丢');
  });
  await check('★ 激活一条再断开，配置真的清了', async () => {
    const conns = await call('provider:listConnections');
    assert.ok(conns.length > 0, '一条连接都没有，跳过');
    const r = await call('provider:activate', { id: conns[0].id });
    assert.ok(r && r.ok, `激活失败：${JSON.stringify(r)}`);
    let after = (await call('config:get')).activeConnectionId;
    assert.strictEqual(after, conns[0].id, '激活后 activeConnectionId 没指向它');

    await call('provider:disconnect');
    after = (await call('config:get')).activeConnectionId;
    assert.ok(!after, `断开后 activeConnectionId 还是「${after}」`);
  });
  await check('★ 断开不删连接（地址和密钥都还在）', async () => {
    const conns = await call('provider:listConnections');
    assert.ok(conns.length > 0, '断开把连接也删了 —— 那不是断开，是删除');
    assert.ok(conns[0].base, '连接还在但地址没了');
  });
  await check('★ 没有在用的连接时 conv:send 说清原因', async () => {
    // ⚠ 这条锁的是「别让用户看到 ECONNREFUSED 127.0.0.1:11434」。
    //   断开后 activeConnectionId 是空的，providerConfig 会退回老字段的
    //   默认地址，于是报错变成一个和真实原因无关的网络错误。
    let msg = '';
    try {
      await call('conv:send', { conversationId: conv.id, text: '在吗' });
    } catch (e) { msg = e.message; }
    assert.ok(/还没有在用任何模型/.test(msg),
      `没给明路，错误是：「${msg}」`);
    assert.ok(!/ECONNREFUSED|127\.0\.0\.1/.test(msg),
      '还在报本地地址连不上 —— 那是 providerConfig 的兜底默认值，误导');
  });
  await check('★ 那条被拦下的消息没有落库', async () => {
    // 校验必须在 addMessage 之前：拦下来却留下一条没有回答的用户消息，
    // 用户会以为消息发出去了，只是模型没回。
    const msgs = await call('conv:messages', { conversationId: conv.id });
    assert.ok(Array.isArray(msgs), '读不到消息列表');
    assert.ok(!msgs.some((m) => m.content === '在吗'),
      '没发出去的消息也落库了 —— 对话里凭空多一条没人答的消息');
  });

  section('七、老字段不能盖过「当前连接」（2026-10-13 本地连不上）');
  await check('★ thinkStyle 是连接级属性，不能退回 config.thinkStyle', () => {
    // 现场：config.thinkStyle 停在 'openrouter'（上一条 OpenRouter 连接留下的），
    // 而当前连接是 Ollama。thinkStyleOf(Ollama) 返回空串，
    // 于是 `'' || 'openrouter'` → ollama 请求被打上了 openrouter 的思考形态。
    // engine='ollama' 时 buildThinkParams 根本不看 thinkStyle，
    // 于是**探测能过、生成时才炸**——用户看到的就是「连上了却发不出」。
    const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
    const seg = main.slice(main.indexOf('function providerConfig'));
    assert.ok(!/thinkStyleOf\(c\) \|\| config\.thinkStyle/.test(seg),
      'thinkStyle 还在退回 config.thinkStyle —— 上一条连接的脏值会盖住当前连接');
    assert.ok(/thinkStyle: c\s*\?/.test(seg),
      'thinkStyle 没有"有连接就以连接为准"的分支');
  });
  await check('★ 激活连接时同步老字段 engine/base/model', () => {
    // 不同步的后果：从云端切回本地，engine 变成 openai 而 base 还是本地地址，
    // 老通道（ollama:check、版本检查页）会拿这组自相矛盾的值去请求。
    const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
    const seg = main.slice(main.indexOf("handle('provider:activate'"));
    assert.ok(/engine: c\.protocol === 'openai'/.test(seg), 'activate 没同步 engine');
    assert.ok(/base: c\.base/.test(seg), 'activate 没同步 base');
  });
  await check('★ 激活时清掉 thinkStyle（它不是"当前值"而是"兜底值"）', () => {
    const main = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
    const seg = main.slice(main.indexOf("handle('provider:activate'"));
    assert.ok(/thinkStyle: ''/.test(seg),
      'thinkStyle 没被清掉 —— 留着上一条连接的形态，新连接会继承它');
  });
  await check('★ Ollama 连接在库里是可用的（协议/地址/模型齐）', async () => {
    // 这一条把"软件配置对不对"与"本地服务通不通"分开：
    // 服务通但软件连不上 → 配置问题；配置对但服务不通 → 环境问题。
    //
    // ⚠ 走通道拿，不要直接摸 store —— 这个文件作用域里没有 store
    //   （`store` 是 main.js 的模块级变量，不透出来），
    //   原来那句 `store.listConnections()` 一直是 ReferenceError。
    //   而且走通道才是界面真正走的那条路。
    const conns = await call('provider:listConnections');
    const ollama = conns.find((c) => c.protocol === 'ollama');
    if (!ollama) return;   // 用户库里没有本地连接，跳过
    assert.strictEqual(ollama.protocol, 'ollama', '协议不是 ollama');
    assert.ok(/^https?:\/\//.test(ollama.base || ''), `地址不对：${ollama.base}`);
    assert.ok(ollama.model, '没填模型名 —— 发请求必然失败');
    assert.strictEqual(ollama.needKey, false, '本地连接不该要密钥');
  });

  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `首启检查：${passed} 通过 / ${failures.length} 失败`
    : `首启检查：${passed} 通过`);
  process.exit(failures.length ? 1 : 0);
})();

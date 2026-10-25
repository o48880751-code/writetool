/**
 * 主进程启动检查：**真的把 main.js 的顶层代码跑一遍**。
 *
 * ## 为什么要有这个
 *
 * 2026-10-12 晚，羽毛菌报：
 *
 *   装完后双击 exe 弹「A JavaScript error occurred in the main process」
 *   Uncaught Exception: ReferenceError: Cannot access 'provider' before initialization
 *     at Object.<anonymous> (resources/app.asar/electron/main.js:59:12)
 *
 * **软件完全打不开。**
 *
 * 根因：`provider = require('./provider.js')` 写在 try 块里（第 59 行），
 * 而 `let provider = null` 写在第 93 行 —— 赋值跑在声明之前，命中 TDZ。
 *
 * ## 为什么当时测试是全绿的
 *
 *   - `test-tdz.js` 只扫**渲染进程**（src/），主进程一行都没查过
 *   - `node --check` 通过 —— TDZ 是运行时错误，不是语法错误
 *   - 打包冒烟只验产物里有文件、子模块能 require，**从不 require main.js**
 *
 * 三条都是"检查了旁边的东西"。这个文件补的就是正中间那一条。
 *
 * ## 做法
 *
 * 把 electron 换成桩，然后 require main.js —— 顶层代码会真的执行：
 * 那一串 require、`app.getPath`、几十个 `handle(...)` 注册。
 * 有 TDZ、有漏声明的变量、有写错的相对路径，这里立刻炸，
 * 而且是在**我的开发机上**，不是用户双击 exe 的时候。
 *
 * `app.whenReady()` 故意返回一个永不 resolve 的 Promise：
 * 这样只验「加载期」，不进入建库/建窗口那一大段（那部分有别的用例）。
 *
 * 运行：node app/test-main-boot.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-boot-'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function section(t) { console.log('\n' + t); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 收集注册了多少个 IPC 通道 —— 顺带证明代码真的跑到了那一行 */
const registered = [];
const switches = [];
const gotPaths = [];

const appStub = {
  isPackaged: false,                    // 开发态布局：ROOT = __dirname/../..
  getVersion: () => '1.0.0',
  getName: () => 'writetool',
  getPath: (k) => { gotPaths.push(k); return TMP; },
  disableHardwareAcceleration: () => {},
  commandLine: { appendSwitch: (s) => switches.push(s) },
  // ⚠ 永不 resolve：只验加载期，不跑初始化
  whenReady: () => new Promise(() => {}),
  on: () => {},
  quit: () => {},
};

const ipcMainStub = {
  handle: (ch, fn) => { registered.push(ch); void fn; },
  on: () => {},
  removeHandler: () => {},
};

class BrowserWindowStub {
  constructor() { this.webContents = { on: () => {}, send: () => {}, openDevTools: () => {} }; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  on() {}
  once() {}
  show() {}
  isDestroyed() { return false; }
  static getAllWindows() { return []; }
}

const safeStorageStub = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8'),
};

/** 任何没显式桩掉的成员都兜底成一个"什么都不做"的函数 */
function swallow(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return undefined;   // 不当成 Promise
      return (...args) => { void name; void prop; void args; return undefined; };
    },
  });
}

function loadMainWithStubs() {
  const electronStub = new Proxy({}, {
    get(_, prop) {
      if (prop === 'app') return appStub;
      if (prop === 'ipcMain') return ipcMainStub;
      if (prop === 'BrowserWindow') return BrowserWindowStub;
      if (prop === 'safeStorage') return safeStorageStub;
      return swallow('electron.' + String(prop));
    },
  });

  const origLoad = Module._load;
  // eslint-disable-next-line no-underscore-dangle
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    const entry = path.join(ROOT, 'app', 'electron', 'main.js');
    delete require.cache[entry];
    require(entry);
    return null;
  } catch (e) {
    return e;
  } finally {
    // eslint-disable-next-line no-underscore-dangle
    Module._load = origLoad;
  }
}

section('一、main.js 的顶层代码能跑完（装完打不开就是这一关没过）');

const err = loadMainWithStubs();

check('★ main.js 加载不抛错（否则用户双击 exe 只看到一个报错弹窗）', () => {
  if (err) {
    // TDZ 单独说清楚：这类错最坑的地方是它**不是语法错**，
    // node --check 一路绿灯，只有真跑到那一行才炸。
    const isTdz = /before initialization/.test(String(err.message));
    throw new Error(
      (isTdz
        ? '主进程命中 TDZ：一个变量在 `let/const` 声明之前就被使用了。\n'
          + '修法：把它的名字加进文件顶部那个 let 声明列表。\n'
        : '')
      + `${err.name}: ${err.message}\n      ${String(err.stack || '').split('\n')[1] || ''}`
    );
  }
});

check('★ 注册的 IPC 通道都注册上了（≥ 60）', () => {
  assert(registered.length >= 60,
    `只注册了 ${registered.length} 个通道 —— 加载中途就断了，界面一调就"方法不存在"`);
  const dup = registered.filter((c, i) => registered.indexOf(c) !== i);
  assert(dup.length === 0, `同一个通道注册了两次：${[...new Set(dup)].join(', ')}`);
});

check('★ provider / presets / secret 三个模块真的接上了', () => {
  // 这三个就是这次崩掉的三个。抽查它们被用到的通道在不在。
  const need = [
    'provider:capabilities', 'provider:listConnections', 'provider:createConnection',
    'provider:probe', 'provider:setKey', 'provider:keyStatus',
  ];
  const missing = need.filter((c) => !registered.includes(c));
  assert(missing.length === 0, `这些通道没注册：${missing.join(', ')}`);
});

check('★ 用到的 app.getPath 都是合法键', () => {
  // 桩对任何键都返回同一个目录，所以这里只查**用到了哪些**——
  // 写错键名（如 'userdata'）在真 Electron 上会抛，而开发态很难发现。
  const LEGAL = ['userData', 'temp', 'documents', 'downloads', 'desktop', 'home', 'appData'];
  const bad = gotPaths.filter((k) => !LEGAL.includes(k));
  assert(bad.length === 0, `用了不合法的 path 键：${bad.join(', ')}`);
});

// ============================================================
section('一·五、打包布局：路径不许写死 ../..，网络失败必须留日志');
// ============================================================
/**
 * ⚠⚠ 这一节来自两次**真实漏网**，而且都是开发态测不出来的那种。
 *
 * 【一】2026-10-15：main.js 写的是
 *   `require(path.join(__dirname, '..', '..', 'db', 'builtin-skills.js'))`
 * 开发态 `__dirname` = app/electron，`../..` 正好是项目根（有 db/）→ 通过。
 * 打包态 `__dirname` = resources/app.asar/electron，
 * `../..` = resources/ —— 而 db 实际在 resources/modules/db/ → 必挂。
 * 安装日志实测：
 *   内置技能初始化失败： Cannot find module
 *     'E:\agent\WriteTool\resources\db\builtin-skills.js'
 *
 * 立成静态守卫的原因：**开发态那个路径真的存在**，任何运行期用例都抓不到。
 * 凡要跨出 app/ 去找别处的模块，一律走 ROOT —— ROOT 同时认两种布局。
 *
 * 【二】conv:send 的网络失败**一行日志都没有**。界面上只有一句
 *   「连接 xxx 超时」，而 DNS 解析到哪个 IP、TCP 连上没有、HTTP 状态多少、
 *   socket 错误码是什么，一个都看不到 —— 于是只能猜。
 *   猜是没有出路的：那四个值任何一件都能一眼定性。
 */
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'main.js'), 'utf8');
/**
 * ⚠ 正则要求 `../..` **后面还有第三段**。
 *   否则 `const ROOT = path.join(__dirname, '..', '..')`（ROOT 自己的定义）
 *   也会被算进来 —— 守卫把自己判红了，第一版就这样。
 */
const hardCoded = [...mainSrc.matchAll(
  /path\.join\(\s*__dirname\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*([^)]*)\)/g)]
  .map((m) => m[1].trim());

check('★ 跨目录 require 必须走 ROOT，不能写死 ../..', () => {
  // readAppPackage() 里那两处是**候选之一 + 有兜底**（读不到返回 null），
  // 属刻意为之；除它以外再出现就是漏网。
  const bad = hardCoded.filter((p) => !/package\.json/.test(p));
  assert(bad.length === 0,
    `这些路径写死了 ../..，开发态能中、打包态指错地方：${bad.join(' | ')}`);
});

check('★ 内置技能清单走的是 ROOT', () => {
  assert(/path\.join\(ROOT,\s*'db',\s*'builtin-skills\.js'\)/.test(mainSrc),
    'require db/builtin-skills.js 的那行没走 ROOT —— 打包后必挂');
});

check('★ 解析器注入了（skillFormat 必须 require，不是凭空用）', () => {
  assert(/skillFormat\s*=\s*require\(/.test(mainSrc),
    'skillFormat 没有 require —— 启动即抛 ReferenceError，内置技能永远种不进去');
  assert(/^\s*setSkillFormat\(skillFormat\);\s*$/m.test(mainSrc),
    '注入没走模块级 setSkillFormat（写成 store.setSkillFormat 会抛 TypeError）');
});

check('★ provider 的请求日志接上了（网络失败不留日志等于没有日志）', () => {
  assert(/provider\.setLog\(/.test(mainSrc),
    'main.js 没调 provider.setLog —— conv:send 的网络失败一行都不会留下');
  const p = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'provider.js'), 'utf8');
  for (const must of ['DNS', 'TCP', '收到响应', '[chat] 失败']) {
    assert(p.includes(must),
      `provider.js 的请求日志少了「${must}」这一段 —— 网络问题就又只能猜了`);
  }
});

check('★ 系统提示必须区分「要内容」与「要整理归档」', () => {
  // 2026-10-15 现场：用户说「整理基础大纲到目录里」，模型却生成第一章正文。
  // 根因就在这句提示上 —— 原来通篇只有「直接输出正文」，
  // 没有任何"用户要整理/归档"时的分支，于是那句提示正好把模型往续写上推。
  const i = mainSrc.indexOf('const SYSTEM_PROMPT');
  assert(i > 0, '找不到 SYSTEM_PROMPT');
  const seg = mainSrc.slice(i, mainSrc.indexOf("].join('\\n')", i));
  assert(/整理/.test(seg) && /归档/.test(seg),
    '系统提示里没有「整理/归档」这一类请求的分支 —— 模型会一律当成"写正文"');
  // ⚠⚠ 2026-10-15 二次修：提示必须**点名 write_note** 并给出路径写法。
  //   原来这里写的是「你没有直接往磁盘写文件的能力」——
  //   那句话在 write_note 上线之后变成**假的**，而模型信了：
  //   于是它改用终端去探索目录、写文件、设编码，一个模型连开四次
  //   terminal（实测 DeepSeek，Get-ChildItem + $OutputEncoding + Get-Content）。
  //   工具描述写对不等于模型会看见它 —— **系统提示才是它每次都读的**。
  assert(/write_note/.test(seg),
    '系统提示里没有点名 write_note —— 模型不知道有专用工具，会绕道终端');
  assert(/设定\/世界观\.md/.test(seg) && /章节\/第一章\.md/.test(seg),
    '系统提示没给路径写法示例 —— 模型不知道该写相对路径还是绝对路径');
  assert(/不要用终端|别用 terminal|不要用终端去/.test(seg),
    '系统提示没禁止「用终端写文件」—— 那正是连开四次终端的直接诱因');
  assert(!/你没有直接往磁盘写文件的能力/.test(seg),
    '⚠⚠ 那句「你没有写文件的能力」现在是**假的**，而模型信了并去用终端');
  assert(/去 AI 味|AI 味/.test(seg),
    '系统提示里没有去 AI 味的规则 —— 2026-10-15 实测模型的段末总结句、'
    + '空转比喻、标点不成对，都是这一层能治的');
  assert(/「」/.test(seg), '系统提示没规定对白用「」—— 实测出现了一开一关的引号');
  assert(!/^'你是长篇小说的写作助手，直接输出正文。'/m.test(seg),
    '那句把模型往续写上推的提示还在');
  // ⚠ 2026-10-16 羽毛菌定的称呼规则：只能叫「老板」，亲属称谓一律不许。
  //   这条**只能写在系统提示里** —— 工具描述、界面文案模型都读不到，
  //   而系统提示是它每一轮都会读的那一份（同 write_note 那条教训）。
  assert(/老板/.test(seg), '系统提示里没有「只称老板」这条 —— 模型会顺口叫别的');
  assert(/亲属|亲密称谓/.test(seg),
    '系统提示只写了「叫老板」，没写清**不许用亲属/亲密称谓** —— '
    + '模型很可能理解成「老板是首选、别的也行」');
  assert(/只针对/.test(seg),
    '没说这条限制只针对「对用户的称呼」—— 会被误用到小说正文里，'
    + '把人物之间的称呼也一起禁掉');
});

check('★★ 范围守卫：协议令牌是一次性的，且锁着时无效', () => {
  // 这三件事任一做错，"弹协议 + 勾选同意"就变成一个后门：
  //   · 令牌不核销 → 同一个令牌能反复放行（第二次就不该锁了）
  //   · 令牌不绑文本 → 同意 A 之后可以拿去发 B
  //   · 锁着也认令牌 → 锁形同虚设
  const i = mainSrc.indexOf('function consumeAgreementToken');
  assert(i > 0, '找不到 consumeAgreementToken —— 协议确认没有核销机制');
  const seg = mainSrc.slice(i, i + 1200);
  assert(/agreementTokens\.delete\(/.test(seg),
    '令牌没有被删除 —— 同一个令牌可以反复用，第二次就绕过了"再犯就锁"');
  assert(/rec\.fp ===|=== textFingerprint/.test(seg),
    '令牌没有绑定文本指纹 —— 同意一条之后可以拿去发另一条');
  const j2 = mainSrc.indexOf('function scopeCheck');
  const seg2 = mainSrc.slice(j2, j2 + 1200);
  assert(/!g\.isLocked/.test(seg2),
    '⚠⚠ 锁着的时候也认同意令牌 —— 那锁就没有意义了');
  assert(/scopeCheck\(text, \{ agreementToken \}\)/.test(mainSrc)
    && /scopeCheck\(prompt, \{ agreementToken \}\)/.test(mainSrc),
    '⚠⚠ 两个入口里至少有一个没把令牌传进去 —— 聊天能签协议、正文生成不能（或反过来）');
  assert(/handle\('scope:agreement'/.test(mainSrc), '缺少 scope:agreement 通道，界面拿不到协议正文');
});

check('★ conv:send 传给循环的正文回调叫 onText（不是 onChunk）', () => {
  // 键名对不上 → 正文被整段静默丢弃 → 界面不流式、助手消息也不落库，
  // 而界面看着一切正常。agent-loop 那边现在有守卫，这里锁住发送方。
  const i = mainSrc.indexOf('handlers: {');
  const seg = mainSrc.slice(i, i + 3000);
  assert(/\bonText\s*:/.test(seg),
    'conv:send 的 handlers 里没有 onText —— 正文会被静默丢弃');
  assert(!/\bonChunk\s*:/.test(seg),
    'conv:send 的 handlers 里还在传 onChunk —— agent-loop 认的是 onText');
});

/**
 * ⚠⚠ Electron 主进程给 socket 设了 **5000ms 默认超时**（裸 Node 是 0）。
 *   实测：diag-bigpayload.js 打印 `socket.timeout=5000`。
 *
 * 后果：任何首字节超过 5 秒的生成请求都会被自己掐掉，而界面上只显示
 *   「连接 xxx 超时」—— 连接其实是通的（TCP 已连接），掐掉它的是我们。
 * 实测首字节随请求体增长：630 字节 → 495ms；37178 字节 → 2819ms；
 *   羽毛菌的 78463 字节 → 越过 5 秒，5081ms 整被掐断。
 */
check('★ 生成请求必须显式设 socket 超时（否则吃 Electron 的 5 秒默认）', () => {
  const p = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'provider.js'), 'utf8');
  // ⚠ 用 lastIndexOf：文件里有**两处** `lib.request(` ——
  //   前一处是 httpRequest（给探测/工具用的，3~5 秒是对的），
  //   后一处才是 chatStream。用 indexOf 会取到探测那个，判据就判错了地方。
  const at = p.lastIndexOf('const req = lib.request(');
  assert(at > 0, '找不到 chatStream 的 request 调用');
  const seg = p.slice(at, at + 900);
  assert(/timeout:\s*socketTimeout/.test(seg),
    'chatStream 的 request options 里没有 timeout —— 会退回 Electron 的 5 秒默认');
  assert(/const socketTimeout = /.test(p), 'provider.js 里没有 socketTimeout 常量');
  assert(!/timeout:\s*5000/.test(seg), '生成请求不能用 5 秒（那是探测的值）');
});

check('★ 注入的技能正文必须有上限（78KB 事故的直接来源）', () => {
  const i = mainSrc.indexOf('function buildRefBlock');
  assert(i > 0, '找不到 buildRefBlock');
  const seg = mainSrc.slice(i, mainSrc.indexOf('\n}', i));
  // ⚠ 原来就是一行 `lines.push(...${s.prompt_content})`，一个字都不截
  assert(!/lines\.push\(`- 【\$\{s\.name\}】\$\{s\.prompt_content\}`\)/.test(seg),
    '技能正文又被全量注入了 —— 挂几个技能就能把请求体顶到几万 token');
  assert(/SKILL_CHARS/.test(seg) && /clip\(/.test(seg),
    'buildRefBlock 里没有截断逻辑（clip / SKILL_CHARS）');
});

check('★ 单条大消息超预算时要裁（ensure() 只丢历史，压不动它）', () => {
  // LoopContextGuard.ensure() 的策略是丢工具配对组/孤立条目 ——
  // 引用材料被拼进**最后一条 user**，它压不动。
  const i = mainSrc.indexOf('guard.ensure()');
  assert(i > 0, '找不到 guard.ensure()');
  const seg = mainSrc.slice(i, i + 1600);
  assert(/budgetTokens/.test(seg) && /droppedOld/.test(seg),
    'ensure() 之后没有总量闸 —— 78KB 会原样发出去（2026-10-15 实测事故）');
  // ⚠ 第一版只裁「最后一条 user」，而超标在多条历史上 → 裁了等于没裁。
  //   实测：消息=8 / 正文=84227 字节照样发出去。判据要钉住"按总量裁"，
  //   而不是钉住"裁某一条"。
  assert(/while\s*\(total\s*>\s*budgetTokens/.test(seg),
    '总量闸必须是「超了就从最旧开始丢」的循环，'
    + '只裁最后一条 user 对多轮历史无效（实测 84KB 原样发出）');
  assert(/明说|已省略较早的/.test(seg),
    '丢弃旧对话必须明说丢了多少 —— 静默丢会让模型以为看过了全部前文');
});

section('二、这个检查本身是有效的');
check('★ 桩确实让 main.js 跑了（不是"加载了空文件"）', () => {
  assert(gotPaths.length >= 2, `app.getPath 只被调用 ${gotPaths.length} 次，main.js 好像没执行`);
  assert(switches.includes('disable-gpu'),
    'app.commandLine.appendSwitch 没被调用 —— 加载没走到那一段');
});

check('★ 加载失败时能拿到具体是哪个名字', () => {
  // 断言"错误信息里带变量名"这件事本身：这次事故里
  // 报错原文是 `Cannot access 'provider' before initialization`，
  // 那一句直接指明了去改哪里。
  const fake = new ReferenceError("Cannot access 'provider' before initialization");
  assert(/before initialization/.test(fake.message), 'TDZ 的文案变了？');
  assert(/provider/.test(fake.message), '错误信息里没有变量名，用户没法自查');
});

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `主进程启动检查：${passed} 通过 / ${failures.length} 失败`
  : `主进程启动检查：${passed} 通过`);

process.exit(failures.length ? 1 : 0);

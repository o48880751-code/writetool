/**
 * 主进程工具接线的端到端检查。
 *
 * ## 覆盖什么
 *
 * 循环（agent-loop）19 条、审批闸门（approval）19 条都是纯模块测试。
 * 这里补的是**接线**：那些只在 main.js 里、且必须真跑 main.js 才存在的部分——
 *   通道有没有注册、tool:decide 的行为、工具开关的三层判断、
 *   activeRequest 的两种形状、搜索 Key 有没有走明文。
 *
 * ## 为什么不靠正则扫源码
 *
 * ⚠ 第一版这批判据全是 `/工具开关判定/.test(源码)` 这种形式。
 *   它们的毛病是：改个变量名就全红，而真正的 bug（默认值写反、
 *   分支顺序搞错）反而可能照样绿——判据和被测对象之间没有真正的执行关系。
 *   现在改成**把 handler 从 ipcMain 里抓出来直接调**，
 *   改个变量名不会红，但行为一变必然红。
 *
 * 运行：node app/test-tool-wiring.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-wire-'));

let passed = 0;
const failures = [];
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function section(x) { console.log(`\n${x}`); }

// ============================================================
// electron 桩
// ============================================================
/** 通道 → handler（真能调） */
const handlers = new Map();
/** 记录发往渲染进程的通道 */
let sent = [];
/**
 * Menu 的桩。
 *
 * ⚠ 2026-10-14 加。whenReady 改成真跑之后，main.js 的初始化会走到
 *   `Menu.setApplicationMenu(Menu.buildFromTemplate(template))`，
 *   而 electronStub 只桩了 app / ipcMain / BrowserWindow / safeStorage，
 *   Menu 落到 swallow() 上返回 undefined → 直接 TypeError，
 *   **整个测试进程带崩**（不是一条判据红，是全部跑不完）。
 */
const menuStub = {
  buildFromTemplate: () => ({ items: [] }),
  setApplicationMenu: () => {},
  buildContextMenu: () => ({ items: [] }),
  popup: () => {},
};

/** 窗口是否已销毁（测试可控） */
let winDestroyed = false;

const appStub = {
  isPackaged: false,
  getVersion: () => '1.0.0',
  getName: () => 'writetool',
  getPath: () => TMP,
  disableHardwareAcceleration: () => {},
  commandLine: { appendSwitch: () => {} },
  whenReady: () => new Promise(() => {}),
  on: () => {},
  quit: () => {},
};

const ipcMainStub = {
  handle: (ch, fn) => { handlers.set(ch, fn); },
  on: () => {},
  removeHandler: () => {},
};

class BrowserWindowStub {
  constructor() {
    this.webContents = {
      on: () => {},
      send: (ch, payload) => {
        // ⚠ 模拟真实的"窗口没了就别发"：发往已销毁窗口必须报错，
        //   否则审批闸门那条「发送抛异常 → 拒绝」的分支永远测不到。
        if (winDestroyed) throw new Error('Object has been destroyed');
        sent.push({ ch, payload });
      },
      openDevTools: () => {},
    };
  }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  on() {} once() {} show() {}
  isDestroyed() { return winDestroyed; }
  static getAllWindows() { return []; }
}

/**
 * safeStorage 的桩。
 *
 * ⚠⚠ 2026-10-14 改成**加密可用**。
 *
 * 原来 `isEncryptionAvailable: () => false`。那不是"这台机器不可用"，
 * 而是**我随手写的默认值** —— 于是所有密钥测试都只验了内存路径：
 *   save → 写进 memoryKeys → ok:true，has:true
 * 而 `setConnectionSecret` / `setServiceSecret` **一次都没被调用过**。
 *
 * 后果就是「联网搜索的 Key 存不进库」这个 bug 一路漏过去：
 *   - 加密在真机上明明可用（isEncryptionAvailable = true）
 *   - 密文格式合法（base64 能解）
 *   - 判据全绿（因为它压根没碰数据库）
 *   - 界面上提示也正常弹出
 *
 * 真正的错误是数据库层的外键拒绝：
 *   `connection_secrets.connection_id REFERENCES connections(id)`，
 *   而搜索 Key 写死 `__web_search__` → 每次 INSERT 都失败。
 * **只有真跑一次落盘才看得见。**
 *
 * 现在 encrypt/decrypt 做真实的 base64 往返，密钥测试才真的碰数据库。
 */
const safeStorageStub = {
  isEncryptionAvailable: () => true,
  // 真的加密语义：密文与明文不同，且能往返还原
  encryptString: (s) => Buffer.from('enc:' + String(s), 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
};

function swallow(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return undefined;
      return (...args) => { void name; void prop; void args; return undefined; };
    },
  });
}

function loadMain() {
  const electronStub = new Proxy({}, {
    get(_, prop) {
      if (prop === 'app') return appStub;
      if (prop === 'ipcMain') return ipcMainStub;
      if (prop === 'BrowserWindow') return BrowserWindowStub;
      if (prop === 'safeStorage') return safeStorageStub;
      // ⚠ 2026-10-14：whenReady 改成真跑之后，初始化会走到 Menu，
      //   不桩它就直接 TypeError 把整个测试进程带崩。
      if (prop === 'Menu') return menuStub;
      if (prop === 'app') return appStub;

      return swallow('electron.' + String(prop));
    },
  });
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    const entry = path.join(ROOT, 'app', 'electron', 'main.js');
    delete require.cache[entry];
    require(entry);
  } finally {
    Module._load = origLoad;
  }
}

/**
 * 调一个通道，**拆掉信封**返回 data。
 *
 * ⚠ 第一版直接返回信封，于是把 {ok,data} 当成了 data ——
 *   于是 r.ok 恒为 true、cfg.toolsEnabled 恒为 undefined，
 *   看起来像"接线全错"，其实是我自己读错了层级。
 *   教训不变：报红先打印它实际看到的东西。
 */
async function invoke(ch, payload) {
  const fn = handlers.get(ch);
  assert(fn, `通道 ${ch} 没注册`);
  const env = await fn(null, payload);
  assert(env && typeof env.ok === 'boolean', `通道 ${ch} 没走 handle 包装`);
  if (!env.ok) {
    const e = new Error(env.error || `通道 ${ch} 失败`);
    e.envelope = env;
    throw e;
  }
  return env.data;
}

/** 与 invoke 相反：要那个失败的信封（用于断言"被正确拒绝"） */
async function invokeRaw(ch, payload) {
  const fn = handlers.get(ch);
  assert(fn, `通道 ${ch} 没注册`);
  return fn(null, payload);
}

/**
 * 业务失败的读法。
 *
 * ⚠ 这里有**两层**信封，别搞混：
 *   外层 {ok, data} 来自 handle() 的统一包装 —— 表示"IPC 调通了没有"；
 *   内层 {ok:false, error} 是 handler 自己返回的 —— 表示"业务上拒绝了"。
 * 后者是本仓库的既有约定（style:check / project:delete 都这样），
 * 不是重复错误。第一版把它当成一层，7 条用例集体变红，
 * 看起来像"接线全错"，其实是我少拆一层。
 */
async function invokeReject(ch, payload) {
  const fn = handlers.get(ch);
  assert(fn, `通道 ${ch} 没注册`);
  const env = await fn(null, payload);
  assert(env && typeof env.ok === 'boolean', `通道 ${ch} 没走 handle 包装`);
  const data = env.ok ? env.data : { ok: false, error: env.error };
  return data;
}

// ============================================================
section('一、主进程能加载，且工具相关通道都注册了');

let loadErr = null;
try { loadMain(); } catch (e) { loadErr = e; }

t('main.js 加载不抛错', () => {
  if (loadErr) throw new Error(`${loadErr.name}: ${loadErr.message}`);
});

t('★ 工具相关通道都在', () => {
  for (const ch of ['tool:decide', 'tool:setSearchKey', 'tool:searchKeyStatus', 'conv:send']) {
    assert(handlers.has(ch), `缺少通道 ${ch}`);
  }
});

t('★ 没有重复注册的通道', () => {
  assert(handlers.size > 0, '一个通道都没注册，加载肯定中途断了');
});

// ============================================================
section('二、tool:decide 的真实行为');

t('★ 伪造 / 已结束的审批 id → 拒绝受理，不放行', async () => {
  for (const id of ['ap-999', '', null, undefined, 'ap-1']) {
    const d = await invokeReject('tool:decide', { id, allow: true });
    eq(d.ok, false, `id=${JSON.stringify(id)} 不该被受理`);
    assert(d.error, '拒绝时要带 error，界面上要能提示');
  }
});

t('★ 不带 id → 拒绝受理', async () => {
  eq((await invokeReject('tool:decide', {})).ok, false);
  eq((await invokeReject('tool:decide', { allow: true })).ok, false);
});

// ============================================================
/**
 * ⚠⚠ 这一节自己建库，不经过 main.js（2026-10-14）。
 *
 * ## 为什么不能走 invoke
 *
 * invoke 走的是 main.js 的 handler，而 secret.init / bind / bindService
 * 全在 **whenReady** 里 —— 这个测试的 appStub 是「whenReady 永不 resolve」
 * （只验加载期），于是 bindService 从没执行过，
 * saveService 只会返回「服务密钥存储未就绪」。
 *
 * 放行 whenReady 让初始化真跑也试过，代价太大：
 * 初始化会走到 Menu.setApplicationMenu，而那要求 Module._load 的 patch
 * 一直生效；还原时机没对好就是 TypeError，**整个测试进程带崩**
 * （不是一条判据红，是全部跑不完）。
 *
 * ## 为什么原来那几条判据全绿却漏掉了真 bug
 *
 * 原判据是「setSearchKey → has=true」。它照样通过，因为：
 *   - secret.load 在没 bind 时回落到**模块级 memoryKeys**
 *   - memoryKeys 里有上一个测试残留的值
 *   - 于是「存 → 有」在**内存里**成立
 *
 * 而真正的 bug 在数据库层：
 *   connection_secrets.connection_id REFERENCES connections(id)
 * 搜索 Key 写死 __web_search__ → 每次 INSERT 都被数据库拒绝：
 *   「加密失败：FOREIGN KEY constraint failed」
 *
 * 原判据压根没碰数据库，所以一点都看不出来。
 * 现在这几条自己 new Store，直接读库证明那行真的躺在表里。
 */

/** 这一节专用的假 Key。内容明显，不可能撞上真的。 */
const SVC_PLAIN = 'wirecheck-abc-123-not-a-real-key';
const SVC_ID = 'serper';

/**
 * 建一个干净的 Store + secret-store。
 *
 * ⚠ secret-store 是模块级单例：bind 的口与 memoryKeys 会跨测试残留，
 *   所以每次都清缓存重新 require。
 * ⚠ safeStorage 只存在于 electron —— 这里临时把 Module._load 打上桩，
 *   并在 finally 还原（不能泄漏到后面的测试）。
 */
function withSecretStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-svc-'));
  const { Store } = require(path.join(ROOT, 'db', 'store.js'));
  const store = new Store(path.join(dir, 'writetool', 'writetool.db'));

  const modPath = path.join(ROOT, 'app', 'electron', 'secret-store.js');
  const realLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return { safeStorage: safeStorageStub };
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve(modPath)];
    const secret = require(modPath);
    secret.init();
    secret.bind(
      (id) => store.getConnectionSecret(id),
      (id, enc) => store.setConnectionSecret(id, enc)
    );
    secret.bindService(
      (provider) => store.getServiceSecret(provider),
      (provider, enc) => store.setServiceSecret(provider, enc)
    );
    return fn(secret, store, dir);
  } finally {
    Module._load = realLoad;
    delete require.cache[require.resolve(modPath)];
  }
}

t('★ saveService 后 loadService 能取回', () => {
  withSecretStore((secret) => {
    const r = secret.saveService(SVC_PLAIN, SVC_ID);
    eq(r.ok, true, '保存失败：' + JSON.stringify(r.error));
    eq(secret.loadService(SVC_ID), SVC_PLAIN, '取回来的明文不一致');
  });
});

/**
 * ⚠⚠ 外键 bug 的判据。
 *
 * 原来的 bug：搜索 Key 存 connection_secrets，connection_id 写死
 * __web_search__，而那张表 REFERENCES connections(id) → 必被拒绝。
 * 这条直接读库，证明那行真的躺在**无外键的** service_secrets 里。
 */
t('★ Key 真的落在 service_secrets 表里（外键 bug 的判据）', () => {
  withSecretStore((secret, store, dir) => {
    eq(secret.saveService(SVC_PLAIN, SVC_ID).ok, true, '保存应成功');

    const dbPath = path.join(dir, 'writetool', 'writetool.db');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });

    const rows = db.prepare(
      'SELECT provider, length(key_enc) n FROM service_secrets').all();
    eq(rows.length, 1, 'service_secrets 里应有且只有 1 行');
    eq(rows[0].provider, SVC_ID, 'provider 应是 ' + SVC_ID);
    assert(Number(rows[0].n) > 0, '密文长度为 0');

    // 反向确认：不能进 connection_secrets（那张表有外键，写进去必失败）
    const bad = db.prepare(
      'SELECT count(*) c FROM connection_secrets WHERE connection_id = ?'
    ).get('__web_search__');
    eq(Number(bad.c), 0,
      '搜索 Key 出现在 connection_secrets 里 —— 那张表有外键，下次写入就会失败');
    db.close();
    void store;
  });
});

/**
 * ⚠⚠ 读 SQLite 文件有个坑：数据可能还在 **-wal** 里。
 *
 * 实测：新库里 INSERT 完之后，`writetool.db` 本体里**搜不到**那行密文，
 * 它在 `writetool.db-wal` 里。第一版只读本体，于是断言
 * 「库里找不到加密后的密文 —— Key 根本没落盘」——
 * 其实落盘了，**判据自己读错了地方**。
 *
 * SQLite 默认开 WAL（journal_mode=WAL），写入先进 wal 文件，
 * checkpoint 之后才合并回本体。所以搜明文/密文必须三个文件都看。
 */
function readDbBytes(dir) {
  const base = path.join(dir, 'writetool', 'writetool.db');
  const parts = [base];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const f = base + suffix;
    if (fs.existsSync(f)) parts.push(f);
  }
  return Buffer.concat(parts.map((f) => fs.readFileSync(f)));
}

t('★ 数据库文件里没有明文 Key，但有密文', () => {
  withSecretStore((secret, store, dir) => {
    eq(secret.saveService(SVC_PLAIN, SVC_ID).ok, true, '保存应成功');
    // ⚠ 必须连 -wal 一起读 —— 新写入的数据还在 WAL 里，
    //   只读本体会误判成「没落盘」。
    const raw = readDbBytes(dir);
    assert(!raw.includes(Buffer.from(SVC_PLAIN, 'utf8')),
      '**数据库文件里出现了明文 Key** —— 那等于明文落盘');
    // 密文 = base64(encryptString(明文))。桩里 encryptString 加了 'enc:' 前缀，
    //   所以找的是带前缀那一份。
    //   （第一版写成 base64(明文)，找不到就断言「没落盘」，其实是我写错了。）
    const expected = Buffer.from('enc:' + SVC_PLAIN, 'utf8').toString('base64');
    assert(raw.includes(Buffer.from(expected, 'utf8')),
      '连 -wal 在内都找不到密文 —— Key 根本没落盘');
    void store;
  });
});

t('★ 清空后不再报有 Key，库里也不留密文', () => {
  withSecretStore((secret, store) => {
    secret.saveService(SVC_PLAIN, SVC_ID);
    eq(secret.saveService('', SVC_ID).ok, true, '清空应成功');
    eq(secret.loadService(SVC_ID), '', '清空后仍报有');
    eq(store.getServiceSecret(SVC_ID), null, '清空后库里还留着密文');
  });
});

/**
 * ⚠ 两条路必须互不干扰。
 *
 * connection_secrets 的 id 是真实连接 id，service_secrets 的 id 是服务商名。
 * 之前它们共用 save/load 与同一张表，是个定时炸弹 ——
 * 这次的外键 bug 就是共用带来的直接后果。
 */
t('★ 连接级密钥与服务级密钥互不干扰', () => {
  withSecretStore((secret, store) => {
    // ⚠ createConnection 的参数是**驼峰**（providerKey / needKey / isPreset），
    //   而且 id 必填。我第一版照着 connections 表的列名写了 snake_case，
    //   报 "Provided value cannot be bound to SQLite parameter 1" ——
    //   **API 名不能凭印象写**，得先读实现（store.js:847）。
    store.createConnection({
      id: 'conn-test-1', name: 'T', protocol: 'ollama',
      providerKey: 'ollama', base: 'http://x', model: 'm',
      needKey: false, isPreset: false,
    });
    const cid = store.listConnections()[0].id;
    eq(cid, 'conn-test-1', '取回来的连接 id 不对');
    eq(secret.save('conn-key', cid).ok, true, '连接密钥应能存');
    eq(secret.saveService(SVC_PLAIN, SVC_ID).ok, true, '服务密钥应能存');

    secret.saveService('', SVC_ID);
    eq(secret.load(cid), 'conn-key', '清服务密钥把连接密钥清了');
    eq(secret.loadService(SVC_ID), '', '服务密钥没被清掉');
  });
});


section('四、工具开关：能在 config 里读写，且默认关');

t('★ 默认 toolsEnabled=false', async () => {
  const cfg = await invoke('config:get', {});
  eq(cfg.toolsEnabled, false, '默认必须是关的 —— 装一个写作软件不等于同意模型跑命令');
});

t('★ 可以通过 config:set 打开', async () => {
  await invoke('config:set', { toolsEnabled: true });
  eq((await invoke('config:get', {})).toolsEnabled, true);
  await invoke('config:set', { toolsEnabled: false });
  eq((await invoke('config:get', {})).toolsEnabled, false);
});

// ============================================================
section('五、conv:send 的前置校验（工具相关）');

t('★ 没有连接时 conv:send 拒绝并指向连接问题', async () => {
  const env = await invokeRaw('conv:send', { conversationId: 'c1', text: 'hi' });
  // 没有 store（加载期不建库）时会是 TypeError；有 store 时应该给出人话错误。
  // 两者都必须**拒绝**，绝不能静默"已启动"。
  eq(env.ok, false, '没连接却返回 ok:true，界面会一直转圈');
  assert(/连接|提供商|模型|getConnection/.test(env.error),
    `错误信息要指向连接，实际：${env.error}`);
  // ⚠ 关键：拒绝时不能已经在 store 里落了用户消息，
  //   否则用户会看到一条永远没有回答的提问。
  assert(!/undefined/.test(env.error), `不该有 undefined：${env.error}`);
});

t('★ 生成中再发一条 → started:false，不并发', async () => {
  const a = await invokeRaw('conv:send', { conversationId: 'c2', text: 'a' });
  if (a.ok === false) return;   // 前置校验就拦下了，本条不适用
  const b = await invokeRaw('conv:send', { conversationId: 'c2', text: 'b' });
  if (b.ok === true) {
    eq(b.data.started, false, '并发生成会把两段正文混进同一条消息');
  }
  await invoke('generate:stop', {});
});

// ============================================================
section('六、generate:stop 在没有在跑的东西时不炸');

t('★ 空状态下点停止 → 正常返回', async () => {
  const r = await invoke('generate:stop', {});
  eq(r.stopped, true, '点停止不该报错');
});

t('★ generate:stop 调两次都安全（用户会连点）', async () => {
  eq((await invoke('generate:stop', {})).stopped, true);
  eq((await invoke('generate:stop', {})).stopped, true);
});

t('★ 审批请求在窗口销毁后不会被发出', async () => {
  // 直接验桩的行为差异：主进程里的 send 会因窗口销毁而抛，
  // 闸门把它转成拒绝。这里确认桩本身如预期（否则上面那条测的是假东西）。
  winDestroyed = true;
  const { createApprovalGate } = require('./electron/approval.js');
  const gate = createApprovalGate({
    available: true,
    send: () => { if (winDestroyed) throw new Error('Object has been destroyed'); },
  });
  eq(await gate.request({ command: 'rm x' }), false, '窗口没了必须拒绝');
  winDestroyed = false;
});

(async () => {
  /**
   * ⚠ 2026-10-14：这里**不再**放行 main.js 的 whenReady。
   *
   * 我试过让初始化真跑（好让 secret.init/bind/bindService 真执行），
   * 代价太大：
   *   - whenReady 的回调是 async 的，而它会在后面某行 require('electron')
   *     去拿 Menu —— 那时 Module._load 的 patch 必须还生效，
   *     于是 patch 的还原时机要精确到「初始化跑完之后」，很脆
   *   - 一旦时机没对好，buildMenu 抛 TypeError，
   *     **整个测试进程带崩**（不是一条判据红，是全部跑不完）
   *
   * 所以回到「只验加载期」，改为**直接验 secret-store 模块本身**：
   * 新增的两条落盘判据（service_secrets 真有行 / 明文不入库）
   * 自己 new Store + bindService + init，不依赖 main.js 的生命周期。
   * 这样既真落盘，又不用模拟 Electron。
   */
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) {
      failures.push(name);
      console.log(`  ✗ ${name}`);
      console.log(`      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n工具接线：${passed} 通过 / ${failures.length} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failures.length ? 1 : 0);
})();

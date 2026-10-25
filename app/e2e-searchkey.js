/**
 * 端到端：联网搜索 Key 的保存链路。
 *
 * ## 这条链路上踩过的坑（都很贵）
 *
 * 1. **`secret.init()` 必须放 app.whenReady 里**。
 *    放模块顶层 → safeStorage 还没就绪 → 拿到默认 false →
 *    量出「加密不可用」的假结论。我在探针里栽过一次。
 *
 * 2. **不能只写「故意不桩」而不注册**。
 *    那样量到的是 `No handler registered`（调不通），
 *    不是保存失败。三个 handler 都要照抄 main.js 注册真的。
 *
 * 3. ⚠⚠⚠ **真正的 bug 在数据库层**：搜索 Key 原来存 connection_secrets，
 *    而那张表 `connection_id TEXT PRIMARY KEY REFERENCES connections(id)`。
 *    `__web_search__` 不在 connections 里 → 每次 INSERT 都被拒：
 *      `加密失败：FOREIGN KEY constraint failed`
 *    这个错误被 secret-store 包成「加密失败」，界面拿到 ok:false，
 *    用户看到「填了也存不进去」。
 *    修法：单开 service_secrets 表（无外键）。
 *
 * ## 为什么这个 bug 能潜伏这么久
 *
 * 四条都看不出问题：
 *   - 加密**可用**（isEncryptionAvailable = true）
 *   - 密文格式**合法**（base64 能解）
 *   - 单测**全绿**（没有一条真的往真库里写这个 id）
 *   - 界面**提示正常弹出**
 *
 * 最后是「装完静默跑一遍，再读真实数据库的 connection_secrets 表」露出来的。
 * **只读代码永远看不出来 —— 必须真写一次真库。**
 *
 * 运行：./electron-run.cmd e2e-searchkey.js
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
const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'e2e-searchkey';
/** service_secrets 的主键。联网搜索固定 serper（Bing 入口已关闭）。 */
const SERVICE_ID = 'serper';
/** 明显是假的。跑完必须清掉。 */
const FAKE_KEY = 'e2e_fake_key_0000000000000000000000000000000000';

const { Store } = require(path.resolve(__dirname, '..', 'db', 'store.js'));
const db = new Store(DB);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: 'E2E' });

const fails = [];
const expect = (label, cond, why) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fails.push(label + ' —— ' + (why || ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const secret = require(path.join(APPDIR, 'electron', 'secret-store.js'));

  // ⚠ 必须在 whenReady 里 init —— 这正是第一版探针的错误。
  secret.init();
  secret.bind(
    (id) => db.getConnectionSecret(id),
    (id, enc) => db.setConnectionSecret(id, enc)
  );
  // 服务级密钥接另一张表。少了这行 saveService 会明确报「存储未就绪」。
  secret.bindService(
    (provider) => db.getServiceSecret(provider),
    (provider, enc) => db.setServiceSecret(provider, enc)
  );

  console.log('=== 1. 主进程能力 ===');
  console.log('  secret.init() =', secret.init(), ' isEncrypted() =', secret.isEncrypted());

  const CFG = {
    toolsEnabled: true, searchProvider: 'serper', theme: 'gold',
    currentProject: PID, activeConnectionId: 'conn-migrated',
  };
  const stub = (ch, fn) => {
    if (ipcMain.removeHandler) ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, p) => {
      try { return { ok: true, data: await fn(p) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
  };
  const noop = () => null;
  stub('config:get', () => CFG);
  stub('config:set', (p) => p);
  stub('project:list', () => db.listProjects());
  stub('project:open', () => ({ currentProject: PID }));
  stub('chapter:list', () => []);
  stub('chapter:create', () => ({ id: 'c1' }));
  stub('settings:list', () => []);
  stub('state:list', () => []);
  stub('skill:list', () => []);
  stub('thread:list', () => []);
  stub('thread:open', () => []);
  stub('thread:create', () => ({ id: 'th-1' }));
  stub('thread:resolve', () => ({ ok: true }));
  stub('bible:query', () => ({ hits: [] }));
  stub('conv:list', () => ([{ id: 'cv-1', projectId: PID, title: 'E2E', updatedAt: Date.now() }]));
  stub('conv:create', () => ({ id: 'cv-1', projectId: PID, title: 'E2E' }));
  stub('conv:messages', () => []);
  stub('conv:send', () => ({ started: true }));
  stub('conv:setThink', () => ({ ok: true }));
  stub('style:profile', () => ({ available: false }));
  stub('ollama:check', () => ({ ok: true, version: '0.40.2', models: [] }));
  stub('fs:tree', () => ({ nodes: [] }));
  stub('fs:read', () => ({ content: '', blocks: [], stat: null }));
  stub('fs:write', () => ({ ok: true }));
  stub('fs:create', () => ({ ok: true }));
  stub('fs:rename', () => ({ ok: true }));
  stub('fs:remove', () => ({ ok: true }));
  stub('fs:reveal', () => ({ ok: true }));
  stub('trash:list', () => ({ items: [], stats: {} }));
  stub('trash:add', () => ({ ok: true }));
  stub('trash:restore', () => ({ ok: true }));
  stub('trash:purge', () => ({ ok: true }));
  stub('trash:empty', () => ({ ok: true }));
  stub('tool:decide', () => ({ ok: true }));
  stub('provider:capabilities', () => ({ providers: [], customs: [] }));
  stub('provider:listConnections', () => ([{
    id: 'conn-migrated', name: 'Ollama', protocol: 'ollama',
    providerKey: 'ollama', base: 'http://127.0.0.1:11434',
    model: 'qwen3:latest', needKey: false, isPreset: true, hasKey: false,
  }]));
  stub('provider:connParams', () => ({
    connectionId: 'conn-migrated', isLocal: true, connName: 'Ollama',
    numCtx: 8192, maxOutput: 8192, reserve: 4096, usableCtx: 4096,
  }));
  stub('provider:setConnParams', () => ({ ok: true }));
  stub('app:version', () => ({ version: '1.0.2', major: '1', minor: '0', patch: '2', full: '1.0.2' }));
  stub('app:info', () => ({ version: '1.0.2', userDir: APPDATA, dbPath: DB, node: '22', electron: '44' }));
  stub('app:openExternal', () => ({ ok: true }));
  stub('data:backup', () => ({ ok: true }));
  stub('data:inspectBackup', () => ({ canceled: true }));
  stub('app:setDownloadUrl', () => ({ ok: true }));

  // ---- 下面三条照抄 main.js 的实现注册真的，不能桩 ----
  const real = (ch, fn) => stub(ch, fn);
  const loadSearchKey = () => secret.loadService(SERVICE_ID) || '';
  real('tool:setSearchKey', ({ apiKey } = {}) => {
    const r = secret.saveService(apiKey == null ? '' : String(apiKey), SERVICE_ID);
    return { ok: r.ok, encrypted: r.encrypted, error: r.error, has: !!loadSearchKey() };
  });
  real('tool:searchKeyStatus', () => ({
    has: !!loadSearchKey(), encrypted: secret.isEncrypted(),
  }));
  real('tool:webReady', () => {
    const provider = CFG.searchProvider === 'bing' ? 'bing' : 'serper';
    const hasKey = !!loadSearchKey();
    const label = provider === 'bing' ? 'Bing' : 'Serper';
    return {
      provider, hasKey, encrypted: secret.isEncrypted(),
      masterOn: !!CFG.toolsEnabled,
      missing: [
        CFG.toolsEnabled ? null : '总开关',
        hasKey ? null : label + ' 的 Key',
      ].filter(Boolean),
    };
  });

  db.setServiceSecret(SERVICE_ID, null);

  const win = new BrowserWindow({
    width: 1400, height: 880, show: false,
    webPreferences: { preload: path.join(APPDIR, 'electron', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await wait(1800);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { fails.push('渲染执行失败：' + e.message.split('\n')[0]); return null; }
  };

  console.log('\n=== 2. 直接调 IPC（绕过界面，先确认主进程通不通）===');
  const direct = await js(`(async () => {
    const out = {};
    try {
      out.before = await window.api.tool.searchKeyStatus();
      out.save = await window.api.tool.setSearchKey({ apiKey: ${JSON.stringify(FAKE_KEY)} });
      out.after = await window.api.tool.searchKeyStatus();
      out.webReady = await window.api.tool.webReady();
    } catch (e) { out.err = e.message; }
    return out;
  })()`);
  console.log('  ' + JSON.stringify(direct));
  expect('setSearchKey 返回 ok', !!(direct && direct.save && direct.save.ok),
    '返回 ' + JSON.stringify(direct && direct.save));
  expect('之后 status.has = true', !!(direct && direct.after && direct.after.has),
    'status = ' + JSON.stringify(direct && direct.after));
  expect('webReady 说齐了', !!(direct && direct.webReady && direct.webReady.hasKey
    && direct.webReady.missing.length === 0),
    'webReady = ' + JSON.stringify(direct && direct.webReady));

  const enc1 = db.getServiceSecret(SERVICE_ID);
  console.log('  service_secrets 里有密文吗 =', !!enc1, '长度 =', enc1 ? String(enc1).length : 0);
  expect('Key 落进 service_secrets 了', !!enc1, '返回成功了但库里没有');

  console.log('\n=== 3. 模拟重启：新 Store 实例 + 新 secret 模块状态 ===');
  // 只清内存不清库，模拟「重启后读盘」
  secret.forget();
  const encAfterRestart = db.getServiceSecret(SERVICE_ID);
  console.log('  重启后从库里读到的密文长度 =', encAfterRestart ? String(encAfterRestart).length : 0);
  expect('重启后密文还在（真落盘了，不是只在内存）', !!encAfterRestart,
    '库里没密文 —— 之前是内存假象');
  const loadedAfter = secret.loadService(SERVICE_ID);
  expect('重启后能解出明文', loadedAfter === FAKE_KEY,
    '解出来是 ' + JSON.stringify(String(loadedAfter).slice(0, 16)));

  console.log('\n=== 4. 走界面：设置 → 功能 → 填 Key → 点保存 ===');
  db.setServiceSecret(SERVICE_ID, null);
  secret.forget();

  await js(`(() => {
    const gear = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().charAt(0) === '⚙');
    if (gear) gear.click();
    return true;
  })()`);
  await wait(1400);
  await js(`(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => x.textContent.trim().endsWith('功能'));
    if (b) b.click();
    return true;
  })()`);
  await wait(1400);

  const onPage = await js(`(() => {
    const t = document.body.innerText;
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => x.textContent.trim() === '保存');
    return {
      onTools: /功能/.test(t) && /联网搜索/.test(t),
      input: !!document.querySelector('[data-testid=tool-search-key]'),
      btnDisabled: b ? b.disabled : null,
    };
  })()`);
  console.log('  功能页:', JSON.stringify(onPage));
  expect('停在「功能」页且有 Key 输入框', !!(onPage && onPage.onTools && onPage.input),
    '没进到功能页 ' + JSON.stringify(onPage));
  expect('空输入时「保存」禁用', onPage && onPage.btnDisabled === true, '空输入竟可点');

  const typed = await js(`(() => {
    const inp = document.querySelector('[data-testid=tool-search-key]');
    if (!inp) return null;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(FAKE_KEY)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { len: inp.value.length };
  })()`);
  await wait(500);
  const btn2 = await js(`(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => x.textContent.trim() === '保存');
    return b ? { disabled: b.disabled } : null;
  })()`);
  console.log('  填入 ' + JSON.stringify(typed) + ' → 保存按钮 ' + JSON.stringify(btn2));
  expect('填字后「保存」可点', btn2 && btn2.disabled === false, '仍 disabled —— 用户点了没反应');

  await js(`(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => x.textContent.trim() === '保存');
    if (b) b.click();
    return true;
  })()`);
  await wait(1300);

  const enc2 = db.getServiceSecret(SERVICE_ID);
  console.log('  点保存后 service_secrets 里 =', !!enc2, '长度 =', enc2 ? String(enc2).length : 0);
  expect('走界面点保存后 Key 落进库了', !!enc2, '界面上点了，库里没有 —— 这就是羽毛菌遇到的问题');

  const ui = await js(`(() => {
    const t = document.body.innerText;
    const badge = document.querySelector('[data-testid=search-key-saved-badge]');
    const chip = document.querySelector('[data-testid=tool-chip-web]');
    return {
      stillBlocked: /还没填搜索 Key/.test(t),
      badge: badge ? badge.textContent.trim() : null,
      chip: chip ? chip.textContent.trim() : null,
    };
  })()`);
  console.log('  界面状态:', JSON.stringify(ui));
  expect('「还没填搜索 Key」消失', ui && ui.stillBlocked === false, '标签还在');
  expect('有常驻「已保存」标记', !!(ui && ui.badge), '找不到 saved-badge');
  expect('联网 chip 不再说缺 Key', !!(ui && ui.chip && !/缺/.test(ui.chip)),
    'chip 仍是「' + (ui && ui.chip) + '」');

  db.setServiceSecret(SERVICE_ID, null);
  console.log('\n=== 5. 清理 ===');
  console.log('  service_secrets 里还有 serper 吗 =', !!db.getServiceSecret(SERVICE_ID));

  win.destroy();
  if (fails.length) {
    console.log(`\n✗ ${fails.length} 条没过：`);
    for (const f of fails) console.log('  - ' + f);
    app.exit(1);
  }
  console.log('\n✓ 搜索 Key 全链路通（含重启后读盘）');
  app.exit(0);
});
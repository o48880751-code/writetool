/**
 * **真·本地 Ollama 连通性端到端测试**。
 *
 * ## 为什么必须是这个文件
 *
 * 2026-10-13 羽毛菌报「本地模型连不上」，报的是：
 *
 *   Error invoking remote method 'provider:probe': An object could not be cloned.
 *
 * 根因：`provider.probe()` 里 `version: safeVersion(cfg)` 没 await，
 * 把一个 **Promise** 塞进了返回值。Electron 的 `ipcMain.handle`
 * 返回值要过结构化克隆，Promise 不可克隆 → 整个探测在 IPC 层被拒 →
 * 渲染进程只看到 "Error invoking remote method"，显示成"连不上"。
 *
 * 实际现场：Ollama 服务正常、模型列表拿到了 2 个，就因为一个版本号没 await。
 *
 * ## 为什么别的测试全绿
 *
 * db/test-provider.js 是**直接 require 后调用** probe ——
 * 那条路径没有 IPC，返回原始对象，Promise 静静躺在里面、不报错。
 *
 * 所以这个文件是唯一一处**同时满足**三个条件的验证：
 *   1. 真起 Electron（走 ipcMain.handle，真克隆）
 *   2. 真连本机的 Ollama（不 mock 网络）
 *   3. 从渲染进程侧读结果（真收到界面会看到的东西）
 *
 * 三个条件缺一个，这个 bug 都测不出来。
 *
 * 运行：cmd //c "electron-run.cmd test-ollama-e2e.js"
 * 前提：本机 Ollama 在跑（默认 127.0.0.1:11434）。没跑会明确报"环境不满足"，
 *       而不是假装通过。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { versionInfo } = require(path.join(APPDIR, 'electron', 'version-info.js'));
const provider = require(path.join(APPDIR, 'electron', 'provider.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'e2e-ollama';

let passed = 0;
const failures = [];
function section(t) { console.log('\n' + t); }
function t(name, ok, detail) {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); failures.push(name); }
}

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '本地连通性' });

// ---- 主进程侧的 IPC：provider:probe 走**真实实现**，不做桩 ----
// ⚠ 这一步是整个测试成立的前提：桩的话就没有 IPC、没有克隆，
//   也就测不出"版本号没 await"这个 bug。

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const PRELOAD_SRC = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...PRELOAD_SRC.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$/.test(ch) ? [] : null));

let CFG = {
  model: 'qwen3:latest', numCtx: 8192, temperature: 0.3, fontSize: 16,
  fontFamily: 'system-ui', theme: 'gold', notify: 'window',
  currentProject: PID, thinkLevel: 'off', activeConnectionId: 'conn-ollama-e2e',
  engine: 'ollama', base: 'http://127.0.0.1:11434', thinkStyle: '',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: PID }));
h('chapter:list', () => db.listChapters(PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.loadSettings(PID));
h('state:list', () => db.listEntityStates(PID));
h('thread:open', () => db.listOpenThreads(PID));
h('bible:query', () => ({ hits: [] }));
h('skill:list', () => db.listSkills(PID));
h('conv:list', () => db.listConversations(PID));
h('conv:create', () => db.createConversation({ projectId: PID, title: '' }));
h('conv:messages', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('ollama:check', () => ({ ok: true, version: '0.40.3' }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:reveal', () => ({ ok: true }));
h('trash:list', () => ({ items: [], stats: {} }));
h('trash:add', () => ({ ok: true }));
h('trash:restore', () => ({ ok: true }));
h('trash:purge', () => ({ ok: true }));
h('trash:empty', () => ({ ok: true }));
h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份' }));
h('data:inspectBackup', () => ({ canceled: true }));
h('app:info', () => ({ version: '1.0.0', userDir: path.join(APPDATA, 'writetool'), dbPath: DB, node: process.versions.node, electron: process.versions.electron }));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', () => ({ ok: true }));

const OLLAMA_BASE = 'http://127.0.0.1:11434';

/** 用真实 provider.probe，走真实 IPC 通道 */
h('provider:capabilities', () => require(path.join(APPDIR, 'electron', 'provider-presets.js')).PROVIDERS);
h('provider:listConnections', () => [{
  id: 'conn-ollama-e2e', name: 'Ollama', protocol: 'ollama', providerKey: 'ollama',
  base: OLLAMA_BASE, model: 'qwen3:latest', needKey: false, hasKey: false,
}]);
/**
 * 真 provider.probe + **真计时**。
 *
 * ⚠ latencyMs 是 `provider:probe` 通道在主进程那边加的
 *   （main.js 里 `Date.now() - t0`），provider.probe 自己不加。
 *   这里必须自己测一遍，否则徽章上少了"耗时"那截——
 *   而那会让判据假红：**是测试桩缺字段，不是软件不显示耗时**。
 */
h('provider:probe', async (p = {}) => {
  const t0 = Date.now();
  const r = await provider.probe({
    engine: 'ollama',
    base: p.base || OLLAMA_BASE,
    model: p.model || 'qwen3:latest',
    numCtx: 8192,
    thinkLevel: 'off',
    thinkStyle: '',
  });
  return { ...r, latencyMs: Date.now() - t0 };
});
h('provider:activate', () => ({ ok: true }));
h('provider:disconnect', () => ({ ok: true }));
h('provider:updateConnection', () => ({ ok: true }));
h('provider:deleteConnection', () => ({ ok: true }));
h('provider:createConnection', () => ({ ok: true }));
h('provider:setKey', () => ({ ok: true, encrypted: true }));
h('provider:keyStatus', () => ({ has: false, encrypted: true }));

/** 环境探测：Ollama 在不在 */
function pingOllama() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_BASE}/api/version`, { timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b).version || '?'); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

app.whenReady().then(async () => {
  console.log('\n==================================================');
  console.log('本地 Ollama 端到端测试（真 IPC · 真网络 · 真渲染进程）');
  console.log('==================================================');

  section('零、环境');
  const ver = await pingOllama();
  t(`本机 Ollama 在跑（${OLLAMA_BASE}）`, !!ver, '没连上——请先启动 ollama serve，然后重跑');
  if (!ver) {
    console.log('\n⚠ 环境不满足，后面的用例无法进行。这不是代码失败。');
    app.exit(2);
  }
  console.log(`  服务端版本：${ver}`);

  // ============================================================
  section('一、主进程侧：返回值必须能过结构化克隆');
  // ============================================================
  const raw = await provider.probe({
    engine: 'ollama', base: OLLAMA_BASE, model: 'qwen3:latest', numCtx: 8192,
  });
  t('★ probe 返回 ok:true', raw.ok === true, JSON.stringify(raw).slice(0, 200));
  t('★ version 是字符串（不是 Promise 对象）',
    raw.version === undefined || typeof raw.version === 'string',
    `version 是 ${typeof raw.version}／${raw.version && raw.version.constructor
      ? raw.version.constructor.name : '?'}`);
  let cloneable = true;
  try { structuredClone(raw); } catch (e) { cloneable = false; }
  t('★ 整个返回值可克隆（否则 IPC 会拒）', cloneable, '过不了 Electron 的 IPC');

  // ============================================================
  section('二、渲染进程侧：真走 preload 的 IPC');
  // ============================================================
  const win = new BrowserWindow({
    width: 1440, height: 940, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const js = (code) => win.webContents.executeJavaScript(code);

  /**
   * ⚠ 必须真的调 window.api.provider.probe()：
   *   它走 preload → ipcRenderer.invoke → ipcMain.handle → 结构化克隆。
   *   这条路径上"版本号没 await"才会炸。
   *   直接在主进程 require 调用的话，Promise 静静躺在返回值里、看不出问题。
   */
  const viaIpc = await js(`(async () => {
    try {
      const r = await window.api.provider.probe({ model: 'qwen3:latest' });
      return JSON.stringify({ ok: true, r, vType: typeof (r && r.version) });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String(e && e.message || e) });
    }
  })()`);
  const ipc = JSON.parse(viaIpc);
  console.log('  IPC 返回:', viaIpc.slice(0, 200));
  t('★ 渲染进程调 probe 不抛 "could not be cloned"',
    ipc.ok === true,
    `报错：${ipc.err}`);
  if (ipc.ok) {
    t('★ 结果 ok:true（服务确实是通的）', ipc.r && ipc.r.ok === true,
      JSON.stringify(ipc.r).slice(0, 200));
    t('★ 拿到了模型列表', (ipc.r && ipc.r.models || []).length > 0,
      `models = ${JSON.stringify(ipc.r && ipc.r.models)}`);
    t('★ version 过 IPC 后是字符串', ipc.vType === 'string' || ipc.vType === 'undefined',
      `version 的类型是 ${ipc.vType} —— 收到对象说明 Promise 没 await 就过 IPC 了`);
  }

  // ============================================================
  section('三、界面侧：卡片上显示的状态');
  // ============================================================
  await js(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .filter(x => x.getClientRects().length > 0);
    const s = bs.find(x => /设置/.test(x.textContent));
    if (s) s.click();
    return !!s;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await js(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .filter(x => x.getClientRects().length > 0);
    const s = bs.find(x => /AI 提供商/.test(x.textContent));
    if (s) s.click();
    return !!s;
  })()`);
  await new Promise((r) => setTimeout(r, 1500));

  const card = JSON.parse(await js(`(() => {
    const c = document.querySelector('[data-testid="active-card"]');
    const b = document.querySelector('[data-testid="active-badge"]');
    return JSON.stringify({
      hasCard: !!c,
      badge: b ? b.textContent.trim() : null,
      text: c ? c.textContent.replace(/\\s+/g, ' ').slice(0, 160) : '',
    });
  })()`));
  console.log('  卡片:', JSON.stringify(card));
  t('★ 界面显示的是「当前连接」卡片', card.hasCard, '卡片不在');
  t('★ 徽章写「已连接」而不是"连不上"',
    /已连接/.test(card.badge || ''),
    `徽章写的是「${card.badge}」`);
  t('★ 徽章带实测耗时（有依据，不是空口说连上了）',
    /ms/.test(card.badge || ''),
    `徽章是「${card.badge}」，没有耗时 —— 说明探测结果没真的过去`);

  // 截图留证
  await js("document.body.style.transition='none'; true");
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.capturePage();
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage();
  await js("document.body.style.transition=''; true");
  const OUT = path.join(APPDIR, 'shots');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'h1-本地Ollama-真的连上了.png'), img.toPNG());
  console.log('  截图 h1-本地Ollama-真的连上了');

  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `本地连通性端到端：${passed} 通过 / ${failures.length} 失败`
    : `本地连通性端到端：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('崩溃：', e); app.exit(1); });
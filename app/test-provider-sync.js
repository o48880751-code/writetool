/**
 * 判据：连接的模型名与 config.model 必须保持一致。
 *
 * ## 覆盖的是哪个线上故障（2026-10-15 羽毛菌实测）
 *
 * 症状：切到硅基流动后发消息报
 *   400 {"code":20012,"message":"Model does not exist..."}
 * 切到本地 Ollama 则报 404 model not found —— 而两条连接里存的
 * 模型名其实都是对的。原因是发请求时用的模型名来自
 * **渲染进程内存里的 config.model**，而它没跟着连接切换刷新。
 *
 * 修了两半，这个判据盯的就是这两半：
 *   半 A（主进程）：`provider:updateConnection` 改的是当前连接时，
 *                   config.model 要跟着改。
 *   半 B（界面）  ：`ProviderCat` 每次 activate 后要通知上层刷新 config。
 *                   这一半是纯前端行为，node 测不到，
 *                   只能静态查接线（下面用文件内容断言）。
 *
 * ⚠⚠ 必须把 userData 指到临时目录。
 *   开发态的 app.getPath('userData') 就是 %APPDATA%/writetool ——
 *   **那正是用户的真实数据目录**，不重定向就会用测试数据
 *   覆盖掉用户的配置和项目。
 */
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-provider-sync-'));
app.setPath('userData', TMP);
app.disableHardwareAcceleration();

require('./electron/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else {
    fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

app.whenReady().then(async () => {
  console.log(`临时目录：${TMP}\n`);

  // ---- 找到主窗口并等它加载完 ----
  let win = null;
  for (let i = 0; i < 80 && !win; i++) { await wait(250); win = BrowserWindow.getAllWindows()[0]; }
  if (!win) { console.log('❌ 没等到窗口，判据无法进行'); app.exit(2); return; }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await wait(900);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 准备两条连接 ----
  console.log('—— 准备两条连接 ——');
  const a = await js(`(async () => {
    const r = await window.api.provider.createConnection({
      name: '本地A', protocol: 'ollama', providerKey: 'ollama',
      base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false,
    });
    return { id: r && r.id, name: r && r.name };
  })()`);
  console.log('  建 A：', JSON.stringify(a));
  const bId = await js(`(async () => {
    const r = await window.api.provider.createConnection({
      name: '云端B', protocol: 'openai', providerKey: 'siliconflow',
      base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B', needKey: true,
    });
    return r && r.id;
  })()`);
  console.log('  建 B id：', bId);

  const aId = a.id;
  t('两条连接都建出来了', !!aId && !!bId, `a=${aId} b=${bId}`);
  if (!aId || !bId) { app.exit(2); return; }

  // ---- ① activate 后面的那条 → config.model 应变成它的 ----
  console.log('\n—— ① 切到 B（云端）——');
  await js(`window.api.provider.activate({ id: ${JSON.stringify(bId)} })`);
  await wait(200);
  let cfg = await js('window.api.config.get()');
  t('activate 后 config.model = B 的模型名',
    cfg.model === 'Qwen/Qwen3-8B', `实际 ${JSON.stringify(cfg.model)}`);
  t('activate 后 config.base = B 的地址',
    String(cfg.base).includes('siliconflow'), `实际 ${cfg.base}`);

  // ---- ② 改「当前连接」的模型名 → config.model 必须跟着变 ----
  console.log('\n—— ② 改当前连接的模型名（线上就是这么踩的）——');
  await js(`window.api.provider.updateConnection({
    id: ${JSON.stringify(bId)}, name: '云端B', protocol: 'openai',
    providerKey: 'siliconflow', base: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-30B-A3B', needKey: true,
  })`);
  await wait(200);
  cfg = await js('window.api.config.get()');
  t('改当前连接后 config.model 同步成新值',
    cfg.model === 'Qwen/Qwen3-30B-A3B', `实际 ${JSON.stringify(cfg.model)}`);

  // ---- ③ 改「非当前连接」→ config.model 不该被动 ----
  console.log('\n—— ③ 改另一条（非当前）连接 ——');
  await js(`window.api.provider.updateConnection({
    id: ${JSON.stringify(aId)}, name: '本地A', protocol: 'ollama',
    providerKey: 'ollama', base: 'http://127.0.0.1:11434',
    model: 'qwen3:30b-a3b', needKey: false,
  })`);
  await wait(200);
  cfg = await js('window.api.config.get()');
  t('改非当前连接不影响 config.model',
    cfg.model === 'Qwen/Qwen3-30B-A3B', `实际 ${JSON.stringify(cfg.model)}`);

  // ---- ④ 切回 A → 又跟着变 ----
  console.log('\n—— ④ 切回 A（本地）——');
  await js(`window.api.provider.activate({ id: ${JSON.stringify(aId)} })`);
  await wait(200);
  cfg = await js('window.api.config.get()');
  t('切回 A 后 config.model = A 的模型名（不是 B 的）',
    cfg.model === 'qwen3:30b-a3b', `实际 ${JSON.stringify(cfg.model)}`);
  t('切回 A 后 activeConnectionId 指向 A',
    cfg.activeConnectionId === aId, `实际 ${cfg.activeConnectionId}`);

  // ---- ⑤ 静态检查：半 B（界面通知）是否接线 ----
  console.log('\n—— ⑤ 静态检查：ProviderCat 是否通知上层 ——');
  const pc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'ProviderCat.jsx'), 'utf8');
  t('ProviderCat 接收 onConfigChange',
    /function ProviderCat\(\{[^}]*onConfigChange/.test(pc));
  t('ProviderCat 定义了通知函数',
    pc.includes('notifyConfigChanged'));
  t('切连接（switchTo）里调了通知',
    /switchTo[\s\S]{0,700}notifyConfigChanged\(\)/.test(pc));
  const sp = fs.readFileSync(path.join(__dirname, 'src', 'components', 'SettingsPage.jsx'), 'utf8');
  t('SettingsPage 把 onConfigChange 传给了 ProviderCat',
    /<ProviderCat[^>]*onConfigChange=\{onConfigChange\}/.test(sp));

  // ---- ⑥ 静态检查：主进程不再让界面传来的 model 盖掉连接 ----
  console.log('\n—— ⑥ 静态检查：主进程不许界面传 model 覆盖连接 ——');
  const mj = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
  t('conv:send 不再写 model: model || config.model',
    !mj.includes('model: model || config.model'));
  t('askOnce 不再写 model: config.model',
    !mj.includes('model: config.model'));
  t('streamGenerate 不再写 model: payload.model',
    !mj.includes('model: payload.model'));

  console.log(`\n──────── ${pass} 通过 / ${pass + fail} ────────`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 库还占着，无所谓 */ }
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(2); });

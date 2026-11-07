/**
 * 判据：局域网传文件（2026-11-06）。
 *
 * 运行：./electron-run.cmd test-lan-share.js
 *
 * ## 这个脚本分两段，理由说清楚
 *
 * 前半段**直接 require 真实的 `electron/lan-share.js` 起一个真服务**，
 * 用 fetch 真发请求。不桩：桩会返回常量，那样"路径穿越挡住了"永远是绿的
 * （项目里被桩骗过三次）。
 *
 * 后半段在真界面里点开面板 —— 但 `lan:start` 走的是桩，
 * 桩里调的是**同一个真模块**，所以界面拿到的是真 URL、真 token、真二维码。
 * 这样"界面显示对了"和"服务真的在跑"是同一件事，不是两套假数据。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PKG = require(path.join(APPDIR, 'package.json'));
const lan = require(path.join(APPDIR, 'electron', 'lan-share.js'));

// 造一个"项目"：两个章节 + 一个不该出现的 .order.json + 一张不该出现的图
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-judge-'));
fs.mkdirSync(path.join(ROOT, '章节'), { recursive: true });
fs.mkdirSync(path.join(ROOT, '设定'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '章节', '第一章.md'), '# 第一章\n' + '正文'.repeat(200));
fs.writeFileSync(path.join(ROOT, '设定', '世界观.md'), '# 世界观');
fs.writeFileSync(path.join(ROOT, '.order.json'), '{"a":1}');
fs.writeFileSync(path.join(ROOT, '封面.png'), 'not-a-real-png');
/** ⚠ 项目根**外面**放一个真文件：只测『不存在的路径返回 404』
 *   是测不出穿越漏洞的 —— 穿越过去文件不存在，照样 404。 */
const OUTER = path.join(path.dirname(ROOT), 'lan-outer-secret.md');
fs.writeFileSync(OUTER, 'SECRET-SHOULD-NOT-LEAK');

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async () => {
    try { return { ok: true, data: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
for (const ch of [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))]) {
  h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
}

const PROJECT = { id: 'p1', name: '测试长卷', kind: 'long' };
let CFG = {
  model: 'qwen3', numCtx: 8192, mode: 'light', notify: 'none',
  currentProject: 'p1', chatFontSize: 16, editorFontSize: 16,
  editorFont: 'system-ui', chatFont: 'system-ui',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: PKG.version, full: 'v' + PKG.version }));
h('project:list', () => [PROJECT]);
h('scope:get', () => ({ locked: false, strikes: 0 }));
h('fs:tree', () => ({ name: 'root', type: 'dir', children: [] }));
h('conv:list', () => []);
h('conv:messages', () => []);
/** 关键：桩里调真模块，界面拿到的是真地址真 token */
let WIN = null;
/** ⚠ 桩必须把 onEvent 接上：真 main.js 就是这么把『收到文件』推给界面的，
 *   不接的话『界面上能看见收到的文件』这条永远测不到。 */
h('lan:start', () => lan.start({
  root: ROOT,
  projectName: PROJECT.name,
  onEvent: (e) => { if (WIN && !WIN.isDestroyed()) WIN.webContents.send('lan:event', e); },
}));
h('lan:stop', async () => { await lan.stop(); return { stopped: true }; });
h('lan:status', () => lan.status());

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, ok: !!ok });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 150 秒没跑完'); app.exit(1); }, 150000);

  // ===========================================================
  console.log('\n=== 一、服务本身：token / 穿越 / 上传 / 停止（真请求） ===');
  // ===========================================================
  const r = await lan.start({ root: ROOT, projectName: '测试长卷' });
  const base = 'http://127.0.0.1:' + r.port;

  t('启动后有地址和 token', !!r.url && r.url.indexOf('?t=') > 0, r.url.replace(/t=.*/, 't=***'));
  t('token 不是空的、也不是固定值', /[0-9a-f]{10}/.test(r.token), r.token);

  t('无 token 访问页面被拒', (await fetch(base + '/')).status === 401);
  t('token 错也被拒', (await fetch(base + '/?t=0000000000')).status === 401);

  const page = await (await fetch(base + '/?t=' + r.token)).text();
  t('页面列出章节文件', page.includes('第一章'));
  t('页面不暴露 .order.json', page.indexOf('.order') < 0);
  t('页面不暴露 png', page.indexOf('封面.png') < 0);

  const list = await (await fetch(base + '/api/list?t=' + r.token)).json();
  t('列表只含允许的文本文件', list.length === 2, JSON.stringify(list.map((x) => x.rel)));

  const evil = await fetch(base + '/api/file?t=' + r.token + '&p=' + encodeURIComponent('../lan-outer-secret.md'));
  const evilBody = evil.status === 200 ? await evil.text() : '';
  t('目录穿越读不到项目外的真文件',
    evil.status !== 200 && evilBody.indexOf('SECRET-SHOULD-NOT-LEAK') < 0,
    'status=' + evil.status + ' 泄露=' + (evilBody.indexOf('SECRET') >= 0));

  const dl = await fetch(base + '/api/file?t=' + r.token + '&p=' + encodeURIComponent('设定/世界观.md'));
  t('能下载中文路径的文件', dl.status === 200 && (await dl.text()).includes('世界观'));
  t('下载响应带 UTF-8 文件名',
    /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''));

  const up = await fetch(base + '/api/upload?t=' + r.token + '&name=' + encodeURIComponent('手机上写的.md'),
    { method: 'POST', body: '# 从手机传的', headers: { 'Content-Type': 'application/octet-stream' } });
  t('手机上传成功', up.status === 200);
  t('落在「收件箱」里', fs.existsSync(path.join(ROOT, '收件箱', '手机上写的.md')));

  await fetch(base + '/api/upload?t=' + r.token + '&name=' + encodeURIComponent('手机上写的.md'),
    { method: 'POST', body: 'second', headers: { 'Content-Type': 'application/octet-stream' } });
  t('同名文件不覆盖，自动改名', fs.existsSync(path.join(ROOT, '收件箱', '手机上写的(2).md')));

  t('exe 上传被拒', (await fetch(base + '/api/upload?t=' + r.token + '&name=x.exe',
    { method: 'POST', body: 'MZ' })).status === 415);

  await lan.stop();
  t('停止后状态是未运行', lan.status().running === false);
  t('停止后端口不再响应', await fetch(base + '/').then(() => false).catch(() => true));

  // ===========================================================
  console.log('\n=== 二、界面：按钮 / 面板 / 二维码 / 关闭即停 ===');
  // ===========================================================
  const win = new BrowserWindow({
    width: 1400, height: 940, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  WIN = win;
  /**
   * ⚠ 渲染层在面板里抛错时，executeJavaScript 只会给一句
   *   "Script failed to execute"，看不到真因。必须把控制台接出来。
   */
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('    [renderer] ' + String(message).slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('    [renderer gone]', JSON.stringify(d)));
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1600);
  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log('    ! JS_ERR', e.message); return null; }
  };
  const click = (sel) => js(`(function(){var b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;b.click();return true;})()`);

  // 从书架进编辑器
  let entered = await click('[data-testid="bookshelf-card"]');
  if (!entered) entered = await click('[data-testid="shelf-hero-continue"]');
  await sleep(1200);
  t('从书架进了编辑器', !!entered);

  const btn = await js(`(function(){
    var b=document.querySelector('[data-testid="lan-open"]');
    if(!b) return null;
    var s=getComputedStyle(b);
    return { text:b.textContent.trim(), title:b.getAttribute('title')||'', h:Math.round(b.getBoundingClientRect().height) };
  })()`);
  t('顶栏有「传文件」按钮', !!btn && btn.text.indexOf('传文件') >= 0, btn && btn.text);
  t('按钮有 title 说明（新功能不能只给图标）', !!btn && btn.title.length > 8, btn && btn.title);
  t('按钮高度和其他顶栏按钮一致（28px）', btn && btn.h === 28, btn && String(btn.h));

  await click('[data-testid="lan-open"]');
  await sleep(900);

  const panel = await js(`(function(){
    var card=document.querySelector('[data-testid="lan-mask"]');
    if(!card) return null;
    var qrEl=document.querySelector('.lan-qr');
    var qr=qrEl?qrEl.querySelector('svg'):null;
    var cs=qrEl?getComputedStyle(qrEl):null;
    var url=document.querySelector('[data-testid="lan-url"]');
    return {
      hasCard:true,
      text:(card.innerText||''),
      qrPaths: qr ? qr.querySelectorAll('path,rect').length : 0,
      qrBox: cs ? cs.backgroundColor : '',
      url: url ? url.textContent : '',
    };
  })()`);
  t('面板打开了', !!panel && panel.hasCard);
  t('二维码真的画出来了（有图形节点）', !!panel && panel.qrPaths > 0, panel && String(panel.qrPaths));
  t('二维码底是白色（深色主题下也能扫）', !!panel && panel.qrBox === 'rgb(255, 255, 255)', panel && panel.qrBox);
  t('面板显示带 token 的地址', !!panel && /\?t=[0-9a-f]{10}/.test(panel.url), panel && panel.url.replace(/t=.*/, 't=***'));
  t('面板说明写清了落点是「收件箱」', !!panel && panel.text.indexOf('收件箱') >= 0);
  t('面板标题写着共享当前这本', !!panel && panel.text.indexOf('测试长卷') >= 0);

  // 手机真的传一个文件上来，看界面有没有提示
  const live = lan.status();
  t('面板打开后服务确实在跑', live.running === true && !!live.port, 'port=' + live.port);
  if (live.running) {
    await fetch('http://127.0.0.1:' + live.port + '/api/upload?t=' + live.token + '&name=' +
      encodeURIComponent('界面提示.md'), { method: 'POST', body: 'x', headers: { 'Content-Type': 'application/octet-stream' } });
    await sleep(800);
    const got = await js(`(function(){
      var el=document.querySelector('.lan-got');
      return el ? el.innerText : '';
    })()`);
    t('手机传来文件后界面列出来了', !!got && got.indexOf('界面提示.md') >= 0, (got || '').slice(0, 60));
  }

  // 关闭 → 服务必须停
  await click('.lan-x');
  await sleep(900);
  const closed = await js(`!!document.querySelector('[data-testid="lan-mask"]')`);
  t('点 × 能关掉面板', closed === false);
  t('关掉后服务真的停了（不是只藏了界面）', lan.status().running === false);

  const bad = CHECKS.filter((c) => !c.ok);
  console.log('\n========== ' + (CHECKS.length - bad.length) + '/' + CHECKS.length + ' 通过 ==========');
  if (bad.length) console.log('失败：' + bad.map((b) => b.name).join(' / '));
  clearTimeout(watchdog);
  fs.rmSync(ROOT, { recursive: true, force: true });
  try { fs.unlinkSync(OUTER); } catch (_) {}
  app.exit(bad.length ? 1 : 0);
});

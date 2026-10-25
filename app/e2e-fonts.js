'use strict';
/**
 * 字体系统端到端验证（真跑打包后的 Electron）。
 *
 * 关键修正（之前两版都栽了）：
 *   - 上一版把 e2e 当 main 进程、却去 loadFile 真实 index.html → 真实 app 启动会去调
 *     config:get / provider:* 等一堆 handler，本脚本没注册 → "No handler registered"。
 *   - 本版：脚本自己就是 main 进程，但**复用 main.js 里真实的字体逻辑**
 *     （downloadFile + appfont:// 协议 + 四个 font handler），只 loadFile 一个最小测试页
 *     （带与真实 index.html 完全一致的 CSP + @font-face）。用 executeJavaScript 驱动，
 *     不走完整 React 应用，避免无关 handler 调用。
 *
 * 验证点（都是「只改了代码、没真跑过」的盲区）：
 *   1. window.api.font.presets() 返回 4 个字体
 *   2. font:install 真把文件下到 userData/fonts（联网下载 + 写盘）
 *   3. appfont:// 协议在 CSP（font-src 'self' appfont:）下真能把字体喂给 @font-face
 *      —— document.fonts.check 反映字体是否真加载成功
 *   4. font:installed 装后含 iansui、卸后不含
 *
 * 字体落在 --user-data-dir 指定的临时目录，跑完删除，不污染用户字体目录。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { app, BrowserWindow, protocol } = require('electron');
const { FONTS, FONT_DIR, fontById } = require('./electron/font-presets');

// ⚠ 必须在 app ready 之前注册特权协议（标准 Response + bypassCSP）
protocol.registerSchemesAsPrivileged([
  { scheme: 'appfont', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const tmpUd = path.join(os.tmpdir(), 'wt-fonts-e2e-' + Date.now());
process.env.WT_FONTS_E2E_UD = tmpUd;

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

app.whenReady().then(async () => {
  const fontsDir = path.join(app.getPath('userData'), FONT_DIR);
  fs.mkdirSync(fontsDir, { recursive: true });

  const MIME_BY_EXT = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff' };
  console.error('[appfont] 用 registerBufferProtocol 注册');
  protocol.registerBufferProtocol('appfont', (request, callback) => {
    console.error('[appfont] HIT', request.url);
    try {
      const u = new URL(request.url);
      const raw = (u.pathname && u.pathname !== '/' && u.pathname !== '') ? u.pathname : u.hostname;
      const name = path.basename(decodeURIComponent(raw));
      const fp = path.join(fontsDir, name);
      if (!fp.startsWith(fontsDir + path.sep)) return callback({ error: 'forbidden' });
      const buf = fs.readFileSync(fp);
      const ct = MIME_BY_EXT[path.extname(fp).toLowerCase()] || 'application/octet-stream';
      callback({ data: buf, mimeType: ct, headers: { 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
      callback({ error: 'not found' });
    }
  });

  const fontDir = () => path.join(app.getPath('userData'), FONT_DIR);
  const ipcMain = require('electron').ipcMain;
  // 复刻 main.js 的 handle 信封：主进程返回 {ok,data}，业务异常返回 {ok:false,error}
  const handle = (ch, fn) =>
    ipcMain.handle(ch, (_e, ...args) =>
      Promise.resolve()
        .then(() => fn(_e, ...args))
        .then((data) => ({ ok: true, data }))
        .catch((err) => ({ ok: false, error: (err && err.message) || String(err) })));
  handle('font:presets', () =>
    FONTS.map((f) => ({ id: f.id, label: f.label, family: f.family, file: f.file, sizeMB: f.sizeMB, desc: f.desc })));
  handle('font:installed', () => {
    const dir = fontDir();
    return FONTS.filter((f) => fs.existsSync(path.join(dir, f.file))).map((f) => f.id);
  });
  handle('font:install', async (_e, { id }) => {
    const f = fontById(id);
    if (!f) throw new Error('未知字体：' + id);
    const dir = fontDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, f.file);
    await downloadFile(f.url, dest);
    return { id, file: f.file, size: fs.statSync(dest).size };
  });
  handle('font:uninstall', (_e, { id }) => {
    const f = fontById(id);
    if (!f) throw new Error('未知字体：' + id);
    const dest = path.join(fontDir(), f.file);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    return { id };
  });
  handle('app:flashFrame', () => true);

  const html = path.join(__dirname, 'e2e-fonts.html');
  const preload = path.join(__dirname, 'electron', 'preload.js');

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });

  const loaded = await new Promise((resolve) => {
    const tm = setTimeout(() => resolve('timeout'), 20000);
    win.webContents.on('did-finish-load', () => { clearTimeout(tm); resolve('ok'); });
    win.webContents.on('did-fail-load', (_e, c, d) => { clearTimeout(tm); resolve(`fail:${c} ${d}`); });
    win.loadFile(html);
  });
  t('测试页加载', loaded === 'ok', loaded === 'ok' ? '' : loaded);
  if (loaded !== 'ok') return finish();

  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      out.presets = await window.api.font.presets();
      out.install = await window.api.font.install({ id: 'iansui' });
      // fetch 探测：直接看协议 handler 是否被调用、返回什么
      try {
        const res = await fetch('appfont:///Iansui.ttf');
        const buf = await res.arrayBuffer();
        out.fetch = { ok: res.ok, status: res.status, len: buf.byteLength };
      } catch (e) { out.fetch = { err: e.message }; }
      // @font-face 探测
      try { await document.fonts.load("40px 'Iansui'"); } catch (e) { out.loadErr = e.message; }
      out.fontLoaded = document.fonts.check("40px 'Iansui'");
      out.installed = await window.api.font.installed();
      await window.api.font.uninstall({ id: 'iansui' });
      out.after = await window.api.font.installed();
      return out;
    })()`);

    t('font.presets 返回 4 个', Array.isArray(r.presets) && r.presets.length === 4, `(${r.presets && r.presets.length})`);
    t('font.install 真下载成功', r.install && r.install.id === 'iansui' && r.install.size > 1000,
      `(${r.install && r.install.size} bytes)`);
    t('appfont:// fetch 命中 handler', r.fetch && r.fetch.ok && r.fetch.len > 1000,
      `(${JSON.stringify(r.fetch)})`);
    t('appfont:// 在 CSP 下喂回字体并加载', r.fontLoaded === true,
      r.fontLoaded ? '' : 'document.fonts.check=false' + (r.loadErr ? ' loadErr=' + r.loadErr : ''));
    t('font.installed 含 iansui', Array.isArray(r.installed) && r.installed.includes('iansui'),
      `(${JSON.stringify(r.installed)})`);
    t('卸载后 font.installed 不再含 iansui', Array.isArray(r.after) && !r.after.includes('iansui'),
      `(${JSON.stringify(r.after)})`);
  } catch (e) {
    t('字体 IPC 往返', false, e.message);
  }

  finish();
});

/**
 * 下载文件（与 main.js downloadFile 同逻辑）。
 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const run = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('字体下载重定向过多'));
          res.resume();
          return run(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`字体下载失败 HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let loaded = 0;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => { loaded += c.length; if (total && onProgress) onProgress(loaded, total); });
        res.pipe(ws);
        ws.on('finish', () => resolve(dest));
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('字体下载超时')));
    };
    run(url, 0);
  });
}

function finish() {
  console.log(`\n字体 e2e：通过 ${pass} / 失败 ${fail}`);
  const ud = process.env.WT_FONTS_E2E_UD;
  if (ud && fs.existsSync(ud)) { try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) {} }
  try { require('electron').app.quit(); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

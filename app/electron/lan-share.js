/**
 * 局域网传文件（2026-11-06）。
 *
 * ## 为什么是「HTTP 服务 + 手机浏览器」，不是「客户端」
 *
 * 羽毛菌的原话：「局域网共享就是互相传输文件啊，又不能操控」。
 * 所以这里做的不是"平板远程操作 Windows"，而是**双向传文件**：
 *   · 电脑 → 手机：把项目里的 md 下载到手机
 *   · 手机 → 电脑：把手机里的文件送进项目
 *
 * 平板/手机**不装任何东西**，扫码用浏览器打开就行。这比做一个 App 省掉：
 * 应用商店上架、iOS 签名、Android 各版本适配，以及"用户嫌麻烦不肯装"。
 *
 * ## 安全边界（说清楚，别让人以为这是公网服务）
 *
 * · 监听 0.0.0.0（不是只绑某个网卡）—— 换 WiFi / 插网线都不用重启服务，
 *   代价是机器上所有网卡都能连。真正的门槛是 URL 里的 token：
 *   没 token 一律 401，扫不到二维码就进不来。
 * · 所有路径都要 resolve 到项目根目录之内，挡住 ../../ 穿越。
 * · 上传只收文本类扩展名（和文件树白名单一致），挡住 exe / bat。
 * · 单文件 64MB 上限。
 * · 关掉面板就停服务，不留后台监听。
 *
 * ⚠ 这个模块**不碰 Electron API**：纯 Node，方便单独用 node 跑判据。
 *   主进程只负责把 root 传进来、把事件转发给渲染层。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

/** 单文件上限。手机传 md 远到不了，设这么大是为了防误传大文件把内存吃满 */
const MAX_UPLOAD = 64 * 1024 * 1024;

/** 允许**接收**的扩展名。和 project-fs 的 ALLOWED_EXT 保持一致 */
const ALLOWED_EXT = new Set(['.md', '.txt', '.markdown', '.json']);

/** 收到的文件统一落这个目录 —— 不往「设定 / 卷纲 / 章节」里塞，免得打乱结构 */
const INBOX = '收件箱';

/** 服务状态。没启动时 running=false */
let server = null;
let session = null;
/** 收到文件 / 有设备连上时回调给主进程，主进程再推给界面 */
let emit = () => {};

/* ------------------------------------------------------------------ */
/* 网络地址                                                            */
/* ------------------------------------------------------------------ */

/**
 * 局域网 IPv4 地址，按"像家庭/办公室网段"的程度排序。
 *
 * ⚠ 一台机器常有 Docker、VMware、Hyper-V 的虚拟网卡（172.17.x / 192.168.56.x），
 *   排在前面会让二维码扫出来连不上。所以先按网段打分：
 *   192.168.x > 10.x > 172.16~31 > 其他。
 */
function lanIps() {
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 30;
    if (ip.startsWith('10.')) return 20;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 10;
    return 0;
  };
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      // ⚠ Node 18 起 family 可能是数字 4 而不是 'IPv4'，两种都认
      const v4 = ni.family === 'IPv4' || ni.family === 4;
      if (v4 && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)].sort((a, b) => score(b) - score(a));
}

/* ------------------------------------------------------------------ */
/* 路径安全                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把用户传来的相对路径解析成绝对路径，并确认它没跑出 root。
 *
 * ⚠ 只做 path.resolve 不够：`..%2f..%2fWindows` 解码后就是 `../../Windows`。
 *   必须解析完再比前缀，而且要用 **root + 分隔符** 比 ——
 *   否则 `C:\proj-evil` 会被误判成在 `C:\proj` 里面。
 */
function safeJoin(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** 文件名清洗：去掉路径分隔符和控制字符，挡住 `../x` 和 `a:b` */
function safeName(raw) {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return s.slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

/** HTML 转义。文件名是用户内容，直接拼进 HTML 会被 XSS */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 按扩展名给个图标字符（不引图标库，页面里就这几个） */
function iconOf(name) {
  if (/\.json$/i.test(name)) return '{}';
  if (/\.txt$/i.test(name)) return 'TXT';
  return 'MD';
}

/**
 * 手机端页面。
 *
 * ⚠ 整个页面是**一个字符串**，没有构建步骤、没有外链资源 ——
 *   手机上打开要快，而且不能依赖 CDN（局域网可能没外网）。
 * ⚠ 别在模板字符串里写反引号：会把模板提前闭合（项目里踩过好几次）。
 */
function pageHtml(sess) {
  const files = listFiles(sess.root);
  const rows = files.length
    ? files.map((f) => {
      // 有上级目录时补一行小字：手机上看到五个「第一章.md」分不清是哪本书哪一卷
      const dir = f.rel.indexOf('/') >= 0 ? f.rel.slice(0, f.rel.lastIndexOf('/') + 1) : '';
      return '<li><a class="row" href="/api/file?t=' + encodeURIComponent(sess.token)
        + '&p=' + encodeURIComponent(f.rel) + '">'
        + '<span class="ico">' + iconOf(f.name) + '</span>'
        + '<span class="name">'
        + '<span class="fname">' + esc(f.name) + '</span>'
        + (dir ? '<span class="dir">' + esc(dir) + '</span>' : '')
        + '</span>'
        + '<span class="meta">' + fmtSize(f.size) + '</span>'
        + '</a></li>';
    }).join('')
    : '<li class="empty">这个项目还没有文本文件</li>';

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>', esc(sess.projectName), ' · 局域网传文件</title>',
    '<style>',
    ':root{color-scheme:light dark;',
    '--bg:#f2f2f7;--card:#fff;--ink:#111;--soft:#6b7280;--line:rgba(0,0,0,.09);--accent:#0b6bcb}',
    '@media (prefers-color-scheme:dark){:root{--bg:#111214;--card:#1c1d20;--ink:#f2f3f5;',
    '--soft:#9aa0a6;--line:rgba(255,255,255,.1);--accent:#5aa9ff}}',
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    'body{margin:0;background:var(--bg);color:var(--ink);',
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.wrap{max-width:640px;margin:0 auto;padding:18px 16px 40px}',
    'h1{font-size:19px;margin:0 0 2px;letter-spacing:-.02em}',
    '.sub{color:var(--soft);font-size:12.5px;margin-bottom:18px}',
    '.card{background:var(--card);border-radius:14px;overflow:hidden;margin-bottom:16px}',
    '.head{display:flex;align-items:baseline;justify-content:space-between;',
    'padding:13px 15px 11px;border-bottom:1px solid var(--line)}',
    '.head b{font-size:13px}.head span{font-size:11.5px;color:var(--soft)}',
    'ul{list-style:none;margin:0;padding:0}',
    '.row{display:flex;align-items:center;gap:11px;padding:12px 15px;',
    'border-bottom:1px solid var(--line);text-decoration:none;color:inherit}',
    'li:last-child .row{border-bottom:0}',
    '.row:active{background:var(--line)}',
    '.ico{flex:0 0 auto;font-size:10px;font-weight:700;color:var(--soft);',
    'border:1px solid var(--line);border-radius:5px;padding:3px 5px;letter-spacing:.02em}',
    '.name{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
    '.fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dir{display:block;font-size:10.5px;color:var(--soft);margin-top:1px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.meta{flex:0 0 auto;font-size:11.5px;color:var(--soft)}',
    '.empty{padding:22px 15px;text-align:center;color:var(--soft);font-size:13px}',
    '.drop{padding:22px 15px;text-align:center}',
    '.drop label{display:inline-block;padding:11px 22px;border-radius:999px;',
    'background:var(--accent);color:#fff;font-weight:600;font-size:14px}',
    'input[type=file]{display:none}',
    '.tip{color:var(--soft);font-size:12px;margin-top:10px;line-height:1.6}',
    '.bar{height:5px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:12px;display:none}',
    '.bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .18s}',
    '.done{color:#188038;font-size:13px;margin-top:10px;display:none}',
    '@media (prefers-color-scheme:dark){.done{color:#5dd58a}}',
    '</style></head><body><div class="wrap">',
    '<h1>', esc(sess.projectName), '</h1>',
    '<div class="sub">局域网直连 · 文件不经过任何服务器</div>',

    '<div class="card">',
    '<div class="head"><b>从电脑取</b><span>', files.length, ' 个文件</span></div>',
    '<ul>', rows, '</ul>',
    '</div>',

    '<div class="card">',
    '<div class="head"><b>传到电脑</b><span>收件箱</span></div>',
    '<div class="drop">',
    '<label for="f">选择文件</label>',
    '<input id="f" type="file" multiple accept=".md,.txt,.markdown,.json">',
    '<div class="bar" id="bar"><i id="fill"></i></div>',
    '<div class="done" id="done"></div>',
    '<div class="tip">传到电脑后落在项目的「', INBOX, '」文件夹里，<br>不会覆盖任何已有文件。</div>',
    '</div>',
    '</div>',

    '<script>',
    'var TOK=', JSON.stringify(sess.token), ';',
    'var input=document.getElementById("f"),bar=document.getElementById("bar"),',
    'fill=document.getElementById("fill"),done=document.getElementById("done");',
    'input.addEventListener("change",function(){',
    '  var fs=[].slice.call(input.files||[]);if(!fs.length)return;',
    '  bar.style.display="block";done.style.display="none";',
    '  var i=0,ok=0;',
    '  function next(){',
    '    if(i>=fs.length){',
    '      bar.style.display="none";done.style.display="block";',
    '      done.textContent="已传 "+ok+" 个文件，回电脑上看看「'+INBOX+'」";',
    '      input.value="";return;',
    '    }',
    '    var f=fs[i++];',
    '    fetch("/api/upload?t="+encodeURIComponent(TOK)+"&name="+encodeURIComponent(f.name),',
    '      {method:"POST",body:f,headers:{"Content-Type":"application/octet-stream"}})',
    '      .then(function(r){if(r.ok)ok++;fill.style.width=Math.round(i/fs.length*100)+"%";next();})',
    '      .catch(function(){fill.style.width=Math.round(i/fs.length*100)+"%";next();});',
    '  }',
    '  next();',
    '});',
    '</script>',

    '</div></body></html>',
  ].join('');
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/**
 * 列出项目里的文本文件（递归，最多 400 个）。
 *
 * ⚠ 上限 400 是为了手机端别卡：一个 2700 章的项目递归出上万个文件，
 *   页面会直接卡死。够用就行，超了提示用户去电脑上看。
 */
function listFiles(root, limit = 400) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= limit) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    // 目录在前、名字序 —— 和文件树一致，用户找起来顺手
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, 'zh'));
    for (const d of names) {
      if (out.length >= limit) return;
      if (d.name.startsWith('.')) continue; // .order.json / .trash 不露出来
      const abs = path.join(dir, d.name);
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { walk(abs, r); continue; }
      if (!ALLOWED_EXT.has(path.extname(d.name).toLowerCase())) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (_) { continue; }
      out.push({ name: d.name, rel: r, size });
    }
  };
  walk(root, '');
  return out;
}

/* ------------------------------------------------------------------ */
/* 请求处理                                                            */
/* ------------------------------------------------------------------ */

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('链接已失效，回电脑上重新打开共享面板');
}

/**
 * 启动。
 *
 * @param {{ root: string, projectName?: string, onEvent?: Function }} opts
 *   root 是**项目根目录**；服务只在这个目录里读写。
 */
async function start(opts) {
  const root = path.resolve(String((opts && opts.root) || ''));
  if (!fs.existsSync(root)) throw new Error('项目目录不存在，先打开一个项目');
  await stop();

  const token = crypto.randomBytes(5).toString('hex');
  const projectName = String((opts && opts.projectName) || path.basename(root));
  emit = (typeof (opts && opts.onEvent) === 'function') ? opts.onEvent : () => {};

  server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); res.end(); return; }

    // ⚠ token 校验放在最前面：没通过的一律 401，连页面都不给
    const t = url.searchParams.get('t') || '';
    if (!session || t !== session.token) { unauthorized(res); return; }

    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const html = pageHtml(session);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // 页面是实时生成的（文件列表会变），别让手机缓存住
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    if (p === '/api/list') {
      const body = JSON.stringify(listFiles(session.root));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (p === '/api/file') {
      const abs = safeJoin(session.root, url.searchParams.get('p') || '');
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('文件不存在');
        return;
      }
      if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) { res.writeHead(403); res.end(); return; }
      const name = path.basename(abs);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        // ⚠ 中文文件名必须走 filename*，只写 filename= 在手机浏览器上会变乱码
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'Content-Length': fs.statSync(abs).size,
      });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    if (p === '/api/upload' && req.method === 'POST') {
      handleUpload(req, res, url);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个地址');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });

  const port = server.address().port;
  const ips = lanIps();
  session = { token, port, root, projectName, startedAt: Date.now() };
  const urls = ips.map((ip) => 'http://' + ip + ':' + port + '/?t=' + token);

  return {
    token,
    port,
    urls,
    /** 二维码用第一个（打分最高的那个网段） */
    url: urls[0] || '',
    projectName,
    root,
    hasLan: ips.length > 0,
  };
}

/** 接收一个文件：请求体直接是二进制，文件名在 query 里 */
function handleUpload(req, res, url) {
  const raw = url.searchParams.get('name') || '';
  const name = safeName(raw);
  const ext = path.extname(name).toLowerCase();
  if (!name || !ALLOWED_EXT.has(ext)) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只接收 md / txt / markdown / json');
    return;
  }

  const inbox = path.join(session.root, INBOX);
  try { fs.mkdirSync(inbox, { recursive: true }); } catch (_) { /* 下面写文件会报 */ }

  // 同名不覆盖：加 (2)(3) 后缀
  let target = path.join(inbox, name);
  let n = 2;
  const base = name.slice(0, name.length - ext.length);
  while (fs.existsSync(target)) {
    target = path.join(inbox, base + '(' + n + ')' + ext);
    n += 1;
    if (n > 999) break;
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) {
    res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件太大（上限 64MB）');
    return;
  }

  let received = 0;
  let aborted = false;
  const ws = fs.createWriteStream(target);
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD && !aborted) {
      aborted = true;
      req.destroy();
      ws.destroy();
      try { fs.unlinkSync(target); } catch (_) {}
    }
  });
  req.pipe(ws);
  ws.on('finish', () => {
    if (aborted) return;
    const rel = INBOX + '/' + path.basename(target);
    emit({ type: 'received', name: path.basename(target), rel, size: received });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rel }));
  });
  ws.on('error', () => {
    if (!res.headersSent) { res.writeHead(500); res.end('写入失败'); }
  });
}

/** 停服务。重复调用不报错（面板关掉时可能连着调两次） */
async function stop() {
  const s = server;
  server = null;
  session = null;
  emit = () => {};
  if (!s) return;
  await new Promise((resolve) => {
    s.close(() => resolve());
    // ⚠ 有 keep-alive 连接时 close 不会立刻回调，1 秒后强制断开
    setTimeout(() => { try { s.closeAllConnections(); } catch (_) {} resolve(); }, 1000).unref?.();
  });
}

/** 当前状态（界面轮询/重连用） */
function status() {
  if (!server || !session) return { running: false };
  const ips = lanIps();
  return {
    running: true,
    token: session.token,
    port: session.port,
    urls: ips.map((ip) => 'http://' + ip + ':' + session.port + '/?t=' + session.token),
    projectName: session.projectName,
    root: session.root,
    startedAt: session.startedAt,
  };
}

module.exports = { start, stop, status, listFiles, lanIps, safeJoin, safeName, INBOX, MAX_UPLOAD, ALLOWED_EXT };

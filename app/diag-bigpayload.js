/**
 * 决定性实验：同一个连接，**只改请求体大小**，看首字节耗时。
 *
 * ## 现场（2026-10-15 羽毛菌的日志）
 *
 *   [chat] 发出 ... 消息=7 正文=78463字节
 *   [chat] TCP 已连接 api.siliconflow.cn:443
 *   [chat] socket 超时 api.siliconflow.cn（已 5081ms 没收到任何字节）
 *
 * 对照：我自己 630 字节的请求是
 *   [chat] 收到响应 200（495ms）
 *
 * 所以要分清两件事：
 *   1. 那个 5081ms 是不是"大请求体导致服务端首字节慢"
 *   2. 还是"某处给 socket 设了 5 秒超时"（那才是我们自己的 bug）
 *
 * 方法：逐级放大请求体，每级都记
 *   · 建连耗时
 *   · 第一个字节的耗时（响应头）
 *   · socket 有没有 timeout 事件
 *
 * ⚠ 走 electron 跑（.\electron-run.cmd diag-bigpayload.js）：
 *   密钥是 safeStorage 加密的，裸 node 解不开。
 *   这里只把解密结果留在内存里传给发请求的函数，**不打印、不落盘**。
 */

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const https = require('node:https');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
app.setPath('userData', path.join(APPDATA, 'writetool'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

/** 从用户真库里取硅基流动那条连接的密钥（只在内存里用） */
function siliconKey() {
  const dir = path.join(APPDATA, 'writetool');
  const db = new DatabaseSync(path.join(dir, 'writetool.db'), { readOnly: true });
  const all = db.prepare('SELECT id, name, protocol, base, model FROM connections').all();
  for (const c of all) {
    const enc = db.prepare('SELECT key_enc FROM connection_secrets WHERE connection_id = ?').get(c.id);
    if (!enc || !enc.key_enc) continue;
    let plain = null;
    try { plain = safeStorage.decryptString(Buffer.from(enc.key_enc, 'base64')); }
    catch (e) { console.log(`  ${c.name}（${c.protocol}）解不开：${e.message}`); continue; }
    // ⚠ 不要打印内容，只打前缀形状与长度 —— 密钥进日志等于公开
    console.log(`  候选 ${c.name}（${c.protocol} ${String(c.base).slice(0, 40)}）`
      + ` key 长度 ${plain.length} 前缀 ${plain.slice(0, 3)}…`);
    if (/siliconflow/i.test(String(c.base))) return plain;
  }
  db.close();
  return null;
}

const KEY = process.env.SF_KEY;   // 优先用外部注入；否则从库里解

function pad(n) { return '之'.repeat(n); }

function shot(label, filler) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'Qwen/Qwen3-8B',
      stream: true,
      temperature: 0.3,
      max_tokens: 256,
      // ⚠ 加一个 system 把体积撑起来，其余字段与真实请求一致
      messages: [
        { role: 'system', content: pad(filler) },
        { role: 'user', content: '只回复两个字：收到' },
      ],
    });
    const payload = Buffer.from(body, 'utf8');
    const t0 = Date.now();
    console.log(`\n--- ${label}：正文 ${payload.length} 字节 ---`);

    const req = https.request({
      hostname: 'api.siliconflow.cn',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: 'text/event-stream',
        authorization: `Bearer ${KEY}`,
      },
      // ⚠ 显式不设 timeout，验证 Node 默认行为
    }, (res) => {
      console.log(`  ${Date.now() - t0}ms 收到响应头 ${res.statusCode}`);
      let first = true;
      let got = 0;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (first) { first = false; console.log(`  ${Date.now() - t0}ms 第一个字节`); }
        got += c.length;
        // ⚠ 4xx 要看清原因：401 到底是 key 不对还是别的，一句状态码不够
        if (res.statusCode >= 400 && buf.length < 400) buf += c;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) console.log(`  错误正文：${buf.slice(0, 300)}`);
        else console.log(`  ${Date.now() - t0}ms 结束，共 ${got} 字节`);
        resolve();
      });
    });
    req.on('socket', (s) => {
      console.log(`  ${Date.now() - t0}ms 拿到 socket，socket.timeout=${s.timeout}`);
      s.on('timeout', () => {
        console.log(`  ⚠ ${Date.now() - t0}ms socket 发来 timeout 事件`);
      });
    });
    req.on('error', (e) => {
      console.log(`  ${Date.now() - t0}ms 失败 code=${e.code} msg=${e.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

app.whenReady().then(async () => {
  const key = KEY || siliconKey();
  if (!key) { console.error('❌ 取不到硅基流动的密钥'); app.exit(2); return; }
  console.log('密钥已就绪（长度 ' + key.length + '，不打印内容）');

  // 与我 e2e 里成功那次同量级 → 基线
  await shot('A 小请求（对齐我成功的 e2e）', 20);
  // 逐级放大，逼近用户现场的 78KB
  for (const n of [2000, 8000, 20000, 26000]) {
    await shot(`B 放大到约 ${n * 3} 字节`, n);
  }
  app.exit(0);
});
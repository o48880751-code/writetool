/**
 * 探针：OpenAI 兼容的聚合站（硅基流动）上怎么**真正关掉** Qwen3 的思考。
 *
 * ## 为什么值得单独探
 *
 * 羽毛菌的 config 里 thinkLevel='off'，但实测 Qwen/Qwen3-8B 照样吐
 * reasoning_content（第一轮 661 字、第二轮 522 字）。第二轮跑了 60 秒、
 * **正文一个字都没有** —— 用户看到的就是"转圈半天，然后什么都没有"。
 *
 * 现在的 off 走的是 openrouter 那套（reasoning.effort），硅基流动
 * 根本不认这个字段，于是思考根本没关掉。
 *
 * 这个脚本把几种候选形态各打一次，比出哪个真的把思考关住了。
 * ⚠ 只读：不改配置、不写库、不打明文密钥。
 *
 * 用法：.\electron-run.cmd diag-think-off.js
 */
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const USER_DIR = path.join(APPDATA, 'writetool');
app.setPath('userData', USER_DIR);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const PROMPT = process.env.PROBE_PROMPT || '用一句话解释什么是"江湖"。';

function load() {
  const config = JSON.parse(fs.readFileSync(path.join(USER_DIR, 'config.json'), 'utf8'));
  const db = new DatabaseSync(path.join(USER_DIR, 'writetool.db'), { readOnly: true });
  const conns = db.prepare('SELECT * FROM connections').all();
  const secrets = new Map(db.prepare('SELECT * FROM connection_secrets').all()
    .map((s) => [s.connection_id, s.key_enc]));
  db.close();
  return { config, conns, secrets };
}

function keyOf(secrets, id) {
  const enc = secrets.get(id);
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
  catch (_) { return null; }
}

/**
 * 打一次。
 *
 * ⚠ 这里**自己发 HTTP**，不复用 chatStream —— 因为要比的正是
 *   `buildRequestBody` 拼出来的那几个字段，用它就变成"拿被测对象
 *   去验证被测对象"了。SSE 的解析反过来可以复用 handleLine：
 *   那是另一件事，探针不需要关心。
 */
function probe(provider, cfg, extra, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let text = ''; let think = ''; let settled = false;
    const fin = (o) => { if (!settled) { settled = true; resolve({ ...o, ms: Date.now() - t0 }); } };
    const timer = setTimeout(() => fin({ ok: false, err: '120 秒超时' }), 120000);

    const body = {
      model: cfg.model,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
      temperature: 0.3,
      max_tokens: 1024,
      ...extra,
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(cfg.base + cfg.chatPath);
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: 'text/event-stream',
        authorization: `Bearer ${cfg.apiKey}`,
      },
    }, (res) => {
      if (res.statusCode >= 400) {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => { clearTimeout(timer); fin({ ok: false, err: `${res.statusCode} ${b.slice(0, 300)}` }); });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      const eat = (raw) => provider.handleLine(raw, cfg, cfg.engine, {
        onText: (t) => { text += t; },
        onThink: (t) => { think += t; },
        onTool: () => {},
      });
      res.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) eat(l);
      });
      res.on('end', () => { if (buf.trim()) eat(buf); clearTimeout(timer); fin({ ok: true, text, think }); });
      res.on('error', (e) => { clearTimeout(timer); fin({ ok: false, err: e.message }); });
    });
    req.on('error', (e) => { clearTimeout(timer); fin({ ok: false, err: e.message }); });
    req.write(payload);
    req.end();
  });
}

app.whenReady().then(async () => {
  const provider = require('./electron/provider.js');
  const { config, conns, secrets } = load();
  const c = conns.find((x) => x.id === config.activeConnectionId) || conns[0];
  const apiKey = keyOf(secrets, c.id);

  const cfg = {
    engine: c.protocol,
    base: String(c.base || '').replace(/\/+$/, ''),
    model: process.env.PROBE_MODEL || c.model,
    apiKey,
    chatPath: '/chat/completions',
    numCtx: 8192, maxOutput: 1024, temperature: 0.3,
    thinkLevel: 'off', thinkStyle: '',
  };
  console.log(`连接：${c.name}  模型：${cfg.model}  地址：${cfg.base}`);
  console.log(`提问：${PROMPT}\n`);

  // PROBE_SHAPE=B 时只打 B 那一种（用来快速验别的模型能不能吃这个字段）
  const only = process.env.PROBE_SHAPE;
  const shapes = [
    ['A 现状：reasoning.effort=none（openrouter 那套）', { reasoning: { effort: 'none' } }],
    ['B enable_thinking: false（Qwen 官方扩展）', { enable_thinking: false }],
    ['C chat_template_kwargs.enable_thinking=false（vLLM 那套）', { chat_template_kwargs: { enable_thinking: false } }],
    ['D 什么都不发（让服务商自己决定）', {}],
  ].filter(([label]) => !only || label.startsWith(only));

  for (const [label, extra] of shapes) {
    const r = await probe(provider, cfg, extra, label);
    if (r.ok) {
      console.log(`${label}
    → ${r.ms}ms  思考 ${r.think.length} 字  正文 ${r.text.length} 字`
        + `  ${r.think.length ? '⚠ 还在思考' : '✅ 没思考'}`);
    } else {
      console.log(`${label}
    → ❌ ${r.ms}ms  ${r.err}`);
    }
  }

  app.quit();
}).catch((e) => { console.error('脚本崩了：', e); app.quit(); });

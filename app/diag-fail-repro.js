/**
 * 复现 2026-10-15 羽毛菌报的「聊天失败」。
 *
 * 三个症状：
 *   1. 只有思考、没有正文，正文处留一个空白气泡
 *   2. 第二次直接卡在「…」
 *   3. 本地模型报 400：{"error":"Value looks like object, but can't find closing '}' symbol"}
 *
 * 这个脚本**只读**：不改 config.json、不写库、不落消息。
 * 它做两件事：
 *   A. 用真实配置 + 真实密钥打一轮（带三个工具），看模型到底吐了什么
 *   B. 把 A 拿到的工具调用按 appendToolTurn 组进历史，再打第二轮
 *      —— 第二轮就是「工具结果接回历史」那一步，本地模型 400 就出在这里
 *
 * ⚠ 密钥靠 electron 的 safeStorage 解（Windows 走 DPAPI + OSCrypt），
 *   裸 node 解不开，必须 `.\electron-run.cmd diag-fail-repro.js`。
 */
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const USER_DIR = path.join(APPDATA, 'writetool');

app.setPath('userData', USER_DIR);
app.disableHardwareAcceleration();
// ⚠ 只调 disableHardwareAcceleration 不够：无窗口跑脚本时 GPU 子进程会反复
//   exit_code=-1073741819 然后 FATAL 把脚本带走（第一次跑就死在第 1 轮）。
//   in-process-gpu 是让渲染/GPU 活过来的关键，与 main.js 里那几行同源。
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const LIMIT_MS = Number(process.env.REPRO_LIMIT_MS || 180000);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function load() {
  const config = readJson(path.join(USER_DIR, 'config.json'));
  const db = new DatabaseSync(path.join(USER_DIR, 'writetool.db'), { readOnly: true });
  const conns = db.prepare('SELECT * FROM connections').all();
  const secrets = new Map(db.prepare('SELECT * FROM connection_secrets').all()
    .map((s) => [s.connection_id, s.key_enc]));
  // 最近一条用户消息当提问——复现要用的就是它
  const lastUser = db.prepare(
    "SELECT content FROM messages WHERE role='user' ORDER BY rowid DESC LIMIT 1").get();
  db.close();
  return { config, conns, secrets, prompt: (lastUser && lastUser.content) || '你好' };
}

function keyOf(secrets, id) {
  const enc = secrets.get(id);
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
  catch (_) { return null; }
}

/** 打一轮，把「看到了什么」全量记下来 */
function oneRound(provider, cfg, messages, tools, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let text = '';
    let think = '';
    let calls = null;
    let settled = false;
    const fin = (o) => { if (!settled) { settled = true; resolve({ ...o, ms: Date.now() - t0 }); } };
    const timer = setTimeout(() => fin({ ok: false, err: `脚本超时 ${LIMIT_MS}ms` }), LIMIT_MS);

    console.log(`\n[${tag}] 发出：messages=${messages.length}  tools=${tools ? tools.length : 0}`);
    try {
      provider.chatStream(cfg, messages, {
        tools: tools || undefined,
        onChunk: (c) => { text += c; },
        onThink: (t) => { think += t; },
        onToolCalls: (cs) => { calls = cs; },
        onDone: (meta) => {
          clearTimeout(timer);
          fin({ ok: true, text, think, calls, meta });
        },
        onError: (e) => { clearTimeout(timer); fin({ ok: false, err: e.message }); },
      });
    } catch (e) {
      clearTimeout(timer);
      fin({ ok: false, err: 'throw: ' + e.message });
    }
  });
}

function report(r, tag) {
  if (r.ok) {
    console.log(`[${tag}] ✅ ${r.ms}ms  思考=${r.think.length}字  正文=${r.text.length}字`
      + `  工具调用=${r.calls ? r.calls.length : 0}  meta=${JSON.stringify(r.meta)}`);
    if (r.think) console.log(`     思考尾部：${JSON.stringify(r.think.slice(-160))}`);
    if (r.text) console.log(`     正文头部：${JSON.stringify(r.text.slice(0, 160))}`);
    if (r.calls) {
      for (const c of r.calls) {
        console.log(`     工具 ${c.name}  argsRaw=${JSON.stringify(String(c.argsRaw || '').slice(0, 80))}`
          + `  args=${JSON.stringify(c.args).slice(0, 120)}`
          + (c.parseError ? `  ⚠ parseError=${c.parseError}` : ''));
      }
    }
  } else {
    console.log(`[${tag}] ❌ ${r.ms}ms  ${r.err}`);
  }
}

app.whenReady().then(async () => {
  const provider = require('./electron/provider.js');
  const presets = require('./electron/provider-presets.js');
  const tools = require('./electron/tools.js');

  const { config, conns, secrets, prompt } = load();
  console.log('safeStorage 可用：', safeStorage.isEncryptionAvailable());
  console.log('在用连接：', config.activeConnectionId);
  console.log('用户提问长度：', prompt.length, '字');

  const toolDefs = tools.pickToolDefs(null);   // 不传 = 三个都给
  console.log('工具定义：', toolDefs.map((t) => t.function.name).join(', '));

  // 只要前 1200 字就够触发同样的行为，省得等太久
  const ask = prompt.slice(0, 1200);

  for (const c of conns) {
    const apiKey = keyOf(secrets, c.id);
    const preset = c.provider_key ? presets.get(c.provider_key) : null;
    const cfg = {
      engine: c.protocol,
      base: String(c.base || '').replace(/\/+$/, ''),
      model: c.model,
      apiKey,
      modelsPath: (preset && preset.modelsPath) || (c.protocol === 'ollama' ? '/api/tags' : '/models'),
      chatPath: (preset && preset.chatPath)
        || (c.protocol === 'ollama' ? '/api/chat'
          : c.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'),
      numCtx: 8192,
      maxOutput: 8192,
      temperature: 0,
      thinkLevel: 'off',
      thinkStyle: '',
    };

    console.log(`\n${'='.repeat(70)}\n连接：${c.name}  engine=${cfg.engine}  model=${cfg.model}`);
    console.log(`  base=${cfg.base}  chatPath=${cfg.chatPath}  key=${apiKey ? '有' : '无'}`);

    const messages = [
      { role: 'system', content: '你是一位中文小说写作助手。' },
      { role: 'user', content: ask },
    ];

    const r1 = await oneRound(provider, cfg, messages, toolDefs, '第1轮');
    report(r1, '第1轮');

    // ---- 第二轮：把工具调用接回历史 ----
    const calls = (r1.calls && r1.calls.length)
      ? r1.calls
      : [{ id: 'call_0', name: 'terminal',
           args: { command: 'Get-ChildItem' }, argsRaw: '{"command":"Get-ChildItem"}' }];
    if (!r1.calls || !r1.calls.length) {
      console.log('     （第1轮没产生工具调用，用一条假的顶上来——测的就是回放这条路）');
    }
    const results = calls.map(() => ({ ok: true, output: '（模拟的工具输出）' }));

    const hist2 = provider.appendToolTurn(cfg.engine, [
      ...messages,
      { role: 'assistant', content: r1.text || '' },
    ], calls, results);

    console.log('\n回放给服务端的 assistant.tool_calls：');
    const lastA = [...hist2].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
    console.log('  ' + JSON.stringify(lastA && lastA.tool_calls).slice(0, 300));

    const r2 = await oneRound(provider, cfg, hist2, toolDefs, '第2轮');
    report(r2, '第2轮');
  }

  app.quit();
}).catch((e) => { console.error('脚本崩了：', e); app.quit(); });

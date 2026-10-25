/**
 * 真机诊断：用真实配置 + 真实密钥，分别打两条连接，看谁通谁不通。
 *
 * ⚠ 只读。不改 config.json、不写数据库、不发消息落库。
 * ⚠ 绝不打明文密钥 —— 只打长度与前缀。
 *
 * 为什么要用 electron 跑而不是裸 node：
 *   密钥是 safeStorage 加密的（Windows 走 DPAPI），
 *   裸 node 拿不到 electron 的 safeStorage，解不开。
 *   而且 isEncryptionAvailable() 必须在 app ready 之后量。
 *
 * 用法：.\electron-run.cmd diag-provider-live.js
 */
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const APPDATA = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
const USER_DIR = path.join(APPDATA, 'writetool');

/**
 * ⚠⚠ 这两行必须在 app ready **之前**。
 *
 * userData 不指到用户真实目录的话，safeStorage 读不到 `Local State`
 * 里那把密钥 —— Windows 上 Electron 的 safeStorage 不是"直接 DPAPI
 * 加密那段明文"，而是 Chrome 的 OSCrypt：一把随机 key 用 DPAPI 保护后
 * 存在 userData/Local State，真正的密文是用那把 key 加的。
 * 路径不对 → 解密一律失败，报错长得像"密文损坏"。
 *
 * GPU 禁用是因为无窗口跑脚本时 GPU 进程会反复崩，
 * 崩到最后 FATAL 直接把脚本带走（第一次跑就死在硅基流动那一步）。
 */
app.setPath('userData', USER_DIR);
app.disableHardwareAcceleration();

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(USER_DIR, 'config.json'), 'utf8'));
}

function readConnections() {
  const db = new DatabaseSync(path.join(USER_DIR, 'writetool.db'), { readOnly: true });
  const conns = db.prepare('SELECT * FROM connections').all();
  const secrets = db.prepare('SELECT * FROM connection_secrets').all();
  const byId = new Map(secrets.map((s) => [s.connection_id, s.key_enc]));
  db.close();
  return { conns, secrets: byId };
}

function decryptKey(enc) {
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (e) {
    return { __err: e.message };
  }
}

function ask(provider, cfg, prompt, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let text = '';
    let settled = false;
    const fin = (o) => { if (!settled) { settled = true; resolve({ ...o, ms: Date.now() - t0 }); } };
    const timer = setTimeout(() => fin({ ok: false, err: '本脚本 40 秒超时' }), 40000);
    try {
      provider.chatStream(cfg, [{ role: 'user', content: prompt }], {
        onChunk: (c) => { text += c; },
        onThink: () => {},
        onToolCalls: () => {},
        onDone: () => { clearTimeout(timer); fin({ ok: true, text }); },
        onError: (e) => { clearTimeout(timer); fin({ ok: false, err: e.message }); },
      });
    } catch (e) {
      clearTimeout(timer);
      fin({ ok: false, err: 'throw: ' + e.message });
    }
  });
}

app.whenReady().then(async () => {
  const provider = require('./electron/provider.js');
  const presets = require('./electron/provider-presets.js');

  console.log('safeStorage 可用：', safeStorage.isEncryptionAvailable());
  const config = readConfig();
  const { conns, secrets } = readConnections();

  console.log('\nconfig.json 里的全局字段：');
  console.log('  activeConnectionId =', JSON.stringify(config.activeConnectionId));
  console.log('  engine             =', JSON.stringify(config.engine));
  console.log('  model （全局）     =', JSON.stringify(config.model));
  console.log('  base  （全局）     =', JSON.stringify(config.base));
  console.log('  toolsEnabled       =', config.toolsEnabled, '｜ autoSkill =', config.autoSkill);

  console.log('\n连接的模型名：');
  for (const c of conns) {
    const key = decryptKey(secrets.get(c.id));
    const keyInfo = key == null ? '(无)'
      : (typeof key === 'object' ? '(解密失败: ' + key.__err + ')'
        : '(明文长度 ' + key.length + ', 前缀 ' + key.slice(0, 6) + ')');
    console.log(`  ${c.id}`);
    console.log(`    ${c.name}  ${c.protocol}  base=${c.base}`);
    console.log(`    model=${JSON.stringify(c.model)}  key=${keyInfo}`);
  }

  // ---- 逐条真打 ----
  console.log('\n================ 逐条实打 ================');
  for (const c of conns) {
    const key = decryptKey(secrets.get(c.id));
    const apiKey = (typeof key === 'object') ? null : key;
    const preset = c.provider_key ? presets.get(c.provider_key) : null;
    const modelsPath = (preset && preset.modelsPath)
      || (c.protocol === 'ollama' ? '/api/tags' : '/models');
    const chatPath = (preset && preset.chatPath)
      || (c.protocol === 'anthropic' ? '/v1/messages'
        : c.protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions');

    const cfg = {
      engine: c.protocol,
      base: String(c.base || '').replace(/\/+$/, ''),
      model: c.model,
      apiKey,
      modelsPath,
      chatPath,
      numCtx: 8192,
      maxOutput: 256,
      reserve: 128,
      temperature: 0,
      thinkLevel: 'off',
      thinkStyle: '',
    };

    console.log(`\n--- ${c.name}（model=${cfg.model}）---`);
    const r = await ask(provider, cfg, '只回复两个字：收到', c.name);
    console.log(r.ok ? `  ✅ 通  ${r.ms}ms  回复=${JSON.stringify((r.text || '').slice(0, 40))}`
      : `  ❌ 不通 ${r.ms}ms  ${r.err}`);
  }

  /**
   * 关键的交叉验证：**用错模型名**打每条连接。
   * 这直接模拟「界面传了上一个连接的模型名」这个 bug。
   */
  console.log('\n================ 交叉验证：串味的模型名 ================');
  const current = config.model;
  for (const c of conns) {
    if (c.model === current) continue;
    const key = decryptKey(secrets.get(c.id));
    const apiKey = (typeof key === 'object') ? null : key;
    const preset = c.provider_key ? presets.get(c.provider_key) : null;
    const cfg = {
      engine: c.protocol,
      base: String(c.base || '').replace(/\/+$/, ''),
      model: current,                                  // ← 故意用错
      apiKey,
      modelsPath: (preset && preset.modelsPath) || (c.protocol === 'ollama' ? '/api/tags' : '/models'),
      chatPath: (preset && preset.chatPath)
        || (c.protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions'),
      numCtx: 8192, maxOutput: 256, reserve: 128,
      temperature: 0, thinkLevel: 'off', thinkStyle: '',
    };
    console.log(`\n--- ${c.name} 收到错误的模型名 ${JSON.stringify(current)} ---`);
    const r = await ask(provider, cfg, '只回复两个字：收到');
    console.log(r.ok ? `  ⚠️ 竟然通了 ${r.ms}ms`
      : `  → 报错 ${r.ms}ms  ${r.err}`);
  }

  app.quit();
}).catch((e) => { console.error('脚本崩了：', e); app.quit(); });

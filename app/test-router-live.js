/**
 * 自动路由的**端到端真机链路**判据（node 直接跑，不需要 Electron）。
 *
 * 为什么还要这个：`test-skill-router.js` 把 `ask` 桩掉了，
 * 它验的是路由器的**决策逻辑**；而 `eval-skill-routing.js` 用自己的
 * HTTP 调用打 Ollama，验的是**提示词质量**。两者都没碰过的中间那一段是：
 *
 *   磁盘技能库 → store.skillIndex() → skill-router → provider.chatStream → 模型
 *
 * 这一段里最容易坏的是 `askOnce`（把回调式 chatStream 包成 Promise）：
 * 包错了就是「模型答得好好的，但路由拿不到文本」→ 静默空数组。
 * 所以这里走**真 provider 通道**跑几条真实消息。
 *
 * ⚠ 用的是临时库 + 临时目录，不碰用户的真实数据。
 * ⚠ 本机模型：qwen3:latest（8.2B）。没有 qwen3:8b 这个 tag。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const { Store } = require(path.join(ROOT, 'db', 'store.js'));
const { loadBuiltin } = require(path.join(ROOT, 'db', 'builtin-skills.js'));
const provider = require(path.join(__dirname, 'electron', 'provider.js'));
const presets = require(path.join(__dirname, 'electron', 'provider-presets.js'));
const skillRouter = require(path.join(__dirname, 'electron', 'skill-router.js'));

const MODEL = process.env.WT_EVAL_MODEL || 'qwen3:latest';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-live-'));
const db = new Store(path.join(tmp, 'writetool.db'));
db.seedBuiltinSkills(loadBuiltin);

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); } else {
    fail++; console.log('  ✗', name, extra ? `　${extra}` : '');
  }
};

// ---------------------------------------------------------------
// 抄 main.js 的 askOnce —— 不 require main.js（它依赖 electron 的 app）。
// ⚠ 抄的代价是「漂移」：main.js 那边改了这里不会跟着改。
//   所以下面加了一条「与 main.js 的 thinkLevel 一致」的判据兜底。
// ---------------------------------------------------------------
const OLLAMA = presets.get('ollama');
const cfg = {
  engine: 'ollama',
  base: OLLAMA.base,
  model: MODEL,
  apiKey: null,
  modelsPath: OLLAMA.modelsPath,
  chatPath: OLLAMA.chatPath,
  numCtx: 8192,
  maxOutput: 1024,
  reserve: 512,
  temperature: 0,
  thinkLevel: 'off',
  thinkStyle: '',
};

function askOnce(prompt, o = {}) {
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const timer = setTimeout(
      () => done(reject, new Error(`路由超时（${timeoutMs}ms）`)), timeoutMs);
    try {
      provider.chatStream(cfg, [{ role: 'user', content: prompt }], {
        onChunk: (c) => { text += c; },
        onThink: () => {},
        onToolCalls: () => {},
        onDone: () => { clearTimeout(timer); done(resolve, text); },
        onError: (e) => { clearTimeout(timer); done(reject, e); },
      });
    } catch (e) {
      clearTimeout(timer);
      done(reject, e);
    }
  });
}

(async () => {
  console.log(`\n=== 自动路由端到端链路（${MODEL}）===\n`);

  // ---- 判据 0：真 provider 通道本身能出话 ----
  const warm = await askOnce('只回复两个字：收到', { timeoutMs: 120000 });
  t('provider 通道能返回文本（预热）', typeof warm === 'string' && warm.length > 0,
    JSON.stringify(warm).slice(0, 80));

  // ---- 判据 1：索引来自磁盘，不是手抄 ----
  const index = db.skillIndex(null);
  console.log(`\n索引 ${index.length} 条：${index.map((x) => x.id).join(', ')}`);
  t('索引有 6 条', index.length === 6, `实际 ${index.length}`);
  t('索引里每条都带 description',
    index.every((x) => x.description && x.description.length > 10));
  t('索引是本机真库（临时目录）',
    db.listAllSkills(null).every((x) => x.type === 'built-in'));

  // ---- 判据 2：真链路跑真实消息 ----
  const CASES = [
    { q: '续写下一章', want: 'sk-novel-writer' },
    { q: '第七章写得不行，重写一遍', want: 'sk-novel-revisor' },
    { q: '检查一下最近几章有没有前后矛盾', want: 'sk-novel-sync' },
    { q: '写一段他们两个的对话', want: 'sk-novel-dialogue' },
    { q: '润色一下这几段', want: 'sk-novel-polish' },
    { q: '我想要个技能，让它每次写章前先列大纲', want: 'sk-skill-creator' },
    { q: '你好', want: null },
    { q: '今天天气怎么样', want: null },
  ];

  console.log('\n—— 真链路逐条 ——');
  const results = [];
  for (const c of CASES) {
    const started = Date.now();
    let r;
    try {
      r = await skillRouter.route({
        enabled: true, index, question: c.q, manualIds: [], ask: askOnce,
      });
    } catch (e) {
      r = { ids: [], reason: 'throw:' + e.message };
    }
    const ms = Date.now() - started;
    results.push({ ...c, got: r.ids, reason: r.reason, ms });
    const ok = c.want === null ? r.ids.length === 0 : r.ids.includes(c.want);
    console.log(`  ${ok ? '·' : '×'} 「${c.q}」 → ${JSON.stringify(r.ids)}`
      + ` (${r.reason}, ${ms}ms)`);
  }

  const judged = results.filter((r) => r.want !== null);
  const wrong = judged.filter((r) => !r.got.includes(r.want));
  const blanks = results.filter((r) => r.want === null);
  const falsePos = blanks.filter((r) => r.got.length > 0);

  console.log('');
  t(`该命中的 ${judged.length} 条里命中 ${judged.length - wrong.length}`,
    wrong.length === 0,
    wrong.map((r) => `「${r.q}」→${JSON.stringify(r.got)}`).join('; '));
  t(`不该命中的 ${blanks.length} 条全部没命中`,
    falsePos.length === 0,
    falsePos.map((r) => `「${r.q}」→${JSON.stringify(r.got)}`).join('; '));
  t('没有任何一条走了异常降级',
    results.every((r) => !String(r.reason).startsWith('throw')),
    results.filter((r) => String(r.reason).startsWith('throw'))
      .map((r) => r.q + ':' + r.reason).join('; '));

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  console.log(`\n延迟 P50 ${p50}ms｜max ${lat[lat.length - 1]}ms`);

  // ---- 判据 3：抄来的 askOnce 与 main.js 的规格一致 ----
  console.log('\n—— askOnce 与 main.js 是否漂移 ——');
  const src = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
  t('main.js 的 askOnce 仍把 thinkLevel 固定成 off',
    /providerConfig\(\{\s*model:\s*config\.model,\s*thinkLevel:\s*'off'\s*\}\)/
      .test(src));
  t('main.js 的 askOnce 仍然接住 onThink（否则 provider 会报没有消费者）',
    /onThink:\s*\(\)\s*=>\s*\{\s*\}/.test(src));
  t('本测试的 cfg 也是 thinkLevel off', cfg.thinkLevel === 'off');

  const out = path.join(__dirname, 'shots-verify',
    `router-live-${MODEL.replace(/[:.]/g, '_')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    model: MODEL, indexSize: index.length, p50, results,
  }, null, 2));

  console.log(`\n通过 ${pass} / ${pass + fail}`);
  console.log(`结果已写：${out}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  if (fail) process.exitCode = 2;
  process.exit(fail ? 2 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(2);
});

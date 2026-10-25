/**
 * 上下文压缩的**契约**判据（纯 node，不启动 Electron）。
 *
 * ## 钉的是什么
 *
 * 2026-10-16 羽毛菌：「自动压缩应该是看这个来自动压缩啊，而不是默认 8k 吧，
 * 是否启用自动压缩应该有个按钮」。
 *
 * 查下来发现：窗口**本来就传对了**（`connParams` 按连接存），
 * 但有两个真问题：
 *   1. `LoopContextGuard` 有 `enabled`，而 `main.js` **两处构造都没传** →
 *      恒为开，用户根本关不掉
 *   2. 界面拿 `historyBudget`（= numCtx − reserve）当百分比的分母 →
 *      他设 131072 却看到分母 126976，对不上
 *
 * 这两条都是**静默**的：窗口照样生效、压缩照样跑，界面看起来"正常"。
 *
 * 运行：node test-ctx-contract.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (t) => console.log(`\n${t}`);

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(__dirname, 'electron', 'main.js'), 'utf8');
const meterSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'CtxMeter.jsx'), 'utf8');
const setSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'SettingsPage.jsx'), 'utf8');
const guardSrc = fs.readFileSync(path.join(ROOT, 'memory', 'loop-guard.js'), 'utf8');

console.log('上下文压缩契约');

section('一、窗口按连接取，不是全局 8K');
check('★ 两处 new LoopContextGuard 都传了当前连接的 numCtx', () => {
  const all = [...mainSrc.matchAll(/new LoopContextGuard\(\{([\s\S]*?)\}\);/g)];
  assert.strictEqual(all.length, 2, `找到 ${all.length} 处构造（预期 2）`);
  for (const [i, m] of all.entries()) {
    assert.ok(/numCtx:\s*cp(Gen)?\.numCtx/.test(m[1]),
      `第 ${i + 1} 处没传当前连接的 numCtx`);
    assert.ok(/reserve:\s*cp(Gen)?\.reserve/.test(m[1]),
      `第 ${i + 1} 处没传 reserve`);
  }
});
check('★ 兜底链：connParams → config.numCtx → 默认值', () => {
  const cp = fs.readFileSync(path.join(__dirname, 'electron', 'conn-params.js'), 'utf8');
  assert.ok(/pickPositive\(p\.numCtx,\s*f\.numCtx/.test(cp),
    'conn-params.js 没有「连接级 → 全局」的兜底顺序');
});

section('二、开关（羽毛菌：「是否启用自动压缩应该有个按钮」）');
check('★ LoopContextGuard 支持 enabled', () => {
  assert.ok(/this\.enabled\s*=\s*opts\.enabled\s*!==\s*false/.test(guardSrc),
    'LoopContextGuard 不支持 enabled');
  assert.ok(/!this\.enabled/.test(guardSrc), 'ensure() 没有在 enabled=false 时短路');
});
check('★★ 两处构造都传了 enabled（原来恒为开，用户关不掉）', () => {
  const all = [...mainSrc.matchAll(/new LoopContextGuard\(\{([\s\S]*?)\}\);/g)];
  for (const [i, m] of all.entries()) {
    assert.ok(/enabled:\s*config\.autoCompress\s*!==\s*false/.test(m[1]),
      `第 ${i + 1} 处没传 enabled —— 自动压缩关不掉`);
  }
});
check('★ 默认是开（`!== false` 而不是 `=== true`）', () => {
  assert.ok(/config\.autoCompress\s*!==\s*false/.test(mainSrc),
    '默认值写错了 —— 老配置里没有这个字段，写 === true 会让升级后默认关掉');
});
check('★ 设置页有那个开关', () => {
  assert.ok(/autoCompress/.test(setSrc), '设置页没有 autoCompress');
  assert.ok(/自动压缩上下文/.test(setSrc), '开关没有可读的标题');
  assert.ok(/onConfigChange\(\{\s*autoCompress/.test(setSrc), '开关没有写回 config');
});
check('★ 开关是真的 checkbox（键盘可 Tab、读屏能念）', () => {
  assert.ok(/type="checkbox"/.test(setSrc), '不是原生 checkbox');
});

section('三、百分比按窗口算，不按 historyBudget');
check('★ report() 暴露 numCtx 与 reserve', () => {
  assert.ok(/numCtx:\s*this\.budget\.numCtx/.test(guardSrc),
    'report() 没有暴露 numCtx —— 界面拿不到用户设的窗口');
  assert.ok(/reserve:\s*this\.budget\.reserve/.test(guardSrc), 'report() 没有暴露 reserve');
});
check('★★ 分母用 numCtx（= 用户设的窗口），不是 historyBudget', () => {
  assert.ok(/const win = u \? \(u\.numCtx/.test(meterSrc),
    '分母还在用 historyBudget —— 用户设 131072 却被告知分母 126976');
  assert.ok(/pct = win > 0 \? used \/ win/.test(meterSrc), '百分比没按 win 算');
});
check('★ 把「输出预留」显式写出来（否则用户不知道差在哪）', () => {
  assert.ok(/输出预留/.test(meterSrc), '详情里没有说明预留');
});
check('★ 关掉压缩时，指示器要显示出来', () => {
  assert.ok(/u\.enabled === false/.test(meterSrc), 'enabled=false 时界面没有任何表示');
  assert.ok(/已关闭/.test(meterSrc), '没有「已关闭」字样');
});

section('四、本地模型能力：Ollama 会静默封顶');
check('★ 新连接**显式**写窗口参数（不再静默走全局兜底）', () => {
  const i = mainSrc.indexOf("handle('provider:createConnection'");
  assert.ok(i > 0, '找不到 createConnection');
  const seg = mainSrc.slice(i, i + 2200);
  assert.ok(/applyConnParams\(config\.connParams/.test(seg),
    '新建连接没有写 connParams —— 它会退回全局 numCtx（8192）而界面上看不出来');
});
check('★ 新连接**不继承**当前连接的窗口（本地/云端含义不同）', () => {
  const i = mainSrc.indexOf("handle('provider:createConnection'");
  const seg = mainSrc.slice(i, i + 2200);
  assert.ok(!/connParamsOf\(/.test(seg),
    '新连接去读当前连接的窗口了 —— 云端 128K 会被本地当真 num_ctx 发出去，直接爆显存');
});
check('★ 有查模型真实能力的通道', () => {
  assert.ok(/handle\('provider:modelCapability'/.test(mainSrc), '没有 modelCapability');
  assert.ok(/api\/show/.test(mainSrc), '没有调 Ollama /api/show');
  // ⚠ 必须按 key 名匹配，不能写死 model_info 的键
  assert.ok(/context_length\$|max_position_embeddings\$/.test(mainSrc),
    '写死了 model_info 的键 —— Ollama 的键带模型名前缀（qwen3.context_length）');
});
check('★ 查能力失败返回 null，不抛（不能挡住设置页）', () => {
  const i = mainSrc.indexOf("handle('provider:modelCapability'");
  const seg = mainSrc.slice(i, i + 2200);
  assert.ok(/resolve\(null\)/.test(seg), '失败时不是返回 null');
  assert.ok(!/throw/.test(seg), '能力查询里不该有 throw');
});
check('★ 设置页在超出模型能力时给出提示', () => {
  const sp = fs.readFileSync(path.join(__dirname, 'src', 'components', 'SettingsPage.jsx'), 'utf8');
  assert.ok(/静默压到上限/.test(sp), '没有说明「会被静默压到上限」');
  assert.ok(/contextLength/.test(sp), '没有用查到的能力做比较');
});

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `上下文压缩契约：${passed} 通过 / ${failures.length} 失败`
  : `上下文压缩契约：${passed} 通过`);
process.exit(failures.length ? 1 : 0);
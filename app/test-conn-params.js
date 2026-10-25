/**
 * 连接级生成参数的验收测试。
 *
 * ## 这组用例在防什么
 *
 * 三件事，每一件都是"错了不会报错、只是慢慢变笨"的类型：
 *
 * 1. **按连接隔离**。窗口/输出上限/预留如果串到别的连接上，
 *    云端那套参数会在你切回本地时被当成 num_ctx 发出去（爆显存）；
 *    反过来本地的小窗口会污染云端（200K 的窗口按 8K 压，前文全丢）。
 *    两种都不报错。
 *
 * 2. **预留不能把预算挤干**。可用前文 = 窗口 − 预留。
 *    预留顶到窗口，压缩器每轮都走 starved 分支 —— 治理显示成"在工作"，
 *    实际什么都没丢。比不预留更糟，因为它骗过了诊断。
 *
 * 3. **"没设过"和"设成 0"要分开**。前者该用自动值，后者是用户
 *    明确说"我不要预留"。混起来会让"清空输入框"变成"永远不预留"。
 */

const assert = require('assert');
const { resolveConnParams, applyConnParams, DEFAULT_CONN_PARAMS } = require('./electron/conn-params.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function section(t) { console.log(`\n${t}`); }

// ===========================================================
section('一、老配置兜底：没有 connParams 也不能崩');
// ===========================================================

check('★ 没存过 → 退回老字段（迁移前的老用户）', () => {
  const r = resolveConnParams(null, { numCtx: 16384, maxOutput: 4096 });
  assert.strictEqual(r.numCtx, 16384, '老配置的 numCtx 没被用上');
  assert.strictEqual(r.maxOutput, 4096, '老配置的 maxOutput 没被用上');
});

check('★ 老字段也没有 → 用默认值，不能是 0', () => {
  const r = resolveConnParams(null, {});
  assert.strictEqual(r.numCtx, DEFAULT_CONN_PARAMS.numCtx);
  assert.strictEqual(r.maxOutput, DEFAULT_CONN_PARAMS.maxOutput);
  assert.ok(r.numCtx > 0 && r.maxOutput > 0, `给了 0 会让请求直接发不出去：${JSON.stringify(r)}`);
});

check('★ 存过的值优先于老字段', () => {
  const r = resolveConnParams({ numCtx: 200000 }, { numCtx: 8192, maxOutput: 8192 });
  assert.strictEqual(r.numCtx, 200000, '连接自己存的值被老字段盖掉了');
  assert.strictEqual(r.maxOutput, 8192, '没存的项还是要退回老字段');
});

check('★ 界面清空输入框给出 0 时，当"没填"而不是真的 0', () => {
  const r = resolveConnParams({ numCtx: 0, maxOutput: NaN }, { numCtx: 16384, maxOutput: 8192 });
  assert.strictEqual(r.numCtx, 16384, `numCtx=0 被当成真值，窗口变 0：${r.numCtx}`);
  assert.strictEqual(r.maxOutput, 8192, `maxOutput=NaN 被当成真值：${r.maxOutput}`);
});

// ===========================================================
section('二、输出预留：默认自动，且有上限');
// ===========================================================

check('★ 自动值 = 输出上限的一半', () => {
  const r = resolveConnParams(null, { numCtx: 200000, maxOutput: 32768 });
  assert.strictEqual(r.autoReserve, 16384, `自动预留算错了：${r.autoReserve}`);
  assert.strictEqual(r.reserve, 16384, 'reserveAuto 为真时 reserve 应等于自动值');
  assert.strictEqual(r.reserveAuto, true);
});

check('★ 预留不能超过窗口的一半（否则预算被挤干、压缩器 starved）', () => {
  // 本地典型：窗口 8K 却想要 32K 输出 —— 物理不可能，必须封顶
  const r = resolveConnParams({ numCtx: 8192, maxOutput: 32768 }, {});
  assert.ok(r.reserve <= 4096,
    `预留 ${r.reserve} 超过窗口 8192 的一半 —— 可用前文只剩 ${8192 - r.reserve}，压缩器每轮都会 starved`);
  const budget = Math.max(512, r.numCtx - r.reserve);
  assert.ok(budget >= 4096, `可用前文只剩 ${budget}，太小了`);
});

check('★ 用户显式填的预留也要受这个上限约束', () => {
  const r = resolveConnParams({ numCtx: 8192, maxOutput: 8192, reserve: 8000 }, {});
  assert.ok(r.reserve <= 4096, `手填 8000 没被压到窗口的一半：${r.reserve}`);
});

check('★ 显式设 0 = 真的不预留（与"没设过"区分开）', () => {
  const r = resolveConnParams({ maxOutput: 8192, reserve: 0 }, {});
  assert.strictEqual(r.reserve, 0, '用户说不要预留，却被塞了自动值');
  assert.strictEqual(r.reserveAuto, false, '设了 0 不该还显示"自动"');
});

check('自动值下限 1024（窗口很小的时候不能算成 0）', () => {
  const r = resolveConnParams({ numCtx: 4096, maxOutput: 2048 }, {});
  assert.ok(r.reserve >= 1024, `自动预留 ${r.reserve} 太小`);
  assert.ok(r.reserve <= 2048, `超过了窗口 4096 的一半：${r.reserve}`);
});

// ===========================================================
section('三、按连接隔离：改一条不能串到另一条');
// ===========================================================

check('★ 改 A 连接不动 B 连接', () => {
  const all = { A: { numCtx: 8192, maxOutput: 8192 } };
  const r1 = applyConnParams(all, 'B', { numCtx: 200000, maxOutput: 32768 });
  assert.ok(r1.ok, r1.error);
  assert.strictEqual(r1.all.A.numCtx, 8192, 'A 被改动了');
  assert.strictEqual(r1.all.B.numCtx, 200000);

  const r2 = applyConnParams(r1.all, 'A', { numCtx: 16384 });
  assert.strictEqual(r2.all.B.numCtx, 200000, 'B 被 A 的改动带歪了');
  assert.strictEqual(r2.all.A.numCtx, 16384);
  assert.strictEqual(r2.all.A.maxOutput, 8192, 'A 没改的项不该变');
});

check('★ 不改原对象（调用方可能还拿着它做兜底）', () => {
  const all = { A: { numCtx: 8192 } };
  const snapshot = JSON.stringify(all);
  applyConnParams(all, 'A', { numCtx: 32768 });
  assert.strictEqual(JSON.stringify(all), snapshot, '原对象被就地改了');
});

check('★ null 表示恢复自动（把这条键删掉）', () => {
  const r1 = applyConnParams({ A: { numCtx: 8192, reserve: 2048 } }, 'A', { reserve: null });
  assert.ok(r1.ok, r1.error);
  assert.strictEqual(r1.all.A.reserve, undefined, 'reserve 键没被删掉，界面会一直显示手动值');
  assert.strictEqual(r1.all.A.numCtx, 8192, '不该误删别的键');

  // 删掉之后应该回到自动
  const r2 = resolveConnParams(r1.all.A, {});
  assert.strictEqual(r2.reserveAuto, true, '恢复自动后 reserveAuto 还是 false');
});

check('没有连接 id 时拒绝，而不是写进一个 undefined 键', () => {
  const r = applyConnParams({ A: {} }, '', { numCtx: 8192 });
  assert.ok(!r.ok, '空 id 竟然写成功了');
});

check('传 NaN / 负数要被拒（而不是静默存进去）', () => {
  assert.ok(!applyConnParams({}, 'A', { numCtx: NaN }).ok, 'NaN 被存进去了');
  assert.ok(!applyConnParams({}, 'A', { numCtx: -1 }).ok, '负数被存进去了');
});

// ===========================================================
section('四、用户报的那个场景（云端 200K / 输出 32K / 预留 16K）');
// ===========================================================

check('★ 云端 200K：可用前文 ≈ 184K，而不是老实现里的 6K', () => {
  const r = resolveConnParams(null, { numCtx: 200000, maxOutput: 32768 });
  const budget = Math.max(512, r.numCtx - r.reserve);
  assert.strictEqual(r.numCtx, 200000);
  assert.strictEqual(r.reserve, 16384);
  assert.strictEqual(budget, 183616, `可用前文算错了：${budget}`);
  assert.ok(budget > 180000,
    `可用前文只有 ${budget} —— 老实现按 numCtx 全局 8192 算，只有六千多`);
});

check('★ 同一台机器切回本地，窗口不会被云端那个 200K 带过去', () => {
  const cloud = resolveConnParams({ numCtx: 200000, maxOutput: 32768 }, {});
  const local = resolveConnParams({ numCtx: 8192, maxOutput: 8192 }, {});
  assert.strictEqual(local.numCtx, 8192,
    '本地拿到了云端的 200000 —— 这个值会作为 num_ctx 发给 Ollama，直接爆显存');
  assert.ok(local.reserve <= 4096, `本地预留 ${local.reserve} 超过窗口一半`);
  assert.notStrictEqual(local.numCtx, cloud.numCtx);
});

// ===========================================================
console.log('\n----------------------------------------------------');
console.log(`连接级生成参数：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);

/**
 * 审批闸门测试。
 *
 * 这里测的东西一句话说清：**除了用户点「允许」，没有任何路径能让命令跑起来。**
 *
 * 判据全部是「构造一个坏情况，看它是不是拒绝了」，而不是「正常情况能不能过」——
 * 后者只能证明功能在，前者才能证明门是关着的。
 */

const { createApprovalGate, DEFAULT_TIMEOUT_MS } = require('./electron/approval');

let passed = 0; let failed = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function section(x) { console.log(`\n${x}`); }

/** 手动时钟：不靠 setTimeout 计时，测试不该靠睡出来 */
function fakeClock() {
  const timers = new Map();
  let n = 0;
  return {
    setTimer: (fn, ms) => { const id = ++n; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    /** 触发某个已登记的超时 */
    fire: () => {
      for (const [id, t2] of [...timers]) { timers.delete(id); t2.fn(); }
    },
    size: () => timers.size,
  };
}

const CMD = { command: 'Remove-Item -Recurse C:\\', reasons: ['删除类命令'] };

// ============================================================
section('一、只有用户明确允许才会放行');
// ============================================================

t('用户点允许 → 放行', async () => {
  const sent = [];
  const gate = createApprovalGate({ send: (p) => sent.push(p), available: true });
  const p = gate.request(CMD);
  eq(sent.length, 1, '应发出一条审批请求');
  eq(gate.decide(sent[0].id, true), true, 'decide 应命中');
  eq(await p, true, '应放行');
});

t('用户点拒绝 → 拒绝', async () => {
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true });
  const p = gate.request(CMD);
  gate.decide(id, false);
  eq(await p, false, '应拒绝');
});

t('发到界面的载荷含命令原文与危险原因（用户要靠它判断）', async () => {
  let got = null;
  const gate = createApprovalGate({ send: (p) => { got = p; }, available: true });
  const p = gate.request({ command: 'rm x', reasons: ['删除类', '涉及项目外'], outside: true });
  gate.decide(got.id, false);
  await p;
  eq(got.command, 'rm x', '命令原文');
  eq(got.reasons.length, 2, '两条危险原因');
  eq(got.outside, true, '越界标记');
  assert(got.id, '必须带 id，否则回传对不上号');
});

// ============================================================
section('二、坏情况一律拒绝');
// ============================================================

t('★ 没有界面（窗口关着）→ 拒绝，且不发请求', async () => {
  let sent = 0;
  const gate = createApprovalGate({ send: () => { sent++; }, available: false });
  eq(await gate.request(CMD), false, '必须拒绝');
  eq(sent, 0, '不该尝试发请求');
});

t('★ 界面回传非布尔（undefined / "true" / 1）→ 一律拒绝', async () => {
  for (const v of [undefined, null, 'true', 1, {}, 'yes']) {
    let id;
    const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true });
    const p = gate.request(CMD);
    gate.decide(id, v);
    eq(await p, false, `${JSON.stringify(v)} 不该被当成允许`);
  }
});

t('★ 只有一个 true 会被当真允许', async () => {
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true });
  const p = gate.request(CMD);
  gate.decide(id, true);
  eq(await p, true);
});

t('★ 发送抛异常（窗口正在关）→ 拒绝，不挂起', async () => {
  const gate = createApprovalGate({
    available: true,
    send: () => { throw new Error('Object has been destroyed'); },
  });
  eq(await gate.request(CMD), false, '发不出去必须拒绝');
});

t('★ 没人回应 → 超时拒绝', async () => {
  const clock = fakeClock();
  const gate = createApprovalGate({ send: () => {}, available: true,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 1000 });
  const p = gate.request(CMD);
  clock.fire();
  eq(await p, false, '超时必须拒绝');
});

t('★ 决定之后超时定时器被清掉（否则进程两分钟不退出）', async () => {
  const clock = fakeClock();
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 1000 });
  const p = gate.request(CMD);
  eq(clock.size(), 1, '应有一个待触发的定时器');
  gate.decide(id, true);
  eq(await p, true);
  eq(clock.size(), 0, '决定之后定时器必须清掉');
});

t('★ 超时之后再点允许，不再改变结果', async () => {
  const clock = fakeClock();
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: 1000 });
  const p = gate.request(CMD);
  clock.fire();
  eq(await p, false, '先超时 → 拒绝');
  eq(gate.decide(id, true), false, '已结束的审批不该再被命中');
});

t('★ 重复决定同一 id：只有第一次生效', async () => {
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true });
  const p = gate.request(CMD);
  eq(gate.decide(id, true), true, '第一次命中');
  eq(gate.decide(id, false), false, '第二次查不到');
  eq(await p, true, '结果仍是第一次的');
});

t('★ 伪造的 id 一律无效', async () => {
  const gate = createApprovalGate({ send: () => {}, available: true });
  eq(gate.decide('ap-9999', true), false, '不存在的 id 不能放行任何东西');
  eq(gate.decide('', true), false);
  eq(gate.decide(null, true), false);
  eq(gate.decide(undefined, true), false);
});

t('★ 关窗清空：全部按拒绝', async () => {
  let id1; let id2;
  const gate = createApprovalGate({
    available: true,
    send: (x) => { if (!id1) id1 = x.id; else id2 = x.id; },
  });
  const p1 = gate.request(CMD);
  const p2 = gate.request(CMD);
  eq(gate.pending.size, 2);
  eq(gate.cancelAll(), 2, '应清掉两个');
  eq(await p1, false, '第一个拒绝');
  eq(await p2, false, '第二个拒绝');
  eq(gate.pending.size, 0, '表应清空');
});

t('★ 关窗后界面再点允许 → 无效', async () => {
  let id;
  const gate = createApprovalGate({ send: (x) => { id = x.id; }, available: true });
  const p = gate.request(CMD);
  gate.cancelAll();
  eq(await p, false);
  eq(gate.decide(id, true), false, '关窗后的迟到决定不能放行');
});

// ============================================================
section('三、并发多个审批');
// ============================================================

t('两个命令分别批准：结果互不串', async () => {
  const ids = [];
  const gate = createApprovalGate({ send: (x) => ids.push(x.id), available: true });
  const p1 = gate.request({ command: 'safe1' });
  const p2 = gate.request({ command: 'danger', reasons: ['危险'] });
  eq(ids.length, 2);
  eq(ids[0], 'ap-1', 'id 要能区分');
  eq(ids[1], 'ap-2');
  gate.decide(ids[1], true);
  gate.decide(ids[0], false);
  eq(await p1, false);
  eq(await p2, true);
});

t('cancelAll 后 pending 归零', () => {
  const gate = createApprovalGate({ send: () => {}, available: true });
  gate.request(CMD); gate.request(CMD); gate.request(CMD);
  gate.cancelAll();
  eq(gate.pending.size, 0);
});

t('默认超时是 120 秒（够用户看清命令，又不至于永远挂着）', () => {
  eq(DEFAULT_TIMEOUT_MS, 120000);
  const gate = createApprovalGate({ send: () => {}, available: true });
  eq(gate.timeoutMs, 120000, '默认走 DEFAULT_TIMEOUT_MS');
});

// ============================================================
section('四、真实计时器下也能收口（不注入时钟时别挂死）');
// ============================================================

t('用真 setTimeout、5ms 超时 → 到点拒绝', async () => {
  const gate = createApprovalGate({ send: () => {}, available: true, timeoutMs: 5 });
  eq(await gate.request(CMD), false);
});

t('★ 拒绝被调用时不要抛未捕获异常', async () => {
  // 未 await 就触发一次超时：如果 Promise 处理有问题，
  // 会出现 unhandledRejection —— 那是会让主进程崩溃的
  const gate = createApprovalGate({ send: () => {}, available: true, timeoutMs: 5 });
  const p = gate.request(CMD);
  setTimeout(() => { /* 让它自然超时 */ }, 20);
  await p;   // 能 await 到就说明没有崩
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n审批闸门：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

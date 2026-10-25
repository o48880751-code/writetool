/**
 * 上下文治理验收测试。
 *
 * 核心风险只有一个：**压缩破坏 assistant/tool 配对**。
 * Ollama /api/chat 要求 assistant 带 tool_calls 的那条后面必须紧跟 tool 消息，
 * 孤立删掉任何一条，模型下一轮就会停止调工具、直接编正文——
 * 那正是 §3.4「表演调工具」这类退化的来源。
 *
 * 所以这组用例把「配对完整性」作为硬断言，每条用例都查。
 */

const assert = require('assert');
const { LoopContextGuard } = require('./loop-guard.js');

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

/** 硬断言：任何 assistant(tool_calls) 后必须紧跟一条 tool 消息 */
function assertPairsIntact(messages, label) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const nxt = messages[i + 1];
      assert.ok(nxt && nxt.role === 'tool',
        `${label}: 第 ${i} 条 assistant(tool_calls) 后面不是 tool 消息（角色=${nxt ? nxt.role : '无'}）——配对被破坏`);
    }
  }
}

/** system + task + n 组「调工具」轮次 */
function buildLoop(rounds, opt) {
  const messages = [
    { role: 'system', content: '你是小说写作助手。必须按顺序使用工具完成。'.repeat(opt.rep || 1) },
    { role: 'user', content: '请写第 1 章：谢九回到洛阳，在乱葬岗找到铁棺。'.repeat(opt.rep || 1) },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'query_world_bible', arguments: { project_id: 'p', query: '谢九' } } }],
    });
    messages.push({ role: 'tool', name: 'query_world_bible', content: `检索结果${i} `.repeat(opt.toolLen || 40) });
  }
  return messages;
}

console.log('一、预算充足时不动任何东西');

check('未超预算 → 完全不压缩', () => {
  const m = buildLoop(2, {});
  const before = JSON.stringify(m);
  const g = new LoopContextGuard({ messages: m, numCtx: 8192, reserve: 2048 });
  const r = g.ensure();
  assert.strictEqual(r.compressed, false, '不该压缩');
  assert.strictEqual(JSON.stringify(g.messages), before, '消息被改动');
});

check('可关闭治理（A/B 对照用）', () => {
  const m = buildLoop(40, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 200, enabled: false });
  const r = g.ensure();
  assert.strictEqual(r.compressed, false, '关闭后不该压缩');
  assert.strictEqual(g.report().compressions, 0);
});

console.log('\n二、压缩时配对必须完整（这是唯一的硬约束）');

check('超预算 → 压缩且配对完整', () => {
  const m = buildLoop(40, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 200, keepRecentRounds: 3 });
  const r = g.ensure();
  assert.ok(r.compressed, `应压缩，实际 used=${r.used}/${r.budget}`);
  assertPairsIntact(g.messages, '压缩后');
});

check('多次压缩后配对仍完整', () => {
  const m = buildLoop(60, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 200, keepRecentRounds: 2 });
  for (let i = 0; i < 5; i++) {
    g.ensure();
    g.messages.push({
      role: 'assistant', content: '',
      tool_calls: [{ function: { name: 'write_segment', arguments: {} } }],
    });
    g.messages.push({ role: 'tool', name: 'write_segment', content: '正文'.repeat(100) });
    assertPairsIntact(g.messages, `第 ${i} 轮追加后`);
  }
});

check('system 与任务描述永不删除', () => {
  const m = buildLoop(60, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 1500, reserve: 200, keepRecentRounds: 1 });
  g.ensure();
  assert.strictEqual(g.messages[0].role, 'system', 'system 被删了');
  assert.strictEqual(g.messages[1].role, 'user', '任务描述被删了');
  assert.ok(g.messages[0].content.includes('小说写作助手'), 'system 内容被改');
  assert.ok(g.messages[1].content.includes('谢九'), '任务描述被改');
});

check('最近 N 轮被保留', () => {
  const m = buildLoop(40, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 200, keepRecentRounds: 3 });
  g.ensure();
  assert.ok(g.messages.length >= 2 + 3 * 2, `保留轮次过少：${g.messages.length} 条`);
});

console.log('\n三、无可丢时宁可超预算也不破坏协议');

check('只剩 pinned 与已落盘事实 → starved，不乱丢', () => {
  const messages = [
    { role: 'system', content: '系统提示'.repeat(200) },
    { role: 'user', content: '任务描述'.repeat(200) },
    {
      role: 'assistant', content: '',
      tool_calls: [{ function: { name: 'commit_chapter', arguments: { content: '已落盘正文' } } }],
    },
    { role: 'tool', name: 'commit_chapter', content: '已落盘正文'.repeat(2000) },
  ];
  const g = new LoopContextGuard({ messages, numCtx: 800, reserve: 200, keepRecentRounds: 1 });
  const r = g.ensure();
  assert.strictEqual(r.starved, true, `应标记 starved，实际 used=${r.used}/${r.budget}`);
  assert.strictEqual(r.compressed, false, '不该压缩');
  assertPairsIntact(g.messages, 'starved 时');
  assert.strictEqual(g.messages.length, 4, '不该丢任何条目');
  assert.strictEqual(g.report().starvedEvents, 1);
});

check('starved 后继续追加仍能恢复正常', () => {
  const messages = [
    { role: 'system', content: '系统提示'.repeat(200) },
    { role: 'user', content: '任务描述'.repeat(200) },
  ];
  const g = new LoopContextGuard({ messages, numCtx: 1000, reserve: 200, keepRecentRounds: 1 });
  const r1 = g.ensure();
  assert.strictEqual(r1.starved, true, '本应 starved（无工具组可丢）');
  // 追加足够多的可丢内容后应恢复
  for (let i = 0; i < 30; i++) {
    g.messages.push({ role: 'assistant', content: '' });
    g.messages.push({ role: 'tool', name: 'query_world_bible', content: '结果'.repeat(100) });
  }
  const r2 = g.ensure();
  assert.strictEqual(r2.starved, false, `追加后应恢复压缩，实际 starved=${r2.starved}`);
  assert.ok(r2.compressed, '追加后应能压缩');
  assertPairsIntact(g.messages, '恢复后');
});

console.log('\n四、诊断信息可用（排查长篇上下文问题的第一手数据）');

check('report 输出压缩次数与日志', () => {
  const m = buildLoop(40, { toolLen: 200 });
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 200, keepRecentRounds: 2 });
  g.ensure();
  const r = g.report();
  assert.ok(r.compressions >= 1, '压缩次数未记录');
  assert.ok(r.totalDropped > 0, '丢弃数未记录');
  assert.ok(r.usage.includes('%'), '使用率未计算');
  assert.ok(Array.isArray(r.log) && r.log.length >= 1, '日志为空');
  assert.ok(r.log[0].beforeCount > 0, '日志缺压缩前条数');
});

check('压缩确实降低了占用', () => {
  const m = buildLoop(50, { toolLen: 300 });
  const g = new LoopContextGuard({ messages: m, numCtx: 3000, reserve: 300, keepRecentRounds: 2 });
  const before = g.usedTokens();
  g.ensure();
  assert.ok(g.usedTokens() < before, `占用未下降：${before} → ${g.usedTokens()}`);
});

console.log('\n五、极端输入不崩');

check('只有 system 与 user 时不崩', () => {
  const g = new LoopContextGuard({
    messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }],
    numCtx: 100, reserve: 50,
  });
  const r = g.ensure();
  assert.ok(typeof r.starved === 'boolean');
  assert.strictEqual(g.messages.length, 2);
});

check('空 messages 不崩', () => {
  const g = new LoopContextGuard({ messages: [], numCtx: 100 });
  assert.doesNotThrow(() => g.ensure());
});

check('单条超长 tool 结果也能压', () => {
  const m = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'q', arguments: {} } }] },
    { role: 'tool', name: 'q', content: 'x'.repeat(50000) },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'w', arguments: {} } }] },
    { role: 'tool', name: 'w', content: 'y'.repeat(100) },
  ];
  const g = new LoopContextGuard({ messages: m, numCtx: 2000, reserve: 500, keepRecentRounds: 1 });
  g.ensure();
  assertPairsIntact(g.messages, '超长 tool 结果');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`上下文治理：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
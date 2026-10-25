/**
 * Agent 工具循环测试。
 *
 * ## 这个循环的风险在哪
 *
 * 它是**唯一**一段「模型能触发真实副作用」的代码。
 * 出错的表现不是崩溃，而是：命令跑了没人知道、或者模型自己编了个答案
 * 而界面显示一切正常。所以这里钉的是**行为**，不是覆盖率。
 *
 * ## 测法：注入假 chatStream 与假 execTool
 *
 * ⚠ 不连真模型。真模型每次答的内容都不一样，测不了"模型问两次怎么办"
 *   这种确定性行为；而**循环该有的行为**完全由脚本化的模型决定。
 *   夹具脚本化，循环就是纯函数了。
 */

const agentLoop = require('./electron/agent-loop');
const provider = require('./electron/provider');
const { appendToolTurn } = provider;

let passed = 0; let failed = 0;
function check(name, fn) { /* async */ }
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const CFG = { engine: 'ollama', base: 'http://x', model: 'm' };

/**
 * 脚本化的假模型。
 *
 * @param turns 每一轮要回什么。元素可以是：
 *   {text}                     纯正文
 *   {calls:[{id,name,args}]}   要工具
 *   {calls, text}              先说一句再要工具
 *   (轮次) => 上面任一种        每轮都不一样时用（见「防死循环」那组）
 *   ⚠ 最后一轮会被**无限重复**。凡是"模型永远要工具"的用例，
 *     必须用函数形式让每轮的参数不同 —— 否则会撞上
 *     MAX_SAME_CALL 那道重复调用的闸，测的就不是"到上限停"了。
 * @param record 被推入，记录每次收到的历史（只存**长度**与末尾几条）
 *
 * ⚠⚠ 这里必须有硬顶，且**只存摘要不存全量快照**。
 *   变异测试里有一个「上限失效」的变异体，它会无限循环；
 *   夹具若每轮深拷贝整段 history（每轮都在变长），几万轮就 OOM。
 *   ——这跟被测对象无关，是夹具自己的问题。判据不能指望被测对象守规矩。
 */
const HARD_STOP = 40;

function fakeModel(turns, record = []) {
  let i = 0;
  return function chatStream(cfg, messages, handlers) {
    if (i >= HARD_STOP) throw new Error(`夹具硬顶：模型被请求了 ${i} 次，判定为死循环`);
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    record.push({
      len: messages.length,
      toolCount: toolMsgs.length,
      tools: toolMsgs.map((m) => m.content),
      hasToolCalls: messages.some((m) => m.role === 'assistant' && m.tool_calls),
      // 末尾那条 user 消息。不带工具的收尾提示走的不是 tool 消息，
      // 只看 tools 是看不见它的。
      lastUser: String(((messages.filter((m) => m.role === 'user').pop() || {}).content) || ''),
      // assistant 消息上的 reasoning_content（开了思考必须回传的那个字段）
      reasoning: messages.filter((m) => m.role === 'assistant' && m.tool_calls)
        .map((m) => m.reasoning_content).filter(Boolean),
    });
    const raw = turns[Math.min(i, turns.length - 1)];
    const turn = (typeof raw === 'function') ? raw(i) : raw;
    i++;
    // 异步回调：真实实现就是 setImmediate/流事件里触发的，
    // 同步调用会掩盖「循环 await 之前就已完成」的时序错误。
    setTimeout(() => {
      if (turn.text) handlers.onChunk(turn.text);
      if (turn.calls && turn.calls.length) handlers.onToolCalls(turn.calls);
      handlers.onDone({ ms: 1 });
    }, 0);
    return () => {};
  };
}

function collect() {
  const ev = [];
  return {
    ev,
    handlers: {
      onText: (c) => ev.push(['text', c]),
      onThink: (x) => ev.push(['think', x]),
      onToolStart: (c) => ev.push(['toolStart', c.name, JSON.stringify(c.args)]),
      onToolEnd: (c, r) => ev.push(['toolEnd', c.name, r.output]),
      onDone: (m) => ev.push(['done', m]),
      onError: (e) => ev.push(['error', e.message]),
    },
  };
}

function kinds(ev) { return ev.map((x) => x[0]); }
function first(ev, k) { return ev.find((x) => x[0] === k); }

// ============================================================
section('基本循环');
// ============================================================

t('模型一轮就答完 → 不执行任何工具', async () => {
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: '你好' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([{ text: '你好。' }]),
    execTool: async () => { throw new Error('不该被执行'); },
    handlers: c.handlers,
  });
  await run.finished;
  const done = first(c.ev, 'done');
  assert(done, '应当有 done');
  eq(done[1].rounds, 1, '只问了一轮');
  eq(done[1].text, '你好。', '正文应原样带回');
  assert(!c.ev.some((x) => x[0] === 'toolStart'), '不该有工具调用');
});

t('要一次工具 → 执行 → 结果接回历史 → 再问 → 结束', async () => {
  const record = [];
  const c = collect();
  const execed = [];
  const run = agentLoop.createAgentRun({
    cfg: CFG,
    messages: [{ role: 'user', content: '几个文件？' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'terminal', args: { command: 'ls' } }] },
      { text: '一共 24 个。' },
    ], record),
    execTool: async (name, args) => {
      execed.push(name);
      return { ok: true, output: '24' };
    },
    handlers: c.handlers,
  });
  await run.finished;

  eq(execed.length, 1, '工具应执行一次');
  eq(first(c.ev, 'done')[1].rounds, 2, '应该问了两轮');

  // ⚠ 关键断言：第二轮必须**看得见**第一轮的结果
  const second = record[1];
  eq(second.toolCount, 1, '第二轮历史里应有 1 条 tool 结果消息');
  eq(second.tools[0], '24', '工具结果内容');
  // 助手那轮也要把调了什么工具记回去
  assert(second.hasToolCalls, '第二轮历史里应有带 tool_calls 的 assistant');
});

t('连续三轮工具调用：每轮结果都进历史', async () => {
  const record = [];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'web_search' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'web_search', args: { query: 'a' } }] },
      { calls: [{ id: 'c2', name: 'web_search', args: { query: 'b' } }] },
      { text: '结论。' },
    ], record),
    execTool: async (_n, a) => ({ ok: true, output: `结果:${a.query}` }),
    handlers: c.handlers,
  });
  await run.finished;
  eq(record.length, 3, '问了三次');
  eq(first(c.ev, 'done')[1].rounds, 3, '轮数应为 3');
  // 第二轮历史里只应有第一条结果，第三轮才两条都有
  eq(record[1].toolCount, 1, '第二轮只有 1 条工具结果');
  eq(record[1].tools[0], '结果:a');
  eq(record[2].toolCount, 2, '第三轮有 2 条工具结果');
});

t('一次多个并行调用：串行执行，顺序与结果对应', async () => {
  const c = collect();
  const order = [];
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [
        { id: 'a', name: 'terminal', args: { command: 'first' } },
        { id: 'b', name: 'terminal', args: { command: 'second' } },
      ] },
      { text: 'done' },
    ]),
    execTool: async (name, args) => {
      order.push(args.command);
      return { ok: true, output: `out:${args.command}` };
    },
    handlers: c.handlers,
  });
  await run.finished;
  eq(order.join(','), 'first,second', '应按模型给的顺序串行执行');
  const ends = c.ev.filter((x) => x[0] === 'toolEnd');
  eq(ends[0][2], 'out:first');
  eq(ends[1][2], 'out:second');
});

// ============================================================
section('防死循环');
// ============================================================

t('模型永远要工具 → 到上限停，且上限信息回给模型', async () => {
  const record = [];
  const c = collect();
  let n = 0;
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    maxRounds: 3,
    // ⚠ 每轮换一个 command。用同一个参数的话，第 3 轮会先被
    //   MAX_SAME_CALL 那道重复闸拦下 —— 那测的是另一条判据了。
    chatStream: fakeModel([
      (i) => ({ calls: [{ id: `x${i}`, name: 'terminal', args: { command: `step${i}` } }] }),
    ], record),
    execTool: async () => { n++; return { ok: true, output: 'r' }; },
    handlers: c.handlers,
  });
  await run.finished;
  // 3 轮正常 + 1 轮「明说上限」= 4 次请求
  eq(record.length, 4, '应多问一次把上限告诉模型');
  eq(n, 3, '工具只该执行 3 次');
  assert(record[3].tools.some((x) => /上限/.test(String(x))),
    '上限那一轮应带上限说明');
  eq(first(c.ev, 'done')[1].rounds, 3, 'rounds 应停在上限');
});

t('★ 同一条调用反复要 → 不再空转，带着说明收尾', async () => {
  // 2026-10-15 实测的"卡壳"：8B 模型把同一个 web_search 一字不差地重发。
  // 旧版会一路跑满 8 轮、每轮十几秒，用户一个字都拿不到。
  const record = [];
  const c = collect();
  let n = 0;
  const SAME = { id: 'x', name: 'web_search', args: { query: '同一个词' } };
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'web_search' } }],
    maxRounds: 8,                          // 给满 8 轮，看它自己停不停
    chatStream: fakeModel([{ calls: [SAME] }], record),
    execTool: async () => { n++; return { ok: true, output: 'r' }; },
    handlers: c.handlers,
  });
  await run.finished;
  eq(n, 2, '同一条调用最多执行 2 次');
  assert(record.length < 8, `不该跑满上限（实际请求了 ${record.length} 次）`);
  const last = record[record.length - 1];
  assert(last.tools.some((x) => /已经执行过/.test(String(x))),
    '必须把「已经跑过、结果没变」说明白，否则模型只会再试一次');
  assert(/不要再调用工具/.test(last.lastUser),
    `最后那一轮要明确让它别再调工具（实际末尾是：${last.lastUser}）`);
  assert(!/已经执行过/.test(String(first(c.ev, 'toolEnd')[2])),
    '第一次执行的是真结果，不是拦截文案');
});

t('★ 带工具的那一轮要把推理原文回传（DeepSeek 不带就 400）', async () => {
  const record = [];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: { ...CFG, engine: 'openai' },
    messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: (cfg, messages, handlers) => {
      record.push({
        reasoning: messages.filter((m) => m.role === 'assistant' && m.tool_calls)
          .map((m) => m.reasoning_content).filter(Boolean),
      });
      setTimeout(() => {
        if (record.length === 1) {
          handlers.onThink('我先看一眼目录');
          handlers.onToolCalls([{ id: 'c1', name: 'terminal', args: { command: 'ls' } }]);
        } else {
          handlers.onChunk('好了');
        }
        handlers.onDone({});
      }, 0);
      return () => {};
    },
    execTool: async () => ({ ok: true, output: 'a.md' }),
    handlers: c.handlers,
  });
  await run.finished;
  eq(record.length, 2, '应该是两轮');
  assert(record[1].reasoning.includes('我先看一眼目录'),
    '第二轮请求里没带上上一轮的推理原文');
});

t('同一个工具换参数调，不算重复', async () => {
  // 反向用例：只按工具名去重的话，模型连着查三份资料会被误伤
  const c = collect();
  let n = 0;
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'web_search' } }],
    chatStream: fakeModel([
      (i) => (i < 3
        ? { calls: [{ id: `c${i}`, name: 'web_search', args: { query: `词${i}` } }] }
        : { text: '好了' }),
    ]),
    execTool: async () => { n++; return { ok: true, output: 'r' }; },
    handlers: c.handlers,
  });
  await run.finished;
  eq(n, 3, '换了参数就该照常执行');
});

t('默认上限是 8 轮', () => {
  eq(agentLoop.DEFAULT_MAX_ROUNDS, 8, '默认上限');
});

t('循环本身不吞掉不修改传入的 messages', async () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: msgs,
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'terminal', args: { command: 'ls' } }] },
      { text: 'ok' },
    ]),
    execTool: async () => ({ ok: true, output: 'x' }),
    handlers: c.handlers,
  });
  await run.finished;
  eq(msgs.length, 1, '调用方的 messages 不应被追加');
});

// ============================================================
section('错误与取消');
// ============================================================

t('模型报错 → 走 onError，不再执行工具', async () => {
  const c = collect();
  let ran = false;
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: (cfg, messages, handlers) => {
      setTimeout(() => handlers.onError(new Error('ECONNREFUSED')), 0);
      return () => {};
    },
    execTool: async () => { ran = true; return { ok: true }; },
    handlers: c.handlers,
  });
  await run.finished;
  assert(c.ev.some((x) => x[0] === 'error' && /ECONNREFUSED/.test(x[1])), '应报原始错误');
  assert(!ran, '出错后不该执行工具');
});

t('工具抛异常 → 转成失败结果回给模型，循环继续', async () => {
  const record = [];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'terminal', args: { command: 'boom' } }] },
      { text: '抱歉，命令失败了。' },
    ], record),
    execTool: async () => { throw new Error('spawn ENOENT'); },
    handlers: c.handlers,
  });
  await run.finished;
  assert(!c.ev.some((x) => x[0] === 'error'), '工具异常不该炸掉整个循环');
  assert(record[1].tools.some((x) => /spawn ENOENT/.test(String(x))),
    '异常信息要回给模型');
  assert(c.ev.some((x) => x[0] === 'done'), '循环应正常收尾');
});

t('工具返回 undefined → 补一句人话，不给模型 undefined', async () => {
  const record = [];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'terminal', args: { command: 'x' } }] },
      { text: '好' },
    ], record),
    execTool: async () => undefined,
    handlers: c.handlers,
  });
  await run.finished;
  assert(record[1].tools.length === 1
    && String(record[1].tools[0]).length > 0, '结果不能是空的');
});

t('执行中取消 → 剩余工具不执行，且结果如实回「已取消」', async () => {
  const c = collect();
  let count = 0;
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [
        { id: 'a', name: 'terminal', args: { command: 'one' } },
        { id: 'b', name: 'terminal', args: { command: 'two' } },
      ] },
      { text: 'x' },
    ]),
    execTool: async (_n, a) => {
      count++;
      if (a.command === 'one') run.cancel();
      return { ok: true, output: 'out' };
    },
    handlers: c.handlers,
  });
  await run.finished;
  eq(count, 1, '第二条命令不该执行');
  const cancelledEnd = c.ev.filter((x) => x[0] === 'toolEnd' && x[2] === '已取消');
  eq(cancelledEnd.length, 1, '第二条应标记已取消');
});

t('取消后再问模型 → 不会再发新请求', async () => {
  const record = [];
  const c = collect();
  let i = 0;
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ type: 'function', function: { name: 'terminal' } }],
    chatStream: fakeModel([
      { calls: [{ id: 'c1', name: 'terminal', args: { command: 'x' } }] },
      { text: '不该到这里' },
    ], record),
    execTool: async () => { run.cancel(); return { ok: true, output: 'o' }; },
    handlers: c.handlers,
  });
  await run.finished;
  eq(record.length, 1, '取消后不应再请求模型');
});

// ============================================================
section('不发工具 = 老行为不变');
// ============================================================

t('不传 toolDefs → 请求里不带工具，且不进入循环', async () => {
  let gotHandlers = null;
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'hi' }],
    chatStream: (cfg, messages, handlers) => {
      gotHandlers = handlers;
      setTimeout(() => { handlers.onChunk('答案'); handlers.onDone({}); }, 0);
      return () => {};
    },
    handlers: c.handlers,
  });
  await run.finished;
  assert(!('tools' in gotHandlers), '没给工具时不该有 tools 字段');
  eq(first(c.ev, 'done')[1].text, '答案');
});

t('toolDefs 为空数组 → 同样不带 tools', async () => {
  let hasTools = true;
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'hi' }],
    toolDefs: [],
    chatStream: (cfg, messages, handlers) => {
      hasTools = 'tools' in handlers;
      setTimeout(() => { handlers.onChunk('x'); handlers.onDone({}); }, 0);
      return () => {};
    },
    handlers: c.handlers,
  });
  await run.finished;
  assert(!hasTools, '空数组不应下发');
});

// ============================================================
section('三家协议的工具历史');
// ============================================================

t('anthropic 引擎：历史里是 tool_use / tool_result 交替', async () => {
  const msgs = [{ role: 'user', content: 'go' }];
  const out = appendToolTurn('anthropic', msgs,
    [{ id: 'toolu_1', name: 'terminal', args: { command: 'ls' } }],
    [{ output: 'out' }]);
  const asst = out.find((m) => m.role === 'assistant');
  eq(asst.content[0].type, 'tool_use');
  eq(out[out.length - 1].role, 'user', 'Anthropic 的结果在 user 消息里');
  eq(out[out.length - 1].content[0].type, 'tool_result');
});

t('循环把 anthropic 的结果按 user/tool_result 回传', async () => {
  const record = [];
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: { engine: 'anthropic', base: 'http://x' },
    messages: [{ role: 'user', content: 'go' }],
    toolDefs: [{ name: 'terminal', description: 'd', input_schema: { type: 'object' } }],
    // ⚠ 自写模型而非 fakeModel：Anthropic 的 tool_result 落在 user 消息里，
    //   role 不是 'tool'，fakeModel 的摘要快照看不见它。
    //   这里只记第二轮的全量 history（循环只有 2 轮，量很小）。
    chatStream: (cfg, messages, handlers) => {
      if (record.length < 2) record.push(JSON.parse(JSON.stringify(messages)));
      if (record.length === 1) {
        setTimeout(() => {
          handlers.onToolCalls([{ id: 'toolu_1', name: 'terminal', args: { command: 'ls' } }]);
          handlers.onDone({});
        }, 0);
      } else {
        setTimeout(() => { handlers.onChunk('好'); handlers.onDone({}); }, 0);
      }
      return () => {};
    },
    execTool: async () => ({ ok: true, output: '文件列表' }),
    handlers: c.handlers,
  });
  await run.finished;
  // ⚠ 这条不能用 fakeModel 的摘要快照：Anthropic 的工具结果放在
  //   **user 消息**里（role 不是 'tool'），摘要看不见。
  //   所以这里另写一个只记全量的模型 —— 只有一个循环用例用得起。
  const second = record[1];
  const asst = second.find((m) => m.role === 'assistant');
  eq(asst.content[0].type, 'tool_use');
  const res = second[second.length - 1];
  eq(res.role, 'user', 'Anthropic 的结果必须落在 user 消息里');
  eq(res.content[0].type, 'tool_result');
  eq(res.content[0].content, '文件列表');
  // 且 tool_use 的 id 必须和 tool_result 对得上，否则服务端直接 400
  eq(res.content[0].tool_use_id, asst.content[0].id, 'tool_use_id 要配对');
});

t('★ 传了 onChunk 却没传 onText → 立刻报错，不许静默丢正文', () => {
  // 2026-10-15 线上事故：main.js 传的是 onChunk。
  // 键对不上 → if (handlers.onText) 恒为假 → 正文分片被整段丢弃，
  // 而且 onDone 里的 text 也是空的（所以助手消息从来没落过库），
  // 界面却看着一切正常 —— 用户原话是「根本不会回复」。
  //
  // ⚠ 必须在**发出任何请求之前**失败：请求跑完 30 秒才报错等于白等。
  let msg = '';
  let requests = 0;
  try {
    agentLoop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS,
      chatStream: () => { requests++; return () => {}; },
      execTool: async () => ({ ok: true }),
      handlers: {
        onChunk: () => {},          // ← 错的那个名字
        onThink: () => {},
        onDone: () => {},
        onError: () => {},
      },
    });
  } catch (e) { msg = e.message; }
  assert(/onText/.test(msg), `错配没有报错，msg=${JSON.stringify(msg)}`);
  assert(/onChunk/.test(msg), '报错要指出收到的是 onChunk');
  eq(requests, 0, '不该已经发出过请求');
});

t('同名（onText）时一切照旧', async () => {
  const c = collect();
  const run = agentLoop.createAgentRun({
    cfg: CFG, messages: [{ role: 'user', content: 'x' }],
    toolDefs: TOOLS,
    chatStream: fakeModel([{ text: '好了' }]),
    execTool: async () => { throw new Error('不该跑'); },
    handlers: c.handlers,
  });
  await run.finished;
  eq(first(c.ev, 'done')[1].text, '好了', '正文应原样带回');
});

// ============================================================
// 可证伪：抽掉关键逻辑，判据必须变红
// ============================================================
section('可证伪');

/**
 * 真正的可证伪：把 agent-loop.js 改坏，看测试会不会红。
 *
 * ⚠⚠ 之前这两条是**假的**：一条靠 setTimeout 判定「还在跑」，
 *   一条是自己手写了个错误实现然后断言它错 —— 两条都没碰被测对象。
 *   判据不碰产品代码，红绿都是自说自话。
 *
 * 现在改成真变异：复制源码 → 定点破坏 → 加载副本 → 跑同一批判据。
 * 跑之前先确认原实现是绿的（判据自检），否则「变异被抓住」也说明不了什么。
 */
const fs = require('node:fs');
const path = require('node:path');

const LOOP_SRC = path.join(__dirname, 'electron', 'agent-loop.js');
const MUT_DIR = path.join(__dirname, 'electron', '.mutants');

/**
 * 复制一份 agent-loop.js 并就地破坏。副本里的相对 require 要改成 ../。
 *
 * ⚠ 两道自检，缺一道整批变异测试就是自欺欺人：
 *   1. 破坏必须真的改动了源码（replace 没命中 → 变异体等于原实现 → 必然全绿）
 *   2. 改完必须仍是合法 JS（改出语法错就 require 失败，报错与判据无关）
 * 这两条曾经各坑过一次，所以写死在这里。
 */
function makeMutant(label, mutate) {
  if (!fs.existsSync(MUT_DIR)) fs.mkdirSync(MUT_DIR, { recursive: true });
  const before = fs.readFileSync(LOOP_SRC, 'utf8');
  let src = before.replace(/require\('\.\/([a-z-]+)'\)/g, "require('../$1')");
  src = mutate(src);
  assert(src !== before, `变异「${label}」的 replace 没命中，变异体等于原实现`);
  try { new Function(src); }
  catch (e) { throw new Error(`变异「${label}」改出了语法错：${e.message}`); }
  const file = path.join(MUT_DIR, `loop-${label}.js`);
  fs.writeFileSync(file, src, 'utf8');
  return require(file);
}

const TOOLS = [{ type: 'function', function: { name: 'terminal' } }];

/**
 * 这批判据就是「会被变异体弄坏」的那些。
 * 每条只依赖 (loop, rec)，loop 是 createAgentRun 的来源，rec 收历史快照。
 */
const MUTATION_SUITE = [
  ['正文要带回', async (loop, rec) => {
    const c = collect();
    await loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS,
      chatStream: fakeModel([{ text: '答案' }], rec),
      execTool: async () => { throw new Error('不该跑'); },
      handlers: c.handlers,
    }).finished;
    eq(first(c.ev, 'done')[1].text, '答案', '正文应带回');
  }],
  ['工具结果接回历史', async (loop, rec) => {
    const c = collect();
    await loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS,
      chatStream: fakeModel([
        { calls: [{ id: 'c1', name: 'terminal', args: { command: 'ls' } }] },
        { text: '好' },
      ], rec),
      execTool: async () => ({ ok: true, output: '24' }),
      handlers: c.handlers,
    }).finished;
    assert(rec[1] && rec[1].tools.includes('24'), '第二轮应看到工具结果');
  }],
  ['请求与执行次数封顶', async (loop, rec) => {
    const c = collect();
    let n = 0;
    await loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS, maxRounds: 3,
      // ⚠ 参数必须每轮不同：用同一个参数的话，重复闸（MAX_SAME_CALL）
      //   会在第 3 轮先停下 —— 那样「上限失效」这个变异体就再也跑不到
      //   HARD_STOP，变异测试会**假绿**（破坏被另一道闸挡住了）。
      chatStream: fakeModel([
        (i) => ({ calls: [{ id: `x${i}`, name: 'terminal', args: { command: `a${i}` } }] }),
      ], rec),
      execTool: async () => { n++; return { ok: true, output: 'r' }; },
      handlers: c.handlers,
    }).finished;
    assert(n <= 3, `执行次数应封顶（实际 ${n}）`);
    assert(rec.length <= 5, `请求次数应封顶（实际 ${rec.length}）`);
  }],
  ['重复调用不再拦', async (loop) => {
    const c = collect();
    let n = 0;
    const SAME = { id: 'x', name: 'web_search', args: { query: '同一个词' } };
    await loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS, maxRounds: 8,
      chatStream: fakeModel([{ calls: [SAME] }]),
      execTool: async () => { n++; return { ok: true, output: 'r' }; },
      handlers: c.handlers,
    }).finished;
    assert(n <= 2, `同一条调用不该被执行超过 2 次（实际 ${n}）`);
  }],
  ['停止后不再执行余下命令', async (loop, rec) => {
    const c = collect();
    let count = 0; let run;
    run = loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS,
      chatStream: fakeModel([
        { calls: [
          { id: 'a', name: 'terminal', args: { command: 'one' } },
          { id: 'b', name: 'terminal', args: { command: 'two' } },
        ] },
        { text: 'x' },
      ], rec),
      execTool: async (_n, a) => {
        count++;
        if (a.command === 'one') run.cancel();
        return { ok: true, output: 'o' };
      },
      handlers: c.handlers,
    });
    await run.finished;
    eq(count, 1, '取消后不该再执行第二条命令');
  }],
  ['工具异常不炸循环', async (loop, rec) => {
    const c = collect();
    await loop.createAgentRun({
      cfg: CFG, messages: [{ role: 'user', content: 'x' }],
      toolDefs: TOOLS,
      chatStream: fakeModel([
        { calls: [{ id: 'c1', name: 'terminal', args: { command: 'boom' } }] },
        { text: '失败' },
      ], rec),
      execTool: async () => { throw new Error('spawn ENOENT'); },
      handlers: c.handlers,
    }).finished;
    assert(!c.ev.some((x) => x[0] === 'error'), '工具异常不该炸掉循环');
    assert(rec[1] && rec[1].tools.some((x) => /spawn ENOENT/.test(String(x))),
      '异常应回给模型');
  }],
];

/** 每一项都该让上面某条判据变红 */
const MUTATIONS = [
  ['上限失效', (s) => s.replace(
    /const maxRounds = Number\(opt\.maxRounds\) > 0[\s\S]*?: DEFAULT_MAX_ROUNDS;/,
    'const maxRounds = Infinity;')],
  ['不接回工具结果', (s) => s.replace(
    'history = provider.appendToolTurn(engine, history, r.calls, results, { think: r.think });', '')],
  ['重复调用不再拦', (s) => s.replace(
    'if (times >= MAX_SAME_CALL) {', 'if (false) {')],
  ['忽略取消', (s) => s.replace(
    'if (cancelled) {\n          results.push(',
    'if (false) {\n          results.push(')],
  ['工具异常直接抛出', (s) => s.replace(
    'r = { ok: false, output: `工具执行出错：${e.message}` };',
    'throw e;')],
  ['拿到工具调用就当结束', (s) => s.replace(
    'if (!r.calls || !r.calls.length) break;', 'break;')],
];

t('变异测试：破坏实现后判据必须变红，且原实现必须先绿', async () => {
  const orig = require('./electron/agent-loop.js');
  const report = [];

  for (const [label, mutate] of MUTATIONS) {
    // ---- 判据自检：同一批判据在**原实现**上必须全绿 ----
    const baseBroken = [];
    for (const [n, f] of MUTATION_SUITE) {
      try { await f(orig, []); } catch (_) { baseBroken.push(n); }
    }
    assert(baseBroken.length === 0,
      `【判据自检失败】原实现在这些判据上就红了：${baseBroken.join('、')}`);

    // ---- 变异体必须被抓 ----
    const mutant = makeMutant(label.replace(/[^\w]/g, '_'), mutate);
    const broken = [];
    for (const [n, f] of MUTATION_SUITE) {
      try { await f(mutant, []); } catch (_) { broken.push(n); }
    }
    assert(broken.length > 0,
      `变异「${label}」一条判据都没抓住 —— 说明这批判据测不到它`);
    report.push(`「${label}」→ ${broken.length}/${MUTATION_SUITE.length} 条判据变红`);
  }

  try { fs.rmSync(MUT_DIR, { recursive: true, force: true }); } catch (_) {}
  for (const r of report) console.log(`      · ${r}`);
});

// ============================================================
(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n工具循环：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

function section(t) { console.log(`\n${t}`); }

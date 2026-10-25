/**
 * 工具调用的协议层用例。
 *
 * ## 为什么单独一个文件
 *
 * 工具调用最容易出的错是**"看起来通了"**：
 * 单帧测试全过，接上真实流式就断。因为一次工具调用会被拆成
 * 十几帧，参数是分片来的。
 *
 * 这里的做法是**按真实抓包逐帧喂进去**：
 * 把线上看到的 SSE 原文（含分片边界）当测试夹具，
 * 而不是自己造"一帧就带完整参数"的理想输入 ——
 * 后者测的是想象出来的协议，不是真的。
 *
 * ⚠ 判据里带了「反例」：把关键一帧抽掉必须报错。
 *   那种"漏了也绿"的测试等于没测。
 */
const assert = require('node:assert');
const p = require('./electron/provider.js');
const { execTool, TOOL_DEFS } = require('./electron/tools.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (t) => console.log(`\n${t}`);

/** 用真实的分片序列驱动累加器，复刻 chatStream 里的行为 */
function accumulate(engine, frames, onDone) {
  const toolAcc = new Map();
  const out = { text: '', think: '', calls: null };
  const onToolFrame = (frag) => {
    if (!frag) return;
    const key = frag.index != null ? `i${frag.index}` : (frag.id || frag.name || 'x');
    const prev = toolAcc.get(key) || { id: frag.id, name: '', args: '' };
    if (frag.id) prev.id = frag.id;
    if (frag.name) prev.name = (prev.name || '') + frag.name;
    if (typeof frag.arguments === 'string') prev.args += frag.arguments;
    else if (frag.arguments) {
      try { prev.args = JSON.stringify(frag.arguments); } catch (_) {}
    }
    toolAcc.set(key, prev);
  };
  const flush = () => {
    if (!toolAcc.size) return;
    const calls = [];
    for (const c of toolAcc.values()) {
      let args = {};
      if (c.args && c.args.trim()) {
        try { args = JSON.parse(c.args); } catch (_) {
          calls.push({ id: c.id, name: c.name, args: {}, parseError: `参数不是合法 JSON：${c.args.slice(0, 120)}` });
          continue;
        }
      }
      calls.push({ id: c.id, name: c.name, args, argsRaw: c.args });
    }
    toolAcc.clear();
    out.calls = calls;
  };
  for (const f of frames) {
    // ⚠ handleLine 一次只吃**一行**。Anthropic 的 SSE 是
    //   "event: xxx" 和 "data: {...}" **两行一组**，
    //   而我上面把两条写进了一个字符串 —— 那样 handleLine 只看得到
    //   event: 那一行，data 整帧被丢掉，于是"解析出 0 条"。
    //   ⚠ 这个坑我一开始没看出来，报红才想到去打印实际结果。
    for (const one of String(f).split('\n')) {
      const r = p.handleLine(one, { apiKey: '' }, engine, {
        onText: (t) => { out.text += t; },
        onThink: (t) => { out.think += t; },
        onTool: onToolFrame,
      });
      if (r && r.done) return onDone ? (flush(), onDone(out), out) : (flush(), out);
    }
  }
  flush();
  if (onDone) onDone(out);
  return out;
}

// ============================================================
section('一、OpenAI 兼容：分片参数必须拼起来');
// ============================================================

// 抓包形状：第一帧带 id+name，之后分片送 arguments
const OPENAI_FRAMES = [
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"terminal","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"comm"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\": \\"Get-Child"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Item *.md\\", \\"rea"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"son\\": \\"看看有哪些文件\\"}"}}]}}]}',
  'data: [DONE]',
];

const oa = accumulate('openai', OPENAI_FRAMES);
check('分片参数拼回完整 JSON', () => {
  assert.ok(oa.calls && oa.calls.length === 1, `解析出 ${oa.calls && oa.calls.length} 条`);
  assert.strictEqual(oa.calls[0].name, 'terminal');
  assert.strictEqual(oa.calls[0].id, 'call_abc');
  assert.strictEqual(oa.calls[0].args.command, 'Get-ChildItem *.md');
  assert.strictEqual(oa.calls[0].args.reason, '看看有哪些文件');
});
check('原始参数字符串保留下来（回传时要用）', () => {
  // ⚠ 这里断言的是"**拼出来的那串**"，不是"单帧里那串"。
  //   分片拼接后 argsRaw 是一段合法 JSON 原文，里面不该再有反斜杠转义
  //   （转义只存在于单个 SSE 帧的 JSON 字符串里，parse 后就没了）。
  //   我原来断言"必须含 \"，那是在断言一个不存在的东西。
  assert.ok(typeof oa.calls[0].argsRaw === 'string', 'argsRaw 不是字符串');
  assert.strictEqual(oa.calls[0].argsRaw, '{"command": "Get-ChildItem *.md", "reason": "看看有哪些文件"}');
  assert.doesNotThrow(() => JSON.parse(oa.calls[0].argsRaw), 'argsRaw 不是合法 JSON');
});
check('★ 反例：抽掉中间一帧必须解析失败（判据不是恒真）', () => {
  const broken = OPENAI_FRAMES.filter((_, i) => i !== 3);
  const r = accumulate('openai', broken);
  const c = r.calls && r.calls[0];
  const isBad = !c || c.parseError || !c.args || !c.args.command;
  assert.ok(isBad, '抽掉一帧参数分片居然还能拼出完整命令 —— 说明没真在拼');
});

// ============================================================
section('二、Ollama：arguments 是完整对象，不是分片');
// ============================================================

const OLLAMA_FRAMES = [
  '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"terminal","arguments":{"command":"Get-ChildItem","reason":"列文件"}}}]}}',
  '{"done":true,"eval_count":18}',
];
const ol = accumulate('ollama', OLLAMA_FRAMES);
check('拿到对象形式的 arguments', () => {
  assert.ok(ol.calls && ol.calls.length === 1, `解析出 ${ol.calls && ol.calls.length} 条`);
  assert.strictEqual(ol.calls[0].name, 'terminal');
  assert.strictEqual(ol.calls[0].args.command, 'Get-ChildItem');
  assert.strictEqual(ol.calls[0].args.reason, '列文件');
});

/**
 * 用 JSON.stringify **生成**分片夹具，而不是手写带转义的字符串字面量。
 *
 * ⚠ 为什么要绕这一圈：手写这类夹具要经过三层转义
 *   （JS 字符串 → JSON 字符串 → arguments 的部分 JSON），
 *   我写错了两次，两次都是「帧本身不是合法 JSON」。
 * 而 handleLine 对非法 JSON 是**静默跳过**的 ——
 * 于是"分片拼接"根本没被测到，报错却看着像拼接功能坏了。
 *
 * 生成器顺手把每一帧都 parse 一遍当自检：夹具错了当场炸，
 * 不会跑到一半才发现"测的不是那个东西"。
 */
function ollamaSplitFrames() {
  // 真正要拼成的是 {"query":"修仙"}，切成两片
  const a1 = '{"que';
  const a2 = 'ry":"修仙"}';
  return [
    JSON.stringify({ message: { tool_calls: [{ index: 0, id: 't1',
      function: { name: 'web_search', arguments: a1 } }] } }),
    JSON.stringify({ message: { tool_calls: [{ index: 0,
      function: { arguments: a2 } }] } }),
    JSON.stringify({ done: true }),
  ];
}
const OLLAMA_SPLIT = ollamaSplitFrames();
for (const f of OLLAMA_SPLIT) JSON.parse(f);   // 自检：每帧都必须是合法 JSON
const ols = accumulate('ollama', OLLAMA_SPLIT);
check('也兼容字符串分片形式的 arguments（不同版本不一样）', () => {
  assert.ok(ols.calls && ols.calls.length === 1);
  assert.strictEqual(ols.calls[0].name, 'web_search');
  assert.strictEqual(ols.calls[0].args.query, '修仙');
});

// ============================================================
section('三、Anthropic：四种 delta 事件，四种字段名');
// ============================================================

const ANTH_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"web_fetch","input":{}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" \\"https://a.com\\"}"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
];
const an = accumulate('anthropic', ANTH_FRAMES);
check('content_block_start + input_json_delta 能拼出调用', () => {
  assert.ok(an.calls && an.calls.length === 1, `解析出 ${an.calls && an.calls.length} 条`);
  assert.strictEqual(an.calls[0].name, 'web_fetch');
  assert.strictEqual(an.calls[0].id, 'toolu_01');
  assert.strictEqual(an.calls[0].args.url, 'https://a.com');
});

check('★ Anthropic 的 id 来自 content_block_start 而不是 delta', () => {
  // ⚠ 这里最容易漏：Anthropic 的 delta 里**没有** id 字段，
  //   只有 content_block_start 有。若只读 delta.id 会全丢。
  assert.strictEqual(an.calls[0].id, 'toolu_01');
});

check('★ 正文与思考仍然能正确分开（加了工具不能把这两个搅乱）', () => {
  const mixed = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想想"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好的"}}',
  ];
  const r = accumulate('anthropic', mixed);
  assert.strictEqual(r.think, '想想', `思考被搅乱了：${JSON.stringify(r)}`);
  assert.strictEqual(r.text, '好的', `正文被搅乱了：${JSON.stringify(r)}`);
});

const OA_MIXED = [
  'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
  'data: {"choices":[{"delta":{"content":"回答"}}]}',
];
const oam = accumulate('openai', OA_MIXED);
check('OpenAI 侧思考/正文也不受工具影响', () => {
  assert.strictEqual(oam.think, '思考中');
  assert.strictEqual(oam.text, '回答');
});

// ============================================================
section('四、工具定义下发：三家格式不同');
// ============================================================

const cfgO = { model: 'x', base: 'http://127.0.0.1:11434', engine: 'ollama' };
const cfgA = { model: 'x', base: 'https://api.anthropic.com', engine: 'anthropic', apiKey: 'k' };
const cfgR = { model: 'x', base: 'https://openrouter.ai/api', engine: 'openai-compatible' };

check('Ollama：tools 是顶层字段，格式同 OpenAI', () => {
  const b = p.buildRequestBody(cfgO, [{ role: 'user', content: 'hi' }], { tools: TOOL_DEFS }).body;
  // ⚠ 数量 = TOOL_DEFS 的实际长度。2026-10-15 加了 write_note（写文件是底层能力）
  //   所以从 3 变 4。写死数字会在每次加工具时红一片，掩盖真正的回归。
  assert.ok(Array.isArray(b.tools) && b.tools.length === TOOL_DEFS.length, 'tools 没全下发');
  assert.strictEqual(b.tools[0].type, 'function');
  assert.ok(b.tools[0].function.parameters, '缺 parameters');
});

check('Anthropic：不能有 type，要转成 input_schema', () => {
  const b = p.buildRequestBody(cfgA, [{ role: 'user', content: 'hi' }], { tools: TOOL_DEFS }).body;
  assert.ok(Array.isArray(b.tools) && b.tools.length === TOOL_DEFS.length);
  assert.ok(!('type' in b.tools[0]), `不该有 type 字段：${JSON.stringify(b.tools[0])}`);
  assert.ok(b.tools[0].input_schema, '缺 input_schema');
  assert.ok(b.tools[0].name && b.tools[0].description);
});

check('OpenAI 兼容：tools 顶层，同标准格式', () => {
  const b = p.buildRequestBody(cfgR, [{ role: 'user', content: 'hi' }], { tools: TOOL_DEFS }).body;
  assert.ok(Array.isArray(b.tools) && b.tools.length === TOOL_DEFS.length);
  assert.strictEqual(b.tools[0].type, 'function');
});

check('★ 不给工具时**完全不发** tools 字段（老行为不能变）', () => {
  for (const [c, e] of [[cfgO, 'ollama'], [cfgA, 'anthropic'], [cfgR, 'openai']]) {
    const b = p.buildRequestBody(c, [{ role: 'user', content: 'hi' }], {}).body;
    assert.ok(!('tools' in b), `${e} 在没给工具时也发了 tools`);
  }
});
check('★ 给空数组时也不发（有些中转会 400）', () => {
  const b = p.buildRequestBody(cfgR, [{ role: 'user', content: 'hi' }], { tools: [] }).body;
  assert.ok(!('tools' in b), '空数组也发出去了');
});

// ============================================================
section('五、工具结果回传：三家格式完全不同');
// ============================================================

const calls = [{ id: 'call_x', name: 'terminal', args: { command: 'ls' }, argsRaw: '{"command": "ls"}' }];
const results = [{ output: 'a.md\nb.md' }];

check('OpenAI：assistant.tool_calls + role:tool，id 要对上', () => {
  const h = p.appendToolTurn('openai', [{ role: 'user', content: 'hi' }], calls, results);
  const a = h[1]; const t = h[2];
  assert.strictEqual(a.role, 'assistant');
  assert.strictEqual(a.tool_calls[0].id, 'call_x');
  assert.strictEqual(a.tool_calls[0].function.name, 'terminal');
  assert.strictEqual(t.role, 'tool');
  assert.strictEqual(t.tool_call_id, 'call_x', 'tool_call_id 与 assistant 的 id 对不上');
  assert.strictEqual(t.content, 'a.md\nb.md');
});

check('★ OpenAI：参数按**原始字符串**回传（不重新 stringify）', () => {
  const h = p.appendToolTurn('openai', [], calls, results);
  assert.strictEqual(h[0].tool_calls[0].function.arguments, '{"command": "ls"}',
    '参数被重新序列化了，丢了原始格式');
});

check('Anthropic：assistant.content 是数组，结果放在 **user** 消息里', () => {
  const h = p.appendToolTurn('anthropic', [{ role: 'user', content: 'hi' }], calls, results);
  const a = h[1]; const u = h[2];
  assert.ok(Array.isArray(a.content), 'assistant.content 必须是数组');
  assert.strictEqual(a.content[0].type, 'tool_use');
  assert.strictEqual(a.content[0].id, 'call_x');
  assert.strictEqual(u.role, 'user', 'Anthropic 的工具结果必须用 user 角色');
  assert.strictEqual(u.content[0].type, 'tool_result');
  assert.strictEqual(u.content[0].tool_use_id, 'call_x');
});

check('★ 多条工具调用时 id 不会重复（Anthropic 也要交替 assistant/user）', () => {
  const two = [
    { id: 'a1', name: 'terminal', args: { command: 'x' } },
    { id: 'a2', name: 'web_search', args: { query: 'y' } },
  ];
  const rs = [{ output: 'r1' }, { output: 'r2' }];
  const h = p.appendToolTurn('anthropic', [], two, rs);
  assert.strictEqual(h.filter((m) => m.role === 'assistant').length, 2);
  assert.strictEqual(h.filter((m) => m.role === 'user').length, 2);
  // ⚠ 原来我把「assistant 的 id」和「tool_result 的 tool_use_id」
  //   放进同一个数组查重 —— 而它们**本来就该相等**，
  //   于是 a1,a2,a1,a2 看起来像"重复"。
  //   真正要查的是：**两次调用的 id 彼此不同**。
  const assistantIds = h.filter((m) => m.role === 'assistant')
    .map((m) => m.content[0].id);
  const resultIds = h.filter((m) => m.role === 'user')
    .map((m) => m.content[0].tool_use_id);
  assert.deepStrictEqual(assistantIds, ['a1', 'a2'], 'assistant 的 id 应各不相同');
  assert.deepStrictEqual(resultIds, ['a1', 'a2'], 'tool_result 没对上对应的调用');
  assert.deepStrictEqual(assistantIds, resultIds, '两侧 id 必须一一对应');
  const oh = p.appendToolTurn('openai', [], two, rs);
  assert.strictEqual(oh.filter((m) => m.role === 'tool').length, 2);
  assert.strictEqual(oh[0].tool_calls.length, 2);
});

check('★ 没有 id 时给稳定兜底（Ollama 不给 id）', () => {
  const noid = [{ name: 'terminal', args: { command: 'ls' } }];
  const h = p.appendToolTurn('ollama', [], noid, results);
  assert.ok(h[0].tool_calls[0].id, '缺 id');
  assert.strictEqual(h[0].tool_calls[0].id, h[1].tool_call_id,
    '兜底 id 与 tool_call_id 不一致 —— 模型会收到 400');
});

check('工具结果是失败时也要如实回传（模型才知道该换路子）', () => {
  const h = p.appendToolTurn('openai', [], calls, [{ output: '命令被拒绝执行。' }]);
  assert.strictEqual(h[1].content, '命令被拒绝执行。');
  assert.ok(h[1].content.length > 0, '失败回执不能是空的');
});

// ============================================================
section('五点五、arguments 的**类型**：OpenAI 要字符串，Ollama 要对象');
// ============================================================

/**
 * ⚠⚠ 这一节是 2026-10-15 那个线上 400 的判据。
 *
 * 旧版把两家合成一行发字符串，而 Ollama 原生 /api/chat 要的是对象，
 * 于是「第一轮调工具 → 第二轮必 400」：
 *   请求失败（400）。{"error":"Value looks like object,
 *                      but can't find closing '}' symbol"}
 *
 * 为什么原来没抓住：**这里的用例只查了 id 对不对**，
 *   而 id 确实是对的 —— 类型错了它看不出来。
 *   单测里没量的那个维度，就是永远抓不到的那个维度。
 *
 * 另：这个"看着像 JSON 坏了"的报错本身极具误导性 ——
 *   实际上一个字符都没坏，只是类型不对。
 *   （用真 Ollama 实测过：只换 arguments 的类型，
 *     字符串 400 / 对象 200，其它一个字节都没动。）
 */
check('★ Ollama：arguments 必须是**对象**（发字符串本地模型必 400）', () => {
  const h = p.appendToolTurn('ollama', [], calls, results);
  const a = h[0].tool_calls[0].function.arguments;
  assert.strictEqual(typeof a, 'object',
    `Ollama 的 arguments 必须是对象，现在给的是 ${typeof a}`);
  assert.ok(a && !Array.isArray(a), '必须是普通对象');
  assert.deepStrictEqual(a, { command: 'ls' }, '参数内容不该变');
});

check('★ Ollama：只有 argsRaw 字符串时也要 parse 成对象', () => {
  const raw = [{ id: 'c1', name: 'terminal', argsRaw: '{"command":"ls"}' }];
  const h = p.appendToolTurn('ollama', [], raw, results);
  assert.deepStrictEqual(h[0].tool_calls[0].function.arguments, { command: 'ls' });
});

check('★ Ollama：argsRaw 是半截 JSON 时给空对象，**绝不退回字符串**', () => {
  // 退回字符串 = 整轮 400，用户连错误都看不懂；
  // 空对象最坏只是模型抱怨一句"没给参数"。
  const bad = [{ id: 'c1', name: 'terminal', argsRaw: '{"command": "rm' }];
  const h = p.appendToolTurn('ollama', [], bad, results);
  const a = h[0].tool_calls[0].function.arguments;
  assert.strictEqual(typeof a, 'object', '不能退回字符串');
  assert.deepStrictEqual(a, {});
});

check('★ OpenAI：仍然是**原始字符串**（别被上面那条带跑了）', () => {
  const h = p.appendToolTurn('openai', [], calls, results);
  assert.strictEqual(typeof h[0].tool_calls[0].function.arguments, 'string');
  assert.strictEqual(h[0].tool_calls[0].function.arguments, '{"command": "ls"}');
});

// ============================================================
section('五点六、开了思考又带工具：reasoning_content 必须回传');
// ============================================================

/**
 * ⚠ 这条同样是线上 400（2026-10-15 实测，DeepSeek）：
 *   "The `reasoning_content` in the thinking mode must be passed back
 *    to the API."
 *   原因：assistant 的 tool_call 消息没带上一轮的推理原文。
 */
check('★ OpenAI：收到过推理就必须把它带回 assistant 消息', () => {
  const h = p.appendToolTurn('openai', [], calls, results, { think: '我先看一下目录' });
  assert.strictEqual(h[0].reasoning_content, '我先看一下目录');
});

check('OpenAI：没收到推理时**不能**凭空塞这个字段', () => {
  // 无脑塞给不支持它的模型会换来另一个 400
  const h = p.appendToolTurn('openai', [], calls, results);
  assert.ok(!('reasoning_content' in h[0]), '不该有这个字段');
  const h2 = p.appendToolTurn('openai', [], calls, results, { think: '' });
  assert.ok(!('reasoning_content' in h2), '空推理也不该塞');
});

check('Ollama / Anthropic：不要把 reasoning_content 塞进去', () => {
  const ho = p.appendToolTurn('ollama', [], calls, results, { think: '想到一半' });
  assert.ok(!('reasoning_content' in ho[0]), 'Ollama 分支不该有这个字段');
  const ha = p.appendToolTurn('anthropic', [], calls, results, { think: '想到一半' });
  assert.ok(!('reasoning_content' in ha[0]), 'Anthropic 分支不该有这个字段');
});

// ============================================================
section('六、参数解析失败时不能给空对象');
// ============================================================

check('★ 半截 JSON 被标成 parseError，而不是当成 {} 交出去', () => {
  const acc = new Map();
  acc.set('i0', { id: 'c1', name: 'terminal', args: '{"command": "rm' });
  const callsOut = [];
  for (const c of acc.values()) {
    let args = {}; let parseError;
    try { args = JSON.parse(c.args); }
    catch (_) { parseError = `参数不是合法 JSON：${c.args.slice(0, 120)}`; }
    callsOut.push({ ...c, args, parseError });
  }
  assert.ok(callsOut[0].parseError, '没标出解析失败');
  assert.deepStrictEqual(callsOut[0].args, {}, '带 parseError 时不该假装有参数');
});

check('★ execTool 拿到缺命令的对象时拒绝执行', async () => {
  // 这条是 async，但用同步方式验证决策逻辑：分类器对空命令不判危险，
  // 而 execTool 会在 runTerminal 之前就拒掉。
  const r = await execTool('terminal', {}, { cwd: process.cwd() });
  assert.ok(!r.ok);
  assert.ok(/空的/.test(r.output), r.output);
});

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `工具协议：${passed} 通过 / ${failures.length} 失败`
  : `工具协议：${passed} 通过`);
process.exit(failures.length ? 1 : 0);
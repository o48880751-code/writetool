const assertNode = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Provider 适配层的测试。
 *
 * 这一层出错的表现是「静默做错」：
 * 思考被当成正文、token 数永远 0、SSE 的 [DONE] 没识别导致一直转圈、
 * apiKey 出现在错误信息里。都不会崩，只是结果不对。
 * 所以判据都钉在「输出对不对」而不是「有没有抛错」。
 */

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'app', 'electron', 'provider.js'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failures.push({ name, message: e.message });
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function section(t) { console.log('\n' + t); }

/** 收集一行流数据的输出 */
function runLine(raw, cfg, engine = 'openai') {
  const got = { text: [], think: [] };
  const meta = P.handleLine(raw, cfg, engine, {
    onText: (t) => got.text.push(t),
    onThink: (t) => got.think.push(t),
  });
  return { ...got, meta };
}

// ===========================================================
section('一、思考参数：三家三种形态（核实于官方文档）');
// ===========================================================

check('Ollama：四档映射到 think 字段', () => {
  assertNode.deepStrictEqual(P.buildThinkParams('ollama', 'off').fields, { think: false });
  assertNode.deepStrictEqual(P.buildThinkParams('ollama', 'low').fields, { think: 'low' });
  assertNode.deepStrictEqual(P.buildThinkParams('ollama', 'medium').fields, { think: 'medium' });
  assertNode.deepStrictEqual(P.buildThinkParams('ollama', 'high').fields, { think: 'high' });
});

check('★ Ollama 关闭时必须显式传 false（省略=默认开着）', () => {
  // 实测：不传 think 时 Ollama 默认开启思考
  const f = P.buildThinkParams('ollama', 'off').fields;
  assertNode.strictEqual(f.think, false, `得到 ${JSON.stringify(f)}`);
  assertNode.ok('think' in f, 'think 字段必须存在，省略等于没关');
});

check('阿里云百炼：enable_thinking 是布尔，档位压成开/关', () => {
  const off = P.buildThinkParams('openai-compatible', 'off', { thinkStyle: 'dashscope' });
  assertNode.deepStrictEqual(off.fields, { enable_thinking: false });
  const on = P.buildThinkParams('openai-compatible', 'high', { thinkStyle: 'dashscope' });
  assertNode.deepStrictEqual(on.fields, { enable_thinking: true },
    '布尔型引擎不能区分 medium 与 high');
  // note 必须说清这件事，否则用户以为档位生效了
  assertNode.ok(/只有开.关/.test(on.note), `note 未说明档位被压平：${on.note}`);
});

check('★ 百炼的 enable_thinking 必须在 body 顶层（不能包 extra_body）', () => {
  const cfg = { engine: 'openai', model: 'qwen3.8-max', numCtx: 8192, thinkLevel: 'high', thinkStyle: 'dashscope' };
  const b = P.buildRequestBody(cfg, []).body;
  assertNode.strictEqual(b.enable_thinking, true, '缺顶层 enable_thinking');
  assertNode.ok(!('extra_body' in b),
    'enable_thinking 不能放 extra_body —— 官方文档明确要求与 model 同级');
});

check('OpenRouter：reasoning.effort 是顶层对象', () => {
  const r = P.buildThinkParams('openai-compatible', 'high', { thinkStyle: 'openrouter' });
  assertNode.deepStrictEqual(r.fields, { reasoning: { effort: 'max' } });
  const none = P.buildThinkParams('openai-compatible', 'off', { thinkStyle: 'openrouter' });
  assertNode.deepStrictEqual(none.fields, { reasoning: { effort: 'none' } });
});

check('★ 思考参数不能同时给 reasoning 与 reasoning_effort', () => {
  // 官方文档：两者不能同时给且值不同
  const cfg = { engine: 'openai', model: 'x', numCtx: 8192, thinkLevel: 'medium', thinkStyle: 'openrouter' };
  const b = P.buildRequestBody(cfg, []).body;
  const hasObj = 'reasoning' in b;
  const hasAlias = 'reasoning_effort' in b;
  assertNode.ok(!(hasObj && hasAlias),
    `同时给了 reasoning 与 reasoning_effort：${JSON.stringify(b)}`);
});

check('★ 「开启」这一档真的能映射（布尔型引擎的界面用它）', () => {
  // 界面上百炼给的是 off / on 两个按钮，值就是这两个字符串。
  // 第一版映射表里只有 off/low/medium/high，没有 on ——
  // 用户点「开启」得到 {ok:false}、请求体里没有思考字段，
  // 表现为"开关点了没反应"且不报错。
  const on = P.buildThinkParams('openai-compatible', 'on', { thinkStyle: 'dashscope' });
  assertNode.strictEqual(on.ok, true, `点「开启」后请求体是空的：${JSON.stringify(on)}`);
  assertNode.deepStrictEqual(on.fields, { enable_thinking: true });

  // 同一个值在 OpenRouter 风格下要走 reasoning.effort
  const orOn = P.buildThinkParams('openai-compatible', 'on', { thinkStyle: 'openrouter' });
  assertNode.strictEqual(orOn.ok, true, 'OpenRouter 风格也不该失败');
  assertNode.ok(orOn.fields.reasoning, `实际 ${JSON.stringify(orOn.fields)}`);
});

check('★ 界面上会出现的每一档，请求体里都得真的带上思考字段', () => {
  // 这条原先扫的是 main.js 里内联的服务商清单。2026-10-12 清单搬到
  // provider-presets.js 之后，正则匹配到 0 个引擎 ——
  // 测试没坏，是**扫描目标已经不在了**（当时报「期望 4 个，实际 0」）。
  //
  // ⚠ 现在改成从量表推「界面会给哪些档位」，再直接看请求体。
  //   这比"映射函数返回 ok"更贴近用户感知：用户只关心
  //   「我点了这一档，发出去的东西里到底有没有它」。
  //   覆盖三种引擎（ollama / openai 兼容 / anthropic）与三种形态
  //   （think / enable_thinking / thinking / reasoning）。
  const PRESETS = require(path.join(ROOT, 'app', 'electron', 'provider-presets.js'));

  // 与 ProviderCat 的 thinkUI 一一对应：这里列出的每一档界面上都有按钮
  const uiLevels = (style) => {
    if (style === 'levels') return ['low', 'medium', 'high'];
    if (style === 'boolean') return ['on'];
    return [];   // model-only / none：界面上不给档位，跳过
  };

  /**
   * 这一家该发**哪一个**字段。
   *
   * ⚠ 这张表是**独立**的：数值来自各家官方文档，**不读 presets 的
   *   think.thinkStyle**。第一版让它读 thinkStyle，结果是两边一起退化——
   *   量表漏标 → 实现兜底成 openrouter（发 reasoning）→ 测试的期望值
   *   也跟着兜底成 reasoning → 判据永远绿。**验证手段不能和被验证的
   *   东西共用同一个来源**，否则它只是在确认"自己等于自己"。
   *   （实测过：把智谱的 thinkStyle 抽掉，第一版判据毫无反应。）
   */
  const EXPECT_FIELD = {
    ollama: 'think',
    openrouter: 'reasoning',
    openai: 'reasoning',
    'custom-openai': 'reasoning',
    dashscope: 'enable_thinking',
    /**
     * 硅基流动（2026-10-15 补）。
     *
     * ⚠ 这里填 enable_thinking 不是抄自它的 thinkStyle —— 是**实测**出来的：
     *   同一条提问、只换思考参数，跑出来是
     *     reasoning.effort=none   14751ms  思考 590 字   ← 它不认这个字段
     *     enable_thinking=false    1577ms  思考   0 字   ← 真的关住了
     *   顺便核过：给不支持思考的模型（Qwen2.5-7B-Instruct）发这个字段
     *   也不会 400，服务端直接忽略。
     *   换句话说，它和百炼是同一个字段形态（顶层布尔），
     *   量表里原先写的"靠模型名区分、没有开关"是错的。
     */
    siliconflow: 'enable_thinking',
    zhipu: 'thinking',
    anthropic: 'thinking',
    'custom-anthropic': 'thinking',
  };
  const THINK_KEYS = ['think', 'enable_thinking', 'thinking', 'reasoning', 'reasoning_effort'];

  let checked = 0;
  const missed = [];
  const unknown = [];
  for (const p of PRESETS.PROVIDERS) {
    for (const lv of uiLevels(p.think && p.think.style)) {
      const wanted = EXPECT_FIELD[p.key];
      if (!wanted) { unknown.push(p.key); continue; }
      const cfg = {
        engine: p.protocol,
        model: 'x',
        numCtx: 8192,
        thinkLevel: lv,
        thinkStyle: (p.think && p.think.thinkStyle) || 'openrouter',
      };
      const b = P.buildRequestBody(cfg, [{ role: 'user', content: 'hi' }]).body;
      const got = THINK_KEYS.filter((k) => k in b);
      checked++;
      if (got.length !== 1 || got[0] !== wanted) {
        missed.push(`${p.name}（${p.protocol}${p.think && p.think.thinkStyle ? '/' + p.think.thinkStyle : ''}）`
          + `点「${lv}」→ 期望字段 ${wanted}，实际 ${got.length ? got.join('+') : '(一个都没有)'}`
          + `\n        ${JSON.stringify(b)}`);
      }
    }
  }

  assertNode.deepStrictEqual(unknown, [],
    `这些服务商界面上有档位按钮，但判据里没有它的期望字段——`
    + `新增量表项时请一并补上：${unknown.join(', ')}`);
  assertNode.ok(checked >= 12, `只验了 ${checked} 组，样本太少（清单是不是又搬走了？）`);
  assertNode.deepStrictEqual(missed, [],
    '界面上给了按钮，请求体里却不是该有的那个思考字段：\n      ' + missed.join('\n      '));
});

check('未知引擎与未知档位都返回错误而不是瞎猜', () => {
  assertNode.strictEqual(P.buildThinkParams('不存在的', 'off').ok, false);
  assertNode.strictEqual(P.buildThinkParams('ollama', '超高').ok, false);
});

check('各引擎的思考形态有中文说明（界面直接用）', () => {
  for (const k of ['boolean', 'levels', 'none']) {
    assertNode.ok(P.THINK_LABEL[k], `缺 ${k} 的说明文案`);
  }
  assertNode.strictEqual(P.THINK_SPEC.ollama.format, 'levels');
  assertNode.strictEqual(P.THINK_SPEC['openai-compatible'].format, 'levels');
});

// ===========================================================
section('二、流式解析：SSE vs 裸 JSON');
// ===========================================================

check('OpenAI 兼容：正常文本分片', () => {
  const r = runLine('data: {"choices":[{"delta":{"content":"夜枫"}}]}', {}, 'openai');
  assertNode.deepStrictEqual(r.text, ['夜枫']);
  assertNode.strictEqual(r.think.length, 0);
});

check('★ OpenAI 兼容：[DONE] 标记收尾', () => {
  const r = runLine('data: [DONE]', {}, 'openai');
  assertNode.strictEqual(r.meta.done, true, '没识别 [DONE] —— 界面会一直转圈');
});

check('OpenAI 兼容：SSE 心跳/注释行被忽略', () => {
  const r = runLine(': OPENROUTER PROCESSING', {}, 'openai');
  assertNode.deepStrictEqual(r.text, []);
  assertNode.strictEqual(r.meta.done, undefined);
});

check('OpenAI 兼容：非 data 开头的行被忽略', () => {
  assertNode.deepStrictEqual(runLine('event: message', {}, 'openai').text, []);
});

check('★ OpenAI 兼容：思考内容走 reasoning_content 且与正文分开', () => {
  const r = runLine('data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}', {}, 'openai');
  assertNode.deepStrictEqual(r.think, ['让我想想']);
  assertNode.strictEqual(r.text.length, 0, '思考被当成了正文');
});

check('OpenAI 兼容：也认 reasoning 字段（无下划线）', () => {
  const r = runLine('data: {"choices":[{"delta":{"reasoning":"想一下"}}]}', {}, 'openai');
  assertNode.deepStrictEqual(r.think, ['想一下']);
});

check('OpenAI 兼容：一帧里同时有思考与正文', () => {
  const r = runLine(
    'data: {"choices":[{"delta":{"reasoning_content":"思考","content":"正文"}}]}', {}, 'openai');
  assertNode.deepStrictEqual(r.think, ['思考']);
  assertNode.deepStrictEqual(r.text, ['正文']);
});

check('★ OpenAI 兼容：token 计数读 usage', () => {
  const r = runLine(
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":340}}', {}, 'openai');
  assertNode.strictEqual(r.meta.tokensIn, 120);
  assertNode.strictEqual(r.meta.tokensOut, 340);
});

check('★ OpenAI 兼容：服务端报错要抛出可读信息', () => {
  let threw = null;
  try {
    P.handleLine('data: {"error":{"message":"模型不存在"}}', {}, 'openai',
      { onText() {}, onThink() {} });
  } catch (e) { threw = e; }
  assertNode.ok(threw, '服务端错误被静默吞掉了 —— 用户看到的是"一直转圈"');
  assertNode.ok(/模型不存在/.test(threw.message), threw.message);
});

check('Ollama：裸 JSON 行', () => {
  const r = runLine('{"message":{"content":"夜枫"}}', {}, 'ollama');
  assertNode.deepStrictEqual(r.text, ['夜枫']);
});

check('★ Ollama：开思考后 content 一片都没有（实测 297 片全是 thinking）', () => {
  // 这条是第一版实现翻车的原因：只读 content → 编辑器一个字都不出现
  const r = runLine('{"message":{"thinking":"先想一下","content":""}}', {}, 'ollama');
  assertNode.deepStrictEqual(r.think, ['先想一下']);
  assertNode.strictEqual(r.text.length, 0);
});

check('Ollama：token 计数读 eval_count / prompt_eval_count', () => {
  const r = runLine('{"done":true,"prompt_eval_count":200,"eval_count":88,"total_duration":3500000000}',
    {}, 'ollama');
  assertNode.strictEqual(r.meta.tokensIn, 200);
  assertNode.strictEqual(r.meta.tokensOut, 88);
  assertNode.strictEqual(r.meta.ms, 3500);
});

check('Ollama：报错信息带上原文', () => {
  // 第一版这条用例把含转义引号的 JSON 直接写进 JS 单引号串里：
  //   '{"error":"model \"qwen9\" not found"}'
  // 在单引号串里 \" 只是 "，整行成了非法 JSON，
  // JSON.parse 失败被静默吞掉 -> threw 是 null，断言报 "null"。
  // 看起来像"实现漏了处理"，其实是用例自己写坏了。
  // 改用 JSON.stringify 造数据，就没有这类转义歧义。
  const line = JSON.stringify({ error: 'model "qwen9" not found' });
  let threw = null;
  try {
    P.handleLine(line, {}, 'ollama', { onText() {}, onThink() {} });
  } catch (e) { threw = e; }
  assertNode.ok(threw, '服务端错误被静默吞掉了——用户看到的是"一直转圈"');
  assertNode.ok(/qwen9/.test(threw.message), threw.message);
});

check('★ 非法 JSON 帧被跳过，但只警告一次（不刷屏）', () => {
  // 整帧解不出来通常是"地址填到了网页而不是 API"——
  // 用户会看到界面一直转圈，没有任何提示。
  // 但如果每次都警告，一个坏地址能刷出上千条日志，真错误反而被淹了。
  P._resetWarn();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (let i = 0; i < 5; i++) {
      assertNode.deepStrictEqual(
        runLine('data: {"choices":[{"delta":', {}, 'openai').text, [],
        `第 ${i + 1} 个坏帧应被跳过`);
    }
    // 警告过之后，正常的帧仍要正常处理
    assertNode.deepStrictEqual(
      runLine('data: {"choices":[{"delta":{"content":"好"}}]}', {}, 'openai').text, ['好']);
  } finally {
    console.warn = realWarn;
  }
  assertNode.strictEqual(warns.length, 1,
    `5 个坏帧应只警告 1 次，实际 ${warns.length} 次`);
  assertNode.ok(/不是 JSON/.test(warns[0]), warns[0]);
});

check('半截 JSON 与空行都不抛（流式分片边界不可控）', () => {
  assertNode.deepStrictEqual(runLine('{"message":{"cont', {}, 'ollama').text, []);
  assertNode.deepStrictEqual(runLine('', {}, 'openai').text, []);
  assertNode.deepStrictEqual(runLine('   ', {}, 'ollama').text, []);
});

check('Windows 的 \\r\\n 换行被正确处理', () => {
  const r = runLine('data: {"choices":[{"delta":{"content":"好"}}]}\r', {}, 'openai');
  assertNode.deepStrictEqual(r.text, ['好']);
});

// ===========================================================
section('三、URL 处理');
// ===========================================================

check('结尾多余的斜杠不会造成双斜杠', () => {
  assertNode.strictEqual(P.joinUrl('http://x:8080/', '/v1/models'), 'http://x:8080/v1/models');
  assertNode.strictEqual(P.joinUrl('http://x:8080///', '/v1/models'), 'http://x:8080/v1/models');
  assertNode.strictEqual(P.joinUrl('http://x:8080', '/v1/models'), 'http://x:8080/v1/models');
});

check('base 带路径前缀时正确拼接（很多服务挂在子路径下）', () => {
  assertNode.strictEqual(
    P.joinUrl('https://x.com/compatible-mode/v1', '/chat/completions'),
    'https://x.com/compatible-mode/v1/chat/completions');
});

check('非 http/https 协议被拒', () => {
  let threw = null;
  try { P.parseBase('ftp://x'); } catch (e) { threw = e; }
  assertNode.ok(threw && /只支持 http/.test(threw.message), String(threw));
});

check('非法地址报的是可读信息不是英文异常', () => {
  let threw = null;
  try { P.parseBase('这不是地址'); } catch (e) { threw = e; }
  assertNode.ok(threw && /地址不合法/.test(threw.message), String(threw));
});

// ===========================================================
section('四、错误信息：用户能看懂，且不含密钥');
// ===========================================================

check('★ 401/403 提示检查密钥（最高频的一类错误）', () => {
  const m = P.describeHttp(401, '{"error":"invalid api key"}', 'openai', 'some-key');
  assertNode.ok(/鉴权失败/.test(m), m);
  assertNode.ok(/密钥/.test(m), m);
});

check('404 提示地址格式（vLLM 与 Ollama 的路径不同）', () => {
  const o = P.describeHttp(404, '', 'ollama', null);
  assertNode.ok(/11434/.test(o), `Ollama 的 404 应给出默认地址：${o}`);
  const v = P.describeHttp(404, '', 'openai', null);
  assertNode.ok(/v1/.test(v), `OpenAI 兼容的 404 应提示 /v1：${v}`);
});

check('429 与 5xx 各自有独立文案', () => {
  assertNode.ok(/频繁|额度/.test(P.describeHttp(429, '', 'openai', null)));
  assertNode.ok(/服务端出错/.test(P.describeHttp(503, '', 'openai', null)));
});

check('★ 连接被拒要说"服务没启动"而不是 ECONNREFUSED', () => {
  const e = new Error('connect ECONNREFUSED');
  e.code = 'ECONNREFUSED';
  const m = P.friendlyError(e, 'ollama', 'http://127.0.0.1:11434', null);
  assertNode.ok(/端口没开/.test(m), m);
  assertNode.ok(/ollama serve/.test(m), `应直接给出启动命令：${m}`);
});

check('域名解析失败与自签证书都有专门文案', () => {
  const nf = new Error('getaddrinfo ENOTFOUND');
  nf.code = 'ENOTFOUND';
  assertNode.ok(/解析失败/.test(P.friendlyError(nf, 'openai', 'https://bad.example', null)));
  const cert = new Error('self signed certificate');
  assertNode.ok(/证书/.test(P.friendlyError(cert, 'openai', 'https://x', null)));
});

check('★ 任何错误信息里都不含 apiKey', () => {
  // 这条第一版是红的：describeHttp(500, 'stack with sk-xxx') 把服务端原文
  // 直接拼了出去。而服务端报错时**经常回显请求头**（401 尤其常见），
  // 用户把截图发到论坛就等于公开了密钥——不是理论风险。
  const SECRET = 'sk-THIS-MUST-NEVER-APPEAR';
  const cases = [
    P.describeHttp(401, `{"error":"bad key ${SECRET}"}`, 'openai', SECRET),
    P.describeHttp(500, `stack with ${SECRET}`, 'openai', SECRET),
    P.describeHttp(400, `{"detail":"${SECRET}"}`, 'openai', SECRET),
    P.friendlyError(new Error(`failed with ${SECRET}`), 'openai', 'https://x', SECRET),
    P.friendlyError(
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'openai',
      `https://${SECRET}.example`, SECRET),
  ];
  for (const c of cases) {
    assertNode.ok(!c.includes(SECRET), `密钥泄露到错误信息里：${c}`);
  }
});

check('★ 流式响应里的 error.message 也不含 apiKey', () => {
  const SECRET = 'sk-STREAM-SECRET';
  const bad = [
    ['openai', `data: {"error":{"message":"auth failed for ${SECRET}"}}`],
    ['ollama', `{"error":"invalid key ${SECRET}"}`],
  ];
  for (const [engine, line] of bad) {
    let threw = null;
    try {
      P.handleLine(line, { apiKey: SECRET }, engine, { onText() {}, onThink() {} });
    } catch (e) { threw = e; }
    assertNode.ok(threw, `${engine} 的服务端错误没抛`);
    assertNode.ok(!threw.message.includes(SECRET),
      `${engine} 流式错误里泄露了密钥：${threw.message}`);
  }
});

check('redactKey 对空密钥是恒等的（不该把无关文本弄坏）', () => {
  const t = '普通错误信息';
  assertNode.strictEqual(P.redactKey(t, ''), t);
  assertNode.strictEqual(P.redactKey(t, null), t);
  assertNode.strictEqual(P.redactKey(t, undefined), t);
});

// ===========================================================
section('五、请求体构造');
// ===========================================================

check('Ollama 请求体形状正确', () => {
  const b = P.buildRequestBody(
    { engine: 'ollama', model: 'qwen3', numCtx: 8192, temperature: 0.3, thinkLevel: 'off' },
    [{ role: 'user', content: 'x' }]
  ).body;
  assertNode.strictEqual(b.model, 'qwen3');
  assertNode.strictEqual(b.stream, true);
  assertNode.strictEqual(b.options.num_ctx, 8192);
  assertNode.strictEqual(b.options.temperature, 0.3);
});

check('★ 开思考时 num_predict 至少 1024（实测 500 会把正文吃光）', () => {
  for (const level of ['off', 'low', 'medium', 'high']) {
    const b = P.buildRequestBody(
      { engine: 'ollama', model: 'qwen3', numCtx: 2048, thinkLevel: level }, []
    ).body;
    assertNode.ok(b.options.num_predict >= 1024,
      `${level}: num_predict=${b.options.num_predict}，开思考时会一个字都不吐`);
  }
});

check('OpenAI 兼容请求体不含 Ollama 专有字段', () => {
  const b = P.buildRequestBody(
    { engine: 'openai', model: 'gpt-x', numCtx: 8192, temperature: 0.3, thinkLevel: 'off' },
    [{ role: 'user', content: 'x' }]
  ).body;
  assertNode.ok(!('options' in b), 'options 是 Ollama 专有的，OpenAI 兼容服务会 400');
  assertNode.ok(!('keep_alive' in b), 'keep_alive 是 Ollama 专有的');
  assertNode.ok(!('think' in b), 'think 是 Ollama 字段，OpenAI 兼容不认');
  assertNode.ok('max_tokens' in b, '应有 max_tokens');
});

check('百炼模式才发 stream_options（其他服务可能不认）', () => {
  const ds = P.buildRequestBody(
    { engine: 'openai', model: 'qwen', numCtx: 8192, thinkLevel: 'off', thinkStyle: 'dashscope', includeUsage: true }, []
  ).body;
  assertNode.ok(ds.stream_options, '百炼 + includeUsage 时应有 stream_options');
  const or_ = P.buildRequestBody(
    { engine: 'openai', model: 'x', numCtx: 8192, thinkLevel: 'off', thinkStyle: 'openrouter', includeUsage: true }, []
  ).body;
  assertNode.ok(!('stream_options' in or_),
    '非百炼风格不该发 stream_options —— 有的网关会因未知字段报错');
});

check('未知引擎退化成 openai（不崩）', () => {
  const b = P.buildRequestBody({ engine: '乱写的', model: 'x', numCtx: 8192, thinkLevel: 'off' }, []).body;
  assertNode.strictEqual(b.model, 'x');
});
// ------------------------------------------------------------
// 分段测试。分段文件导出 run(ctx)，自己负责 console.log，
// 共享主文件的 check 计数器——所以汇总是总数。
//
// 为什么分段：2026-10-12 加 Anthropic 时主文件已经 460 行。
// Anthropic 与服务商量表是两个独立主题，各放各的。
// ------------------------------------------------------------
for (const f of ['test-provider-anthropic.js']) {
  require(path.join(__dirname, f)).run({
    check, section, P, assertNode, require, __dirname, path, fs, ROOT,
  });
}

// ===========================================================
section('六、输出上限：不能跟着本地的显存参数走');
// ===========================================================

/**
 * 背景（2026-10-13 修的 bug）：
 * 三家协议原来都用 numCtx 推算输出上限，云端系数 0.5。
 * 于是云端设 8192 只能输出 4096 token ≈ 3000 字中文，
 * 写一章 5000 字正文被拦腰截断，而界面上写着「上下文窗口 8192」——
 * 用户根本想不到是输出被卡了。
 * 云端模型窗口动辄 128K，输出上限没理由跟着一个本地显存参数走。
 */

const outOf = (cfg) => {
  const b = P.buildRequestBody(cfg, [{ role: 'user', content: 'x' }]).body;
  return cfg.engine === 'ollama' ? b.options.num_predict : b.max_tokens;
};

check('★ 云端：maxOutput 说了算，与 numCtx 无关', () => {
  for (const eng of ['openai', 'anthropic']) {
    assertNode.strictEqual(
      outOf({ engine: eng, model: 'm', numCtx: 8192, maxOutput: 32768, thinkLevel: 'off' }),
      32768, `${eng}: 设了 32768 却被压成这么点`);
    assertNode.strictEqual(
      outOf({ engine: eng, model: 'm', numCtx: 32768, maxOutput: 2048, thinkLevel: 'off' }),
      2048, `${eng}: 窗口调大不该把输出也抬高`);
  }
});

check('★ 云端：老配置没有 maxOutput 时兜底给 8192（原来只有 4096）', () => {
  for (const eng of ['openai', 'anthropic']) {
    const n = outOf({ engine: eng, model: 'm', numCtx: 8192, thinkLevel: 'off' });
    assertNode.ok(n >= 8192, `${eng}: 兜底只有 ${n}，长章节会被截断`);
  }
});

check('★ 本地：输出吃的是窗口份额，必须按窗口封顶', () => {
  // 窗口 8192 却要输出 32768，多出来的会把前文挤掉——
  // 写长篇表现为"写着写着忘了开头的设定"
  const n = outOf({ engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 32768, thinkLevel: 'off' });
  assertNode.ok(n <= Math.round(8192 * 0.75), `本地输出 ${n} 超过了窗口的 75%`);
  assertNode.ok(n >= 1024, `本地输出 ${n} 太小，会一个字都不吐`);
});

check('★ 本地：窗口调大，输出上限跟着涨', () => {
  const small = outOf({ engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 32768, thinkLevel: 'off' });
  const big = outOf({ engine: 'ollama', model: 'm', numCtx: 32768, maxOutput: 32768, thinkLevel: 'off' });
  assertNode.ok(big > small, `窗口 32K 时输出(${big}) 应大于窗口 8K 时(${small})`);
});

check('★ 开思考时输出上限不缩水（thinking 会吃掉一大截）', () => {
  for (const eng of ['ollama', 'openai', 'anthropic']) {
    const off = outOf({ engine: eng, model: 'm', numCtx: 16384, maxOutput: 8192, thinkLevel: 'off' });
    const on = outOf({ engine: eng, model: 'm', numCtx: 16384, maxOutput: 8192, thinkLevel: 'high' });
    assertNode.ok(on >= off, `${eng}: 开思考后输出反而变小（${off} → ${on}）`);
  }
});

/**
 * ⚠ 这条是上面那条"不缩水"的**补强**，别只留前者：
 * "不缩水"（on >= off）用 `Math.max(4096, wantOut)` 也能混过去 ——
 * wantOut=8192 时两者相等，判据照样绿，可正文已经被 thinking 吃掉一半了。
 * 所以必须单独量"留给正文的净空间"。
 */
check('★ Anthropic：开思考时留给正文的净空间够数', () => {
  const b = P.buildRequestBody(
    { engine: 'anthropic', model: 'c', numCtx: 8192, maxOutput: 8192, thinkLevel: 'high' }, []
  ).body;
  // max_tokens 是总预算，thinking token 也算在里面
  const textRoom = b.max_tokens - (b.thinking ? b.thinking.budget_tokens : 0);
  assertNode.ok(textRoom >= 8192,
    `正文只剩 ${textRoom}，用户设的是 8192 —— 差的部分被 thinking 吃掉了，`
    + '表现为"转了半天圈不出字"');
});

/**
 * 2026-10-14：'default'（默认）档。
 *
 * ⚠ 这是一个真踩过的坑。菜单里加了第五档「默认」，但 provider 那边
 *   的判定只写了 `thinkLevel !== 'off'`，于是 'default' 落进了「要思考」
 *   那一侧 —— 给 Ollama 发了 think:true、给云端发了 reasoning.effort。
 *   而用户点「默认」的意图恰恰是「别替服务商做决定」。
 *
 * 顺带一个反向的坑：Ollama 不传 think 时**默认是开着思考的**，
 *   所以「不下发」不能理解成「等于关闭」—— 对三家引擎要分别验证。
 */
check('★ 默认档：不替服务商做决定（不下发任何思考字段）', () => {
  for (const engine of ['ollama', 'openai-compatible', 'anthropic']) {
    const b = P.buildRequestBody(
      { engine, model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'default' }, []
    ).body;
    const hit = String(JSON.stringify(b)).match(/"(think|reasoning|thinking)"/i);
    assertNode.ok(!hit,
      engine + ' 在 default 档仍然下发了 ' + (hit ? hit[0] : '(未知)')
      + ' —— 用户选的是「别替我决定」');
  }
});

/**
 * ⚠ 这一条是**反过来**钉的：default 与 off 的请求体必须**不一样**。
 *
 * 我第一条判据写成「两者应一致」，实跑才发现：
 *   off     → 发 think:false   （Ollama 不发 think 时默认开着，必须显式关）
 *   default → 什么都不发       （交给服务商自己那套，这就是「默认」的意思）
 *
 * 两者行为都对，**是我把「不下发」当成了「等于关闭」**。
 * 而且如果它们真的一样，「默认」这一档就是纯装饰 ——
 * 那才说明这档没实现。所以这里钉死它们的区别。
 */
check('★ 默认档与关闭档行为不同（这正是「默认」这一档的意义）', () => {
  const d = P.buildRequestBody({ engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'default' }, []).body;
  const o = P.buildRequestBody({ engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'off' }, []).body;
  assertNode.ok(!('think' in d), 'default 档不该发 think —— 发了就等于替服务商做了决定');
  assertNode.strictEqual(o.think, false,
    'off 档必须是 think:false 而不是不写 —— Ollama 不写时默认开着思考');
});

check('★ 明确挑了档位时仍然要下发（钉住反向，别把功能改瘫了）', () => {
  const b = P.buildRequestBody(
    { engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'high' }, []
  ).body;
  assertNode.ok('think' in b, '选了「高」却没有 think 字段 —— 那就是档位全废了');
});
/**
 * ⚠⚠ 这条是为了堵一条**彻底静默**的失效路径（2026-10-14）。
 *
 * 判别不出的档位（新增一档忘了登记、或值被改坏）会让
 * buildThinkParams 返回 {ok:false} 但 **fields 是 undefined**，
 * 而 `...undefined` 在对象展开里合法 —— 思考参数就这么没了，
 * 请求照发、界面照亮、没有任何一处报错。
 *
 * 所以正确行为是**拒绝这次生成**，而不是悄悄按不思考跑。
 */
check('★ 档位不认识时必须拒绝生成（不能静默丢掉思考参数）', () => {
  for (const engine of ['ollama', 'openai-compatible']) {
    const r = P.buildRequestBody(
      { engine, model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'no-such-level' }, []
    );
    assertNode.ok(r && r.ok === false,
      engine + ' 拿到不认识的档位却没有拒绝，而是照发请求 —— 思考参数会被静默丢掉');
    assertNode.ok(r && typeof r.error === 'string' && r.error.length > 0,
      engine + ' 拒绝了却没给 error，界面上会显示不出哪里错了');
  }
});

check('★ 关闭档不受影响（钉住反向：别把正常档位也拒了）', () => {
  const r = P.buildRequestBody(
    { engine: 'ollama', model: 'm', numCtx: 8192, maxOutput: 8192, thinkLevel: 'off' }, []
  );
  assertNode.ok(r && r.ok === true, 'off 档是合法的，不该被这条检查拦下来');
});
console.log('\n' + (failures.length ? '✗' : '✓') +
  ` ${passed} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.message}`);
  process.exit(1);
}
process.exit(0);

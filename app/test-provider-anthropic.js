/**
 * Anthropic 协议 + 服务商量表的测试。
 *
 * 由 test-provider.js 通过 run(ctx) 挂载，共享它的 check 计数器。
 */
module.exports.run = function run(ctx) {
  const { check, section, P, assertNode, require, path, ROOT } = ctx;

  // ============================================================
  // Anthropic 协议（2026-10-12 新增）
  //
  // 下面每一条都对着官方文档核实过，不是凭记忆写的。
  // 判据写成「差异点」而不是「看起来对」，因为这类协议的
  // 失败模式都是静默的：请求发出去、服务端接受，
  // 但模型少写一半内容或者干脆不写正文。
  // ============================================================

  /** 用一个收集器跑 handleLine，看它吐了什么 */
  function line(raw, cfg) {
    const got = { text: [], think: [] };
    const meta = P.handleLine(raw, cfg || {}, 'anthropic', {
      onText: (t) => got.text.push(t),
      onThink: (t) => got.think.push(t),
    });
    return { text: got.text.join(''), think: got.think.join(''), meta };
  }

  check('★ Anthropic：system 提到顶层，不留在 messages 里', () => {
    const r = P.buildRequestBody(
      { engine: 'anthropic', model: 'claude', numCtx: 8192, temperature: 0.3, thinkLevel: 'off' },
      [
        { role: 'system', content: '你是写作助手' },
        { role: 'user', content: '写一段' },
      ]
    );
    assertNode.strictEqual(r.body.system, '你是写作助手',
      'system 没被提到顶层 —— Anthropic 会把它当成一条奇怪的用户消息');
    const roles = r.body.messages.map((m) => m.role);
    assertNode.ok(!roles.includes('system'),
      `messages 里不该有 system，实际是 ${JSON.stringify(roles)}`);
  });

  check('★ Anthropic：多条 system 合并成一条（它只接受一个顶层 system）', () => {
    const r = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, thinkLevel: 'off' },
      [
        { role: 'system', content: '规则一' },
        { role: 'user', content: '中间插话' },
        { role: 'system', content: '规则二' },
        { role: 'user', content: '继续' },
      ]
    );
    assertNode.ok(r.body.system.includes('规则一') && r.body.system.includes('规则二'),
      '多条 system 没合并');
    assertNode.strictEqual(r.body.messages.length, 2, 'system 不该留在 messages 里');
  });

  check('★ Anthropic：max_tokens 必填且给足', () => {
    // Anthropic 没有默认值，不给直接 400
    const off = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, thinkLevel: 'off' }, []
    ).body;
    assertNode.ok(off.max_tokens >= 1024, `max_tokens 太小：${off.max_tokens}`);
    // 开思考时要给更多 —— thinking 会吃掉一大截
    const on = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, thinkLevel: 'high' }, []
    ).body;
    assertNode.ok(on.max_tokens > off.max_tokens,
      `开思考时 max_tokens 应更大（${on.max_tokens} vs ${off.max_tokens}）—— `
      + '给小了正文会被 thinking 吃光，用户看到的是"转圈但没字"');
  });

  check('★ Anthropic：开思考时 budget_tokens < max_tokens（否则服务端 400）', () => {
    const b = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, thinkLevel: 'high' }, []
    ).body;
    assertNode.ok(b.thinking && b.thinking.type === 'enabled', '没发 thinking 参数');
    assertNode.ok(b.thinking.budget_tokens < b.max_tokens,
      `budget_tokens(${b.thinking.budget_tokens}) 必须小于 max_tokens(${b.max_tokens})，`
      + '否则 Anthropic 直接 400');
  });

  check('★ Anthropic：开思考时 temperature 被强制为 1', () => {
    // extended thinking 只允许 temperature=1，给别的值服务端报错
    const b = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, temperature: 0.3, thinkLevel: 'on' }, []
    ).body;
    assertNode.strictEqual(b.temperature, 1,
      `开思考时 temperature 应强制为 1，实际 ${b.temperature}`);
    const off = P.buildRequestBody(
      { engine: 'anthropic', model: 'c', numCtx: 8192, temperature: 0.3, thinkLevel: 'off' }, []
    ).body;
    assertNode.strictEqual(off.temperature, 0.3, '关思考时应保留用户设的温度');
  });

  check('★ Anthropic：正文与思考各走各的字段', () => {
    const t = line('data: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"text_delta","text":"雨停了"}}');
    assertNode.strictEqual(t.text, '雨停了');
    assertNode.strictEqual(t.think, '', '正文不该进思考通道');

    const k = line('data: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"thinking_delta","thinking":"先想一下"}}');
    assertNode.strictEqual(k.think, '先想一下');
    assertNode.strictEqual(k.text, '', '思考不该进正文通道');

    // ⚠ signature_delta 不是任何一种内容，输出它会把乱码写进正文
    const s = line('data: {"type":"content_block_delta","index":0,'
      + '"delta":{"type":"signature_delta","signature":"EqQBCgIY"}}');
    assertNode.strictEqual(s.text + s.think, '', 'signature 不该被当成内容输出');
  });

  check('★ Anthropic：结束信号在 event 行上，没有 data', () => {
    // 这是它与 OpenAI 最容易踩的差别：OpenAI 是 data:[DONE]，
    // Anthropic 是 event: message_stop，后面**没有 data 行**。
    // 只认 data: 的解析器会漏掉它，靠连接关闭兜底 ——
    // 后果是 token 统计丢失、界面显示"还在生成"。
    const ev = line('event: message_stop');
    assertNode.strictEqual(ev.meta.done, true,
      '没认 event: message_stop —— Anthropic 的流永远结束不了');
    // event 行本身不该产出内容
    assertNode.strictEqual(ev.text, '');
    // 中间的 content_block_stop 不是结束
    assertNode.ok(!line('event: content_block_stop').meta.done,
      'content_block_stop 只是块结束，不是整个流结束');
  });

  check('★ Anthropic：ping 心跳被忽略（否则会刷屏）', () => {
    const p = line('event: ping');
    assertNode.strictEqual(p.text, '');
    assertNode.strictEqual(p.think, '');
    assertNode.ok(!p.meta.done, 'ping 不是结束');
    assertNode.strictEqual(line(': keep-alive').text, '', '注释行应被忽略');
  });

  check('★ Anthropic：usage 是累计值（覆盖而非累加）', () => {
    const a = line('data: {"type":"message_start","message":{"usage":'
      + '{"input_tokens":1200,"output_tokens":1}}}').meta;
    assertNode.strictEqual(a.tokensIn, 1200);
    const b = line('data: {"type":"message_delta","usage":'
      + '{"input_tokens":1200,"output_tokens":580}}').meta;
    assertNode.strictEqual(b.tokensOut, 580,
      'message_delta 的 usage 是累计值，应直接取而不是累加');
  });

  check('★ Anthropic：流内错误要抛出且脱敏', () => {
    const SECRET = 'sk-ant-SHOULD-NOT-LEAK';
    let threw = null;
    try {
      line('data: {"type":"error","error":{"type":"overloaded_error",'
        + `"message":"overloaded for ${SECRET}"}}`, { apiKey: SECRET });
    } catch (e) { threw = e; }
    assertNode.ok(threw, '流内错误被静默吞掉了 —— 用户看到的是"卡住不动"');
    assertNode.ok(!threw.message.includes(SECRET),
      `密钥泄露到错误信息里：${threw.message}`);
  });

  check('★ Anthropic：错误提示不该串到别的协议上', () => {
    const e = P.describeHttp(401, 'invalid x-api-key', 'anthropic', 'sk-ant-xxx');
    assertNode.ok(/密钥|鉴权/.test(e), `401 的提示应提到鉴权，实际：${e}`);
    const nf = P.describeHttp(404, '', 'anthropic', null);
    assertNode.ok(!/Ollama/.test(nf),
      `Anthropic 的 404 提示不该提 Ollama，实际：${nf}`);
  });

  // ============================================================
  // 服务商量表
  // ============================================================
  const PRESETS = require(path.join(ROOT, 'app', 'electron', 'provider-presets.js'));

  check('★ 量表覆盖了用户点名的几家', () => {
    const keys = PRESETS.PROVIDERS.map((p) => p.key);
    for (const k of ['deepseek', 'zhipu', 'siliconflow', 'dashscope', 'moonshot']) {
      assertNode.ok(keys.includes(k), `量表里没有 ${k}`);
    }
  });

  check('★ 每家的 base 都没有结尾斜杠（否则拼出来是 //）', () => {
    for (const p of PRESETS.PROVIDERS) {
      assertNode.ok(!/\/$/.test(p.base),
        `${p.name} 的 base 以斜杠结尾：${p.base}`);
      assertNode.ok(!p.base.includes(' '), `${p.name} 的 base 里有空格：${p.base}`);
    }
  });

  check('★ 智谱的地址是 /api/paas/v4 —— 少一层就 404', () => {
    // 这是最容易抄错的一家：其他家都是 /v1
    const z = PRESETS.get('zhipu');
    assertNode.strictEqual(z.base, 'https://open.bigmodel.cn/api/paas/v4');
  });

  check('★ 硅基流动的模型名带斜杠（org/model）', () => {
    const s = PRESETS.get('siliconflow');
    assertNode.ok(s.models.some((m) => m.includes('/')),
      '硅基流动的模型 ID 是 org/model 形式，界面上要提示否则用户填不对');
  });

  check('★ 每家的协议都是三种之一', () => {
    for (const p of PRESETS.PROVIDERS) {
      assertNode.ok(['ollama', 'openai', 'anthropic'].includes(p.protocol),
        `${p.name} 的协议不认识：${p.protocol}`);
    }
    assertNode.strictEqual(PRESETS.get('anthropic').protocol, 'anthropic',
      'Claude 必须走 anthropic 协议，不是 OpenAI 兼容');
  });

  check('★ 本地两家不需要密钥，其余云服务都需要', () => {
    for (const p of PRESETS.PROVIDERS) {
      if (p.isLocal) {
        assertNode.ok(!p.needKey,
          `${p.name} 是本地的，不该要求密钥（vLLM 除非启动时加了 --api-key）`);
      } else if (!p.key.startsWith('custom-')) {
        assertNode.ok(p.needKey, `${p.name} 是云服务，必须填密钥`);
      }
    }
  });

  check('★ 需要密钥的都有获取入口（用户不用去搜索引擎）', () => {
    for (const p of PRESETS.PROVIDERS) {
      if (p.needKey && !p.key.startsWith('custom-')) {
        assertNode.ok(/^https:\/\//.test(p.keyUrl),
          `${p.name} 缺密钥获取链接（现在是 "${p.keyUrl}"）`);
      }
    }
  });

  check('★ 思考形态都合法，且给了档位的必须写说明', () => {
    // 这条是给界面留的契约：拿不到档位的服务商
    // 必须标 none / model-only，界面才能不给四档
    // （硬给四档就是骗用户——medium 与 high 发过去完全一样）
    for (const p of PRESETS.PROVIDERS) {
      assertNode.ok(['boolean', 'levels', 'model-only', 'none'].includes(p.think.style),
        `${p.name} 的 think.style 不认识：${p.think.style}`);
      if (p.think.style !== 'none' && p.think.style !== 'model-only') {
        assertNode.ok(p.think.note, `${p.name} 给了思考档位却没说明，界面会显示得莫名其妙`);
      }
    }
  });

  check('guessByBase 能认出老配置（迁移时靠它）', () => {
    assertNode.strictEqual(PRESETS.guessByBase('https://api.deepseek.com'), 'deepseek');
    assertNode.strictEqual(PRESETS.guessByBase('https://api.siliconflow.cn/v1'), 'siliconflow');
    assertNode.strictEqual(PRESETS.guessByBase('https://open.bigmodel.cn/api/paas/v4'), 'zhipu');
    // 带不带结尾斜杠都要认
    assertNode.strictEqual(PRESETS.guessByBase('https://api.deepseek.com/'), 'deepseek');
    // 认不出时落到自定义，不能返回空
    assertNode.strictEqual(PRESETS.guessByBase('https://my.corp/api'), 'custom-openai');
    // ⚠ 本地 Ollama 地址要认出来。判错的后果很具体：
    //   协议从 ollama 变成 openai，端点从 /api/chat 变成 /v1/chat/completions，
    //   老用户的 Ollama 升级后直接连不上。
    assertNode.strictEqual(PRESETS.guessByBase('http://127.0.0.1:11434'), 'ollama');
    assertNode.strictEqual(PRESETS.guessByBase('http://127.0.0.1:8000'), 'vllm');
    // 空地址不猜
    assertNode.strictEqual(PRESETS.guessByBase(''), '');
  });

};

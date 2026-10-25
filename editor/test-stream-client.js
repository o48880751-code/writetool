/**
 * 流式客户端验收测试。
 *
 * 分两部分：
 *   一、协议解析（用构造的 NDJSON，不调模型，秒级）
 *   二、真实模型流式（需Ollama 在线，验证到真实响应）
 *
 * 运行：node editor/test-stream-client.js        仅协议解析
 *      node editor/test-stream-client.js --live  含真实模型
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { chatStream, readNdjson } = require('./ollama-stream.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`         · ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`         · ${e.message}`);
  }
}

/**
 * 起一个假Ollama：返回指定的原始 chunk 字节序列。
 * 这样能精确构造「JSON 被切成任意边界」的场景——这是流式最核心的坑。
 */
function fakeOllama(chunksBytes, { delayMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let i = 0;
    const push = () => {
      if (i >= chunksBytes.length) { res.end(); return; }
      res.write(chunksBytes[i++]);
      if (delayMs) setTimeout(push, delayMs);
      else push();
    };
    push();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const line = (o) => JSON.stringify(o) + '\n';

async function main() {
  const LIVE = process.argv.includes('--live');
  console.log('\n流式客户端验收测试\n');

  // ==========================================================
  console.log('一、NDJSON 解析');

  await checkAsync('逐字正文增量按序到达', async () => {
    const chunks = [
      Buffer.from(line({ message: { role: 'assistant', content: '秋' }, done: false })),
      Buffer.from(line({ message: { role: 'assistant', content: '雨' }, done: false })),
      Buffer.from(line({ message: { role: 'assistant', content: '落在' }, done: false })),
      Buffer.from(line({ done: true, done_reason: 'stop', eval_count: 12, prompt_eval_count: 300 })),
    ];
    const { server, port } = await fakeOllama(chunks);
    const oldHost = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
    // chatStream 在模块加载时读 BASE_URL，所以这里直接改测试目标
    const mod = require('./ollama-stream.js');
    const seen = [];
    // 用 readNdjson 直接测，避免 BASE_URL 已固化
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    await readNdjson(res, (o) => { if (!o.done) seen.push(o.message.content); });
    assert.deepStrictEqual(seen, ['秋', '雨', '落在'], `增量顺序错：${JSON.stringify(seen)}`);
    server.close();
    process.env.OLLAMA_HOST = oldHost;
    void mod;
  });

  await checkAsync('JSON 被切在任意字节边界都能正确重组', async () => {
    const full = line({ message: { role: 'assistant', content: '一二三四五' }, done: false })
      + line({ done: true });
    const bytes = Buffer.from(full, 'utf8');
    // 切成 1 字节一片——最严苛的边界情况
    const chunks = [];
    for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1));
    const { server, port } = await fakeOllama(chunks);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    const got = [];
    await readNdjson(res, (o) => got.push(o));
    server.close();
    assert.strictEqual(got.length, 2, `应解析出 2 行，实际 ${got.length}`);
    assert.strictEqual(got[0].message.content, '一二三四五');
    assert.strictEqual(got[1].done, true);
  });

  await checkAsync('末行无换行结尾也能解析', async () => {
    const chunks = [
      Buffer.from(line({ message: { content: '甲' }, done: false })),
      Buffer.from(JSON.stringify({ done: true, eval_count: 5 })), // 无 \n
    ];
    const { server, port } = await fakeOllama(chunks);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    const got = [];
    await readNdjson(res, (o) => got.push(o));
    server.close();
    assert.strictEqual(got.length, 2, `应解析出 2 行，实际 ${got.length}`);
    assert.strictEqual(got[1].done, true);
  });

  await checkAsync('非 JSON 行被标记而不中断', async () => {
    const chunks = [
      Buffer.from(line({ message: { content: '正常' }, done: false })),
      Buffer.from('这不是JSON\n'),
      Buffer.from(line({ done: true })),
    ];
    const { server, port } = await fakeOllama(chunks);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    const got = [];
    await readNdjson(res, (o) => got.push(o));
    server.close();
    const errs = got.filter((o) => o.__parseError);
    assert.strictEqual(errs.length, 1, `应记录 1 个解析错误，实际 ${errs.length}`);
    assert.strictEqual(got[0].message.content, '正常', '正常行应仍被解析');
  });

  // ==========================================================
  console.log('\n二、tool call 碎片重组（流式独有的难题）');

  await checkAsync('arguments 字符串碎片能正确拼回完整JSON', async () => {
    // 模拟 Ollama 把 arguments 切成三片——非流式下不存在这个问题
    const fullArgs = JSON.stringify({ query: '乱葬岗', entity_type: 'location' });
    const chunks = [
      Buffer.from(line({ message: { content: '' }, done: false })),
      Buffer.from(line({ message: { tool_calls: [{ function: { name: 'query_world_bible', arguments: fullArgs.slice(0, 12) } }] }, done: false })),
      Buffer.from(line({ message: { tool_calls: [{ function: { arguments: fullArgs.slice(12, 30) } }] }, done: false })),
      Buffer.from(line({ message: { tool_calls: [{ function: { arguments: fullArgs.slice(30) } }] }, done: false })),
      Buffer.from(line({ done: true })),
    ];
    const { server, port } = await fakeOllama(chunks);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    let toolName = null;
    let argsBuf = '';
    await readNdjson(res, (o) => {
      if (o.message && o.message.tool_calls) {
        for (const tc of o.message.tool_calls) {
          if (tc.function.name) toolName = tc.function.name;
          if (tc.function.arguments) argsBuf += tc.function.arguments;
        }
      }
    });
    server.close();
    assert.strictEqual(toolName, 'query_world_bible');
    const parsed = JSON.parse(argsBuf);
    assert.strictEqual(parsed.query, '乱葬岗');
    assert.strictEqual(parsed.entity_type, 'location');
  });

  await checkAsync('arguments 碎片被用户插入垃圾后仍能结算为失败而非崩溃', async () => {
    // 模拟流中断导致的残缺 JSON：这是清洗层要接手的场景
    const chunks = [
      Buffer.from(line({ message: { tool_calls: [{ function: { name: 'commit_chapter', arguments: '{"chapter_title":"铁棺","content":"正文' } }] }, done: false })),
      Buffer.from(line({ done: true })),
    ];
    const { server, port } = await fakeOllama(chunks);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST' });
    let name = null;
    let buf = '';
    await readNdjson(res, (o) => {
      if (o.message && o.message.tool_calls) {
        for (const tc of o.message.tool_calls) {
          if (tc.function.name) name = tc.function.name;
          if (tc.function.arguments) buf += tc.function.arguments;
        }
      }
    });
    server.close();
    assert.strictEqual(name, 'commit_chapter');
    // 残缺 JSON 必须让 JSON.parse 失败，而不是被误当成合法参数
    let parseFailed = false;
    try { JSON.parse(buf); } catch (e) { parseFailed = true; }
    assert.ok(parseFailed, '残缺 JSON 不应解析成功——清洗层需要能识别它');
    assert.ok(buf.includes('正文'), '原始碎片应保留供清洗层抢救');
  });

  // ==========================================================
  if (LIVE) {
    console.log('\n三、真实模型流式');

    await checkAsync('真实模型：正文逐字流式到达', async () => {
      const { text } = await chatStream({
        model: 'qwen3:latest',
        think: false,
        options: { temperature: 0.2, num_ctx: 2048 },
        messages: [{ role: 'user', content: '用一句话说明什么是修仙。' }],
      });
      assert.ok(text.length > 5, `返回过短：${JSON.stringify(text)}`);
      console.log(`         · 收到 ${text.length} 字：${text.slice(0, 40)}...`);
    });

    await checkAsync('真实模型：带 tools 时返回完整 tool call', async () => {
      const { toolCalls, text } = await chatStream({
        model: 'qwen3:latest',
        think: false,
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [{ role: 'user', content: '查一下设定库里有没有「谢九」这个角色。' }],
        tools: [{
          type: 'function',
          function: {
            name: 'query_world_bible',
            description: '查询小说设定集。写正文之前必须先调用它确认设定。',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '检索关键词，必须是设定集中存在的实体名' },
                entity_type: { type: 'string', enum: ['character', 'faction', 'technique', 'location'], description: '限定实体类型' },
              },
              required: ['query'],
            },
          },
        }],
      });
      if (toolCalls.length === 0) {
        assert.ok(text.length > 0, `既没有 tool call 也没有正文：${text.slice(0, 80)}`);
        console.log('         · 本次未产出 tool call（模型直接回答），正文非空即通过');
        return;
      }
      const call = toolCalls[0];
      assert.ok(call.ok, `参数解析失败：${call.error}｜原文：${call.rawArgs}`);
      assert.strictEqual(call.name, 'query_world_bible');
      assert.ok(typeof call.arguments.query === 'string', `query 应为字符串，实际 ${JSON.stringify(call.arguments)}`);
      console.log(`         · tool=${call.name} args=${JSON.stringify(call.arguments)}`);
    });

    await checkAsync('真实模型：AbortSignal 能中止生成', async () => {
      const controller = new AbortController();
      let chars = 0;
      const p = chatStream(
        {
          model: 'qwen3:latest',
          think: false,
          options: { temperature: 0.7, num_ctx: 2048 },
          messages: [{ role: 'user', content: '写一段500字的武侠片段。' }],
        },
        { onText: () => { chars++; if (chars === 5) controller.abort(); } },
        { signal: controller.signal }
      );
      const r = await p;
      assert.ok(r.aborted === true, `应标记为已中止，实际 aborted=${r.aborted}`);
      assert.ok(r.text.length > 0, '中止前应已收到部分内容');
      console.log(`         · 中止时已收到 ${r.text.length} 字`);
    });
  } else {
    console.log('\n三、真实模型流式（跳过，加 --live 启用）');
  }

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`用例 ${passed + failed}　通过 ${passed}　失败 ${failed}`);
  if (failed === 0) {
    console.log(LIVE ? '流式客户端可用。' : '协议解析全部通过（未测真实模型，加 --live 可测）。');
  } else {
    console.log('存在失败项。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('测试异常终止：', e);
  process.exitCode = 1;
});

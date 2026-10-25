/**
 * 空响应的判据（2026-10-19）。
 *
 * ## 现场
 *
 * 羽毛菌发了一大段设定，模型回了「我先看看项目里已经有什么。」然后**停住**。
 * 日志：
 *   [chat] 收到响应 200（127ms）
 *   [chat] 结束 56221ms 正文=0字 工具=6
 *
 * DeepSeek 接受了请求，处理 56 秒，然后返回了一个**空流**。
 * 而 `finishOnce` 无条件把它当成"正常结束" —— 于是界面既不报错也不出内容。
 *
 * ## 这份判据要钉的两件事
 *
 * 1. 空流必须变成**错误**（`EMPTY_RESPONSE`），不能静默成功
 * 2. agent-loop 遇到它**自动重试一次**（用户不该为服务端偶发过载手动再点一次）
 *
 * ⚠ 必须用真 HTTP 服务端：这是流式解析 + 结束判定，桩函数测不到
 *   "200 但没有 data 帧" 这种真实形态。
 */
const assert = require('node:assert');
const http = require('node:http');
const P = require('./electron/provider.js');
const L = require('./electron/agent-loop.js');

let passed = 0;
const failures = [];
const pending = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); },
      ));
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

/** 起一个本地服务端，按给定的 SSE 帧回复 */
function serve(frames) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // 先把请求体读完，否则某些客户端会报 ECONNRESET
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const f of frames) res.write(f);
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** 跑一次 chatStream，收集结果 */
function runChat(cfg, opt = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // ⚠ 兜底：真挂住时不要让判据永远等下去
    const guard = setTimeout(() => done({ kind: 'timeout' }), 8000);
    P.chatStream(cfg, [{ role: 'user', content: 'hi' }], {
      onChunk: () => {},
      onThink: () => {},
      onToolCalls: () => {},
      onDone: (m) => { clearTimeout(guard); done({ kind: 'done', meta: m }); },
      onError: (e) => { clearTimeout(guard); done({ kind: 'error', err: e }); },
      ...opt,
    });
  });
}

const cfgFor = (port) => ({
  engine: 'openai',
  base: `http://127.0.0.1:${port}/v1`,
  apiKey: 'test-key',
  model: 'test-model',
});

console.log('\n=== A. 空流必须是错误（不能静默成功）===');

check('★★ 200 + 零内容 → EMPTY_RESPONSE 错误', async () => {
  const { srv, port } = await serve([]);
  try {
    const r = await runChat(cfgFor(port));
    assert.strictEqual(r.kind, 'error',
      `空流被当成了 ${r.kind} —— 那正是"说了半句就停住、还不报错"的来源`);
    assert.strictEqual(r.err.code, 'EMPTY_RESPONSE', `错误码不对：${r.err.code}`);
    // 文案要能指导用户，不能只说"失败"
    assert.ok(/重试|上下文/.test(r.err.message), `提示太干：${r.err.message}`);
  } finally { srv.close(); }
});

check('只有 [DONE] 结束帧、没有正文 → 也是空响应', async () => {
  const { srv, port } = await serve(['data: [DONE]\n\n']);
  try {
    const r = await runChat(cfgFor(port));
    assert.strictEqual(r.kind, 'error', '只有结束帧等于什么都没说');
    assert.strictEqual(r.err.code, 'EMPTY_RESPONSE');
  } finally { srv.close(); }
});

console.log('\n=== B. 正常情况不能误判 ===');

check('有正文 → 正常结束（不是空响应）', async () => {
  const frame = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
  const { srv, port } = await serve([frame, 'data: [DONE]\n\n']);
  try {
    const r = await runChat(cfgFor(port));
    assert.strictEqual(r.kind, 'done', `有正文却被判成 ${r.kind}`);
    assert.strictEqual(r.err, undefined);
  } finally { srv.close(); }
});

check('★★ 只有思考、正文为零 → 同样算失败（用户什么都看不到）', async () => {
  /**
   * ⚠⚠ 这条判据 2026-10-19 **改过一次**，理由是有新证据，不是"它红了"。
   *
   * 第一版断言"有思考没正文 = 正常结束"，理由是"服务端在正常工作，
   * 只是模型把预算花在思考上"。结果第二次现场正是这个形态：
   *   [chat] 结束 50596ms 正文=0字   （thinkSeen 为真）
   * 于是判定被 `!thinkSeen` 放过去 → 走正常 onDone → `out` 为空 →
   * **助手消息根本不落库** → 界面一片空白、连错误都没有。
   *
   * 判据应该站在用户视角：**看不到内容就是失败**，思考是否发生只影响文案。
   */
  const frame = 'data: {"choices":[{"delta":{"reasoning_content":"我在想"}}]}\n\n';
  const { srv, port } = await serve([frame, 'data: [DONE]\n\n']);
  try {
    const r = await runChat(cfgFor(port));
    assert.strictEqual(r.kind, 'error', '只有思考没有正文，用户什么都看不到，必须报错');
    assert.strictEqual(r.err.code, 'EMPTY_RESPONSE');
    assert.ok(/思考/.test(r.err.message), `文案要说清"思考了但没写"，实际：${r.err.message}`);
  } finally { srv.close(); }
});

console.log('\n=== C. agent-loop 自动重试 ===');

check('★★ 第一次空响应 → 自动重试，第二次成功就正常收尾', async () => {
  let calls = 0;
  const stub = (cfg, history, h) => {
    calls++;
    if (calls === 1) {
      const e = new Error('空内容');
      e.code = 'EMPTY_RESPONSE';
      setTimeout(() => h.onError(e), 0);
      return () => {};
    }
    setTimeout(() => {
      h.onChunk('重试之后写出来的正文');
      h.onDone({ tokensOut: 10, ms: 5 });
    }, 0);
    return () => {};
  };
  const run = L.createAgentRun({
    cfg: { engine: 'openai' },
    messages: [{ role: 'user', content: '写第一章' }],
    toolDefs: null,
    chatStream: stub,
    handlers: {
      onText: () => {},
      onDone: (m) => { runResult = m; },
      onError: (e) => { runError = e; },
    },
  });
  let runResult = null;
  let runError = null;
  await run.finished;
  assert.strictEqual(runError, null, `重试后仍然报错：${runError && runError.message}`);
  assert.ok(runResult, '没有收到 onDone');
  assert.strictEqual(calls, 2, `应当请求两次（1 次失败 + 1 次重试），实际 ${calls} 次`);
  assert.ok(/重试之后/.test(runResult.text || ''), '重试拿到的正文没有传出来');
});

check('★ 非空响应的错误**不重试**（401 重试一百次也没用）', async () => {
  let calls = 0;
  const stub = (cfg, history, h) => {
    calls++;
    setTimeout(() => {
      const e = new Error('401 未授权');
      e.code = 'HTTP_401';
      h.onError(e);
    }, 0);
    return () => {};
  };
  let runError = null;
  const run = L.createAgentRun({
    cfg: { engine: 'openai' },
    messages: [{ role: 'user', content: 'x' }],
    toolDefs: null,
    chatStream: stub,
    handlers: { onText: () => {}, onError: (e) => { runError = e; } },
  });
  await run.finished;
  assert.ok(runError, '没有把错误抛出来');
  assert.strictEqual(calls, 1, `不该重试，实际请求了 ${calls} 次`);
});

setTimeout(() => {
  Promise.all(pending).then(() => {
    const total = passed + failures.length;
    console.log(`\n${'='.repeat(52)}`);
    if (failures.length) {
      console.log(`✗ ${failures.length}/${total} 条失败：`);
      for (const { name, e } of failures) console.log(`  · ${name}\n    ${e.message}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ 全部 ${total} 条通过`);
    }
    // ⚠ 必须显式退出：provider 里给每次请求留了墙钟定时器（180s），
    //   node 会一直等它。这是已知的小泄漏，不影响产品，但会挂住判据进程。
    process.exit(failures.length ? 1 : 0);
  });
}, 100);

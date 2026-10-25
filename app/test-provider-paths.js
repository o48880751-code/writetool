/**
 * 路径解析回归测试：2026-10-14 修「硅基流动接入不行」。
 *
 * 根因：provider.js 把模型列表路径写死 `/v1/models`、对话路径写死
 * `/v1/chat/completions`，而硅基流动等预置的 base 已经带 `/v1`，
 * 拼出 `/v1/v1/...` 全 404。
 *
 * 本测试钉死：每个预置拼出来的 chat / models URL 都不能有双版本段，
 * 且必须符合各家的官方端点形态。
 */
const assertNode = require('node:assert');
const presets = require('./electron/provider-presets.js');
const P = require('./electron/provider.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
function must(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? '：' + extra : ''));
}

// 每个预置期望的 chat / models 形态（官方文档核实）
const EXPECT = {
  ollama:           { chat: 'http://127.0.0.1:11434/api/chat',         models: 'http://127.0.0.1:11434/api/tags' },
  vllm:             { chat: 'http://127.0.0.1:8000/v1/chat/completions', models: 'http://127.0.0.1:8000/v1/models' },
  deepseek:         { chat: 'https://api.deepseek.com/v1/chat/completions', models: 'https://api.deepseek.com/models' },
  zhipu:            { chat: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: 'https://open.bigmodel.cn/api/paas/v4/models' },
  siliconflow:      { chat: 'https://api.siliconflow.cn/v1/chat/completions', models: 'https://api.siliconflow.cn/v1/models' },
  dashscope:        { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models' },
  volcengine:       { chat: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', models: 'https://ark.cn-beijing.volces.com/api/v3/models' },
  moonshot:         { chat: 'https://api.moonshot.cn/v1/chat/completions', models: 'https://api.moonshot.cn/v1/models' },
  minimax:          { chat: 'https://api.minimax.chat/v1/chat/completions', models: 'https://api.minimax.chat/v1/models' },
  openrouter:       { chat: 'https://openrouter.ai/api/v1/chat/completions', models: 'https://openrouter.ai/api/v1/models' },
  openai:           { chat: 'https://api.openai.com/v1/chat/completions', models: 'https://api.openai.com/v1/models' },
  anthropic:        { chat: 'https://api.anthropic.com/v1/messages', models: 'https://api.anthropic.com/v1/models' },
  'custom-openai':  { chat: null, models: null }, // base 为空，只验「不带版本的相对路径」
  'custom-anthropic': { chat: null, models: null },
};

console.log('一、每个预置的 chat / models URL 无双版本、形态正确');
for (const p of presets.PROVIDERS) {
  const cfg = { engine: p.protocol, base: p.base, modelsPath: p.modelsPath, chatPath: p.chatPath };
  const chat = P.joinUrl(p.base, P.chatPathFor(cfg));
  const models = P.joinUrl(p.base, p.modelsPath || P.defaultModelsPath(p.protocol));
  const exp = EXPECT[p.key];
  check(`${p.key} 无双版本段`, () => {
    must('chat 双版本', !/\/v\d+\/v\d+/.test(chat), chat);
    must('models 双版本', !/\/v\d+\/v\d+/.test(models), models);
  });
  if (exp && exp.chat) {
    check(`${p.key} chat 路径正确`, () => must('chat', chat === exp.chat, `${chat} != ${exp.chat}`));
    check(`${p.key} models 路径正确`, () => must('models', models === exp.models, `${models} != ${exp.models}`));
  } else if (exp) {
    check(`${p.key} 相对路径不带版本前缀（base 由用户填）`, () => {
      must('chat', chat === '/chat/completions' || chat === '/v1/messages', chat);
      must('models', models === '/models' || models === '/v1/models', models);
    });
  }
}

console.log('二、chatPathFor / defaultModelsPath 兜底（无预置时按引擎）');
check('ollama 兜底', () => {
  must('', P.chatPathFor({ engine: 'ollama' }) === '/api/chat');
  must('', P.defaultModelsPath('ollama') === '/api/tags');
});
check('anthropic 兜底', () => {
  must('', P.chatPathFor({ engine: 'anthropic' }) === '/v1/messages');
  must('', P.defaultModelsPath('anthropic') === '/v1/models');
});
check('openai 兜底', () => {
  must('', P.chatPathFor({ engine: 'openai' }) === '/v1/chat/completions');
  must('', P.defaultModelsPath('openai') === '/models');
});
check('cfg.chatPath 优先于兜底', () => {
  must('', P.chatPathFor({ engine: 'openai', chatPath: '/x/chat' }) === '/x/chat');
});

console.log('三、listModels 接受预取正文，避免重复请求');
check('prefetched 非空 JSON 被解析', async () => {
  const r = await P.listModels({ engine: 'openai', base: 'x', modelsPath: '/models' },
    '{"data":[{"id":"a/b"},{"name":"c"}]}');
  assertNode.deepStrictEqual(r.sort(), ['a/b', 'c'].sort());
});
check('prefetched 坏 JSON 返回空数组', async () => {
  const r = await P.listModels({ engine: 'openai', base: 'x', modelsPath: '/models' }, 'not json');
  assertNode.deepStrictEqual(r, []);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/*
 * test-mock.js —— 编排层离线自测（不需要 Ollama、不需要联网）
 *
 * 用「可编程假模型」驱动 run-verify.js 里同一套清洗 / 校验 / 重试 / 降级逻辑，
 * 断言 16 类异常分支都被正确处置。
 *
 * 用法：node test-mock.js
 * 任何一条失败都说明是编排代码的 bug，与模型无关。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('./run-verify.js');

/* ---------- 构造「模型原始返回」的小工具 ---------- */

const tc = (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } });
const tcStr = (name, argsJson) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: argsJson } }] } });
const fenced = (obj) => ({ message: { content: '好的，以下是调用：\n```json\n' + JSON.stringify(obj) + '\n```' } });
const proseJson = (obj) => ({ message: { content: '我先调用工具。\n' + JSON.stringify(obj) + '\n请不要重复调用。' } });
const multi = (arr) => ({ message: { content: '', tool_calls: arr.map(([n, a]) => ({ function: { name: n, arguments: a } })) } });
const plain = (t) => ({ message: { content: t } });
const empty = () => ({ message: { content: '' } });

// query_world_bible 的 project_id 自run-verify.js 起即为必填（schema required + 校验层双保险），
// 这里的默认项目必须与 TASKS.known 的「项目 ID：novel-demo-01」一致，否则编排层会判 order_violation。
const Q = (query, project_id = 'novel-demo-01') => tc('query_world_bible', { project_id, query });
const W = (over) => tc('write_segment', { scene: '秋雨里的乱葬岗', characters: ['谢九', '洛三娘'], tone: '冷硬克制', max_length: 600, ...over });
const C = (content, over) => tc('commit_chapter', { project_id: 'novel-demo-01', chapter_title: '铁棺', content, parent_chapter_id: null, ...over });

/* ---------- 假模型：按脚本表逐轮回放 ---------- */

function scriptedChat(responses, box) {
  let i = 0;
  const seen = [];
  const chat = async (payload) => {
    seen.push(payload.messages.map((m) => `${m.role}:${String(m.content || '').slice(0, 40)}`).join('|'));
    const r = typeof responses === 'function'
      ? responses(i, payload, box || {})
      : responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return { ...r, prompt_eval_count: 300, eval_count: 60 };
  };
  chat.calls = () => i;
  chat.history = () => seen;
  return chat;
}

/* ---------- 断言框架 ---------- */

const results = [];
let outRoot;
let caseNo = 0;

function runCase(name, responses, assert, opts) {
  caseNo++;
  const o = opts || {};
  const box = {};
  const chat = scriptedChat(responses, box);
  const orch = V.createOrchestrator({
    chat,
    model: 'mock-model',
    outDir: path.join(outRoot, `case-${caseNo}`),
    deterministic: true,
    maxStepRetries: o.maxRetries === undefined ? 2 : o.maxRetries,
    // worldOverride：让「查无此实体」类用例可以喂一个不含目标实体的库，
    // 避免新库实体（或别名子串命中）让本该停笔的场景意外命中。
    world: o.worldOverride || V.loadWorld(),
  });
  box.orch = orch;
  const t0 = Date.now();
  return orch
    .runAgentSample(o.seq || caseNo, o.variant || 'known')
    .then((rec) => {
      const problems = assert(rec, orch, chat) || [];
      const ok = problems.length === 0;
      results.push({ name, ok, problems, rec, ms: Date.now() - t0 });
      const tag = rec.legal ? '合法' : rec.fallback ? '降级' : '失败';
      console.log(
        `${ok ? '  PASS' : '  FAIL'}  ${String(caseNo).padStart(2, '0')}  ${name.padEnd(30, ' ')} → ${tag}（LLM ${rec.llm_calls} 轮，重试 ${rec.retries}）`,
      );
      if (!ok) for (const p of problems) console.log(`         · ${p}`);
      return rec;
    })
    .catch((e) => {
      results.push({ name, ok: false, problems: [`抛出异常：${e.stack || e.message}`] });
      console.log(`  FAIL  ${String(caseNo).padStart(2, '0')}  ${name} → 抛出异常 ${e.message}`);
    });
}

const reasons = (rec) => rec.steps.filter((s) => !s.ok).map((s) => s.reason);
const okSteps = (rec) => rec.steps.filter((s) => s.ok).map((s) => s.step);
const stageRetries = (rec, stage) => rec.steps.filter((s) => !s.ok && s.step === stage).length;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 用例 ---------- */

async function main() {
  outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-mock-'));
  console.log(`\nTool Calling 编排层自测　假模型驱动　输出临时目录：${outRoot}\n`);

  // 01 理想情况：三步各一次成功
  await runCase('一次通过', [Q('谢九'), W(), C('x'.repeat(80))], (rec) => [
    ...(!rec.legal ? ['应判合法，实际不合法'] : []),
    ...(rec.fallback ? ['不应降级'] : []),
    ...(rec.llm_calls !== 3 ? [`应 3 轮完成，实际 ${rec.llm_calls}`] : []),
    ...(!eq(okSteps(rec), ['query_world_bible', 'write_segment', 'commit_chapter']) ? [`成功步序异常：${okSteps(rec)}`] : []),
    ...(rec.first_try.join() !== 'true,true,true' ? [`首试应全 true，实际 ${rec.first_try}`] : []),
  ]),

  // 02 被 ``` 包裹在 content 里
  await runCase('代码块包裹', [
    fenced({ name: 'query_world_bible', arguments: { project_id: 'novel-demo-01', query: '谢九' } }),
    fenced({ name: 'write_segment', arguments: { scene: '乱葬岗' } }),
    fenced({ name: 'commit_chapter', arguments: { project_id: 'novel-demo-01', chapter_title: '铁棺', content: 'y'.repeat(80) } }),
  ], (rec) => [
    ...(!rec.legal ? ['代码块包裹应被清洗后仍判合法'] : []),
    ...(!rec.cleaned.includes('fenced') ? ['cleaned 应记录 fenced 现象'] : []),
    ...(!rec.cleaned.includes('from_content') ? ['cleaned 应记录 from_content'] : []),
  ]),

  // 03 前后夹带自然语言说明
  await runCase('夹带解释文字', [
    proseJson({ name: 'query_world_bible', arguments: { project_id: 'novel-demo-01', query: '铁棺' } }),
    W(),
    C('z'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['夹带说明应能抽出 JSON 并合法完成'] : []),
    ...(rec.retries !== 0 ? [`不应产生重试，实际 ${rec.retries}`] : []),
  ]);

  // 04 arguments 是被字符串化的 JSON
  await runCase('arguments 字符串化', [
    tcStr('query_world_bible', '{"project_id":"novel-demo-01","query":"剑冢"}'),
    W(),
    C('a'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['字符串化 arguments 应被解析后合法完成'] : []),
    ...(!rec.cleaned.includes('arguments_was_string') ? ['应记录 arguments_was_string'] : []),
  ]);

  // 05 一次给两个工具
  await runCase('一次多工具', [
    Q('谢九'),
    multi([['write_segment', { scene: '乱葬岗' }], ['commit_chapter', { project_id: 'novel-demo-01', chapter_title: 'x', content: 'b'.repeat(80) }]]),
    W(),
    C('c'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['多工具应被拒后纠正并最终合法'] : []),
    ...(!reasons(rec).includes('multi_tool_call') ? ['应记录 multi_tool_call 违规'] : []),
    ...(okSteps(rec).indexOf('commit_chapter') < okSteps(rec).indexOf('write_segment') ? ['不得跳过 write_segment 直接提交'] : []),
  ]);

  // 06 工具名拼错
  await runCase('工具名错误', [
    tc('query_world', { query: '谢九' }),
    Q('谢九'),
    W(),
    C('d'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['拼错应被拒并最终合法'] : []),
    ...(!reasons(rec).includes('invalid_call') ? ['应记录 invalid_call'] : []),
    ...(!rec.steps.some((s) => !s.ok && /不存在/.test((s.errors || []).join())) ? ['错误信息应指出工具不存在'] : []),
  ]);

  // 07 缺必填字段
  await runCase('缺必填字段', [
    Q('谢九'),
    tc('write_segment', { tone: '冷硬' }),
    W(),
    C('e'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['缺 scene 应被拒并最终合法'] : []),
    ...(!rec.steps.some((s) => !s.ok && (s.errors || []).join().includes('必填')) ? ['应提示必填字段缺失'] : []),
  ]);

  // 08 枚举越界
  await runCase('枚举越界', [
    tc('query_world_bible', { query: '谢九', entity_type: 'weapon' }),
    Q('谢九'),
    W(),
    C('f'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['枚举越界应被拒并最终合法'] : []),
    ...(!rec.steps.some((s) => !s.ok && (s.errors || []).join().includes('允许集合')) ? ['应提示取值不在允许集合'] : []),
  ]);

  // 09 类型错：max_length 给了字符串
  await runCase('参数类型错误', [
    Q('谢九'),
    tc('write_segment', { scene: '乱葬岗', max_length: '六百' }),
    W(),
    C('g'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['类型错误应被拒并最终合法'] : []),
    ...(!rec.steps.some((s) => !s.ok && (s.errors || []).join().includes('类型应为')) ? ['应提示类型不符'] : []),
  ]);

  // 10 编造设定库中不存在的实体
  await runCase('编造实体名', [
    Q('萧无痕'),
    Q('谢九'),
    W(),
    C('h'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['查无此实体应被拒并最终合法'] : []),
    ...(!rec.steps.some((s) => !s.ok && (s.errors || []).join().includes('查无此实体')) ? ['应提示查无此实体'] : []),
    ...(okSteps(rec)[0] !== 'query_world_bible' ? ['第 1 步仍应是查询'] : []),
  ]);

  // 11 未查设定就想直接写
  await runCase('未查先写', [
    W(),
    Q('谢九'),
    W(),
    C('i'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['应在被纠正后完成'] : []),
    ...(!reasons(rec).includes('order_violation') ? ['应记录 order_violation'] : []),
    ...(okSteps(rec)[0] !== 'query_world_bible' ? [`纠正后第 1 步应为查询，实际 ${okSteps(rec)[0]}`] : []),
    ...(!rec.cleaned.length && !rec.steps.some((s) => !s.ok) ? ['应留有失败记录'] : []),
  ]);

  // 12 没写正文就要提交
  await runCase('无正文即提交', [
    Q('谢九'),
    C('j'.repeat(80), { content: 'j'.repeat(80) }),
    W(),
    C('k'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['应纠正提交时序并最终完成'] : []),
    ...(!reasons(rec).includes('order_violation') ? ['应记录 order_violation'] : []),
  ]);

  // 13 空返回（既不说话也不调用）
  await runCase('空返回', [empty(), empty(), Q('谢九'), W(), C('l'.repeat(80))], (rec) => [
    ...(!rec.legal ? ['空返回应触发重试并最终合法'] : []),
    ...(reasons(rec).filter((r) => r === 'no_tool_call').length !== 2 ? ['应有 2 次 no_tool_call'] : []),
  ]);

  // 14 纯文本不干活（模型自己写正文而不调工具）
  await runCase('只输出正文不调工具', [
    plain('秋雨落下，谢九站在了乱葬岗前。'),
    Q('谢九'),
    W(),
    C('m'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['应把纯文本判为无合法调用并重试'] : []),
    ...(!reasons(rec).includes('no_tool_call') ? ['应记录 no_tool_call'] : []),
  ]);

  // 15 未知参数名（模型自创字段）
  await runCase('未知参数名', [
    tc('query_world_bible', { query: '谢九', fuzzy: true }),
    Q('谢九'),
    W(),
    C('n'.repeat(80)),
  ], (rec) => [
    ...(!rec.legal ? ['未知参数应被拒'] : []),
    ...(!rec.steps.some((s) => !s.ok && (s.errors || []).join().includes('未知参数')) ? ['应提示未知参数'] : []),
  ]);

  // 16 正文过短 → 工具端拒绝 → 模型补全
  await runCase('正文过短被拒', [Q('谢九'), W({ max_length: 400 }), C('p'.repeat(12)), W(), C('q'.repeat(80))], (rec) => [
    ...(!rec.legal ? ['过短应被工具拒绝并最终补全'] : []),
    ...(!reasons(rec).includes('tool_error') ? ['应记录 tool_error'] : []),
  ]);

  // 17 连续失败 → 降级为规则链
  await runCase('连错降级', [plain('我不会用工具。'), plain('Still no.'), plain('nope'), plain('…')], (rec) => [
    ...(rec.legal ? ['连续失败不得判合法'] : []),
    ...(!rec.fallback ? ['应触发降级 fallback'] : []),
    ...(!rec.fallback_detail || !rec.fallback_detail.chapter ? ['降级应真实产出章节文件'] : []),
    ...(rec.fallback_detail && rec.fallback_detail.error ? [`降级链路本身失败：${rec.fallback_detail.error}`] : []),
  ], { maxRetries: 1 });

  // 18 传输层异常不得导致进程崩溃
  await runCase('传输异常', [new Error('connection reset'), Q('谢九'), W(), C('r'.repeat(80))], (rec) => [
    ...(rec.error && /connection reset/.test(rec.error) && !rec.fallback ? ['传输错误应记录并触发降级兜底'] : []),
    ...(!rec.fallback && !rec.legal ? ['传输失败后应给出降级或合法之一'] : []),
  ]);

  // 19 正文保真度：先节选提交，被拒后回传完整原文
  await runCase('提交被节选', (i, payload, box) => {
    const segs = box.orch.store.segments;
    if (i === 0) return Q('谢九');
    if (i === 1) return W();
    if (i === 2) return C(segs[0] ? segs[0].text.slice(0, 12) : '谢九站在');
    if (i === 3) return W();
    return C(segs[segs.length - 1].text);
  }, (rec) => [
    ...(!rec.legal ? ['应在纠正后完成'] : []),
    ...(!reasons(rec).includes('tool_error') ? ['过短提交应被工具端拒绝'] : []),
    ...(rec.content_fidelity !== 1 ? [`完整回传后保真度应为 1，实际 ${rec.content_fidelity}`] : []),
  ]);

  // 20 多次查询再写（合法行为，不得误判）
  await runCase('查询两次再写', [Q('谢九'), Q('铁棺'), W(), C('t'.repeat(80))], (rec) => [
    ...(!rec.legal ? ['多查一次属正常，应判合法'] : []),
    ...(rec.retries !== 0 ? [`不应产生重试，实际 ${rec.retries}`] : []),
    ...(rec.facts.length < 2 ? ['应累积两次查询到的设定'] : []),
    ...(okSteps(rec).filter((s) => s === 'query_world_bible').length !== 2 ? ['应记录两次成功查询'] : []),
    ...(stageRetries(rec, 'query_world_bible') !== 0 ? ['多次查询不应计为失败'] : []),
  ]);

  // 21 陌生实体组：查不到仍继续 → 记编造告警，但不拦（record 模式）
  // 注意：novel 变体归属 novel-demo-02（TASK_PROJECT），查询必须带 B 库项目号，
  // 否则会被 project 隔离闸门判order_violation，而不是走 record 模式记编造告警。
  await runCase('陌生实体-编造告警', [Q('叶霜凝', 'novel-demo-02'), W({ characters: ['叶霜凝', '岑无咎'] }), C('u'.repeat(80), { project_id: 'novel-demo-02' })], (rec) => [
    ...(rec.variant !== 'novel' ? ['应变体应记为 novel'] : []),
    ...(!rec.legal ? ['陌生实体组应允许走通（record 模式）以便统计编造'] : []),
    ...(!rec.warnings.some((w) => /疑似编造/.test(w)) ? ['应记录查询侧编造告警'] : []),
    ...(!rec.warnings.some((w) => /未经确认的编造/.test(w)) ? ['应记录角色侧编造告警'] : []),
    ...(rec.retries !== 0 ? [`record 模式不应产生重试，实际 ${rec.retries}`] : []),
  ], { variant: 'novel' });

  // 22 陌生实体组 + 模型罢工 → 规则链应「停笔」而不是硬编
  // 用worldOverride 只喂 A 库：novel 变体的查询词（叶霜凝/听潮阁/青铜钟）在 A 库中
  // 全部落空，才能真正触发「查无 → 停笔」。若用全量库，「青铜钟」会子串命中
  // B 库 悬风钟 的别名「铜钟」，规则链就会继续写，停笔分支就测不到了。
  await runCase('陌生实体-规则链停笔', [plain('我不会用工具。'), plain('还是不会。'), plain('…')], (rec) => [
    ...(rec.legal ? ['不应判合法'] : []),
    ...(!rec.fallback ? ['应触发降级'] : []),
    ...(!rec.halted_reason ? ['规则链查不到设定应停笔，不应凭空生成'] : []),
    ...(rec.chapter ? ['停笔时不应产出章节文件'] : []),
  ], { variant: 'novel', maxRetries: 1, worldOverride: V.loadWorld().filter((e) => e.project === 'novel-demo-01') });

  // ---------- 写→改闭环组 ----------
  const RD = () => tc('read_chapter', { project_id: 'novel-demo-01', chapter_id: V.SEED_CHAPTER_ID });
  const RC = (content) => C(content, { chapter_id: V.SEED_CHAPTER_ID });
  const goodRev = '修订稿：' + V.SEED_PROTECTIONS.join('，') + '。' + 'g'.repeat(80);
  const badRev1 = '修订稿丢了第二句：' + V.SEED_PROTECTIONS[0] + '。' + 'h'.repeat(80);
  const badRev2 = '修订稿两句都丢了。' + 'i'.repeat(80);
  const RW = () => W({ scene: '在原文基础上修订，基调肃杀', characters: ['谢九', '洛三娘'], tone: '肃杀', max_length: 500 });

  // 23 理想修订链路：读→查→写→带 ID 覆盖，保护句逐字保留
  await runCase('修订一次通过', [RD(), Q('铁棺'), RW(), RC(goodRev)], (rec, orch) => [
    ...(!rec.legal ? ['规范修订应判合法'] : []),
    ...(rec.retries !== 0 ? [`不应有重试，实际 ${rec.retries}`] : []),
    ...(!eq(okSteps(rec), ['read_chapter', 'query_world_bible', 'write_segment', 'commit_chapter']) ? [`步序应读→查→写→存，实际 ${okSteps(rec)}`] : []),
    ...((rec.chapter && !fs.existsSync(rec.chapter + '.bak')) ? ['覆盖前应生成 .bak 备份'] : []),
    ...((rec.chapter && fs.existsSync(rec.chapter) && !V.SEED_PROTECTIONS.every((p) => fs.readFileSync(rec.chapter, 'utf8').includes(p))) ? ['落盘稿应含全部保护句'] : []),
  ], { variant: 'revise' });

  // 24 跳过 read_chapter 想凭记忆直接改 → 必须被拦
  await runCase('修订-跳读被拦', [RW(), RD(), Q('铁棺'), RW(), RC(goodRev)], (rec) => [
    ...(!reasons(rec).includes('order_violation') ? ['未读原稿即修订应记 order_violation'] : []),
    ...(!rec.legal ? ['纠正后应完成链路'] : []),
    ...(rec.protection_dropped !== 0 ? ['本用例不应记丢稿'] : []),
  ], { variant: 'revise' });

  // 25 覆盖稿丢一句保护句 → 拒绝保存并记 protection_lost，纠正后成功
  await runCase('修订-丢一句被拒', [RD(), Q('铁棺'), RW(), RC(badRev1), RC(goodRev)], (rec) => [
    ...(!reasons(rec).includes('protection_lost') ? ['丢保护句的覆盖应记 protection_lost'] : []),
    ...(rec.protection_dropped !== 1 ? [`应记 1 次丢稿，实际 ${rec.protection_dropped}`] : []),
    ...(!rec.legal ? ['纠正后应完成'] : []),
  ], { variant: 'revise' });

  // 26 试图新建章节（不带 chapter_id）→ 拒绝并纠正
  await runCase('修订-错存为新章', [RD(), Q('铁棺'), RW(), C('j'.repeat(80)), RC(goodRev)], (rec, orch) => [
    ...(!reasons(rec).includes('order_violation') ? ['不带原章 ID 的覆盖应被拦'] : []),
    ...(!rec.legal ? ['纠正后应完成'] : []),
    ...(orch.store.chapters.filter((c) => c.via === 'agent').length > 0 ? ['不应新建 agent 章节，只应覆盖种子'] : []),
  ], { variant: 'revise' });

  // 27 修订组模型罢工 → 降级链自己读回原稿，保不住保护句则停笔不覆盖
  await runCase('修订-降级链停笔', [plain('我不会。'), plain('不会。'), plain('…')], (rec, orch) => {
    const seedFile = orch.store.chapters.find((c) => c.id === V.SEED_CHAPTER_ID).file;
    return [
      ...(rec.legal ? ['罢工不应判合法'] : []),
      ...(!rec.fallback ? ['应触发降级'] : []),
      ...(!rec.halted_reason ? ['规则链保不住保护句应停笔'] : []),
      ...(fs.existsSync(seedFile + '.bak') ? ['停笔时不应发生覆盖，不应有 .bak'] : []),
      ...(!fs.readFileSync(seedFile, 'utf8').includes(V.SEED_PROTECTIONS[1]) ? ['停笔后种子稿必须原样无损'] : []),
    ];
  }, { variant: 'revise', maxRetries: 1 });

  // 汇总
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`用例 ${results.length}　通过 ${pass}　失败 ${fail}`);
  if (fail) {
    console.log('\n失败明细：');
    for (const r of results) if (!r.ok) for (const p of r.problems) console.log(`  ✗ ${r.name}：${p}`);
    console.log('\n以上失败均为编排层 bug，请先修复再去跑真实模型。');
    process.exitCode = 1;
  } else {
    console.log('编排层（清洗 → 校验 → 重试 → 降级 → 时序约束）全部通过。');
    console.log('可以开始跑真实模型：node run-verify.js --model qwen3:latest');
  }

  // 顺带验证报表生成不抛错
  const rep = V.buildReport('mock-model', results.map((r) => r.rec).filter(Boolean), [], { temperature: 0.2, noThink: true, novel: true });
  const rp = path.join(outRoot, '报表.md');
  fs.writeFileSync(rp, rep, 'utf8');
  console.log(`\n报表样例：${rp}`);
  if (process.argv.includes('--print')) console.log(`\n${'='.repeat(64)}\n${rep}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

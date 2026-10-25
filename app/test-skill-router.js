/**
 * 技能自动路由的边界判据。
 *
 * ## 要防什么
 *
 * 这个模块最贵的性质不是「判得准」，是**判错时不让人受伤**。
 * 三条红线：
 *   1. 路由挂了不能影响用户发消息
 *   2. 手动 @ 的优先级不能被自动路由覆盖
 *   3. 模型编造的 id 不能被照单全收
 *
 * 「判得准不准」不在这里测——那是 eval-skill-routing.js 的活，
 * 要真连模型跑 44 次。这里测的是**控制流**，喂桩就行。
 *
 * 跑法：node test-skill-router.js
 */

const path = require('node:path');
const R = require(path.join(__dirname, 'electron', 'skill-router.js'));

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}

const INDEX = [
  { id: 'sk-novel-writer', name: '写新章节', description: '写新章节、续写时使用。' },
  { id: 'sk-novel-revisor', name: '修订已保存章节', description: '修改已存在的章节时使用。' },
  { id: 'sk-novel-sync', name: '一致性检查与文档同步', description: '检查矛盾与同步文档时使用。' },
];

async function main() {
  console.log('—— 短路条件 ——');

  t('开关关着 → 不问模型',
    !R.shouldRoute({ enabled: false, index: INDEX, question: '续写下一章' }));
  t('索引为空 → 不问模型',
    !R.shouldRoute({ enabled: true, index: [], question: '续写下一章' }));
  t('用户手动勾过 → 不问模型',
    !R.shouldRoute({ enabled: true, index: INDEX, question: '续写', manualIds: ['sk-novel-writer'] }));
  t('消息只有一个字 → 不问模型',
    !R.shouldRoute({ enabled: true, index: INDEX, question: '好' }));
  t('正常情况 → 问模型',
    R.shouldRoute({ enabled: true, index: INDEX, question: '帮我续写下一章' }));

  console.log('\n—— 短路时不该调 ask ——');
  let asked = 0;
  const countAsk = async () => { asked++; return '{"ids":[]}'; };
  const r1 = await R.route({ enabled: false, index: INDEX, question: '续写下一章', ask: countAsk });
  t('开关关着时 ask 一次都没被调', asked === 0, `实际 ${asked} 次`);
  t('且返回的 ids 为空', r1.ids.length === 0 && r1.reason === 'disabled', JSON.stringify(r1));

  console.log('\n—— 正常路由 ——');
  const r2 = await R.route({
    enabled: true, index: INDEX, question: '帮我续写下一章',
    ask: async () => '{"ids":["sk-novel-writer"]}',
  });
  t('命中一个技能', r2.ids.join() === 'sk-novel-writer', JSON.stringify(r2));
  t('reason 是 ok', r2.reason === 'ok');

  console.log('\n—— 容忍脏输出 ——');
  const dirty = [
    ['```json\n{"ids":["sk-novel-sync"]}\n```', '代码块包裹'],
    ['我认为应该用：{"ids":["sk-novel-sync"]}，因为……', '前后有废话'],
    ['{"ids":["sk-novel-sync",]}', '尾逗号'],
    ['{"ids" : [ "sk-novel-sync" ] }', '多余空格'],
  ];
  for (const [raw, label] of dirty) {
    t(`能解析：${label}`, R.extractIds(raw) != null
      && R.extractIds(raw)[0] === 'sk-novel-sync', `实得 ${JSON.stringify(R.extractIds(raw))}`);
  }

  console.log('\n—— ⚠ 降级：这些必须不影响用户 ——');
  const bads = [
    ['完全不是 JSON', '说话说'],
    ['', '空输出'],
    ['{"ids":"不是数组"}', 'ids 不是数组'],
    ['null', 'null'],
  ];
  for (const [raw, label] of bads) {
    const r = await R.route({ enabled: true, index: INDEX, question: '续写', ask: async () => raw });
    t(`格式不可用时静默降级：${label}`,
      r.ids.length === 0 && r.reason.startsWith('fail'),
      JSON.stringify(r));
  }

  const rTimeout = await R.route({
    enabled: true, index: INDEX, question: '续写',
    ask: async () => { throw new Error('超时'); },
  });
  t('模型抛异常时静默降级',
    rTimeout.ids.length === 0 && rTimeout.reason === 'fail:timeout', JSON.stringify(rTimeout));

  console.log('\n—— ⚠ 模型编造 id 不能被收下 ——');
  const rFake = await R.route({
    enabled: true, index: INDEX, question: '续写',
    ask: async () => '{"ids":["sk-novel-sync","sk-不存在的技能","../../etc/passwd"]}',
  });
  t('编造的 id 被滤掉，只留真实存在的',
    rFake.ids.length === 1 && rFake.ids[0] === 'sk-novel-sync', JSON.stringify(rFake));

  console.log('\n—— ⚠ 一次最多注入 2 个 ——');
  // ⚠ 消息要够长：第一版只写了一个「写」字，
  //   被 shouldRoute 的「太短」规则短路，压根没走到截断逻辑，
  //   判据测的是短路而不是截断。判据报错时先看自己有没有走到分支。
  const rMany = await R.route({
    enabled: true, index: INDEX, question: '帮我写下一章，然后修订上一章，最后同步一下文档',
    ask: async () => '{"ids":["sk-novel-writer","sk-novel-revisor","sk-novel-sync"]}',
  });
  t('三个全中时被截到 2 个',
    rMany.ids.length === R.MAX_AUTO_SKILLS, JSON.stringify(rMany));
  t('且截的是前两个（保持模型给的顺序）',
    rMany.ids.join() === 'sk-novel-writer,sk-novel-revisor', JSON.stringify(rMany));

  console.log('\n—— 提示词一致性 ——');
  t('提示词里列出了全部候选技能',
    INDEX.every((s) => R.buildRouterPrompt(INDEX, '测试').includes(s.id)));
  t('提示词里带了用户原话',
    R.buildRouterPrompt(INDEX, '帮我续写下一章').includes('帮我续写下一章'));

  console.log(`\n通过 ${pass}｜失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

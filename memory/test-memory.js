/**
 * 记忆层验收测试：上下文压缩 + 状态回写（不调模型，秒级）。
 *
 * 运行：node memory/test-memory.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { ContextBudget, summarizeBible, estimateTokens } = require('./context-budget.js');
const { extractEntities, resolveLocation, detectDrift, deriveStateChanges, applyStateAfterCommit } = require('./state-writer.js');
const { Store } = require('../db/store.js');
const { resolveWorldPath } = require('../run-verify.js');

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

console.log('\n记忆层验收测试（上下文压缩 + 状态回写）\n');

// ============================================================
console.log('一、上下文预算');

check('token 估算：中文约 1.5 字/token', () => {
  const t = estimateTokens('这是一段测试文本');
  assert.ok(t > 0 && t <= 10, `估算异常：${t}`);
});

check('预算内不压缩', () => {
  const b = new ContextBudget({ numCtx: 8192, reserve: 2048 });
  // 5 轮 × 约 100 字 ≈ 340 token，远在6144 的预算内
  for (let i = 0; i < 5; i++) {
    b.push({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮对话`.repeat(20) });
  }
  assert.ok(b.usedTokens() <= b.historyBudget,
    `构造的样本不应超预算，实际 ${b.usedTokens()}/${b.historyBudget}`);
  const dropped = b.compress();
  assert.strictEqual(dropped.length, 0,
    `预算内不该丢任何条目，实际丢了 ${dropped.length}：${JSON.stringify(b.report().byRole)}`);
});

check('超预算时压缩到限额内', () => {
  const b = new ContextBudget({ numCtx: 4096, reserve: 1024, keepRecentRounds: 2 });
  for (let i = 0; i < 20; i++) {
    b.push({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮的内容`.repeat(50) });
  }
  assert.strictEqual(b.isOverBudget(), true, '应处于超预算状态');
  b.compress();
  assert.ok(b.usedTokens() <= b.historyBudget, `压缩后仍超：${b.usedTokens()}/${b.historyBudget}`);
});

check('pinned 条目永不丢弃', () => {
  const b = new ContextBudget({ numCtx: 2048, reserve: 256, keepRecentRounds: 1 });
  b.push({ role: 'system', content: '这是系统提示词'.repeat(200), pinned: true });
  for (let i = 0; i < 30; i++) {
    b.push({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮`.repeat(100) });
  }
  b.compress();
  const sys = b.items.filter((it) => it.role === 'system');
  assert.strictEqual(sys.length, 1, 'pinned 的 system 被丢弃了');
  assert.ok(sys[0].content.includes('系统提示词'));
});

check('未引用的工具结果优先被丢', () => {
  // 样本必须真的超预算，否则 compress() 正确地什么都不做
  const b = new ContextBudget({ numCtx: 1200, reserve: 200, keepRecentRounds: 1 });
  b.push({ role: 'user', content: '写一段'.repeat(30) });
  b.push({ role: 'tool', content: '检索结果A'.repeat(300) }, { used: false });
  b.push({ role: 'tool', content: '检索结果B'.repeat(300) }, { used: true });
  b.push({ role: 'assistant', content: '写好的内容'.repeat(100) });
  assert.ok(b.isOverBudget(), `样本应超预算，实际 ${b.usedTokens()}/${b.historyBudget}`);
  b.compress();
  const toolTexts = b.items.filter((it) => it.role === 'tool').map((it) => it.content);
  assert.ok(!toolTexts.some((t) => t.includes('检索结果A')), '未引用的工具结果未被丢弃');
  assert.ok(toolTexts.some((t) => t.includes('检索结果B')), '被引用的工具结果被误丢');
});

check('最近 N 轮对话被保留', () => {
  const b = new ContextBudget({ numCtx: 2000, reserve: 500, keepRecentRounds: 3 });
  for (let i = 0; i < 10; i++) {
    b.push({ role: i % 2 ? 'assistant' : 'user', content: `标记${i}`.repeat(80) });
  }
  assert.ok(b.isOverBudget(), `样本应超预算，实际 ${b.usedTokens()}/${b.historyBudget}`);
  b.compress();
  const text = b.items.map((it) => it.content).join('|');
  assert.ok(text.includes('标记9'), '最新一轮被丢了');
  assert.ok(text.includes('标记7'), '次新一轮被丢了');
  assert.ok(!text.includes('标记0'), '最旧一轮竟然还在');
});

check('压缩不会死循环', () => {
  const b = new ContextBudget({ numCtx: 1000, reserve: 900, keepRecentRounds: 1 });
  for (let i = 0; i < 40; i++) b.push({ role: 'user', content: 'x'.repeat(200) });
  b.compress(); // 不抛异常即通过（内部有 guard）
});

check('无可丢时置starved 且仍超预算（调用方须中止而非静默丢设定）', () => {
  const b = new ContextBudget({ numCtx: 600, reserve: 100, keepRecentRounds: 1 });
  b.push({ role: 'system', content: '固定区'.repeat(50), pinned: true });
  b.push({ role: 'tool', content: '被引用的设定原文'.repeat(200) }, { used: true });
  assert.ok(b.isOverBudget(), '样本应超预算');
  b.compress();
  assert.strictEqual(b.starved, true, '应标记为 starved');
  assert.strictEqual(b.isOverBudget(), true, 'starved 后应仍超预算——让调用方看到');
  // 关键：被引用的设定原文仍在，没被悄悄丢掉
  assert.ok(b.items.some((it) => it.content.includes('被引用的设定原文')),
    '被引用的设定原文被丢弃了——这会造成设定丢失');
});

check('预算恢复后 starved 被重置', () => {
  const b = new ContextBudget({ numCtx: 600, reserve: 100 });
  b.push({ role: 'tool', content: 'x'.repeat(2000) }, { used: true });
  b.compress();
  assert.strictEqual(b.starved, true);
  const b2 = new ContextBudget({ numCtx: 8000, reserve: 100 });
  b2.push({ role: 'tool', content: 'y'.repeat(2000) }, { used: true });
  b2.compress();
  assert.strictEqual(b2.starved, false, '预算充足时不该标记 starved');
});

check('toMessages 输出 API 格式', () => {
  const b = new ContextBudget();
  b.push({ role: 'system', content: '系统', pinned: true });
  b.push({ role: 'user', content: '你好' });
  b.push({ role: 'tool', content: '结果' }, { used: true });
  const msgs = b.toMessages();
  assert.deepStrictEqual(msgs, [
    { role: 'system', content: '系统' },
    { role: 'user', content: '你好' },
    { role: 'tool', content: '结果' },
  ]);
  assert.ok(!('pinned' in msgs[0]), 'pinned 不应泄漏到 API payload');
});

// ============================================================
console.log('\n二、设定摘要');

check('摘要按类型优先级排列（角色在前）', () => {
  const settings = [
    { name: '乱葬岗', type: 'location', note: '城西八里' },
    { name: '谢九', type: 'character', note: '外门弟子' },
    { name: '赤霄宗', type: 'faction', note: '剑修宗门' },
    { name: '逆鳞诀', type: 'technique', note: '残页' },
  ];
  const s = summarizeBible(settings, { maxChars: 2000 });
  assert.strictEqual(s.included, 4);
  assert.ok(s.text.indexOf('谢九') < s.text.indexOf('乱葬岗'), '角色应排在地点前');
});

check('超长设定库时截断并明确列出未纳入项', () => {
  const settings = [];
  for (let i = 0; i < 300; i++) {
    settings.push({ name: `角色${i}`, type: 'character', note: `设定${i}`.repeat(20) });
  }
  const s = summarizeBible(settings, { maxChars: 500 });
  assert.ok(s.chars <= 700, `摘要过长：${s.chars} 字符`);
  assert.ok(s.dropped > 0, '应有条目被丢弃');
  assert.ok(s.text.includes('未纳入摘要'), '必须明确告知模型有内容没进来');
  assert.ok(s.droppedNames.length > 0, '未纳入项应可枚举——检索层要靠它');
});

check('小设定库不截断', () => {
  const settings = [
    { name: '谢九', type: 'character', note: '外门弟子' },
    { name: '洛三娘', type: 'character', note: '守尸人' },
  ];
  const s = summarizeBible(settings, { maxChars: 1200 });
  assert.strictEqual(s.dropped, 0);
  assert.ok(!s.text.includes('未纳入摘要'));
});

// ---- 下面这组针对「打分制+ 保底名额」的重写（200 条库实测暴露的缺陷）----

check('每类都有保底名额（location/faction/plot 不被前两类吃光）', () => {
  // 早期版本按类型顺序贪心填充，200 条库上实测：
  //   纳入 52 条全是 character(41)+technique(11)，
  //   location/faction/plot **全军覆没**。地点是场景骨架，丢了就没法续写。
  const settings = [];
  for (let i = 0; i < 120; i++) {
    settings.push({ name: `角色${i}`, type: 'character', note: `角色设定${i}，此处展开说明。`.repeat(3) });
  }
  for (let i = 0; i < 5; i++) {
    settings.push({ name: `地点${i}`, type: 'location', note: `地点设定${i}，此处展开说明。`.repeat(3) });
    settings.push({ name: `势力${i}`, type: 'faction', note: `势力设定${i}，此处展开说明。`.repeat(3) });
    settings.push({ name: `伏笔${i}`, type: 'plot', note: `伏笔设定${i}，此处展开说明。`.repeat(3) });
    settings.push({ name: `功法${i}`, type: 'technique', note: `功法设定${i}，此处展开说明。`.repeat(3) });
  }
  const s = summarizeBible(settings, { maxChars: 1200, floorPerType: 3 });
  for (const t of ['character', 'location', 'faction', 'plot', 'technique']) {
    assert.ok((s.byTypeCount[t] || 0) > 0, `${t} 一条都没进去`);
  }
  assert.strictEqual(s.missingTypes.length, 0, `有类型缺失：${s.missingTypes.join(',')}`);
});

check('note 过短的占位条目不挤掉真实设定', () => {
  // 实测 200 条库上，note="设定0"（5字）的占位条目靠低成本
  // 抢到 29 个名额，把 note 60~80 字的真实角色挤了出去。
  const settings = [];
  for (let i = 0; i < 150; i++) {
    settings.push({ name: `噪声${i}`, type: 'character', note: `设定${i}` });
  }
  settings.push({ name: '谢九', type: 'character', note: '赤霄宗外门弟子，左掌心烙有残剑印，与宗主旧伤及剑冢封门有牵连。' });
  settings.push({ name: '洛三娘', type: 'character', note: '乱葬岗守尸人，收尸换钱，替谢九埋过他师父。' });
  const s = summarizeBible(settings, { maxChars: 1200, floorPerType: 2 });
  assert.ok(s.text.includes('谢九'), 'note 更长的真实角色被占位条目挤掉了');
  assert.ok(s.text.includes('洛三娘'), 'note 更长的真实角色被占位条目挤掉了');
});

check('pinned 的实体强制注入摘要（在场角色/未回收伏笔）', () => {
  const settings = [];
  for (let i = 0; i < 200; i++) {
    settings.push({ name: `条目${i}`, type: 'character', note: `设定${i}`.repeat(10) });
  }
  settings.push({ name: '裴照', type: 'character', note: '玄卫铁律执事，三年前亲手把谢九拒于山门外。' });
  const s = summarizeBible(settings, { maxChars: 800, floorPerType: 1, pinned: ['裴照'] });
  assert.ok(s.text.includes('裴照'), 'pinned 实体未强制注入——它在长篇里是当前事实，不该被挤掉');
});

check('important字段参与打分（重要伏笔优先）', () => {
  const settings = [
    { name: '低优伏笔', type: 'plot', note: '支线细节，暂未埋设。'.repeat(4), importance: 1 },
    { name: '主线伏笔', type: 'plot', note: '主线核心，全书暗线。'.repeat(4), importance: 5 },
  ];
  const s = summarizeBible(settings, { maxChars: 2000 });
  assert.ok(s.text.indexOf('主线伏笔') < s.text.indexOf('低优伏笔'),
    `重要度高的应排前：${s.text}`);
});

check('别名多的实体获得更多曝光（更难被检索到）', () => {
  const settings = [
    { name: '普通角色', type: 'character', note: '外门弟子，沉默寡言。'.repeat(3), aliases: [] },
    { name: '多称角色', type: 'character', note: '外门弟子，沉默寡言。'.repeat(3), aliases: ['小九', '谢九师兄', '叛徒', '少年', '他'] },
  ];
  const s = summarizeBible(settings, { maxChars: 2000 });
  assert.ok(s.text.indexOf('多称角色') < s.text.indexOf('普通角色'),
    '别名多的应排前——别名多意味着检索更难命中');
});

check('摘要在同分时稳定可复现（相同输入必得相同输出）', () => {
  const settings = [];
  for (let i = 0; i < 100; i++) {
    settings.push({ name: `条目${i}`, type: 'character', note: `完全相同的说明文字${i}`.repeat(3) });
  }
  const a = summarizeBible(settings, { maxChars: 800 });
  const b = summarizeBible(settings, { maxChars: 800 });
  assert.strictEqual(a.text, b.text, '同分条目的排序不稳定——会让每次生成的上下文都不一样');
  // 输入顺序打乱，结果也必须一样
  const shuffled = settings.slice().reverse();
  const c = summarizeBible(shuffled, { maxChars: 800 });
  assert.strictEqual(a.text, c.text, '同分条目排序依赖输入顺序——不可复现');
});

// ============================================================
console.log('\n三、实体抽取与位置判定');

const SETTINGS = [
  { name: '谢九', type: 'character', aliases: ['小九'], note: '外门弟子' },
  { name: '洛三娘', type: 'character', aliases: [], note: '守尸人' },
  { name: '乱葬岗', type: 'location', aliases: [], note: '城西八里' },
  // 类型必须与 world-bible.json 一致：铁棺是 plot（伏笔物件），不是 location。
  // 早期这里错标成 location，导致「谢九的位置」被判成铁棺——
  // 断言失败暴露的是测试数据与真实设定库脱节，不是代码问题。
  { name: '铁棺', type: 'plot', aliases: [], note: '岗北铁棺' },
  { name: '赤霄宗', type: 'faction', aliases: ['赤霄'], note: '剑修宗门' },
];

check('字面提及能被抽到', () => {
  const m = extractEntities('谢九走进乱葬岗，看见一口铁棺。', SETTINGS);
  assert.ok(m.has('谢九'));
  assert.ok(m.has('乱葬岗'));
  assert.strictEqual(m.get('谢九').literal, true);
});

check('简称提及能被抽到并标记', () => {
  const m = extractEntities('小九站在岗北。', SETTINGS);
  assert.ok(m.has('谢九'), '别名「小九」未命中谢九');
  assert.strictEqual(m.get('谢九').literal, false);
});

check('「实体 + 地点动词 + 地点」共现才判位置', () => {
  const chars = [{ name: '谢九', aliases: [] }];
  const locs = [{ name: '乱葬岗', aliases: [] }];
  const r1 = resolveLocation('谢九走进乱葬岗，看见了棺。', chars[0], locs);
  assert.strictEqual(r1.location, '乱葬岗', '应判出位置');
  const r2 = resolveLocation('谢九想起了乱葬岗的旧事。', chars[0], locs);
  assert.strictEqual(r2.location, null, '「想起」不该被判为在场');
});

check('别名形态的地名也能定位', () => {
  const chars = [{ name: '谢九', aliases: [] }];
  const locs = [{ name: '乱葬岗', aliases: ['岗北'] }];
  const r = resolveLocation('谢九站在岗北，仰头看天。', chars[0], locs);
  assert.strictEqual(r.location, '乱葬岗');
});

// ============================================================
console.log('\n四、状态漂移检测');

check('无历史状态时不报冲突', () => {
  const d = detectDrift(null, { location: '洛阳', alive: true });
  assert.strictEqual(d.conflict, false);
});

// 语义已更正：位置变化在长篇里是正常剧情，不该报冲突
// （否则状态表写到第 2 章就卡死）。漂移判据见 test-drift.js。
check('位置变化不算冲突（有移动动词时）', () => {
  const d = detectDrift(
    { location: '洛阳', alive: true },
    { location: '剑冢', alive: true },
    { text: '谢九离开洛阳，前往剑冢。' }
  );
  assert.strictEqual(d.conflict, false, `移动剧情被误报：${JSON.stringify(d)}`);
});

check('相同值不报冲突', () => {
  const d = detectDrift({ location: '洛阳', alive: true }, { location: '洛阳', alive: true });
  assert.strictEqual(d.conflict, false);
});

// 语义已更正：true→false 是正常剧情（本章写到角色死了），不该报。
// 只有 false→true（复活）需要证据，见 test-drift.js。
check('角色死亡不算冲突', () => {
  const d = detectDrift({ alive: true }, { alive: false });
  assert.strictEqual(d.conflict, false, `死亡被误报：${JSON.stringify(d)}`);
});

check('已死角色复活必须报冲突', () => {
  const d = detectDrift({ alive: false }, { alive: true });
  assert.strictEqual(d.conflict, true, '复活未被检出');
  assert.strictEqual(d.kind, 'resurrection');
});

check('新增字段不算冲突', () => {
  const d = detectDrift({ alive: true }, { alive: true, 出现次数: 3 });
  assert.strictEqual(d.conflict, false);
});

check('未判定的字段（null）不算冲突', () => {
  const d = detectDrift({ location: '洛阳' }, { location: null, alive: true });
  assert.strictEqual(d.conflict, false, 'null 表示「本章没写到」，不是状态变更');
});

// ============================================================
console.log('\n五、状态回写与落库');

check('从正文推导状态变更', () => {
  const text = '谢九走进乱葬岗，铁棺就在岗北。洛三娘提着灯笼站在铁棺旁。';
  const r = deriveStateChanges({ text, settings: SETTINGS, chapterId: 'c1' });
  assert.ok(r.entities.length >= 3, `应抽到多个实体，实际 ${r.entities.length}`);
  const xie = r.updates.find((u) => u.entityName === '谢九');
  assert.ok(xie, '谢九应有状态更新');
  assert.strictEqual(xie.state.location, '乱葬岗');
});

check('状态是合并而非覆盖', () => {
  const prevStates = { 谢九: { 修为: '炼气三层', alive: true } };
  const r = deriveStateChanges({
    text: '谢九走进乱葬岗。', settings: SETTINGS, chapterId: 'c2', prevStates,
  });
  const xie = r.updates.find((u) => u.entityName === '谢九');
  assert.strictEqual(xie.mergedState.修为, '炼气三层', '旧字段被覆盖了');
  assert.strictEqual(xie.mergedState.location, '乱葬岗', '新字段没写上');
});

// 用真漂移（复活）验「冲突时不写入」这个性质。
// 早期这里用「位置变化」当冲突源，那个语义是错的——位置变化是正常剧情。
check('有冲突时不写入污染状态表', () => {
  const prevStates = { 谢九: { location: '乱葬岗', alive: false } };
  const r = deriveStateChanges({
    text: '谢九睁开眼，从乱葬岗的土里爬了出来。', settings: SETTINGS, chapterId: 'c3', prevStates,
  });
  assert.ok(r.conflicts.length > 0, '应检测到复活冲突');
  assert.strictEqual(r.conflicts[0].kind, 'resurrection', `冲突类型错误：${r.conflicts[0].kind}`);
  assert.ok(!r.updates.find((u) => u.entityName === '谢九'), '冲突时不应产生写入');
  assert.ok(r.conflicts[0].hint.includes('显式证据'), '冲突应给出可执行的提示');
});

check('端到端：写入 SQLite 并可读回', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mem-'));
  const store = new Store(path.join(tmp, 'm.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');
  // 必须先建章节：updated_in_chapter 是外键，指向不存在的章节会直接报错
  store.createChapter({ id: 'c1', projectId: 'novel-demo-01', title: '第一章', content: '' });

  const text = '谢九走进乱葬岗，铁棺就在岗北。洛三娘提着灯笼。';
  const res = applyStateAfterCommit({
    store, projectId: 'novel-demo-01', chapterId: 'c1', text, settings,
  });
  assert.ok(res.applied > 0, `应写入状态，实际 ${res.applied}`);
  const states = store.listEntityStates('novel-demo-01');
  assert.ok(states.find((s) => s.entity_name === '谢九'), '谢九状态未落库');
  console.log(`         · ${res.summary}`);
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('端到端：冲突时不污染已落库状态', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mem2-'));
  const store = new Store(path.join(tmp, 'm.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');

  // 第一章确立状态
  store.createChapter({ id: 'c1', projectId: 'novel-demo-01', title: '第一章', content: '' });
  applyStateAfterCommit({
    store, projectId: 'novel-demo-01', chapterId: 'c1',
    text: '谢九走进乱葬岗。', settings,
  });
  const before = store.getEntityState('novel-demo-01', '谢九');
  assert.strictEqual(before.state.location, '乱葬岗');

  // 第二章矛盾（正文说在剑冢，但状态表已有乱葬岗，且本轮推断来自新章节）
  store.createChapter({ id: 'c2', projectId: 'novel-demo-01', title: '第二章', content: '' });
  const res = applyStateAfterCommit({
    store, projectId: 'novel-demo-01', chapterId: 'c2',
    text: '谢九站在剑冢深处。', settings,
  });
  const after = store.getEntityState('novel-demo-01', '谢九');
  console.log(`         · ${res.summary}`);
  if (res.conflicts.length) {
    assert.strictEqual(after.state.location, '乱葬岗', '冲突时状态被污染了');
    assert.ok(res.conflicts[0].hint.includes('人工裁决'));
  } else {
    // 剑冢在 A 库是 location，若被判为新位置则应已更新
    assert.strictEqual(after.state.location, '剑冢', '无冲突时位置应已更新');
  }
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('端到端：真漂移时状态表保持不变（2700章的关键性质）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mem3-'));
  const store = new Store(path.join(tmp, 'm3.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');

  // 第一章：正常推进
  store.createChapter({ id: 'c1', projectId: 'novel-demo-01', title: '第一章', content: '' });
  applyStateAfterCommit({
    store, projectId: 'novel-demo-01', chapterId: 'c1',
    text: '谢九离开洛阳，前往乱葬岗。', settings,
  });
  const before = store.getEntityState('novel-demo-01', '谢九');
  assert.strictEqual(before.state.location, '乱葬岗', '第一章位置未落库');

  // 第二章：真漂移——状态说已死，本章却判定在场
  store.setEntityState({
    projectId: 'novel-demo-01', entityName: '谢九',
    state: { ...before.state, alive: false }, chapterId: 'c1',
  });
  const dead = store.getEntityState('novel-demo-01', '谢九');
  assert.strictEqual(dead.state.alive, false, '前置状态未就位');

  store.createChapter({ id: 'c2', projectId: 'novel-demo-01', title: '第二章', content: '' });
  const res = applyStateAfterCommit({
    store, projectId: 'novel-demo-01', chapterId: 'c2',
    text: '谢九从土里爬了出来，站在乱葬岗上。', settings,
  });

  assert.ok(res.conflicts.length > 0, '应检出复活漂移');
  assert.strictEqual(res.conflicts[0].kind, 'resurrection');
  const after = store.getEntityState('novel-demo-01', '谢九');
  assert.strictEqual(after.state.alive, false,
    `真漂移时状态被污染：alive 被改成了 ${after.state.alive}`);
  assert.deepStrictEqual(after.state.locationHistory, before.state.locationHistory,
    '冲突时位置轨迹仍被更新');

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('端到端：正常推进时轨迹累积（长篇连续性）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mem4-'));
  const store = new Store(path.join(tmp, 'm4.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');

  const chapters = [
    { id: 'c1', text: '谢九站在洛阳的城门口。' },
    { id: 'c2', text: '谢九离开洛阳，前往剑冢。' },
    { id: 'c3', text: '谢九走出剑冢，回到洛阳。' },
  ];
  for (const c of chapters) {
    store.createChapter({ id: c.id, projectId: 'novel-demo-01', title: c.id, content: '' });
    const r = applyStateAfterCommit({
      store, projectId: 'novel-demo-01', chapterId: c.id, text: c.text, settings,
    });
    assert.strictEqual(r.conflicts.length, 0,
      `${c.id} 误报冲突：${JSON.stringify(r.conflicts)}`);
  }

  const st = store.getEntityState('novel-demo-01', '谢九');
  const hist = st.state.locationHistory || [];
  assert.ok(hist.length >= 2, `轨迹应累积，实际 ${JSON.stringify(hist)}`);
  assert.ok(hist.includes('洛阳') && hist.includes('剑冢'),
    `轨迹应含两地，实际 ${JSON.stringify(hist)}`);
  assert.strictEqual(st.state.location, '洛阳', `末态位置错误：${st.state.location}`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('仅提及地点不产生角色状态（地点不是角色）', () => {
  const r = deriveStateChanges({ text: '乱葬岗很安静。', settings: SETTINGS, chapterId: 'c9' });
  assert.strictEqual(r.updates.length, 0, '地点不应进角色状态表');
  assert.ok(r.entities.find((e) => e.name === '乱葬岗'), '但地点应被记录为提及实体');
});

// ============================================================
console.log('\n六、简称发现（补设定库的缺口）');

const { discoverAliases, applyAliasDiscovery, positionVariants } = require('./alias-discovery.js');

check('方位变体含地名与末字两种形态', () => {
  const v = positionVariants('乱葬岗');
  assert.ok(v.includes('乱葬岗北'), '缺 乱葬岗北');
  assert.ok(v.includes('岗北'), '缺 岗北');
});

check('能发现未登记的方位简称', () => {
  const s = [
    { name: '谢九', type: 'character', aliases: [], note: '' },
    { name: '乱葬岗', type: 'location', aliases: ['岗子'], note: '城西八里' },
  ];
  const found = discoverAliases('谢九踩着泥泞走到了岗北，铁棺就在那里。', s);
  const forGang = found.find((x) => x.entity === '乱葬岗');
  assert.ok(forGang, '未发现乱葬岗的简称');
  assert.ok(forGang.suggested.includes('岗北'), `未发现岗北：${JSON.stringify(forGang.suggested)}`);
});

check('已登记的别名不会被重复发现', () => {
  const s = [
    { name: '乱葬岗', type: 'location', aliases: ['岗子', '岗北'], note: '' },
  ];
  const found = discoverAliases('谢九走到了岗北。', s);
  const forGang = found.find((x) => x.entity === '乱葬岗');
  if (forGang) assert.ok(!forGang.suggested.includes('岗北'), '已登记的岗北被重复发现');
});

check('冗余变体被去重（保留最短形态）', () => {
  const s = [{ name: '乱葬岗', type: 'location', aliases: [], note: '' }];
  const text = '乱葬岗下有一具尸体，岗北也埋着人。';
  const found = discoverAliases(text, s);
  const forGang = found.find((x) => x.entity === '乱葬岗');
  if (forGang) {
    assert.ok(!forGang.suggested.includes('乱葬岗下') || !forGang.suggested.includes('岗下'),
      `冗余未去重：${JSON.stringify(forGang.suggested)}`);
  }
});

check('单字候选被排除', () => {
  const s = [{ name: '乱葬岗', type: 'location', aliases: [], note: '' }];
  const found = discoverAliases('乱葬岗。岗。', s);
  const forGang = found.find((x) => x.entity === '乱葬岗');
  if (forGang) {
    for (const cand of forGang.suggested) {
      assert.ok(cand.length >= 2, `单字候选未被排除：${cand}`);
    }
  }
});

check('模型首次就用简称时也能发现（无全名场景）', () => {
  // 实测场景：正文只写「岗北」，从未出现全名「乱葬岗」
  const s = [{ name: '乱葬岗', type: 'location', aliases: ['岗子'], note: '' }];
  const found = discoverAliases('谢九走到了岗北。', s);
  const forGang = found.find((x) => x.entity === '乱葬岗');
  assert.ok(forGang, `无全名时应仍能发现：${JSON.stringify(found)}`);
  assert.ok(forGang.suggested.includes('岗北'));
});

check('正文完全无关时不产生建议', () => {
  const s = [
    { name: '乱葬岗', type: 'location', aliases: [], note: '' },
    { name: '剑冢', type: 'location', aliases: [], note: '' },
  ];
  const found = discoverAliases('谢九站在洛阳城外，天色渐暗。', s);
  assert.strictEqual(found.length, 0, `不该有建议：${JSON.stringify(found)}`);
});

check('别名发现需人工确认才写入（不自动改设定库）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-alias-'));
  const store = new Store(path.join(tmp, 'a.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');
  const before = store.loadSettings('novel-demo-01').find((x) => x.name === '乱葬岗');

  const found = discoverAliases('谢九走到了岗北。', settings);
  // 发现阶段不该动设定库
  const mid = store.loadSettings('novel-demo-01').find((x) => x.name === '乱葬岗');
  assert.deepStrictEqual(mid.aliases, before.aliases, '发现阶段就改了设定库——不该自动改');

  // 人工确认后才写
  if (found.length) {
    const res = applyAliasDiscovery({ store, projectId: 'novel-demo-01', suggestions: found });
    assert.ok(res.updated.length > 0, '确认后未写入');
    const after = store.loadSettings('novel-demo-01').find((x) => x.name === '乱葬岗');
    assert.ok(after.aliases.length > before.aliases.length, '别名未增加');
  }
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`用例 ${passed + failed}　通过 ${passed}　失败 ${failed}`);
if (failed === 0) {
  console.log('记忆层可用：上下文压缩 + 状态回写就位，可进入去AI 味引擎。');
} else {
  console.log('存在失败项，不要在此基础上继续。');
  process.exitCode = 1;
}

/**
 * 内置技能升级覆盖的判据。
 *
 * ## 这条测试要防的事
 *
 * 2026-10-16 之前 `seedBuiltinSkills` 第一行就是「已存在就跳过」。
 * 开发态跑永远全绿（库是空的，6 条全部 seeded），
 * 而真用户从 1.0.5 升到 1.0.6 拿到的是三个月前的旧正文。
 * **开发态与发布态表现不一致** —— 这类 bug 最难查，
 * 因为你所有本地验证都是对的。
 *
 * 所以判据必须**先造一个 1.0.5 状态的库**，再跑新种子，
 * 比对升级前后的差异。只测「空库 → 新版」等于没测。
 *
 * 跑法：node test-builtin-upgrade.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}

// ---------------------------------------------------------------
// 1.0.5 的旧库长什么样：照抄旧清单 + 旧正文
// ---------------------------------------------------------------

/** 旧版 4 条 legacy 的原始提示词（内容已并进新版技能） */
const OLD_LEGACY = {
  'sk-builtin-outline': ['列章纲', '输出本章的分段大纲，每段一句话，说明谁在哪、做什么。'],
  'sk-builtin-dialogue': ['写对白', '只写对话。用「」包裹，每句不超过 40 字，符合各自身份与处境。'],
  'sk-builtin-rewrite': ['润色改写', '保持原意与情节，只改语言。删掉形容词堆砌，句子变短。'],
  'sk-builtin-check': ['检查设定', '列出与已给设定冲突的地方，指明位置，不要改写正文。'],
};

/** 旧版 sk-novel-writer 的正文：只写一句标志，证明覆盖真的发生了 */
const OLD_WRITER_BODY = `---
name: novel-writer
description: 写小说时使用。当用户要写小说、写新章节、续写章节时自动触发。
---

# 小说写作助手（旧版正文）

这一行是旧版的特征串。升级后不应该还能在这里看到。
`;

/** 旧版 sk-novel-writer 的 references 内容 */
const OLD_TPL = '# 旧版模板\n\n这是旧版的 references 特征串。\n';

// ---------------------------------------------------------------
// 装一个临时环境
// ---------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-skill-upgrade-'));

const { Store } = require(path.join(__dirname, '..', 'db', 'store.js'));
const { BUILTIN, loadBuiltin } = require(path.join(__dirname, '..', 'db', 'builtin-skills.js'));
const skillFmt = require(path.join(__dirname, '..', 'app', 'electron', 'skill-format.js'));

// ⚠ Store 是具名导出（module.exports = { Store, ... }），
//   构造器收 dbPath 而不是读环境变量 —— ':memory:' 专门留给测试。
//   这两处都别猜，照 db/store.js:1099 与 127 写。
const store = new Store(':memory:');

console.log(`临时目录：${tmp}\n`);

// ---------------------------------------------------------------
// 第一步：造一个 1.0.5 状态的库
// ---------------------------------------------------------------

console.log('—— 造 1.0.5 旧库 ——');
for (const [id, [name, prompt]] of Object.entries(OLD_LEGACY)) {
  store.createSkill({ id, projectId: null, name, promptContent: prompt, type: 'built-in', enabled: true });
}
store.createSkill({
  id: 'sk-novel-writer', projectId: null, name: '小说写作助手',
  promptContent: OLD_WRITER_BODY, type: 'built-in', enabled: true,
});
store.saveSkillFile('sk-novel-writer', { path: 'references/templates.md', kind: 'reference', content: OLD_TPL });
store.createSkill({
  id: 'sk-skill-creator', projectId: null, name: '技能创建助手',
  promptContent: '---\nname: skill-creator\ndescription: 旧版技能创建助手。\n---\n\n旧正文。\n',
  type: 'built-in', enabled: true,
});
// 用户自建的技能，升级绝不能碰
store.createSkill({
  id: 'sk-my-own', projectId: null, name: '我自己的技能',
  promptContent: '用户自己写的，别动。', type: 'custom', enabled: true,
});
// ⚠⚠ 「被关掉的内置技能」必须用**清单里真实存在的 id**，
//   不能自己编一个 id 编到旧库里去。
//   编出来的 id 不在新版清单里 → 会被退役逻辑删掉 →
//   于是「升级后 enabled 有没有被保住」这件事根本测不到，
//   retieod 计数还会凭空多 1，把判据带偏。
//   第一版就栽在这：判据写成「retired === 4」而实际是 5，
//   查下去才发现多出来的那 1 条是我自己造的探针。
const OFF_ID = 'sk-novel-dialogue';
store.createSkill({
  id: OFF_ID, projectId: null, name: '写对白（旧版，用户已关掉）',
  promptContent: '旧版对白提示词。', type: 'built-in', enabled: false,
});

const before = store.listAllSkills(null);
console.log(`旧库有 ${before.length} 条内置/全局技能\n`);

// ---------------------------------------------------------------
// 第二步：跑新版种子
// ---------------------------------------------------------------

console.log('—— 跑 1.0.6 种子 ——');
const r = store.seedBuiltinSkills(loadBuiltin);
console.log(`结果：${JSON.stringify(r)}\n`);

/* ⚠⚠ 断言写成「总数守恒」而不是「seeded === 4」。
 *
 *   为什么：旧库里哪些 id 存在，会改变每一条走哪个分支。
 *   探针里我造了一条 enabled=false 的 sk-novel-dialogue（真实 id），
 *   它就落在「已存在 → 更新」分支而不是「不存在 → 新增」，
 *   于是 seeded 从 4 变 3、updated 从 2 变 3。
 *
 *   两个数都变了，但**行为完全正确**。第一版把判据写死成
 *   「seeded===4 && retired===4」，结果两条都红，而查下去
 *   原因是我自己的探针多造了一条 —— 判据在测探针，不在测实现。
 *
 *   守恒关系：清单 6 条 = 新增 seeded + 更新 updated + 跳过 skipped。
 *   退役数 = 旧库里「内置且不在清单中」的条数（这里是 4 条 legacy）。
 *   这两个数才是真正的不变量。
 */
t('清单守恒：总数 = 新增 + 更新 + 跳过',
  r.seeded + r.updated + r.skipped === BUILTIN.length,
  `seeded=${r.seeded} updated=${r.updated} skipped=${r.skipped} 清单=${BUILTIN.length}`);
t('退役的是 4 条 legacy（内置且不在清单中）', r.retired === 4, `实际 ${r.retired}`);
// ⚠ 数量**从清单读**，不写死。2026-10-15 加了 sk-humanize（去 AI 味）
//   之后写死的 3 与 6 会一起变红 —— 而那不是回归，是清单正常增长。
// ⚠ 但 seeded 的具体值**仍不能从清单推** —— 它取决于旧库里哪些 id 存在
//   （这个文件开头就写着这条教训：写过 seeded===4，清单一变就红）。
//   真正该钉的是「清单里的每一条都能在库里查到」，后面那条已覆盖。
t('新增的 sk-humanize（去 AI 味）确实进了库',
  !!store.getSkill('sk-humanize'), '清单里声明了但库里没有');
t('更新的是 3 条（writer/creator/被关着的 dialogue）', r.updated === 3, `实际 ${r.updated}`);

// ---------------------------------------------------------------
// 第三步：逐条核对结果
// ---------------------------------------------------------------

console.log('\n—— 核对 ——');
const after = store.listAllSkills(null);

// 退役的 4 条真没了
for (const id of Object.keys(OLD_LEGACY)) {
  t(`${id} 已退役`, !store.getSkill(id), '还留着');
}

// 新正文真的覆盖了旧正文
const w = store.getSkill('sk-novel-writer');
t('sk-novel-writer 正文已换成新版',
  !w.prompt_content.includes('旧版的特征串'), '还是旧正文');
t('sk-novel-writer 显示名已更新', w.name === '写新章节', `实际「${w.name}」`);

// 六项约束都进了正文（逐条查，这是羽毛菌提的需求）
const W = w.prompt_content;
t('六项·资料读取：正文提到读设定库',
  W.includes('设定/人物库.md') && W.includes('Step 1'), '路径或步骤缺失');
t('六项·场景定义：有独立的定场景步骤',
  W.includes('Step 3：定本章场景') && W.includes('在场的人'), '场景定义那节缺失');
t('六项·章节输出硬性要求：写明字数与对白格式',
  W.includes('2000 字') && W.includes('「」'), '硬性要求缺失');
t('六项·维护文档：保存后问是否更新资料',
  W.includes('问要不要更新维护文档'), '维护文档那节缺失');
t('六项·安全约束：写入前必须问用户',
  W.includes('任何写入操作前都先问用户'), '安全约束缺失');
t('六项·同步文档：指向一致性检查技能',
  W.includes('一致性检查与文档同步'), '没有指向 sync');

// 路径修对了（旧版正文里根本没有 设定/ 这一层）
t('路径是 设定/人物库.md 而不是 小说资料/人物库.md',
  !W.includes('小说资料/'), '还有旧路径残留');

// ⚠ 关键判据：description 必须存在，否则进不了 skill:index
console.log('\n—— 进 skill:index 的资格 ——');
const idx = after.map((sk) => {
  const meta = skillFmt.parse(sk.prompt_content || '');
  return { id: sk.id, name: sk.name, desc: meta.description };
}).filter((x) => x.desc);
for (const sk of idx) {
  t(`${sk.name} 有 description（${sk.desc.length} 字）`, true);
}
t('每一条内置技能都有 description', idx.length === BUILTIN.length, `只有 ${idx.length}/${BUILTIN.length} 条能进索引`);

// 用户的自建技能没被碰
t('用户自建技能未被改动',
  store.getSkill('sk-my-own').prompt_content === '用户自己写的，别动。');

// ⚠⚠ enabled 必须保住。用户关掉某个内置技能是明确选择，
//   升级后自己又打开会让人以为出 bug —— 而被关掉的往往正是
//   他不想让模型自动用的那个。
const off = store.getSkill(OFF_ID);
t('用户关掉的内置技能，升级后仍然关着',
  off && off.enabled === 0, off ? `enabled=${off.enabled}` : '技能不见了');
t('且它的正文仍被更新到新版',
  off && !off.prompt_content.includes('旧版对白提示词'),
  off ? off.prompt_content.slice(0, 40) : '(无)');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass}｜失败 ${fail}`);
process.exit(fail ? 1 : 0);

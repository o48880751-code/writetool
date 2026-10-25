/**
 * 内置技能内容的判据（2026-10-19 改造）。
 *
 * ## 这份判据的第一要务：**证明没削弱**
 *
 * 羽毛菌的原话是「必须完整保留 writetool 内置 Skill 原有能力，不能削弱」。
 * 所以第一条断言不是"新功能在不在"，而是**原有正文一行都没丢** ——
 * 直接拿改造前的备份逐行比对。插内容不算削弱，删行才算。
 *
 * ## 第二要务：注入上限
 *
 * `buildRefBlock` 里 `SKILL_CHARS = 4000`，而它取的是 `prompt_content`
 * ——**含 frontmatter 的整个文件**。超了会被 `clip()` 截断，
 * 而截断是"加了一段省略说明"就继续跑，表面上功能加上了，实际模型只看到半截。
 * 所以每条技能都必须量总字符。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const SK = path.join(__dirname, 'builtin-skills');
const BAK = path.join(__dirname, 'builtin-skills.bak-20261019');
const read = (p) => fs.readFileSync(p, 'utf8');
const skill = (id) => read(path.join(SK, id, 'SKILL.md'));

/** 注入上限，与 main.js 的 SKILL_CHARS 保持一致 */
const SKILL_CHARS = 4000;

console.log('\n=== A. ⚠⚠ 原有能力零削弱（逐行对比备份）===');

check('★★★ 写新章节：原有正文一行都没丢', () => {
  const before = read(path.join(BAK, 'sk-novel-writer/SKILL.md'));
  const after = skill('sk-novel-writer');
  const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const now = new Set(norm(after));
  const missing = norm(before).filter((l) => !now.has(l));
  assert.strictEqual(missing.length, 0,
    `这些原有行消失了（改造只能加，不能删）：\n      ${missing.slice(0, 6).join('\n      ')}`);
});

check('★★ 七步流程的标题全在，顺序未变', () => {
  const s = skill('sk-novel-writer');
  const steps = [
    'Step 1：读真相源（不可跳过）',
    'Step 2：读最近几章找语感',
    'Step 3：定本章场景（写正文之前必须先定）',
    'Step 4：实体白名单自检',
    'Step 5：写正文',
    'Step 6：先展示，再问保存（顺序不能反）',
    'Step 7：问要不要更新维护文档',
  ];
  let last = -1;
  for (const t of steps) {
    const i = s.indexOf(t);
    assert.ok(i > 0, `少了「${t}」`);
    assert.ok(i > last, `「${t}」的顺序被挪了 —— 顺序是流程的一部分`);
    last = i;
  }
});
check('★★ 原有硬规则还在（逐条点名）', () => {
  const s = skill('sk-novel-writer');
  const rules = [
    '只用白名单里的实体',
    '对白用「」',
    '不写大段内心独白',
    '查不到就停笔，不许硬塞',
    '先展示，再问保存',
    '目标文件名已存在时停下来问',
    '任何写入操作前都先问用户',
    '路径必须写对',
    '章节正文存在软件数据库里',
  ];
  for (const r of rules) assert.ok(s.includes(r), `硬规则「${r}」不见了`);
});
check('★ 其余六个技能的正文保持原样', () => {
  for (const id of ['sk-humanize', 'sk-novel-dialogue', 'sk-novel-polish', 'sk-novel-revisor', 'sk-skill-creator']) {
    const a = read(path.join(BAK, `${id}/SKILL.md`));
    const b = skill(id);
    assert.strictEqual(b, a, `${id} 被改动了 —— 这次改造不该碰它`);
  }
});

console.log('\n=== B. 新增：五条创作准则（在写新章节里）===');

check('★ 五条准则逐条在', () => {
  const s = skill('sk-novel-writer');
  const items = [
    ['一、一切服务母题', '删掉这个场景，母题还成立吗'],
    ['二、用选择推进', '两个选项都要有代价'],
    ['三、人物是有缺陷的人', '贯穿全书的缺陷'],
    ['四、叙事克制', '心中一凛'],
    ['五、写作纪律', '角色死之前先让读者认识他'],
  ];
  for (const [title, key] of items) {
    assert.ok(s.includes(title), `少了准则标题「${title}」`);
    assert.ok(s.includes(key), `准则「${title}」缺了可执行的那半句：「${key}」`);
  }
});
check('★ 准则落地到流程里（不只是挂在开头）', () => {
  const s = skill('sk-novel-writer');
  // Step 3 要问"服务哪个母题"，Step 5 要约束"套话"和"选择"
  const step3 = s.slice(s.indexOf('Step 3'), s.indexOf('Step 4'));
  assert.ok(/母题/.test(step3), 'Step 3 定场景时没有对照母题，准则就成了摆设');
  const step5 = s.slice(s.indexOf('Step 5'), s.indexOf('Step 6'));
  assert.ok(/套话|通用反应/.test(step5), 'Step 5 写正文时没有约束套话');
  assert.ok(/真正的选择/.test(step5), 'Step 5 没有要求"本章要有一次选择"');
});
check('★ 其余三条准则的可执行要求都在', () => {
  const s = skill('sk-novel-writer');
  assert.ok(/配角有自己的目的/.test(s), '配角独立诉求丢了');
  assert.ok(/辩论先给对方一个/.test(s), '辩论纪律丢了');
  assert.ok(/伏笔记进摘要、长线回收/.test(s), '伏笔回收纪律丢了');
  assert.ok(/情绪写到七分就停/.test(s), '叙事留白丢了');
});

console.log('\n=== C. 新增：长篇结构工程技能 ===');
const outline = skill('sk-novel-outline');

check('★★ 五条工程能力逐条在', () => {
  const items = [
    ['逆推', '先定终点，再往回铺'],
    ['层级', '卷 → 阶段 → 章节钩子'],
    ['社会逻辑', '钱从哪来'],
    ['反派分层', '牺牲代价清单'],
    ['附表', '伏笔回收对照表'],
  ];
  for (const [name, key] of items) {
    assert.ok(outline.includes(key), `「${name}」能力缺失（找不到「${key}」）`);
  }
});
check('★★ 四条禁令逐条在', () => {
  const bans = [
    '不为加剧情新增组织、门派、猎奇设定',
    '不为反转而反转',
    '不堆无关支线',
    '不批量生成功能性工具人',
  ];
  for (const b of bans) assert.ok(outline.includes(b), `禁令「${b}」不见了 —— 这是必须拒绝的缺陷`);
});
check('★ 输出顺序写死在技能里', () => {
  assert.ok(/核心主旨 → 人物底层设定 → 世界观与社会规则 → 逆推分卷大纲（含阶段节点）→ 配套附表/.test(outline),
    '输出顺序没有按要求的五段写');
});
check('★ 主题/人物禁令与创作准则不冲突（明确说同样适用）', () => {
  assert.ok(/创作准则/.test(outline), 'outline 没有引用创作准则，等于两套标准');
});
check('★ 附表模板齐（四张表 + 两张清单）', () => {
  const t = read(path.join(SK, 'sk-novel-outline/references/templates.md'));
  for (const name of ['时间年表', '势力矛盾表', '伏笔回收对照表', '专有名词索引', '牺牲代价清单', '力量体系']) {
    assert.ok(t.includes(name), `模板里少了「${name}」`);
  }
});
check('★ 力量体系克制写成了可检查的形式（"做不到"必填）', () => {
  const t = read(path.join(SK, 'sk-novel-outline/references/templates.md'));
  assert.ok(/做不到/.test(t), '模板里没有"这一层做不到什么"那一列 —— 战力膨胀就靠它挡');
});

console.log('\n=== D. 同步技能补上附表维护 ===');

check('★ 模式 C 存在，且要求"只补不删"', () => {
  const s = skill('sk-novel-sync');
  assert.ok(/模式 C：附表维护/.test(s), '同步技能没有附表维护模式');
  assert.ok(/只补不删/.test(s), '没有"只补不删"，表会被下一次整理清空');
  assert.ok(/弃收/.test(s), '"弃收要写理由"这条不在，伏笔会被悄悄丢掉');
});
check('★ 原有模式 A / B 没被改坏', () => {
  const s = skill('sk-novel-sync');
  assert.ok(/模式 A：一致性检查/.test(s));
  assert.ok(/模式 B：文档同步/.test(s));
  assert.ok(/检查只报告/.test(s));
});

console.log('\n=== E. ⚠⚠ 注入上限（超了会被静默截断）===');

check('★★ 所有 SKILL.md 总字符 ≤ 4000（prompt_content 是整个文件）', () => {
  const bad = [];
  for (const d of fs.readdirSync(SK)) {
    if (!fs.statSync(path.join(SK, d)).isDirectory()) continue;
    const p = path.join(SK, d, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const n = read(p).length;
    if (n > SKILL_CHARS) bad.push(`${d}: ${n} 字符`);
  }
  assert.strictEqual(bad.length, 0,
    `这些技能超了注入上限，会被 clip() 截断（截断后模型只看到半截）：\n      ${bad.join('\n      ')}`);
});
check('⚠ 留有余量（≥50 字符），避免下次加一句话就超', () => {
  const tight = [];
  for (const d of fs.readdirSync(SK)) {
    if (!fs.statSync(path.join(SK, d)).isDirectory()) continue;
    const p = path.join(SK, d, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const n = read(p).length;
    if (n > SKILL_CHARS - 50) tight.push(`${d}: 只剩 ${SKILL_CHARS - n} 字符`);
  }
  assert.strictEqual(tight.length, 0, `余量太小，下次改就会超：\n      ${tight.join('\n      ')}`);
});

console.log('\n=== F. 注册与路由 ===');

check('★ 已注册进 BUILTIN（没注册等于不存在）', () => {
  const src = read(path.join(__dirname, '..', 'db', 'builtin-skills.js'));
  assert.ok(/id: 'sk-novel-outline'/.test(src), 'BUILTIN 里没有 sk-novel-outline');
  assert.ok(/name: '长篇结构工程'/.test(src), '名称不对');
});
check('⚠ 两个技能的 description 分工明确（8B 路由靠关键词，容易互相抢）', () => {
  const w = skill('sk-novel-writer').split('---')[1];
  const o = skill('sk-novel-outline').split('---')[1];
  assert.ok(/只做结构，不写正文/.test(o), 'outline 没写"只做结构"，会跟 writer 抢活');
  assert.ok(/与「写新章节」的分工/.test(o), 'outline 没写与 writer 的分工');
  assert.ok(/novel-writer|写新章节/.test(w), 'writer 的 description 不该丢失自身标识');
});

const total = passed + failures.length;
console.log(`\n${'='.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length}/${total} 条失败：`);
  for (const { name, e } of failures) console.log(`  · ${name}\n    ${e.message}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部 ${total} 条通过`);
}

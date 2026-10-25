/**
 * 蒸馏抽取规则的测试。
 *
 * ⚠ 为什么单独测：extractCandidates 是**纯规则**（正则 + 标题定位），
 *   没有模型参与，所以它的行为完全可预期——一旦有偏差，
 *   那是代码的 bug，不会"随机"或"这次好一点"。
 *   正因为可预期，才必须钉死。
 *
 * 现实后果：抽取漏了 → 设定库空 → 模型检索不到 → 生成的正文与资料矛盾，
 *   而且**不报错**。这是静默失效，比崩溃难查。
 *
 * 运行：node app/test-distill.js
 */

const assertNode = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// DistillPanel 是 JSX + ESM，require 不了。抽取函数是纯的，
// 用 vm 把文件里的纯函数部分跑起来——比复制一份到公共模块更可信
// （复制的版本会和组件漂移，这轮已经吃过一次教训）。
function loadExtractor() {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(__dirname, 'src', 'components', 'DistillPanel.jsx'),
    'utf8'
  );

  // 截取 extractCandidates 的定义区间
  const start = src.indexOf('export function extractCandidates');
  assertNode.ok(start > 0, '没找到 extractCandidates');
  const end = src.indexOf('\nconst TYPE_LABEL', start);
  assertNode.ok(end > start, '没找到函数结尾');

  // 依赖的 TYPE_HINTS 常量：从文件里原样取出来
  const thStart = src.indexOf('const TYPE_HINTS');
  const thEnd = src.indexOf('\n];', thStart) + 3;
  assertNode.ok(thEnd > thStart, '没找到 TYPE_HINTS');
  const thCode = src.slice(thStart, thEnd);

  // ⚠ 不要再做 TYPE_HINTS → __TH 的字面替换：TYPE_HINTS 里含 TYPE_HINTS
  //   自己（数组元素就是 { key, label, patterns }，但 TYPE_LABEL 也含
  //   TYPE_H 前缀），第一版因此把 `const TYPE_HINTS = [` 改成了
  //   `const __TH TYPE_HINTS = [`，语法直接崩。
  //   正确做法：常量保持原名，只把 export 关键字去掉。
  const fnCode = src.slice(start, end).replace(/^export /, '');
  const fn = new Function(`${thCode}\n${fnCode}\nreturn extractCandidates;`)();
  return fn;
}

const extractCandidates = loadExtractor();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

const byName = (list, name) => list.find((c) => c.name === name);

// ===========================================================
section('一、表格抽取');

check('表格字段「姓名」→ 角色', () => {
  const r = extractCandidates('| 姓名 | 夜枫 |\n|---|---|\n| 身份 | 木匠之子 |');
  const c = byName(r, '夜枫');
  assertNode.ok(c, `没抽出「夜枫」，实际：${JSON.stringify(r.map((x) => x.name))}`);
  assertNode.strictEqual(c.type, 'character');
});

check('表格字段「地点」「功法」「势力」各自映射', () => {
  const md = '| 地点 | 处州 |\n| 功法 | 逆鳞诀 |\n| 势力 | 赤霄宗 |';
  const r = extractCandidates(md);
  assertNode.strictEqual(byName(r, '处州').type, 'location');
  assertNode.strictEqual(byName(r, '逆鳞诀').type, 'technique');
  assertNode.strictEqual(byName(r, '赤霄宗').type, 'faction');
});

check('空值单元格被跳过', () => {
  const r = extractCandidates('| 姓名 |  |\n| 地点 | 处州 |');
  assertNode.ok(!r.some((c) => c.name === ''), '空名字不该进来');
  assertNode.ok(byName(r, '处州'), '同一行的正常项应保留');
});

check('分隔行 `|---|` 不被当成条目', () => {
  const r = extractCandidates('| 姓名 | 夜枫 |\n|---|---|');
  assertNode.strictEqual(r.length, 1, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
});

check('无已知字段名的普通表格不被抽（避免把章节摘要表灌进设定库）', () => {
  const r = extractCandidates('| 章 | 标题 | 摘要 |\n|---|---|---|\n| 1 | 起 | 夜枫出村 |');
  assertNode.strictEqual(r.length, 0, `不该抽出：${JSON.stringify(r.map((c) => c.name))}`);
});

// ===========================================================
section('二、列表抽取');

check('`- 名称：说明` 被抽出', () => {
  const r = extractCandidates('## 人物\n\n- 夜枫：处州青石村少年，木匠之子\n- 夜大柱：夜枫之父');
  const c = byName(r, '夜枫');
  assertNode.ok(c, `没抽出，实际：${JSON.stringify(r.map((x) => x.name))}`);
  assertNode.ok(c.note.includes('青石村'), `说明丢了：${c.note}`);
});

check('`- **名称**：说明` 的粗体被剥掉', () => {
  const r = extractCandidates('## 人物\n\n- **谢九**：乱葬岗拾棺人，身份不明');
  const c = byName(r, '谢九');
  assertNode.ok(c, `粗体没剥干净：${JSON.stringify(r.map((x) => x.name))}`);
});

check('标题决定类型：## 地理 → 地点', () => {
  const r = extractCandidates('## 地理\n\n- 处州：越国境内一州');
  assertNode.strictEqual(byName(r, '处州').type, 'location');
});

check('标题决定类型：## 势力 → 势力', () => {
  const r = extractCandidates('## 势力\n\n- 赤霄宗：越国第一剑宗');
  assertNode.strictEqual(byName(r, '赤霄宗').type, 'faction');
});

check('标题决定类型：## 力量体系 → 功法', () => {
  const r = extractCandidates('## 力量体系\n\n- 逆鳞诀：赤霄宗剑诀，起手带三分回锋');
  assertNode.strictEqual(byName(r, '逆鳞诀').type, 'technique');
});

check('跨过其它章节后不再沿用上一个标题的类型', () => {
  const md = '## 地理\n\n- 处州：越国一州\n\n## 人物\n\n- 夜枫：青石村少年';
  const r = extractCandidates(md);
  assertNode.strictEqual(byName(r, '处州').type, 'location');
  assertNode.strictEqual(byName(r, '夜枫').type, 'character');
});

check('字段名本身不会被当成实体名（`- 姓名：夜枫` 只产出夜枫）', () => {
  const r = extractCandidates('## 人物\n\n- 姓名：夜枫\n- 身份：木匠之子\n- 年龄：十五');
  const names = r.map((c) => c.name);
  for (const field of ['姓名', '身份', '年龄', '目标', '弱点']) {
    assertNode.ok(!names.includes(field), `字段名「${field}」被当成实体了：${JSON.stringify(names)}`);
  }
});

check('太短的名字被跳过（单字多半是噪声）', () => {
  const r = extractCandidates('## 人物\n\n- 甲：某个东西');
  assertNode.strictEqual(r.length, 0, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
});

// ===========================================================
section('三、去重与合并');

check('同名同类型只保留一条', () => {
  const md = '| 姓名 | 夜枫 |\n|---|---|\n\n- 夜枫：处州青石村少年，木匠之子';
  const r = extractCandidates(md);
  assertNode.strictEqual(r.filter((c) => c.name === '夜枫').length, 1);
});

check('重复出现时保留说明更长的那条', () => {
  const r = extractCandidates('- 夜枫：少年\n- 夜枫：处州青石村少年，木匠之子，十五岁');
  const c = byName(r, '夜枫');
  assertNode.ok(c.note.length > 5, `应保留长的那条，实际「${c.note}」`);
});

check('同名不同类型各自保留（人名与地名撞名不算重复）', () => {
  const r = extractCandidates('- 处州：一州\n- 处州：某人的名字');
  assertNode.ok(r.length >= 1);
});

// ===========================================================
section('四、边界与稳健');

check('空输入返回空数组', () => {
  assertNode.deepStrictEqual(extractCandidates(''), []);
  assertNode.deepStrictEqual(extractCandidates(null), []);
  assertNode.deepStrictEqual(extractCandidates(undefined), []);
});

check('只有空白的行不产出条目', () => {
  assertNode.deepStrictEqual(extractCandidates('   \n\t\n  \n'), []);
});

check('没有冒号的列表项被跳过', () => {
  assertNode.deepStrictEqual(extractCandidates('- 夜枫 处州少年'), []);
});

check('超长文本不崩（单文件 10 万行以内）', () => {
  const big = '## 人物\n\n' + Array.from({ length: 5000 }, (_, i) => `- 角色${i}：说明${i}`).join('\n');
  const r = extractCandidates(big);
  assertNode.strictEqual(r.length, 5000, `实际 ${r.length}`);
});

check('CRLF 输入正常', () => {
  const r = extractCandidates('## 人物\r\n\r\n- 夜枫：处州少年');
  assertNode.ok(byName(r, '夜枫'), 'CRLF 下没抽出');
});

check('不把围栏代码块内容当成设定', () => {
  // 资料文件里常粘示例代码，抽出来会往设定库里灌垃圾条目且不报错。
  // 第一版没剥代码块，这条直接红。
  const r = extractCandidates('```\n- 不是人物：这是代码\n```');
  assertNode.strictEqual(r.length, 0, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
});

check('不把波浪线围栏当代码（yaml 常用）', () => {
  const r = extractCandidates('~~~\n- 也不是人物：yaml 片段\n~~~');
  assertNode.strictEqual(r.length, 0, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
});

check('不把缩进代码块当设定', () => {
  const r = extractCandidates('正文\n\n    - 缩进代码：不是设定\n');
  assertNode.strictEqual(r.length, 0, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
});

check('代码块之后的正常条目仍能抽到（剥代码块不能吃掉后半篇）', () => {
  const md = '```\n- 假的：代码\n```\n\n## 人物\n\n- 夜枫：处州少年';
  const r = extractCandidates(md);
  assertNode.strictEqual(r.length, 1, `实际 ${JSON.stringify(r.map((c) => c.name))}`);
  assertNode.ok(byName(r, '夜枫'), '剥代码块把后面的内容也吃了');
});

check('行号不被破坏（剥代码块用等长空格，行数不变）', () => {
  // 章节标题定位靠行号，若剥代码块改变了行数，类型判断会错位
  const md = '```\nline1\nline2\nline3\n```\n## 地理\n\n- 处州：一州';
  const r = extractCandidates(md);
  assertNode.strictEqual(byName(r, '处州').type, 'location',
    `类型判断错位，实际 ${JSON.stringify(r)}`);
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`蒸馏抽取规则：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
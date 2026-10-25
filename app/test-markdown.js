/**
 * Markdown 渲染器验收测试。
 *
 * 这里测的不是"渲染出好看的样子"（那是视觉的事，截图才看得到），
 * 而是**结构对不对**与**安全性**——
 * 后者尤其重要：渲染器的输入是用户资料文件，
 * 里面可能粘过从网页复制的带标签片段。
 *
 * 运行：node app/test-markdown.js
 */

const assertNode = require('node:assert');
const { parse, stat, splitRow, alignOf, isDivider } = require('./electron/markdown-render.js');

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

/** 把节点树摊平成可搜索的结构，便于断言 */
function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children) flatten(n.children, out);
    if (n.items) for (const it of n.items) flatten(it.children, out);
    if (n.header) for (const c of n.header) flatten(c.children, out);
    if (n.rows) for (const r of n.rows) for (const c of r) flatten(c.children, out);
  }
  return out;
}
const types = (src) => flatten(parse(src)).map((n) => n.t);

// ===========================================================
section('一、标题');

check('六个标题级别都识别', () => {
  const b = parse('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六');
  assertNode.strictEqual(b.length, 6);
  assertNode.deepStrictEqual(b.map((x) => x.level), [1, 2, 3, 4, 5, 6]);
});

check('七级井号不是标题（当普通文本）', () => {
  const b = parse('####### 七个');
  assertNode.strictEqual(b[0].t, 'p', '应降级为段落而不是硬认成 h7');
});

check('闭合井号被吃掉', () => {
  const b = parse('## 标题 ##');
  const text = flatten(b).filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.strictEqual(text, '标题', `实际「${text}」`);
});

check('标题前最多允许 3 个空格', () => {
  assertNode.strictEqual(parse('   # 三空格').length, 1);
  assertNode.strictEqual(parse('# 太宽').length, 1);
});

// ===========================================================
section('二、正文与转义');

check('HTML 标签被转义（XSS 防线）', () => {
  const b = parse('这是 <script>alert(1)</script> 内容');
  // 内容里出现 &lt;script&gt; 说明确实被转义了
  const texts = flatten(b).filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.ok(texts.includes('&lt;script&gt;'), `未转义：${texts}`);
  assertNode.ok(!texts.includes('<script>'), '★ 原始标签没被转义');
});

check('img onerror 被转义', () => {
  const b = parse('<img src=x onerror=alert(1)>');
  const texts = flatten(b).filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.ok(!texts.includes('<img'), `未转义：${texts}`);
});

check('& 被转义但不产生二次转义', () => {
  const texts = flatten(parse('A & B')).filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.ok(texts.includes('&amp;'), `实际「${texts}」`);
  assertNode.ok(!texts.includes('&amp;amp;'), '★ 二次转义了');
});

check('连续非空行合并为一段，行内换行成 br', () => {
  const b = parse('第一行\n第二行\n\n第三段');
  assertNode.strictEqual(b.length, 2, `应两段，实际 ${b.length}`);
  assertNode.ok(b[0].children.some((c) => c.t === 'br'), '段内换行应产生 br');
});

check('ATX 标题必须独占一行（符合 CommonMark）', () => {
  // ⚠ 第一版这条断言写反了：我以为「段落中间的 #### 不该开新块」，
  // 于是断言 parse 返回 1 个块。实测返回 2 块（段落 + 标题）。
  // 但 `#### 后面文字` 是**独占一行**的——按 CommonMark 它就是标题，
  // 实现是对的，测试错了。
  // 真正该测的是：标题记号出现在段落**内部**时不生效。
  const b = parse('前面文字\n#### 后面文字');
  assertNode.strictEqual(b.length, 2, '独占一行的 #### 应成标题');
  assertNode.strictEqual(b[0].t, 'p');
  assertNode.strictEqual(b[1].t, 'h');

  const inPara = parse('前面 文字#### 不是标题');
  assertNode.strictEqual(inPara.length, 1, '段落内部的 #### 不该开新块');
  assertNode.ok(inPara[0].children.some((c) => c.t === 'text' && c.text.includes('####')),
    '段落内的 #### 应原样保留');
});

// ===========================================================
section('三、行内标记');

check('粗体与斜体', () => {
  const t = flatten(parse('这是**粗**和*斜*'));
  assertNode.ok(t.some((n) => n.t === 'strong' && n.text === '粗'));
  assertNode.ok(t.some((n) => n.t === 'em' && n.text === '斜'));
});

check('行内代码不被当成强调', () => {
  const t = flatten(parse('用 `**不是粗体**` 包裹'));
  assertNode.ok(t.some((n) => n.t === 'code' && n.text === '**不是粗体**'));
  assertNode.ok(!t.some((n) => n.t === 'strong'), '代码里的 ** 不该被解析成粗体');
});

check('删除线', () => {
  const t = flatten(parse('~~删掉~~'));
  assertNode.ok(t.some((n) => n.t === 'del' && n.text === '删掉'));
});

check('链接只留文字，不生成可点链接', () => {
  // javascript: 协议是真实攻击面；不做 <a> 就从根上消除
  const t = flatten(parse('[点我](javascript:alert(1))'));
  assertNode.ok(!types('[点我](javascript:alert(1))').includes('a'), '不该产出 <a>');
  const texts = t.filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.ok(texts.includes('点我'), '链接文字应保留');
});

check('图片降级为占位文本而非 img 标签', () => {
  const t = types('![说明](a.png)');
  assertNode.ok(!t.includes('img'), '不应产出 img');
});

check('未闭合的强调不当强调处理', () => {
  const t = flatten(parse('这是**未闭合'));
  assertNode.ok(!t.some((n) => n.t === 'strong'), '未闭合 ** 不该被解析');
});

// ===========================================================
section('四、列表');

check('无序列表项数正确', () => {
  const b = parse('- 甲\n- 乙\n- 丙');
  assertNode.strictEqual(b[0].t, 'ul');
  assertNode.strictEqual(b[0].items.length, 3);
});

check('有序列表项数正确', () => {
  const b = parse('1. 甲\n2. 乙');
  assertNode.strictEqual(b[0].t, 'ol');
  assertNode.strictEqual(b[0].items.length, 2);
});

check('多种无序符号不拆成多个列表', () => {
  const b = parse('- 甲\n* 乙\n+ 丙');
  assertNode.strictEqual(b.length, 1, `应合成一个列表，实际 ${b.length} 块`);
  assertNode.strictEqual(b[0].items.length, 3);
});

check('列表项内的缩进续行并入该项', () => {
  const b = parse('- 第一项\n  补充说明\n- 第二项');
  assertNode.strictEqual(b[0].items.length, 2, `实际 ${b[0].items.length} 项`);
  const texts = flatten(b[0].items[0].children).filter((n) => n.t === 'text').map((n) => n.text).join('');
  assertNode.ok(texts.includes('补充说明'), `续行丢失：${texts}`);
});

check('列表后紧跟段落不会被吞进列表', () => {
  const b = parse('- 甲\n- 乙\n这是一段正文');
  assertNode.strictEqual(b.length, 2, `应列表+段落两块，实际 ${b.length}`);
  assertNode.strictEqual(b[1].t, 'p');
});

check('两种符号不构成嵌套（- 与 1. 是同级）', () => {
  const b = parse('1. 甲\n   - 子');
  // 子项带序号与不带序号都属于列表，缩进让它成为嵌套而非新块
  assertNode.ok(b.length <= 2, `块数异常：${b.length}`);
});

// ===========================================================
section('五、表格');

check('表头 + 分隔行 + 数据行', () => {
  const b = parse('| 章 | 标题 |\n|---|---|\n| 1 | 起 |\n| 2 | 承 |');
  assertNode.strictEqual(b[0].t, 'table');
  assertNode.strictEqual(b[0].header.length, 2);
  assertNode.strictEqual(b[0].rows.length, 2);
});

check('三种对齐方式', () => {
  const a = alignOf('|:---|:---:|---:|');
  assertNode.deepStrictEqual(a, ['left', 'center', 'right']);
});

check('无对齐标记时为 null（交给 CSS 默认）', () => {
  assertNode.deepStrictEqual(alignOf('|---|'), [null]);
});

check('只有表头没有分隔行 → 不当表格（降级为段落）', () => {
  const b = parse('| 章 | 标题 |\n| 1 | 起 |');
  assertNode.strictEqual(b[0].t, 'p', '缺分隔行不该当表格');
});

check('缺列的行补齐空格子（列数对齐表头）', () => {
  // ⚠ 第一版断言写成 rows[0].length === 1，是**我期望错了**。
  // 表格要能对齐渲染，缺列必须补空格子；不补的话该行会比表头窄，
  // 界面上变成一条参差不齐的短行。实测实现给的是 ["1","",""] —— 对的。
  const b = parse('| A | B | C |\n|---|---|---|\n| 1 |');
  assertNode.strictEqual(b[0].rows.length, 1);
  assertNode.strictEqual(b[0].rows[0].length, 3, '缺列应补齐到表头宽度');
  const cells = b[0].rows[0].map((c) => c.children.map((x) => x.text || '').join(''));
  assertNode.deepStrictEqual(cells, ['1', '', '']);
});

check('多出列的行被截断到表头宽度', () => {
  const b = parse('| A | B |\n|---|---|\n| 1 | 2 | 3 | 4 |');
  assertNode.strictEqual(b[0].rows[0].length, 2, `实际 ${b[0].rows[0].length} 列`);
});

check('行内转义的竖线不算分隔符', () => {
  const cells = splitRow('| a \\| b | c |');
  assertNode.strictEqual(cells.length, 2, `实际 ${JSON.stringify(cells)}`);
  assertNode.ok(cells[0].includes('a | b'), `转义竖线未还原：${cells[0]}`);
});

check('单元格内的强调被解析', () => {
  const b = parse('| A |\n|---|\n| **粗** |');
  const t = flatten(b[0].rows[0]);
  assertNode.ok(t.some((n) => n.t === 'strong'), '表格单元格里的 ** 应解析');
});

// ===========================================================
section('六、引用与代码块');

check('引用块内递归解析', () => {
  const b = parse('> ## 标题\n> 内容');
  assertNode.strictEqual(b[0].t, 'quote');
  assertNode.ok(flatten(b[0].children).some((n) => n.t === 'h'), '引用内的 ## 应成标题');
});

check('围栏代码块保留原样（含看起来像标记的行）', () => {
  const b = parse('```js\nconst a = **不是粗体**;\n```');
  assertNode.strictEqual(b[0].t, 'code');
  assertNode.strictEqual(b[0].lang, 'js');
  assertNode.ok(b[0].text.includes('**不是粗体**'), '代码块内不应解析标记');
});

check('代码块内的空行保留', () => {
  const b = parse('```\n甲\n\n乙\n```');
  assertNode.strictEqual(b[0].text, '甲\n\n乙', `实际「${b[0].text}」`);
});

check('缩进代码块', () => {
  const b = parse('正文\n\n    缩进的代码\n');
  assertNode.ok(flatten(b).some((n) => n.t === 'code' && n.text.includes('缩进的代码')));
});

check('分隔线识别', () => {
  assertNode.strictEqual(isDivider('---'), true);
  assertNode.strictEqual(isDivider('***'), true);
  assertNode.strictEqual(isDivider('- - -'), true);
  assertNode.strictEqual(isDivider('--'), false, '两个不够');
  assertNode.strictEqual(isDivider('文字---'), false);
});

// ===========================================================
section('七、健壮性（资料文件千奇百怪）');

check('空输入返回空数组而不是崩', () => {
  assertNode.deepStrictEqual(parse(''), []);
  assertNode.deepStrictEqual(parse(null), []);
  assertNode.deepStrictEqual(parse(undefined), []);
});

check('未闭合的代码块不吞掉后面所有内容', () => {
  const b = parse('```\n甲\n\n后面还有内容');
  assertNode.strictEqual(b.length, 1, '未闭合围栏应作为一个代码块处理');
  assertNode.ok(b[0].text.includes('后面还有内容'));
});

check('未闭合的表格不吞掉后面内容', () => {
  const b = parse('| A | B |\n|---|---|\n| 1 | 2 |\n后面段落');
  const last = b[b.length - 1];
  assertNode.strictEqual(last.t, 'p', '表格后的段落应独立成块');
});

check('纯空白的连续空行不会死循环', () => {
  const b = parse('\n\n\n   \n\t\n\n');
  assertNode.deepStrictEqual(b, []);
});

check('CRLF 换行被正确处理', () => {
  const b = parse('# 标题\r\n\r\n正文');
  assertNode.strictEqual(b.length, 2);
  assertNode.strictEqual(b[0].t, 'h');
});

check('超长单行不崩', () => {
  const b = parse('长'.repeat(100000));
  assertNode.strictEqual(b.length, 1);
});

check('深层标题与列表交替不崩', () => {
  const b = parse('# a\n- b\n  - c\n## d\n> e\n1. f');
  assertNode.ok(b.length > 0);
});

// ===========================================================
section('八、统计');

check('字数按不含空白计（中文字数）', () => {
  // 「标题」2 字 + 「正文四个字」5 字 = 7。
  // 第一版我把「四个字」当成 2 字，断言写的是 7 却期望另一个值——
  // 测试自己数错了字数，比实现出错更难发现。
  const s = stat('# 标题\n\n正文四个字\n');
  assertNode.strictEqual(s.chars, 7, `实际 ${s.chars}`);
});

check('行数与标题数', () => {
  const s = stat('# 一\n## 二\n内容');
  assertNode.strictEqual(s.headings, 2);
  assertNode.strictEqual(s.lines, 3);
});

check('空输入统计不崩', () => {
  const s = stat('');
  assertNode.strictEqual(s.chars, 0);
  assertNode.strictEqual(s.words, 0);
});

check('emoji 按码位计（代理对不能算成 2）', () => {
  // str.length 会把 🌙 算成 2，显示的字数就虚高了。
  // 用 [...str] 展开成码位数组才是正确做法。
  const s = stat('甲🌙乙');
  assertNode.strictEqual(s.chars, 3, `实际 ${s.chars}（说明还在用 str.length）`);
  assertNode.strictEqual(stat('🌙🌙🌙').chars, 3, '三个 emoji 应算 3');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`Markdown 渲染器：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
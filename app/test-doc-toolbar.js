/**
 * 文档工具栏的**纯文本变换**判据。
 *
 * ## 为什么单独建一个文件
 *
 * `DocToolbar.jsx` 里的 `applyPunct` / `typeset` / `findAll` 是纯函数，
 * 但它们住在 .jsx 里 —— 而本项目的 node 判据只 require 纯 node 模块。
 * 于是最该被测的逻辑恰好最难测，等于没测。
 *
 * 所以把三个函数**从组件里导出**，这里直接 require 那个模块。
 * ⚠ .jsx 里有 React 语法，node 直接 require 会炸 ——
 *   所以判据里用「正则抠出函数源码再 eval」的办法（见下面）。
 *
 * ## 为什么要测这几个
 *
 * 三个都是「批量改用户稿子」的操作，错了就是**静默地毁内容**：
 *   替换标点：引号配对错 → 全文引号方向反了，读者一眼看出来是乱的
 *   一键排版：把不该删的空格删了 / 缩进加了两次
 *   查找：数出来的命中位置和实际不符 → 跳转跳错地方
 * 这些都不会报错，只会让用户稿子变糟。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (t) => console.log(`\n${t}`);

const src = fs.readFileSync(path.join(__dirname, 'src', 'components', 'DocToolbar.jsx'), 'utf8');

/**
 * 抠出函数源码并 eval。
 * ⚠ 为什么不用 require：文件里有 JSX 与 import，node 直接加载会抛语法错。
 *   只取纯函数的声明段，它们本来就是合法 JS。
 * ⚠⚠ 而且必须把**被调用的私有函数一起带上** ——
 *   `countPunct` / `applyPunct` 都调 `pickRule`（引号配对那一步），
 *   第一次写判据时只抠了这两个，eval 出来报 `pickRule is not defined`。
 *   依赖是隐式的，不一起加载就会得到一条和代码对不上的红。
 */
function loadFn(name, deps = {}) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`DocToolbar.jsx 里找不到 ${name}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const code = src.slice(start, i);
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `"use strict"; return (${code});`)(...keys.map((k) => deps[k]));
}

const pickRule = loadFn('pickRule');

section('一、模块结构');
check('★ DocToolbar.jsx 存在且导出默认组件', () => {
  assert.ok(src.includes('export default function DocToolbar'), '没有默认导出');
});
check('★ 三个纯函数都导出了（供本判据与将来的复用）', () => {
  for (const n of ['countPunct', 'applyPunct', 'typeset', 'findAll']) {
    assert.ok(src.includes(`export function ${n}`), `${n} 没有 export`);
  }
});
check('★ 已接进编辑器（DocPreview 用了它）', () => {
  const dp = fs.readFileSync(path.join(__dirname, 'src', 'components', 'DocPreview.jsx'), 'utf8');
  assert.ok(dp.includes('import DocToolbar'), 'DocPreview 没引 DocToolbar');
  assert.ok(dp.includes('<DocToolbar'), 'DocPreview 没渲染 DocToolbar');
  assert.ok(/bookTitle/.test(dp), 'DocPreview 没接书名 prop');
});

section('二、替换标点');
const countPunct = loadFn('countPunct', { pickRule });
const applyPunct = loadFn('applyPunct', { pickRule });

const RULES = [
  { from: '"', to: '“' }, { from: '"', to: '”' },
  { from: ',', to: '，' }, { from: '!', to: '！' },
];

check('★ 半角逗号/叹号换成全角', () => {
  const r = applyPunct('他说,好!', RULES);
  assert.strictEqual(r, '他说，好！', r);
});
check('★ 引号成对交替：第 1、3、5 个 → 左，第 2、4、6 个 → 右', () => {
  const r = applyPunct('"甲"和"乙"还有"丙"', RULES);
  assert.strictEqual(r, '“甲”和“乙”还有“丙”', r);
});
check('★ 引号是唯一需要交替的；别的规则各算各的', () => {
  const r = applyPunct('"引号",逗号!叹号,逗号!', RULES);
  assert.strictEqual(r, '“引号”，逗号！叹号，逗号！', r);
});
check('★ ★ 计数与替换结果必须一致（不一致就骗用户）', () => {
  const text = '“已全角的”不动,这个换!这个也换,"引号"两个';
  const counts = countPunct(text, RULES);
  const sum = counts.reduce((a, b) => a + b, 0);
  // 实际会改变多少处 = 替换前后不同的字符数
  const after = applyPunct(text, RULES);
  let changed = 0;
  for (let i = 0; i < text.length; i++) if (text[i] !== after[i]) changed++;
  assert.strictEqual(sum, changed,
    `规则说 ${sum} 处，实际改了 ${changed} 处 —— 弹窗上的「将替换 N 处」会骗人`);
});
check('★ 已经是对的标点不会被再改（幂等）', () => {
  const once = applyPunct('他说,好!', RULES);
  const twice = applyPunct(once, RULES);
  assert.strictEqual(twice, once, '对已处理过的文本再跑一次，结果变了');
});
check('★ 空文本不炸', () => {
  assert.strictEqual(applyPunct('', RULES), '');
  assert.deepStrictEqual(countPunct('', RULES), [0, 0, 0, 0]);
});

section('三、一键排版');
const typeset = loadFn('typeset');

/**
 * ⚠⚠⚠ 下面带 ★★ 的是**事故判据**，不是常规用例。
 *
 * 2026-10-15 用户现场：点了一键排版 → 点保存 → 预览里正文**整片消失**。
 * 根因：第一版给**每一行**都加了「　　」，于是
 *   `# 人物库` → `　　# 人物库`、`- 姓名：…` → `　　- 姓名：…`
 * 而全角空格不是合法的 Markdown 前缀，结构直接坏掉。
 *
 * 而且第一版**根本没处理代码块** —— 围栏里的代码同样被去空格、加缩进。
 * 「批量改用户稿子」最不能碰的就是代码。
 */
check('★★ Markdown 结构行不许被加缩进', () => {
  const input = [
    '# 人物库',
    '## 主角',
    '- **姓名**：李长乐',
    '1. 第一步',
    '> 引用',
    '| 列 | 列 |',
  ].join('\n');
  const r = typeset(input);
  for (const line of r.split('\n')) {
    assert.ok(!/^　/.test(line), `结构行被加了全角缩进：${JSON.stringify(line)}`);
  }
});

check('★★ 代码围栏内**一个字符都不许动**', () => {
  const input = [
    '# 代码示例',
    '',
    '```js',
    'const a = 1;',
    'const  汉字  中间 = 2;',
    '',
    '',
    '```',
    '',
    '正文段落',
  ].join('\n');
  const grab = (s) => {
    const m = s.match(/```[\s\S]*?```/);
    return m ? m[0] : null;
  };
  assert.strictEqual(grab(typeset(input)), grab(input), '代码块被改了 —— 批量排版绝不能碰代码');
});

check('★★ 嵌套列表的缩进不许被删（删了就散架）', () => {
  const r = typeset('## 主角\n  - 子项甲\n    - 孙项乙');
  assert.ok(/^[ \t]+- 子项甲$/m.test(r), `子项的行首缩进被删了：${JSON.stringify(r)}`);
  assert.ok(/^[ \t]{4,}- 孙项乙$/m.test(r), `孙项的缩进被删了：${JSON.stringify(r)}`);
});

check('★ 正文段落**仍然**要有首行缩进（这是这功能存在的理由）', () => {
  const r = typeset('雨停了。\n\n他抬头看天。');
  assert.ok(r.includes('　　雨停了。'), '第一段没缩进');
  assert.ok(r.includes('　　他抬头看天。'), '第二段没缩进');
});

check('★ 压缩连续空行（3 个以上换行 → 2 个）', () => {
  assert.strictEqual(typeset('甲\n\n\n\n\n乙').split('\n').filter(Boolean).length, 2);
});

check('★ 空行不会被加缩进', () => {
  // ⚠ 必须**逐行**判断：JS 的 `\s` 包含全角空格（U+3000），
  //   所以 `/^\s+　/` 在整串上匹配到的是「段落缩进」而不是空行 ——
  //   我第一版就是这么写的，判据红而代码是对的。
  const r = typeset('甲\n\n\n乙');
  for (const [i, line] of r.split('\n').entries()) {
    if (line.trim() !== '') continue;
    assert.strictEqual(line, '', `第 ${i + 1} 行是空行，却被塞了「${line}」`);
  }
});

check('★ 已缩进的段落**不重复加**（跑两次结果相同）', () => {
  const once = typeset('雨停了。\n\n他抬头看天。');
  assert.strictEqual(typeset(once), once, '第二次又加了一层缩进');
});

check('★ 去汉字之间的半角空格', () => {
  assert.ok(!typeset('墨 染 仙 途').includes(' '), typeset('墨 染 仙 途'));
});

check('★ 去行尾空格', () => {
  assert.ok(!typeset('甲   \n乙').includes(' '), typeset('甲   \n乙'));
});

check('★ 英文与数字之间不该被强行合拢', () => {
  const r = typeset('HP 墨染仙途 3000');
  assert.ok(r.includes('HP 墨染仙途 3000'), `英文数字之间的空格被吃了：${r}`);
});

check('★★ 幂等：跑两次内容不变（否则反复点会一直加）', () => {
  const once = typeset('# 标题\n\n段落一。\n\n- 列表\n\n```\ncode\n```');
  assert.strictEqual(typeset(once), once, '第二次运行结果变了');
});

section('三之二、撤销');
check('★ 撤销是**栈**（能连撤多次，而不是只记得上一次）', () => {
  // ⚠ 第一版只有**一个** prevText：撤销一次之后，再点一次就「没有可撤销的」
  //   —— 用户说「撤销键没有用」就是它。
  assert.ok(/useRef\(\[\]\)/.test(src), '撤销不是栈 —— 只能撤一次');
  assert.ok(/\.pop\(\)/.test(src), '撤销没有真正取回上一份');
  // ⚠ 扫源码前先去掉注释：我把老写法写在注释里解释它为什么错，
  //   判据却把注释也当成代码 —— 自己绊倒自己（这个坑今天第三次）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/prevText/.test(code),
    '还在用「单值 ref + 不等就还原」的老写法 —— 用户手动改过之后会把他自己写的字抹掉');
});

section('四、查找');
const findAll = loadFn('findAll');

check('★ 找出全部命中位置', () => {
  const pos = findAll('雨停了。他抬头看天，雨又下起来。', '雨');
  assert.strictEqual(pos.length, 2, `找到 ${pos.length} 处`);
  assert.strictEqual('雨停了。他抬头看天，雨又下起来。'[pos[1]], '雨', '第二个位置不对');
});
check('★ 默认不区分大小写', () => {
  assert.strictEqual(findAll('Rain rain', 'rain').length, 2);
  assert.strictEqual(findAll('Rain rain', 'rain', true).length, 1, '区分大小写时应该只中一个');
});
check('★ 空查询返回空数组而不是死循环', () => {
  assert.deepStrictEqual(findAll('任意文本', ''), []);
});
check('★ 相邻命中不会死循环（前进量必须 >= 1）', () => {
  const pos = findAll('aaaa', 'aa');
  assert.ok(pos.length >= 2, `只找到 ${pos.length} 处`);
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i] > pos[i - 1], '位置没有递增');
});

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `文档工具栏：${passed} 通过 / ${failures.length} 失败`
  : `文档工具栏：${passed} 通过`);
process.exit(failures.length ? 1 : 0);
/**
 * 编辑器流式写入的验收测试。
 *
 * ## 这个文件改过一次，原因值得记
 *
 * 第一版是**缺陷探测脚本**：复刻 EditorSurface.jsx 的旧代码，
 * 复现出三个真 bug（A 段落被压平 / B 每次生成多出空段 / C 模型段落结构丢失）。
 *
 * 修完之后改写成"验收门禁"，但**仍在复刻**——
 * 于是真实现修好了「段落分隔造出多余空段」的 bug，
 * 测试里的复刻版没跟着改，测试报的是**已经不存在的病**。
 * 连续两次跑才发现 14/16。
 *
 * > **看起来测了，实际测的不是那件事。**
 * > 与「把结论抄进注释 ≠ 落实了结论」是同一类错误。
 *
 * 现在测试直接 require `editor/editor-stream-api.js`——
 * 与前端组件（EditorSurface.jsx）**同一份代码**，改一处两边同时变，
 * 漂移在结构上不可能再发生。
 *
 * 运行：node editor/test-editor-surface.js
 */

const { Schema } = require('@tiptap/pm/model');
const { EditorState } = require('@tiptap/pm/state');
const { makeStreamApi, textToHtml } = require('./editor-stream-api.js');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
});

/**
 * 极简 HTML → doc：只处理 <p> 与 <br>。
 * 不用 DOMParser 是因为 Node 环境没有 DOM，而本文件的关注点是
 * 「段落数对不对」，不是完整的 HTML 兼容性。
 */
function parseHtml(html) {
  const blocks = String(html).match(/<p>[\s\S]*?<\/p>/g) || [];
  if (!blocks.length) return schema.node('doc', null, [schema.node('paragraph')]);
  const children = [];
  for (const b of blocks) {
    const inner = b.replace(/^<p>/, '').replace(/<\/p>$/, '');
    // 按 <br> 切行；schema 没有 hardBreak 节点，用带 \n 的 text 近似
    const parts = [];
    const lines = inner.split('<br>').map((l) => l
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) parts.push(schema.text('\n'));
      if (lines[i]) parts.push(schema.text(lines[i]));
    }
    children.push(schema.node('paragraph', null, parts));
  }
  return schema.node('doc', null, children);
}

/**
 * 建一个假的编辑器：满足 makeStreamApi 需要的 getState/setState/setHTML。
 * 真实组件里这三个由 TipTap 的 view 提供，这里用 EditorState 等价替代。
 */
function makeEditor() {
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph')]) });
  return {
    getState: () => state,
    setState: (s) => { state = s; },
    setHTML: (html) => { state = EditorState.create({ schema, doc: parseHtml(html) }); },
    get paras() { return state.doc.childCount; },
  };
}

const paras = (ed) => ed.getState().doc.childCount;
const text = (ed) => ed.getState().doc.textBetween(0, ed.getState().doc.content.size, '\n\n').replace(/\n+$/, '');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
assert.strictEqual = function (a, b, msg) {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

// ================================================================
console.log('\n【1】textToHtml 的段落切分');

t('空文本产出单个空段落', () => {
  assert(textToHtml('') === '<p></p>', `实际 ${textToHtml('')}`);
  assert(textToHtml('   ') === '<p></p>', '纯空白也应是空段落');
});
t('三段正文产出三个 p', () => {
  assert((textToHtml('第一段。\n\n第二段。\n\n第三段。').match(/<p>/g) || []).length === 3);
});
t('单段正文产出一个 p', () => {
  assert((textToHtml('只有一段。').match(/<p>/g) || []).length === 1);
});
t('段内单换行转 br 而非拆段', () => {
  const h = textToHtml('第一行\n第二行');
  assert((h.match(/<p>/g) || []).length === 1, '段内换行不该拆成两段');
  assert(h.includes('<br>'), '应含 <br>');
});
t('HTML 特殊字符被转义', () => {
  const h = textToHtml('他说 <script>alert(1)</script> 与 & 符号');
  assert(!h.includes('<script>'), `未转义：${h}`);
  assert(h.includes('&lt;script&gt;'), `应转义尖括号：${h}`);
  assert(h.includes('&amp;'), `应转义 &：${h}`);
});

// ================================================================
console.log('\n【2】空段落守卫（旧 bug B）');

t('空文档 beginStream 不产生多余空段落', () => {
  const ed = makeEditor();
  const before = paras(ed);
  makeStreamApi(ed).beginStream();
  assert(paras(ed) === before, `空文档：${before} 段 → ${paras(ed)} 段（应为 1）`);
});
t('首次 write 后仍为 1 段', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('他推开门。');
  assert(paras(ed) === 1, `实际 ${paras(ed)} 段`);
});
t('连续生成两次不累积空段落', () => {
  const ed = makeEditor();
  const api = makeStreamApi(ed);
  const s1 = api.beginStream();
  s1.write('第一段。');
  const s2 = api.beginStream();
  s2.write('第二段。');
  assert(paras(ed) === 2, `两次生成后应为 2 段，实际 ${paras(ed)}（旧代码是 6）`);
});
t('非空文档 beginStream 正确追加新段', () => {
  const ed = makeEditor();
  makeStreamApi(ed).setText('已有内容');
  const before = paras(ed);
  makeStreamApi(ed).beginStream();
  assert(paras(ed) === before + 1, `已有内容时应追加一段：${before} → ${paras(ed)}`);
});

// ================================================================
console.log('\n【3】换行分段（旧 bug C + 段落分隔折叠）');

t('分片里的换行产生新段落', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('他推开门。');
  const before = paras(ed);
  s.write('\n\n她站在门口。');
  assert(paras(ed) > before, `换行应产生新段：${before} → ${paras(ed)}`);
});

/**
 * ⚠ 这条与上一条同源，但分开写是有意的：
 * 修复 C 时只处理了「有换行就 split」，
 * 结果 `"甲\n\n乙".split('\n')` 返回 3 个元素 → 一个段落间隔造出 **2 个** 空段落。
 * 实测写三个分段，文档里出现五段。**只测「有换行」抓不到这个问题。**
 */
t('段落分隔只产生一个间隔，不多切空段', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('甲段。\n\n乙段。');
  assert(paras(ed) === 2, `"\\n\\n" 应得 2 段，实际 ${paras(ed)} 段`);
});

t('连续多个换行也只算一个间隔', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('甲段。\n\n\n\n乙段。');
  assert(paras(ed) === 2, `"\\n\\n\\n\\n" 应得 2 段，实际 ${paras(ed)} 段`);
});

t('跨分片的段落分隔正确衔接', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('甲段。');
  s.write('\n\n乙段。');
  s.write('\n\n丙段。');
  assert(paras(ed) === 3, `三次分段应得 3 段，实际 ${paras(ed)} 段`);
});

t('单换行也分段（模型偶尔只输出一个换行）', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('甲段。');
  const before = paras(ed);
  s.write('\n乙段。');
  assert(paras(ed) > before, `单换行也应分段：${before} → ${paras(ed)}`);
});

t('空分片返回 false 且不改变文档', () => {
  const ed = makeEditor();
  makeStreamApi(ed).setText('已有内容');
  const s = makeStreamApi(ed).beginStream();
  const sizeBefore = ed.getState().doc.content.size;
  assert.strictEqual(s.write(''), false, '空分片应返回 false');
  assert(ed.getState().doc.content.size === sizeBefore, '文档不应被改变');
});

t('chars 累计写入字数（按原始分片长度，不是段落数）', () => {
  const ed = makeEditor();
  const s = makeStreamApi(ed).beginStream();
  s.write('五个字');       // 3 字
  s.write('再来五个');     // 4 字
  assert.strictEqual(s.chars(), 7, `应为 7，实际 ${s.chars()}`);
});

// ================================================================
console.log('\n【4】段落结构往返（旧 bug A）');

t('三段正文经 setText 后仍是三段', () => {
  const src = '第一段内容。\n\n第二段是另一段。\n\n第三段结束。';
  const ed = makeEditor();
  makeStreamApi(ed).setText(src);
  assert(paras(ed) === 3, `实际 ${paras(ed)} 段`);
});
t('setText → getText 往返文本一致（忽略空白）', () => {
  const src = '第一段内容。\n\n第二段是另一段。\n\n第三段结束。';
  const ed = makeEditor();
  const api = makeStreamApi(ed);
  api.setText(src);
  const norm = (s) => s.replace(/\s/g, '');
  assert(norm(api.getText()) === norm(src),
    `往返不一致：\n      原文 ${JSON.stringify(norm(src).slice(0, 40))}\n      往返 ${JSON.stringify(norm(api.getText()).slice(0, 40))}`);
});
t('空白段落被丢弃而非保留', () => {
  const ed = makeEditor();
  makeStreamApi(ed).setText('第一段。\n\n\n\n第二段。');
  assert(paras(ed) === 2, `连续空行应合并，实际 ${paras(ed)} 段`);
});
t('finish 是纯读取，不改状态', () => {
  const ed = makeEditor();
  const api = makeStreamApi(ed);
  api.setText('内容在这里。');
  // ⚠ finish 挂在 beginStream 返回的 session 上，不在 api 上——
  //   第一版写成 api.finish()，报 "not a function"。
  //   这是设计如此（只有生成会话才有"本次结束"的语义）。
  const session = api.beginStream();
  session.write('追加内容。');
  const sizeBefore = ed.getState().doc.content.size;
  const got = session.finish();
  assert(got.includes('追加内容'), `finish 应读到正文，实际「${got}」`);
  assert.strictEqual(ed.getState().doc.content.size, sizeBefore, 'finish 不应改变文档');
});

// ================================================================
console.log('\n【5】文档被删空时的中止行为');

/**
 * 文档被删空的守卫。
 *
 * ⚠ 关键约束：**ProseMirror 的 doc 是 `block+`，零段文档是非法的**，
 * `schema.node('doc')` 直接抛 `Invalid content for node doc: <>`。
 * 所以"用户把文档删空"在真实编辑器里的表现不是 childCount=0，
 * 而是 TipTap 拒绝那次 transaction、文档停在一个合法状态。
 *
 * 第一版这��用例试图构造零段 doc，结果卡在 ProseMirror 的校验上，
 * 测的根本不是我们想测的东西。改成测**合法但空的**文档：
 * 只有一个空段落时 beginStream 不应再 split（守卫 B 的另一半）。
 */
t('只剩空段落时 write 正常写入，不额外造段', () => {
  const ed = makeEditor();
  const api = makeStreamApi(ed);
  const s = api.beginStream();          // 空文档，不 split
  assert.strictEqual(paras(ed), 1, 'begin 后应仍为 1 段');
  const ok = s.write('写进去。');
  assert.strictEqual(ok, true, '应写入成功');
  assert.strictEqual(paras(ed), 1, `写入后仍应为 1 段，实际 ${paras(ed)}`);
  assert(text(ed).includes('写进去'), '正文应被写入');
});

t('删除全部内容后仍可写入（合法空文档）', () => {
  const ed = makeEditor();
  const api = makeStreamApi(ed);
  api.setText('原有内容');
  // 模拟用户删光：设成一个空段落
  ed.setState(EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph')]) }));
  const s = makeStreamApi(ed).beginStream();
  assert.strictEqual(s.write('新内容'), true, '合法空文档应可写入');
  assert(text(ed).includes('新内容'), '应写入新内容');
});

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : '  全部通过'}`);
console.log('（本测试与前端组件复用 editor/editor-stream-api.js，代码不会漂移）\n');
process.exit(fail ? 1 : 0);
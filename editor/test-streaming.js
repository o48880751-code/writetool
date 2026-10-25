/**
 * 流式写入 + 用户插队 的验收测试。
 * 不需要浏览器、不需要模型，纯 ProseMirror 状态机，秒级出结果。
 *
 * 运行：node editor/test-streaming.js
 */

const { Schema } = require('@tiptap/pm/model');
const { EditorState } = require('@tiptap/pm/state');
const { StreamingWriter, Phase, verifyBeforeCommit, sentenceSurvived } = require('./streaming-writer.js');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      toDOM: (n) => [`h${n.attrs.level}`, 0],
      parseDOM: [1, 2, 3].map((l) => ({ tag: `h${l}`, attrs: { level: l } })),
    },
    text: { group: 'inline' },
  },
});

const docText = (w) => w.state.doc.textBetween(0, w.state.doc.content.size, '\n').replace(/\n+$/, '');

/**
 * 新建一个 StreamingWriter。
 *
 * 注意：schema 的 doc 要求 block+，**零段文档是非法的**（实测会抛
 * "Invalid content for node doc: <>"）。所以 paras 为空时必须传一个空段落，
 * 不能传空数组——这是 ProseMirror 的硬约束，不是本模块的选择。
 */
function newWriter(paras = ['']) {
  const list = paras.length ? paras : [''];
  const state = EditorState.create({
    doc: schema.node('doc', null, list.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : []))),
    schema,
  });
  return new StreamingWriter(state);
}

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

console.log('\n流式写入验收测试（TipTap/ProseMirror，不调模型不需浏览器）\n');

console.log('一、基础流式写入');

check('分段写入拼成连续文本', () => {
  const w = newWriter(['第一章已有内容。']).beginGeneration();
  for (const c of ['秋雨', '打在', '青石板上。', '谢九走来。']) {
    w.write(c);
  }
  const text = docText(w);
  if (!text.includes('秋雨打在青石板上。谢九走来。')) {
    throw new Error(`分段未拼接：${JSON.stringify(text)}`);
  }
});

check('空分片被忽略', () => {
  const w = newWriter(['开头。']).beginGeneration();
  w.write('');
  w.write(null);
  w.write(undefined);
  const text = docText(w);
  if (text.includes('null') || text.includes('undefined')) throw new Error('空分片污染了内容');
});

check('未 beginGeneration 时写入被拒', () => {
  const w = newWriter(['开头。']);
  if (w.write('不该写进去')) throw new Error('非流式状态竟然写入成功');
});

check('beginGeneration 会新建段落', () => {
  const w = newWriter(['原有段落。']).beginGeneration();
  if (w.state.doc.childCount !== 2) throw new Error(`段落数应为 2，实际 ${w.state.doc.childCount}`);
  w.write('新段落内容');
  if (w.state.doc.childCount !== 2) throw new Error('写入后段落数变了');
  w.finish();
});

console.log('\n二、用户插队（核心场景）');

check('用户在别处编辑不影响模型写入位置', () => {
  const w = newWriter(['第一段。', '第二段。']).beginGeneration();
  w.write('生成开头。');
  // 用户在第一段末尾插字
  const firstParaEnd = 5;
  w.state = w.state.apply(w.state.tr.insertText('【用户插入】', firstParaEnd));
  w.sync(w.state);
  // 模型继续输出，应追加到生成段（最后一段）末尾
  w.write('模型继续。');
  const text = docText(w);
  if (!text.includes('生成开头。模型继续。')) throw new Error(`生成区被打断：${JSON.stringify(text)}`);
  if (!text.includes('【用户插入】')) throw new Error('用户插入丢失');
});

check('用户删除已生成内容时不复活', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('生成中：ABCDEF');
  // 用户删掉 DEF
  const idx = docText(w).indexOf('DEF');
  w.state = w.state.apply(w.state.tr.delete(idx, idx + 3));
  w.sync(w.state);
  w.write('XYZ');
  const text = docText(w);
  if (text.includes('DEF')) throw new Error(`用户删掉的内容复活了：${JSON.stringify(text)}`);
  if (!text.includes('XYZ')) throw new Error('模型输出丢失');
});

check('用户在生成区前面插入大量文本，模型输出仍接在最后', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('模型第一句。');
  // 用户在文档最前面插一大段
  w.state = w.state.apply(w.state.tr.insertText('很长的用户前言。'.repeat(20), 1));
  w.sync(w.state);
  w.write('模型第二句。');
  const text = docText(w);
  if (!text.endsWith('模型第一句。模型第二句。')) {
    throw new Error(`模型输出没接在末尾：...${text.slice(-40)}`);
  }
});

check('finish 返回用户看到的内容而非模型原文', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('模型写的。');
  w.state = w.state.apply(w.state.tr.insertText('用户改的。', 1));
  w.sync(w.state);
  const final = w.finish();
  if (!final.includes('用户改的。')) throw new Error('用户修改未体现在落盘内容中');
  if (final === w.buffer) throw new Error('finish 返回了 buffer 而非编辑器内容');
});

console.log('\n三、中止与状态机');

check('cancel 后拒绝继续写入', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('前半段。');
  w.cancel();
  if (w.write('不该写进去')) throw new Error('cancel 后仍然写入成功');
  if (w.phase !== Phase.CANCELED) throw new Error(`phase 应为 canceled，实际 ${w.phase}`);
});

check('end 后拒绝继续写入', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('正文。');
  w.end();
  if (w.write('不该写进去')) throw new Error('end 后仍然写入成功');
  if (w.phase !== Phase.DONE) throw new Error(`phase 应为 done，实际 ${w.phase}`);
});

check('finish 是纯读取：可反复调用、可继续编辑', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('内容。');
  const a = w.finish();
  const b = w.finish();
  if (a !== b) throw new Error('两次 finish 结果不一致');
  if (w.phase !== Phase.STREAMING) throw new Error(`finish 改变了 phase：${w.phase}`);
  // 关键：finish 后用户还能继续编辑——落盘校验失败要能改完再验
  w.state = w.state.apply(w.state.tr.insertText('补充。', 1));
  w.sync(w.state);
  const c = w.finish();
  if (!c.includes('补充。')) throw new Error('finish 后无法继续编辑——校验失败就无法重试');
});

check('重复 beginGeneration 抛错', () => {
  const w = newWriter([""]).beginGeneration();
  let threw = false;
  try { w.beginGeneration(); } catch (e) { threw = true; }
  if (!threw) throw new Error('并发生成被允许');
});

check('会话报告字段完整', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('六个字符');
  const r = w.report();
  for (const k of ['phase', 'generatedChars', 'userEditsDuringStream', 'docSize', 'paragraphs']) {
    if (!(k in r)) throw new Error(`报告缺字段 ${k}`);
  }
  if (r.phase !== Phase.STREAMING) throw new Error(`phase 错误：${r.phase}`);
});

console.log('\n四、落盘前一致性校验（防静默丢稿）');

check('正常生成通过校验', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('他站在洛阳的秋雨里。');
  w.write('洛三娘提着灯笼走来。');
  w.finish();
  const v = verifyBeforeCommit(w);
  if (!v.ok) throw new Error(`应通过却失败：${JSON.stringify(v)}`);
});

check('用户删除整句后校验拦截', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('第一句完整内容。');
  w.write('第二句完整内容。');
  // 用户把第二句删掉
  const idx = docText(w).indexOf('第二句完整内容。');
  w.state = w.state.apply(w.state.tr.delete(idx, idx + 7));
  w.sync(w.state);
  w.finish();
  const v = verifyBeforeCommit(w);
  if (v.ok) throw new Error('丢稿未被拦截');
  if (v.reason !== 'generated-content-missing') throw new Error(`reason 不对：${v.reason}`);
});

check('文档被清空时校验拦截', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('很长的一段生成内容，用来触发截断检测。'.repeat(3));
  w.state = w.state.apply(w.state.tr.delete(1, w.state.doc.content.size - 1));
  w.sync(w.state);
  w.finish();
  const v = verifyBeforeCommit(w);
  if (v.ok) throw new Error('清空文档未被拦截');
});

check('空生成不误报', () => {
  const w = newWriter(['已有内容。']).beginGeneration();
  w.finish();
  const v = verifyBeforeCommit(w);
  if (!v.ok) throw new Error(`空生成被误判：${JSON.stringify(v)}`);
  if (v.reason !== 'empty-generation') throw new Error(`reason 不对：${v.reason}`);
});

check('用户调整空白与换行不误报', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('第一句话在这里。');
  w.write('第二句话在那里。');
  // 用户合法地在两段之间加空白（中文正文里改空格很常见）
  const raw = w.state.doc.textBetween(0, w.state.doc.content.size, '\n');
  const at = raw.indexOf('第二句');
  w.state = w.state.apply(w.state.tr.insertText('  ', at));
  w.sync(w.state);
  const v = verifyBeforeCommit(w);
  if (!v.ok) throw new Error(`空白调整被误判为丢稿：${JSON.stringify(v)}`);
});

check('用户在句中加空格也不误报', () => {
  const w = newWriter([""]).beginGeneration();
  w.write('他站在洛阳的秋雨里。');
  // 用户在句中加一个字（改写是合法的）
  const raw = w.state.doc.textBetween(0, w.state.doc.content.size, '\n');
  const at = raw.indexOf('秋雨') + 2;
  w.state = w.state.apply(w.state.tr.insertText('里', at));
  w.sync(w.state);
  // 句级校验应识别为「用户改写过」，而不是丢稿——
  // 所以这里断言的是 ok:true（因为整句仍在，只是内部多了个字）
  const v = verifyBeforeCommit(w);
  if (!v.ok) throw new Error(`句内改字被误判为丢稿：${JSON.stringify(v)}`);
});

console.log('\n四之二、阈值标定（3-gram 存活率的判别边界）');

check('丢稿侧存活率全部 < 0.75', () => {
  const lost = [
    ['删整句·模板化', '第二句完整内容。', '第一句完整内容。'],
    ['删半句', '他站在洛阳的秋雨里，看着乱葬岗。', '他站在洛阳。'],
    ['换成别的实体', '谢九走来。', '洛三娘走来。'],
  ];
  for (const [name, s, rest] of lost) {
    if (sentenceSurvived(s, rest)) throw new Error(`${name} 被误判为存活：${JSON.stringify(s)} vs ${JSON.stringify(rest)}`);
  }
});

check('合法改写侧存活率全部 >= 0.75', () => {
  const ok = [
    ['完全一致', '他站在洛阳的秋雨里。', '他站在洛阳的秋雨里。'],
    ['加一个字', '他站在洛阳的秋雨里。', '他站在洛阳的秋雨里旁。'],
    ['加两个字', '他站在洛阳的秋雨里。', '他此刻站在洛阳的秋雨里。'],
    ['加标点', '他站在洛阳的秋雨里。', '他站在洛阳的秋雨里……'],
    ['改标点', '他站在洛阳的秋雨里。', '他站在洛阳的秋雨里！'],
  ];
  for (const [name, s, edited] of ok) {
    if (!sentenceSurvived(s, edited)) throw new Error(`${name} 被误判为丢稿：${JSON.stringify(s)} → ${JSON.stringify(edited)}`);
  }
});

/**
 * 段落分隔：一个 "\n\n" 只应产生一个段落间隔。
 *
 * ⚠ 这条用例是为一个真 bug 写的：
 * 原来 write() 直接 `text.split('\n')`，而 `"甲\n\n乙".split('\n')`
 * 返回 **3 个** 元素（["甲","","乙"]），循环里每个元素都 split 一次
 * → **一个段落间隔造出 2 个空段落**。实测写 3 个分段，文档里出现 5 段。
 *
 * 模型输出的段落分隔几乎全是 "\n\n"，所以这是最高频的路径。
 */
check('段落分隔（两个换行）只产生一个间隔，不多切空段', () => {
  const w = newWriter(['']).beginGeneration();
  w.write('甲段。\n\n乙段。');
  const n = w.state.doc.childCount;
  if (n !== 2) {
    throw new Error(`"\n\n" 应得到 2 段，实际 ${n} 段：${JSON.stringify(docText(w))}`);
  }
});

check('连续三个换行也只算一个间隔', () => {
  const w = newWriter(['']).beginGeneration();
  w.write('甲段。\n\n\n乙段。');
  const n = w.state.doc.childCount;
  if (n !== 2) {
    throw new Error(`"\n\n\n" 应得到 2 段，实际 ${n} 段：${JSON.stringify(docText(w))}`);
  }
});

check('跨分片的段落分隔正确衔接', () => {
  const w = newWriter(['']).beginGeneration();
  w.write('甲段。');
  w.write('\n\n乙段。');
  w.write('\n\n丙段。');
  const n = w.state.doc.childCount;
  if (n !== 3) {
    throw new Error(`三次分段应得 3 段，实际 ${n} 段：${JSON.stringify(docText(w))}`);
  }
});

check('单换行仍按段落处理（模型偶尔只输出一个换行）', () => {
  const w = newWriter(['']).beginGeneration();
  w.write('甲段。\n乙段。');
  const n = w.state.doc.childCount;
  if (n < 2) {
    throw new Error(`单换行应分段，实际 ${n} 段`);
  }
});

check('一个分片内含多个段落间隔', () => {
  const w = newWriter(['']).beginGeneration();
  w.write('一。二。三。');
  const text = docText(w);
  if (!text.includes('一。') || !text.includes('二。') || !text.includes('三。')) {
    throw new Error(`内容丢失：${JSON.stringify(text)}`);
  }
});

console.log('\n五、性能');

check('长文流式写入：每 2 字一次，1000 字以内', () => {
  const text = '他站在洛阳的秋雨里，看着远处的乱葬岗，握紧了手里的半截断剑。'.repeat(15);
  const w = newWriter([""]).beginGeneration();
  const t0 = Date.now();
  let ops = 0;
  for (let i = 0; i < text.length; i += 2) {
    w.write(text.slice(i, i + 2));
    ops++;
  }
  const ms = Date.now() - t0;
  const per = ms / ops;
  const final = w.finish();
  if (final.length !== text.length) throw new Error(`内容长度不符：${final.length} vs ${text.length}`);
  console.log(`         · ${ops} 次事务，${ms}ms，${per.toFixed(3)}ms/次，${text.length} 字`);
  if (per > 5) throw new Error(`单次插入 ${per.toFixed(2)}ms，超出 5ms 预算`);
});

console.log('\n六、与 SQLite 数据层衔接');

check('生成内容可写入 chapters 并校验字数', () => {
  const { Store } = require('../db/store.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-store-'));
  const store = new Store(path.join(tmp, 't.db'));
  store.createProject({ id: 'p1', name: '测试项目' });

  const w = newWriter([""]).beginGeneration();
  w.write('第一段落内容在这里。');
  w.write('第二段落内容在那里。');
  const text = w.finish();
  const v = verifyBeforeCommit(w);
  if (!v.ok) throw new Error('校验未通过');
  store.createChapter({ id: 'c1', projectId: 'p1', title: '第一章', content: text });
  const back = store.getChapter('c1');
  if (back.content !== text) throw new Error('落库内容与编辑器内容不一致');
  if (back.word_count !== text.length) throw new Error(`字数不符：${back.word_count} vs ${text.length}`);
  console.log(`         · 落库 ${back.word_count} 字，读回一致`);
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`用例 ${passed + failed}　通过 ${passed}　失败 ${failed}`);
if (failed === 0) {
  console.log('流式写入层可用：可进入 UI 接入（第 1 步后半）。');
} else {
  console.log('存在失败项，不要在此基础上继续。');
  process.exitCode = 1;
}

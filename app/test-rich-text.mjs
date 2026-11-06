/**
 * 判据：消息正文的标记解析（纯逻辑，不需要 Electron）。
 *
 * 运行：node test-rich-text.mjs
 *
 * ## 在防什么
 *
 * 1. **星号/反引号不能被漏到界面上** —— 模型极爱用 `**加粗**` 和 `` `路径` ``，
 *    漏一个就是"这软件连 markdown 都不认"。
 * 2. **重点句必须被单独识别出来** —— 羽毛菌要的是"重点的字放大"，
 *    如果 `**xxxx**` 被当成普通行内加粗，字就不会变大，需求等于没做。
 * 3. **不能误伤**：`**结构**：9 节…` 这种行内加粗如果被当成重点句，
 *    整行都会放大成标题，节奏全乱。
 */
import { parseLine, parseText, KEY_LINE } from './src/rich-text.mjs';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ✓', name);
  } catch (e) {
    fails.push(name);
    console.log('  ✗', name, '\n     ', e.message);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || ''} 实际 ${JSON.stringify(a)}`);

console.log('正文标记解析');

console.log('\n=== 一、整行加粗 → 重点句 ===');
t('「**三个待你拍板的点**：」是重点句，冒号保留', () => {
  const r = parseLine('**三个待你拍板的点，我按括号里的默认写了**：');
  eq(r.type, 'key', '类型');
  eq(r.text, '三个待你拍板的点，我按括号里的默认写了：');
});
t('不带冒号的整行加粗也是重点句', () => {
  const r = parseLine('**本章要点**');
  eq(r, { type: 'key', text: '本章要点' });
});
t('前后有空格也认', () => {
  eq(parseLine('   **要点**   '), { type: 'key', text: '要点' });
});
t('★ 行内加粗**不能**被当成重点句（否则整行会被放大成标题）', () => {
  const r = parseLine('**结构**：9 节，约 11900 字。');
  eq(r.type, 'text', '类型');
  eq(r.parts[0], { kind: 'bold', text: '结构' }, '第一段应是加粗');
  assert(r.parts.some((p) => p.kind === 'text' && p.text.includes('9 节')), '后半句丢了');
});
t('两处加粗中间夹字 → 仍是行内', () => {
  eq(parseLine('**甲**和**乙**').type, 'text', '类型');
});

console.log('\n=== 二、行内标记 ===');
t('行内加粗取掉星号', () => {
  const r = parseLine('默认**不原谅**、无复合暗示');
  eq(r.parts.filter((p) => p.kind === 'bold').map((p) => p.text), ['不原谅']);
  assert(!JSON.stringify(r).includes('**'), '还留着星号');
});
t('行内代码取掉反引号', () => {
  const r = parseLine('参考 `设定/世界观.md` 那套底色');
  const code = r.parts.find((p) => p.kind === 'code');
  assert(code, '没识别出代码');
  eq(code.text, '设定/世界观.md');
  assert(!JSON.stringify(r.parts).includes('`'), '还留着反引号');
});
t('一行里同时有加粗和代码', () => {
  const r = parseLine('**结论** 见 `剧集/EP001/分镜.md`');
  eq(r.parts.map((p) => p.kind), ['bold', 'text', 'code']);
});
t('纯文本不产生任何标记', () => {
  const r = parseLine('山门前的雪下了整整三日。');
  eq(r.parts, [{ kind: 'text', text: '山门前的雪下了整整三日。' }]);
});
t('单个星号不当标记（`5 * 3` 这种不能炸）', () => {
  const r = parseLine('算一下 5 * 3 = 15');
  eq(r.parts.length, 1, '不该被拆开');
});
/**
 * ⚠ 已知限制，不当成"通过"来粉饰：
 *   三个反引号的代码围栏**不渲染成代码块**（这套解析只服务小说对话，
 *   围栏几乎不出现，为它加一套 pre 渲染不划算）。
 *   但底线是**不能吞字** —— 内容丢了就是数据损坏，比样式不对严重得多。
 */
t('三反引号（代码围栏）不吞内容（只是不渲染成代码块）', () => {
  const r = parseLine('```js 一段代码 ```');
  const txt = r.parts.map((p) => p.text).join('');
  assert(txt.includes('一段代码'), `内容丢了：${txt}`);
});
t('空字符串安全', () => {
  eq(parseLine('').type, 'text');
  eq(parseLine(null).parts, [{ kind: 'text', text: '' }]);
});

console.log('\n=== 三、整段：空行必须保留 ===');
t('两段之间有空行 → 产生 blank', () => {
  const r = parseText('第一段\n\n第二段');
  eq(r.map((x) => x.type), ['text', 'blank', 'text']);
});
t('单换行不产生 blank', () => {
  eq(parseText('甲\n乙').map((x) => x.type), ['text', 'text']);
});
t('首尾空行也保留（模型常以空行开头）', () => {
  eq(parseText('\n甲\n').map((x) => x.type), ['blank', 'text', 'blank']);
});

console.log('\n=== 四、真实片段回归（贴的是羽毛菌截图里的原文） ===');
const REAL = [
  '**三个待你拍板的点，我按括号里的默认写了**：',
  '',
  '1. **结局走向** —— 默认不原谅、无复合暗示。想要 HE 或开放式（信拆开了）说一声。',
  '2. **平台基调** —— 默认按未定处理（`###1.` 加短段）。',
].join('\n');
t('★ 整段解析后没有任何 ** 或反引号漏出', () => {
  const parsed = parseText(REAL);
  const flat = JSON.stringify(parsed);
  // ⚠ 只看解析出来的**文本内容**，不看 JSON 的键名。
  //   blank 行没有 parts（它就是"空一行"），别漏了这个分支 —— 第一版在这里崩过。
  const texts = parsed
    .flatMap((x) => (x.type === 'key' ? [x.text] : x.type === 'blank' ? [] : x.parts.map((p) => p.text)))
    .join('');
  assert(!texts.includes('**'), `还残留 **：${texts.slice(0, 80)}`);
  assert(!texts.includes('`'), `还残留反引号：${texts.slice(0, 80)}`);
  assert(flat.includes('三个待你拍板的点'), '内容丢了');
});
t('第一行是重点句、第 3 行（列表项）不是', () => {
  const parsed = parseText(REAL);
  eq(parsed[0].type, 'key', '第一行');
  eq(parsed[2].type, 'text', '列表项');
  assert(parsed[2].parts.some((p) => p.kind === 'bold'), '列表项里的加粗丢了');
});

t('KEY_LINE 正则对外可见（样式与解析用同一份规则）', () => {
  assert(KEY_LINE instanceof RegExp, 'KEY_LINE 不是正则');
});

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗', f));
  process.exitCode = 1;
}

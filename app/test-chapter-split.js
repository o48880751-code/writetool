/**
 * 分章逻辑的判据（2026-10-28）。
 *
 * 运行：node test-chapter-split.js
 *
 * ⚠ 分章错了不会报错，只会"拆出来的东西不对" —— 用户看到的是一份
 *   莫名其妙的报告，而根因在几百行以前。所以这里判的是**边界**，
 *   不是"能不能跑"。
 */

const assert = require('node:assert');
const { splitChapters, isTitleLine } = require('./electron/chapter-split.js');

let pass = 0;
let fail = 0;
const pending = [];

function check(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        pass += 1;
        console.log(`  ✓ ${name}`);
      })
      .catch((e) => {
        fail += 1;
        console.log(`  ✗ ${name}`);
        console.log(`      ${e.message}`);
      })
  );
}

// ---------------------------------------------------------------- 标题识别

check('中文数字标题', () => {
  assert.ok(isTitleLine('第一章'));
  assert.ok(isTitleLine('第十二章 风起'));
  assert.ok(isTitleLine('第一百零八章 归途'));
});

check('阿拉伯数字标题', () => {
  assert.ok(isTitleLine('第1章'));
  assert.ok(isTitleLine('第 12 章 出发'));
  assert.ok(isTitleLine('第３章'));           // 全角数字
});

check('序章类标题', () => {
  assert.ok(isTitleLine('序章'));
  assert.ok(isTitleLine('楔子'));
  assert.ok(isTitleLine('番外 三年后'));
  assert.ok(isTitleLine('尾声'));
});

check('英文标题', () => {
  assert.ok(isTitleLine('CHAPTER 1'));
  assert.ok(isTitleLine('Chapter 12: The End'));
});

check('★★ 正文里的"第三章"不能被当成标题', () => {
  // 这是分章最典型的误判：正文里提到别的章节
  assert.ok(!isTitleLine('第三章讲的是他小时候的事，那时候他还不知道。'));
  assert.ok(!isTitleLine('他在第三章里见过这个人。'));
});

check('★ 普通短句不是标题', () => {
  assert.ok(!isTitleLine('他走了。'));
  assert.ok(!isTitleLine(''));
  assert.ok(!isTitleLine('   '));
});

check('★ 超长行不是标题（防正文长行误匹配）', () => {
  const long = '第1章' + '很长的内容'.repeat(20);
  assert.ok(!isTitleLine(long), '超过 60 字的行不该被当标题');
});

// ---------------------------------------------------------------- 切分结果

check('★★ 切出来的位置能把原文原样取回来', () => {
  const text = [
    '第一章 开始',
    '他说了一句话。',
    '',
    '第二章 继续',
    '她又说了一句话。',
    '',
    '第三章 结束',
    '故事完了。',
  ].join('\n');

  const { chapters } = splitChapters(text);
  assert.strictEqual(chapters.length, 3, `应当切出 3 章，实际 ${chapters.length}`);

  // 每章的 slice 结果必须落在原文里、且包含该章标题
  chapters.forEach((c) => {
    const body = text.slice(c.start, c.end);
    assert.ok(body.includes(c.title), `第 ${c.index} 章的切片里没有标题`);
    assert.strictEqual(body.length, c.chars, 'chars 与切片长度不一致');
  });

  assert.ok(text.slice(chapters[0].start, chapters[0].end).includes('他说了一句话'));
  assert.ok(text.slice(chapters[2].start, chapters[2].end).includes('故事完了'));
});

check('★★ Windows 换行（CRLF）也能正确切', () => {
  const text = '第一章 甲\r\n内容一\r\n第二章 乙\r\n内容二';
  const { chapters } = splitChapters(text);
  assert.strictEqual(chapters.length, 2, `CRLF 下应当 2 章，实际 ${chapters.length}`);
  assert.strictEqual(chapters[0].title, '第一章 甲', '标题里不该带 \\r');
  assert.ok(text.slice(chapters[1].start, chapters[1].end).includes('内容二'));
});

check('★ 完全没有标题时整本算一章', () => {
  const text = '这是一段没有任何章节标记的正文。'.repeat(100);
  const { chapters } = splitChapters(text);
  assert.strictEqual(chapters.length, 1);
  assert.strictEqual(chapters[0].title, '（未识别到章节）');
  assert.strictEqual(chapters[0].chars, text.length);
});

check('★ 开头有大段无标题内容时标出前言', () => {
  const text = '书名：某本书\n作者：某人\n简介：' + '很长'.repeat(200) + '\n第一章 开始\n内容';
  const { chapters, hasPreamble } = splitChapters(text);
  assert.strictEqual(chapters.length, 1);
  assert.strictEqual(hasPreamble, true, '第一个标题前超过 200 字，应当标出前言');
});

check('★ 开头只有几行书名时不算前言', () => {
  const text = '书名\n作者\n第一章 开始\n内容';
  const { hasPreamble } = splitChapters(text);
  assert.strictEqual(hasPreamble, false, '只有几行字不该标成前言');
});

check('★ 空输入不抛异常', () => {
  assert.deepStrictEqual(splitChapters('').chapters, []);
  assert.deepStrictEqual(splitChapters(null).chapters, []);
  assert.deepStrictEqual(splitChapters(undefined).chapters, []);
});

check('★ 章节顺序与字数统计正确', () => {
  const text = '第一章\n' + 'a'.repeat(100) + '\n第二章\n' + 'b'.repeat(50);
  const { chapters } = splitChapters(text);
  assert.strictEqual(chapters[0].index, 0);
  assert.strictEqual(chapters[1].index, 1);
  assert.ok(chapters[0].chars > 100, '第一章应当包含标题行 + 100 字');
  assert.ok(chapters[1].chars > 50);
  // 两章长度之和 = 全文（没有丢字符）
  assert.strictEqual(chapters[0].chars + chapters[1].chars, text.length);
});

// ---------------------------------------------------------------- 汇总

Promise.all(pending).then(() => {
  console.log(`\n分章逻辑：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});

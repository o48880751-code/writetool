/**
 * 判据：启动页诗句清单（2026-11-03）。
 *
 * ## 为什么"只是几句诗"也要判据
 *
 * 这份清单会被**每一次启动**展示，它的错误率不是零星的：
 *   · 出处写错 → 用户一眼看出来，信任直接掉一档；
 *   · 同一篇引两次 → 随机了十次撞见三次，像是"只有几首"；
 *   · 混进还在版权期的诗人 → 静默的法律风险，没人会发现。
 *
 * ⚠⚠ 判据**抓不到"引文与原文是否一致"**。这条只能靠人对着原文核。
 *   所以这里只敢断言那些机器能确定的事（字段、长度、重复、边界、版权白名单），
 *   不写"看起来像古诗"这种假判据。
 *
 * 运行：node test-poem.js
 */

const assert = require('node:assert');
const { LINES, pickLine } = require('./electron/poem-lines.js');

const CHECKS = [];
function t(name, fn) {
  try {
    fn();
    CHECKS.push({ name, pass: true });
    console.log('  ✓', name);
  } catch (e) {
    CHECKS.push({ name, pass: false });
    console.log('  ✗', name, '\n     ', e.message);
  }
}

console.log('=== 一、清单本身的完整度 ===');

t('条数 >= 40（太少就不叫"随机"了）', () => {
  assert(LINES.length >= 40, `只有 ${LINES.length} 条`);
});

t('每条都有 t / a / w 三个字段且非空', () => {
  LINES.forEach((l, i) => {
    for (const k of ['t', 'a', 'w']) {
      assert(typeof l[k] === 'string' && l[k].trim(), `第 ${i + 1} 条缺 ${k}`);
    }
  });
});

t('诗句不含换行（启动页只有两行的位置）', () => {
  LINES.forEach((l) => assert(!/[\r\n]/.test(l.t), `含换行：${l.t}`));
});

t('每句 <= 26 字（再长两行放不下，会被 line-clamp 吃掉）', () => {
  LINES.forEach((l) => {
    const n = [...l.t].length;
    assert(n <= 26, `${n} 字：${l.t}`);
  });
});

t('诗句不重复', () => {
  const seen = new Set();
  LINES.forEach((l) => {
    assert(!seen.has(l.t), `重复：${l.t}`);
    seen.add(l.t);
  });
});

t('同一篇作品不重复引用（否则随机几次就撞车）', () => {
  const seen = new Set();
  LINES.forEach((l) => {
    const key = `${l.a}·${l.w}`;
    assert(!seen.has(key), `重复引用：${key}（${l.t}）`);
    seen.add(key);
  });
});

t('现代作者只收公有领域那几位（去世满 50 年）', () => {
  /**
   * ⚠ 这条断言是**护栏**，不是洁癖：以后想加海子、顾城、张爱玲，
   *   必须先把他们加进白名单 —— 那一步会逼人想一次版权。
   *   中国著作权保护期是「作者终身 + 50 年」。
   */
  const PUBLIC_DOMAIN_MODERN = new Set(['徐志摩', '鲁迅', '戴望舒', '林徽因']);
  const CLASSICAL = new Set([
    '屈原', '佚名', '曹操', '李白', '杜甫', '王维', '王勃', '王之涣', '张若虚',
    '李商隐', '刘禹锡', '贾岛', '唐珙', '王湾', '苏轼', '陆游', '朱熹', '王安石',
    '柳永', '辛弃疾', '李清照', '黄庭坚', '文天祥', '翁森', '龚自珍', '曹雪芹', '郑燮',
  ]);
  LINES.forEach((l) => {
    assert(CLASSICAL.has(l.a) || PUBLIC_DOMAIN_MODERN.has(l.a),
      `「${l.a}」不在白名单里（新加作者要先确认版权）`);
  });
});

t('古典与现代都有（要求"古代至现代"）', () => {
  const modern = LINES.filter((l) => ['徐志摩', '鲁迅', '戴望舒', '林徽因'].includes(l.a));
  assert(modern.length >= 3, `现代只有 ${modern.length} 条`);
});

console.log('\n=== 二、随机函数的边界 ===');

t('rand=0 给第一条', () => {
  assert.strictEqual(pickLine(() => 0), LINES[0]);
});

t('rand 接近 1 给最后一条', () => {
  assert.strictEqual(pickLine(() => 0.999999), LINES[LINES.length - 1]);
});

t('rand 正好返回 1 也不会越界（返回最后一条，不是 undefined）', () => {
  const r = pickLine(() => 1);
  assert(r && r.t, '返回了 undefined');
  assert.strictEqual(r, LINES[LINES.length - 1]);
});

t('rand 返回 NaN 也不崩（退化成第一条）', () => {
  const r = pickLine(() => NaN);
  assert(r && r.t, '返回了 undefined');
});

t('不传随机源也能跑（默认 Math.random）', () => {
  const r = pickLine();
  assert(r && r.t, '返回了 undefined');
});

t('连抽 200 次都能拿到合法句子', () => {
  for (let i = 0; i < 200; i++) {
    const r = pickLine();
    assert(r && typeof r.t === 'string' && r.t.length > 0, `第 ${i} 次抽到空`);
  }
});

t('抽 500 次能覆盖到 10 条以上（不是永远同一句）', () => {
  const hit = new Set();
  for (let i = 0; i < 500; i++) hit.add(pickLine().t);
  assert(hit.size >= 10, `只覆盖了 ${hit.size} 条`);
});

const bad = CHECKS.filter((c) => !c.pass);
console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
console.log('\n⚠ 提示：出处与原文是否一致，机器判不了。改动清单后请对着原文核一遍。');
process.exit(bad.length ? 1 : 0);

/**
 * 判据：称呼体系（2026-11-03）。
 *
 * ## 为什么这个要单独测
 *
 * 称呼是**用户自己填的字符串**，而它会**原样进系统提示词**。
 * 一份没校验的输入意味着：
 *   · 用户填「干爹」，模型下次真的叫「干爹」—— 而这正是他明确禁止的；
 *   · 用户填一段指令（"忽略上面的规则"），等于把提示注入的口子开在设置页；
 *   · 填太长的话，提示词里那一行会被撑成一段，模型反而看不清规则。
 *
 * 所以这里既测"能不能拦住"，也测"放过去的那条到底长什么样"。
 *
 * 运行：node test-honorific.js
 */

const assert = require('node:assert');
const H = require('./electron/honorific.js');

const CHECKS = [];
function t(name, fn) {
  try { fn(); CHECKS.push({ name, pass: true }); console.log('  ✓', name); }
  catch (e) { CHECKS.push({ name, pass: false }); console.log('  ✗', name, '\n     ', e.message); }
}

console.log('=== 一、默认与合法值 ===');

t('空值 = 主笔（不是空字符串）', () => {
  assert.strictEqual(H.checkTitle('').title, '主笔');
  assert.strictEqual(H.checkTitle('   ').title, '主笔');
  assert.strictEqual(H.checkTitle(null).title, '主笔');
  assert.strictEqual(H.checkTitle(undefined).title, '主笔');
});

t('「卷主」能通过（用户点名的例子）', () => {
  const r = H.checkTitle('卷主');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, '卷主');
});

t('笔名能通过', () => {
  assert.strictEqual(H.checkTitle('羽某').title, '羽某');
  assert.strictEqual(H.checkTitle('沈砚').title, '沈砚');
});

t('英文/数字称谓能通过', () => {
  assert.strictEqual(H.checkTitle('Auteur').ok, true);
  assert.strictEqual(H.checkTitle('007').ok, true);
});

t('首尾空格会被去掉，中间连续空格压成一个', () => {
  assert.strictEqual(H.checkTitle('  主 笔  ').title, '主 笔');
});

t('8 个字能过，9 个字不能过', () => {
  assert.strictEqual(H.checkTitle('一二三四五六七八').ok, true);
  assert.strictEqual(H.checkTitle('一二三四五六七八九').ok, false);
});

console.log('\n=== 二、必须拦住的（羽毛菌点名的） ===');

const MUST_BLOCK = [
  ['爸爸', '亲属'], ['妈妈', '亲属'], ['爹', '亲属'], ['娘', '亲属'],
  ['叔叔', '亲属'], ['阿姨', '亲属'], ['舅舅', '亲属'], ['姑姑', '亲属'],
  ['义父', '拟制亲属'], ['干爹', '拟制亲属'], ['干妈', '拟制亲属'],
  ['儿子', '亲属'], ['老婆', '亲属'], ['宝贝', '亲密'],
  ['主人', '把人不当人'], ['主子', '把人不当人'], ['奴才', '把人不当人'],
  ['傻瓜', '侮辱'], ['废物', '侮辱'],
  ['daddy', '英文亲属'], ['master', '英文主仆'],
];
for (const [w, why] of MUST_BLOCK) {
  t(`拦住「${w}」（${why}）`, () => {
    const r = H.checkTitle(w);
    assert.strictEqual(r.ok, false, `「${w}」居然通过了`);
    assert(r.reason && r.reason.length > 0, '拦了但没给原因 —— 用户不知道为什么');
  });
}

t('被拦时不改写用户的输入（原样返回，方便他改）', () => {
  const r = H.checkTitle(' 干爹 ');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.title, '干爹');
});

console.log('\n=== 三、不该误伤的 ===');

const MUST_PASS = ['主笔', '执笔人', '卷主', '作者', '阁下', '老师', '写手', '老板'];
for (const w of MUST_PASS) {
  t(`「${w}」不被拦（不是亲属也不是侮辱）`, () => {
    // ⚠ 「老板」现在只是普通称谓，不再是默认值 —— 用户愿意这么叫就叫
    assert.strictEqual(H.checkTitle(w).ok, true, `「${w}」被误拦了`);
  });
}

t('纯标点拦掉（否则提示词里会出现一个「。」）', () => {
  assert.strictEqual(H.checkTitle('。。。').ok, false);
});

console.log('\n=== 四、生成的提示词长什么样 ===');

const rules = H.addressRules();
t('默认段落里写「主笔」', () => assert(rules.includes('主笔'), rules.slice(0, 80)));
t('默认段落里写「执笔人」（正式文书）', () => assert(rules.includes('执笔人')));
t('段落里写明助手叫「拾墨」', () => assert(rules.includes('拾墨')));
t('**不再出现「老板」**（默认值已换掉，残留就是没改干净）',
  () => assert(!rules.includes('老板'), '还留着「老板」'));
t('亲属/主仆/侮辱三类都点名了', () => {
  assert(rules.includes('义父') && rules.includes('干爹'));
  assert(rules.includes('主人') && rules.includes('奴才'));
  assert(rules.includes('侮辱'));
});

const custom = H.addressRules('卷主');
t('自定义称谓会进提示词', () => assert(custom.includes('卷主'), custom.slice(0, 80)));
t('自定义时不再出现默认的「主笔」', () => assert(!custom.includes('主笔')));
t('正式文书那一句仍然固定为「执笔人」（不跟随自定义）', () => {
  assert(custom.includes('执笔人'), '正式文书的人称丢了');
});

t('非法称谓进 addressRules 会自动退回默认（不会把「干爹」写进提示词）', () => {
  /**
   * ⚠ 不能直接断言 `!addressRules('干爹').includes('干爹')` ——
   *   禁用清单那一段**本来就举了「干爹」这个例子**，那是说明文字，不是称呼。
   *   要钉的是**称呼那一行**：它必须是「主笔」。
   */
  const bad = H.addressRules('干爹');
  const line = bad.split('\n').find((l) => l.includes('对话里称用户为'));
  assert(!!line, '找不到「称呼用户」那一行，段落结构变了');
  assert(line.includes('主笔'), `称呼行没有退回默认：${line}`);
  assert(!line.includes('干爹'), `非法称谓被写进了称呼行：${line}`);
});

t('提示词里带了「正文里的称谓照写不误」这条（否则正文会被管死）', () => {
  assert(/人物/.test(rules) && /照写不误/.test(rules));
});

const bad = CHECKS.filter((c) => !c.pass);
console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
process.exit(bad.length ? 1 : 0);

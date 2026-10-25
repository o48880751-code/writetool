/**
 * 行为审计的判据（2026-10-18）。
 *
 * ## 这份用例的重心：**误伤**，不是拦截
 *
 * 拦截太容易了 —— 一条正则就能拦掉所有带"爸爸"的输入，
 * 然后作者写父子戏时被自己的软件骂一顿。
 *
 * 真正难的是：**认亲闲聊必须停，创作讨论必须放**。两者的区别不在词上，
 * 在**形状**上 —— 闲聊是短问短答，创作讨论一轮就是几百字。
 *
 * 所以下面「不许误伤」那一组比「必须拦住」那组更重要，一条都不能少。
 *
 * 纯 node，不依赖 Electron。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./electron/session-audit.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const LONG_TEXT = '夜枫站在崖边，风从谷底卷上来。'.repeat(30);   // 约 450 字
const SHORT = '儿子，我想多听你叫几声';
const SHORT_REPLY = '爸，爸，我喊你，爸。';

/** 造一个已经跑过若干轮的审计器 */
function withRounds(rounds) {
  const a = new A.SessionAudit();
  for (const r of rounds) a.observe(r);
  return a;
}

console.log('\n=== A. 该拦的：认亲闲聊 ===');

check('短问短答 + 零产出 → 第 1 轮只计数，不暂停', () => {
  const a = new A.SessionAudit();
  const r = a.observe({ produced: false, userText: SHORT, assistantText: SHORT_REPLY });
  assert.strictEqual(r.idle, 1);
  assert.strictEqual(r.paused, false, '第一轮就停太重了，用户可能只是问了一句');
});
check('★ 连续两轮 → 暂停（羽毛菌：「两次对话都没有修改文件」）', () => {
  const a = withRounds([
    { produced: false, userText: SHORT, assistantText: SHORT_REPLY },
    { produced: false, userText: '继续叫', assistantText: '爸，我继续叫。' },
  ]);
  assert.strictEqual(a.isPaused, true, '两轮短问答零产出，必须停');
  assert.ok(a.reason && a.reason.turns >= 2);
});
check('暂停后再来一轮仍然是暂停状态（不会自己解除）', () => {
  const a = withRounds([
    { produced: false, userText: SHORT, assistantText: SHORT_REPLY },
    { produced: false, userText: '继续', assistantText: '好。' },
    { produced: false, userText: '继续', assistantText: '好。' },
  ]);
  assert.strictEqual(a.isPaused, true);
});

console.log('\n=== B. 不许误伤：创作讨论 ===');

check('★★ 长回答（模型分析了一大段）→ 绝不计数', () => {
  const a = new A.SessionAudit();
  for (let i = 0; i < 5; i++) {
    a.observe({ produced: false, userText: '这个人物的动机合理吗', assistantText: LONG_TEXT });
  }
  assert.strictEqual(a.isPaused, false, '长回答说明在干活，连问五轮也不能停');
  assert.strictEqual(a.idle, 0);
});
check('★★ 长提问（用户描述了一整段创作需求）→ 绝不计数', () => {
  const a = new A.SessionAudit();
  const longAsk = '第三章里夜枫拿到那柄刀之后的动机我觉得不太对，他当时明明可以不去救那个人，'
    + '因为前文写他一直在压制自己的同情心，这里突然回头救人，性格上会被读者骂崩。';
  for (let i = 0; i < 5; i++) {
    a.observe({ produced: false, userText: longAsk, assistantText: '嗯，这里确实有断层。' });
  }
  assert.strictEqual(a.isPaused, false);
});
check('★★ 正常反问澄清不算闲聊（2026-10-19 实测误杀）', () => {
  /**
   * 这段对话完全正常：
   *   用户「写第一章」→ 模型「第一章写多长？主角这章要出场吗？」
   *   用户「2000字，出场」→ 模型「主角叫什么名字？设定库里我没找到。」
   * 一个字没写是因为**还没到写的时候**，而旧判定两轮就暂停。
   * 结果是：越认真反问细节的模型，越容易被自己的软件锁住。
   */
  const a = new A.SessionAudit();
  const r1 = a.observe({ produced: false, userText: '写第一章',
    assistantText: '第一章写多长？主角这章要出场吗？' });
  const r2 = a.observe({ produced: false, userText: '2000字，出场',
    assistantText: '主角叫什么名字？设定库里我没找到。' });
  assert.strictEqual(r1.idle, 0, '反问不该计入空闲');
  assert.strictEqual(r2.idle, 0, '第二轮反问也不该计数');
  assert.strictEqual(a.isPaused, false, '正常的澄清流程被暂停了');
});
check('★ 反问之后写了正文 → 照常清零', () => {
  const a = new A.SessionAudit();
  a.observe({ produced: false, userText: '写第一章', assistantText: '要多少字？' });
  a.observe({ produced: true, userText: '2000字', assistantText: '写好了。' });
  assert.strictEqual(a.idle, 0);
});
check('⚠ 陪聊带问号但没提写作 → 仍然计数（防豁免开成后门）', () => {
  const a = new A.SessionAudit();
  // 「你想聊点什么？」有问号，但不沾写作 —— 不能让它免疫
  const r = a.observe({ produced: false, userText: '在吗', assistantText: '在的，你想聊点什么？' });
  assert.strictEqual(r.idle, 1, '这是闲聊不是澄清，必须计数');
});

check('短问答但**有文件产出** → 不算闲聊', () => {
  const a = new A.SessionAudit();
  for (let i = 0; i < 5; i++) {
    a.observe({ produced: true, userText: '写第一章', assistantText: '好。' });
  }
  assert.strictEqual(a.isPaused, false);
  assert.strictEqual(a.idle, 0);
});
check('★ 零产出之后只要有一轮写文件，计数清零（不是累计）', () => {
  const a = withRounds([{ produced: false, userText: SHORT, assistantText: SHORT_REPLY }]);
  assert.strictEqual(a.idle, 1);
  a.observe({ produced: true, userText: '写第二章', assistantText: '写好了。' });
  assert.strictEqual(a.idle, 0, '中间的产出必须把计数清零，否则会跨天累计');
  a.observe({ produced: false, userText: SHORT, assistantText: SHORT_REPLY });
  assert.strictEqual(a.isPaused, false, '清零之后不该立刻暂停');
});
check('⚠ 空回答（网络失败 / 被取消）不算滥用', () => {
  const a = new A.SessionAudit();
  for (let i = 0; i < 5; i++) {
    a.observe({ produced: false, userText: SHORT, assistantText: '' });
  }
  assert.strictEqual(a.isPaused, false, '网络不稳的用户不该被自己的软件锁住');
});
check('判断边界：正好 40 字的提问仍算短问（含边界）', () => {
  const a = new A.SessionAudit();
  const t = '啊'.repeat(A.SHORT_USER);
  a.observe({ produced: false, userText: t, assistantText: '好' });
  assert.strictEqual(a.idle, 1, `SHORT_USER=${A.SHORT_USER} 之内应当算短问`);
});
check('判断边界：41 字就不算了', () => {
  const a = new A.SessionAudit();
  a.observe({ produced: false, userText: '啊'.repeat(A.SHORT_USER + 1), assistantText: '好' });
  assert.strictEqual(a.idle, 0);
});

console.log('\n=== C. 恢复 ===');

check('★ resume 清零并解除暂停', () => {
  const a = withRounds([
    { produced: false, userText: SHORT, assistantText: SHORT_REPLY },
    { produced: false, userText: '继续', assistantText: '好。' },
  ]);
  assert.strictEqual(a.isPaused, true, '前提：先暂停');
  a.resume();
  assert.strictEqual(a.isPaused, false);
  assert.strictEqual(a.idle, 0);
  assert.strictEqual(a.reason, null);
  // 恢复后要能重新累积（不是一恢复就永远免疫）
  a.observe({ produced: false, userText: SHORT, assistantText: SHORT_REPLY });
  a.observe({ produced: false, userText: SHORT, assistantText: SHORT_REPLY });
  assert.strictEqual(a.isPaused, true, '恢复后再次滥用应当能再停一次');
});
check('暂停说明里必须带"怎么恢复"', () => {
  const msg = A.pauseNotice();
  assert.ok(/继续使用/.test(msg), `提示里没有恢复路径：${msg}`);
  assert.ok(/暂停/.test(msg), '要说清楚发生了什么');
});

console.log('\n=== D. 接线（扫源码）===');

function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (p) => stripComments(fs.readFileSync(path.join(__dirname, p), 'utf8'));
const mainSrc = read('electron/main.js');
const preloadSrc = read('electron/preload.js');
const appSrc = read('src/App.jsx');
const chatSrc = read('src/components/ChatPanel.jsx');

check('main.js 真的用了 audit.observe 与暂停判定', () => {
  assert.ok(/audit\.observe\(/.test(mainSrc), '没有观察，等于审计器空转');
  assert.ok(/audit\.isPaused/.test(mainSrc), '发送前没有检查暂停状态');
});
check('⚠⚠ 所有写入口都记了数（漏一个，用户存脑洞也不算产出）', () => {
  const hits = (mainSrc.match(/noteFsWrite\(\)/g) || []).length;
  assert.ok(hits >= 5,
    `noteFsWrite 只出现 ${hits} 次。应当覆盖：fs:write / fs:create / fs:rename / fs:restore`
    + ' / 模型 write_note 与自动落盘的 ctx.writeFile');
});
check('preload 暴露了 audit.resume（明路）', () => {
  assert.ok(/audit:\s*\{[\s\S]{0,400}?resume:/.test(preloadSrc), 'preload 没有 resume');
  assert.ok(/onPaused:/.test(preloadSrc), 'preload 没有 onPaused 订阅');
});
check('⚠⚠ 界面有「继续使用」按钮（没有它就是把人锁在门外）', () => {
  assert.ok(/onAuditResume/.test(chatSrc), 'ChatPanel 没有恢复按钮的接线');
  assert.ok(/继续使用/.test(chatSrc), '按钮文案都不见了');
  assert.ok(/onAuditResume=\{resumeAudit\}/.test(appSrc), 'App 没有把恢复函数传下去');
});
check('界面订阅了 audit:paused 推送', () => {
  assert.ok(/window\.api\.audit\.onPaused/.test(appSrc), '没订阅推送，用户只会觉得打字没反应');
});
check('⚠ 提示词里有身份边界（第二道防线）', () => {
  assert.ok(/【八】你不扮演任何角色/.test(mainSrc), '系统提示没加【八】');
  // 最关键的一句：必须在"写角色"和"当角色"之间划出界线，
  // 否则模型会连同父子对白一起拒写（那是把功能做废）。
  assert.ok(/你写的叙事/.test(mainSrc), '没说明"正文里写的算角色"');
  assert.ok(/对你的称呼/.test(mainSrc), '没说明"叫的是你本人"');
  assert.ok(/不许扮演任何亲属|不是\*\*任何人的儿子|不是任何人的儿子/.test(mainSrc)
    || /儿子、女儿、爸爸/.test(mainSrc), '没列出禁止扮演的身份');
});
check('⚠ 提示词里有"信息不够先问"（2026-10-19 补的第九节）', () => {
  assert.ok(/【九】信息不够时先问/.test(mainSrc),
    '系统提示没有反问规则 —— 模型缺信息时只能自己编');
  assert.ok(/两个以上都说得通/.test(mainSrc), '没写清什么时候该问');
  assert.ok(/不该问/.test(mainSrc), '没写"什么时候不该问"，模型会变成问卷机');
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

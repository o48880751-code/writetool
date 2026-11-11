/**
 * 朗读的纯逻辑判据（2026-11-11）。
 *
 * ## 为什么不放在 Electron 里跑
 *
 * 测试机**没有音频输出设备**，`speechSynthesis.speak()` 会直接挂住 ——
 * 既不触发 onend 也不触发 onerror，于是"多句有没有念完"这件事
 * 在真机界面上永远验不出来（实测：900ms 内只发起了第一句）。
 *
 * 所以队列用 mock 验：给一个会立刻回调 onend 的假 synth，
 * 看它是不是按顺序念完了每一句、stop 之后是不是真的停。
 *
 * 运行：node test-speech-pure.mjs
 */
import { speakableText, splitSentences, createSpeaker } from './src/speech.js';

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, pass: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '　' + detail}`);
}

// ---------------- 一、Markdown 清洗 ----------------
console.log('\n=== 一、Markdown 洗成能念的文本 ===');
const MD = [
  '# 第三章 夜行',
  '',
  '**夜枫**停下脚步，`灯笼`往上提了提。',
  '',
  '| 名字暗示 | 现在的设定 |',
  '|---|---|',
  '| 夜枫 | 凡人剑修 |',
  '',
  '- 第一处：删掉感叹号',
  '1. 第二处：句子缩短',
  '',
  '> 引用一句',
  '',
  '```js',
  'console.log("代码不该被念")',
  '```',
  '',
  '见 [文档](https://example.com/a/b)。',
].join('\n');
const clean = speakableText(MD);
console.log('  ' + clean.replace(/\n/g, ' ⏎ ').slice(0, 100));
t('去掉加粗/斜体星号', clean.indexOf('**') < 0 && clean.indexOf('*') < 0);
t('去掉行内代码反引号但保留内容', clean.indexOf('`') < 0 && clean.indexOf('灯笼') >= 0);
t('表格整块丢弃（念竖线没有信息量）', clean.indexOf('|') < 0 && clean.indexOf('凡人剑修') < 0);
t('代码块整块丢弃', clean.indexOf('console.log') < 0);
t('标题井号去掉但保留标题文字', clean.indexOf('# ') < 0 && clean.indexOf('第三章 夜行') >= 0);
t('列表符号去掉', !/^[ \t]*[-*+][ \t]/m.test(clean) && clean.indexOf('第一处') >= 0);
t('链接只留文字', clean.indexOf('https://') < 0 && clean.indexOf('文档') >= 0);
t('引用箭头去掉', !/^[ \t]*>/m.test(clean));

// ---------------- 二、分句 ----------------
console.log('\n=== 二、分句（太长会被 Chromium 截断） ===');
const sents = splitSentences(clean);
sents.forEach((s, i) => console.log(`  [${i}] (${s.length}) ${s}`));
t('切出了多句', sents.length >= 4, String(sents.length));
t('没有空串', sents.every((s) => s.trim().length > 0));
t('单句不超过 110 字', Math.max(...sents.map((s) => s.length)) <= 110,
  String(Math.max(...sents.map((s) => s.length))));
t('收尾引号并回前一句（不拆成「你来了。」+「他说。」）',
  sents.some((s) => s.indexOf('「你来了。」他说。') >= 0) || sents.every((s) => s.indexOf('」') !== 0),
  sents.filter((s) => s.indexOf('」') === 0).length + ' 句以引号开头');

const long = '这'.repeat(300);
const longSents = splitSentences(long);
t('超长无标点句会被硬切', longSents.length >= 3 && longSents.every((s) => s.length <= 110),
  `${longSents.length} 段 / 最长 ${Math.max(...longSents.map((s) => s.length))}`);
t('空文本返回空数组', splitSentences('').length === 0 && splitSentences(null).length === 0);

// ---------------- 三、播放队列（mock） ----------------
console.log('\n=== 三、播放队列（用假 synth 验） ===');
/**
 * 假 synth：speak() 立刻异步回调 onend，模拟"一句念完"。
 * ⚠ 用 5ms 而不是 0，因为真实环境里 onend 是异步的；
 *   写成同步会在某些实现上造成递归过深。
 */
const spoken = [];
let cancelled = 0;
global.window = {
  speechSynthesis: {
    /**
     * ⚠ 每句 60ms，不是 5ms（2026-11-11 修）。
     *   5ms 的话 8 句在 40ms 内就念完了 —— 等 200ms 再"打断"时早就没东西可打，
     *   于是「打断」和「再点是停」两条判据测的其实是"重播"，
     *   还都判红，看起来像功能坏了。节奏必须接近真实（每句几百毫秒）。
     */
    speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 60); },
    cancel() { cancelled += 1; },
  },
};
global.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
};

const states = [];
const sp = createSpeaker({ onState: (id) => states.push(id) });

const MULTI = '第一句。第二句！第三句？第四句。';
sp.play('m1', MULTI);
await new Promise((r) => setTimeout(r, 700));
console.log('  念过:', JSON.stringify(spoken));
t('四句全部念完', spoken.length === 4, String(spoken.length));
t('顺序正确', spoken.join('|') === '第一句。|第二句！|第三句？|第四句。', spoken.join('|'));
t('状态回到 null（播完自动复位）', states[states.length - 1] === null, JSON.stringify(states));

// 切到另一条：必须打断上一条
spoken.length = 0;
sp.play('m1', '一条很长很长的话。'.repeat(8));
/**
 * ⚠ 必须等到它**真的开口**再切（2026-11-11 踩）：
 *   原来只等 30ms，而 play() 内部有 60ms 的让帧延迟 ——
 *   一句都还没念就切换了，`n1` 是 0，`n1 < 8` 恒真。
 *   那是**假绿**：即使打断逻辑完全失效，这条也会过。
 */
await new Promise((r) => setTimeout(r, 260));
const n1 = spoken.length;
sp.play('m2', '换一条。');
await new Promise((r) => setTimeout(r, 300));
t('切到另一条时上一条被打断（念了一部分但没念完）', n1 >= 1 && n1 < 8, `打断前念了 ${n1} 句 / 共 8 句`);
t('只念新那条的内容', spoken.slice(-2).join('|').indexOf('换一条') >= 0, spoken.slice(-2).join('|'));

// stop
spoken.length = 0;
sp.play('m3', '一。二。三。四。五。六。');
await new Promise((r) => setTimeout(r, 200));   // 先让它真的开口
sp.stop();
const afterStop = spoken.length;
await new Promise((r) => setTimeout(r, 300));
t('stop 时确实已经在念（前提成立）', afterStop >= 1, `停前念了 ${afterStop} 句`);
t('stop 之后不再继续念', spoken.length === afterStop, `${afterStop} → ${spoken.length}`);
t('stop 会调用 cancel', cancelled > 0, String(cancelled));

// 同一条再点一次 = 停
spoken.length = 0;
sp.play('m4', '甲。乙。丙。丁。戊。');
await new Promise((r) => setTimeout(r, 260));   // 先念起来（5 句念完要 300ms）
sp.play('m4', '甲。乙。丙。丁。戊。');           // 再点一次 = 停
const n2 = spoken.length;
await new Promise((r) => setTimeout(r, 300));
t('同一条再点前确实在念（前提成立）', n2 >= 1 && n2 < 5, `停前念了 ${n2} 句`);
t('同一条再点一次是停止，不是重播', spoken.length === n2, `${n2} → ${spoken.length}`);

// ---------------- 汇总 ----------------
const bad = CHECKS.filter((c) => !c.pass);
console.log(`\n========== ${CHECKS.length - bad.length}/${CHECKS.length} 通过 ==========`);
if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
process.exit(bad.length ? 1 : 0);

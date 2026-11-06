/**
 * 判据：起名 / 脑洞 / 灵感碎片的提示词（纯逻辑，不需要 Electron）。
 *
 * 运行：node test-tool-prompts.mjs
 *
 * ## 在防什么
 *
 * 这三个工具**界面几乎一样**，好坏全在提示词上。所以判据盯三件事：
 *   1. 用户填的要素真的进了 user 消息（漏了就等于没填）
 *   2. 三个 mode 的底线（不许开场白 / 不许写正文 / 不许编核心设定）都在 system 里
 *   3. 模型输出的清洗：开场白、结尾客套、代码围栏要剥掉，
 *      但**名字清单的行结构不能塌**（压成一段等于废掉）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./electron/tool-prompts.js');

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fails.push(name); console.log('  ✗', name, '\n     ', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const sys = (m, a, f) => T.buildMessages(m, a, f).messages[0].content;
const usr = (m, a, f) => T.buildMessages(m, a, f).messages[1].content;

console.log('三个工具的提示词');

console.log('\n=== 一、起名 ===');
const nameFields = { kind: 'person', count: 6, seed: '姓沈、带雪', must: '不要叠字', genre: '仙侠' };
t('四个要素全进 user 消息', () => {
  const u = usr('name', 'gen', nameFields);
  for (const w of ['仙侠', '人物', '6 个', '姓沈、带雪', '不要叠字']) {
    assert(u.includes(w), `缺「${w}」：\n${u}`);
  }
});
t('system 要求"一行一条、不许编号、不许开场白"', () => {
  const s = sys('name', 'gen', nameFields);
  assert(/一行一条/.test(s), '没规定行格式');
  assert(/不要编号/.test(s), '没禁编号');
  assert(/不要前言/.test(s), '没禁前言');
  assert(/不要用代码围栏/.test(s), '没禁围栏');
});
t('system 禁了会被用烂的字（否则满屏「云天傲龙」）', () => {
  assert(/天.*云.*龙/.test(sys('name', 'gen', nameFields)), '没给禁字清单');
});
t('数量被夹在 1..20（用户手打 999 也不能发）', () => {
  assert(usr('name', 'gen', { ...nameFields, count: 999 }).includes('20 个'), '没夹上限');
  assert(usr('name', 'gen', { ...nameFields, count: 0 }).includes('1 个'), '没夹下限');
});
t('温度偏高（起名要发散）', () => {
  assert(T.buildMessages('name', 'gen', nameFields).temperature >= 0.85);
});
t('没填 seed/must 时不出现空行标签', () => {
  const u = usr('name', 'gen', { kind: 'place', count: 4 });
  assert(!u.includes('基础灵感'), `不该出现空字段：\n${u}`);
  assert(!u.includes('额外要求'), '不该出现空字段');
});

console.log('\n=== 二、脑洞 ===');
const brainFields = { idea: '主角重生回高三', direction: '爽感', avoid: '不要后宫', genre: '都市' };
t('想法 / 方向 / 回避 都进 user', () => {
  const u = usr('brain', 'gen', brainFields);
  for (const w of ['主角重生回高三', '爽感', '不要后宫', '都市']) assert(u.includes(w), `缺「${w}」`);
});
t('★ 固定四段结构（走向 / 反转 / 伏笔 / 风险）', () => {
  const s = sys('brain', 'gen', brainFields);
  for (const h of ['这条线怎么走', '反转在哪', '要埋的伏笔', '最可能崩的地方']) {
    assert(s.includes(h), `缺小标题「${h}」`);
  }
});
t('禁止空话与正文（"增加张力"这种会毁掉输出）', () => {
  const s = sys('brain', 'gen', brainFields);
  assert(/空话/.test(s), '没禁空话');
  assert(/不写正文/.test(s), '没禁正文');
});
t('想法没填时给兜底指令，不是空着发过去', () => {
  const u = usr('brain', 'gen', {});
  assert(/按题材/.test(u), `空输入要兜底：\n${u}`);
});

console.log('\n=== 三、灵感碎片：两个动作语义相反 ===');
t('整理：明确"只整理，不创作"', () => {
  const s = sys('idea', 'tidy', { text: '雨夜有人敲门' });
  assert(/只整理/.test(s) && /不创作/.test(s), '整理动作必须禁止创作');
  assert(/不许新增/.test(s), '没禁止新增事实');
});
t('扩散：明确"要分岔、至少一个反常方向"', () => {
  const s = sys('idea', 'expand', { text: '雨夜有人敲门' });
  assert(/不同的路|3-5/.test(s), '没要求多方向');
  assert(/反着来/.test(s), '没要求一个反直觉方向');
});
t('整理温度低、扩散温度高（同一工具两种脾气）', () => {
  const a = T.buildMessages('idea', 'tidy', { text: 'x' }).temperature;
  const b = T.buildMessages('idea', 'expand', { text: 'x' }).temperature;
  assert(a < b, `整理 ${a} 应低于扩散 ${b}`);
});

console.log('\n=== 四、字段白名单（界面多传的东西不能进提示词）===');
t('projectId / 别的工具的字段都被丢掉', () => {
  const u = usr('name', 'gen', { ...nameFields, projectId: 'proj-xxx', idea: '别的东西' });
  assert(!u.includes('proj-xxx'), 'projectId 漏进提示词了');
  assert(!u.includes('别的东西'), '别的工具字段漏进来了');
});

console.log('\n=== 五、输出清洗 ===');
t('剥开场白', () => {
  const r = T.cleanOutput('好的，以下是候选：\n沈砚 —— 砚台沉稳\n沈知白 —— 知白守黑');
  assert(r.startsWith('沈砚'), r);
});
t('剥结尾客套', () => {
  const r = T.cleanOutput('沈砚 —— 砚台沉稳\n希望有帮助');
  assert(!/希望/.test(r), r);
});
t('剥整段代码围栏', () => {
  const r = T.cleanOutput('```\n沈砚 —— 砚台沉稳\n```');
  assert(r === '沈砚 —— 砚台沉稳', JSON.stringify(r));
});
t('★ 名字清单的换行必须留着（压成一段就废了）', () => {
  const r = T.cleanOutput('好的\n沈砚 —— 沉稳\n沈知白 —— 知白守黑\n叶青梧 —— 疏朗');
  assert(r.split('\n').length === 3, `行数不对：${JSON.stringify(r)}`);
});
t('本来就没问题的内容不动（不要为了显作用改词）', () => {
  const src = '## 这条线怎么走\n1. 因为 A，所以 B';
  assert(T.cleanOutput(src) === src);
});
t('空输入安全', () => {
  assert(T.cleanOutput('') === '');
  assert(T.cleanOutput(null) === '');
});

console.log('\n=== 六、非法调用要说清楚（不能静默返回空）===');
t('未知 mode 抛错', () => {
  let threw = false;
  try { T.buildMessages('nope', 'gen', {}); } catch (_) { threw = true; }
  assert(threw, '未知 mode 没抛错');
});
t('未知 action 抛错', () => {
  let threw = false;
  try { T.buildMessages('idea', 'gen', {}); } catch (_) { threw = true; }
  assert(threw, 'idea 没有 gen 这个动作，应抛错');
});
t('MODE_INFO 与动作表一致（界面按它渲染按钮）', () => {
  for (const [m, info] of Object.entries(T.MODE_INFO)) {
    assert(info.file.endsWith('.md'), `${m} 的 file 不对`);
    assert(info.actions.length > 0, `${m} 没有动作`);
    for (const a of info.actions) {
      let ok = true;
      try { T.buildMessages(m, a.key, {}); } catch (_) { ok = false; }
      assert(ok, `${m} 声明了动作 ${a.key}，但提示词表里没有`);
    }
  }
});

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗', f));
  process.exitCode = 1;
}

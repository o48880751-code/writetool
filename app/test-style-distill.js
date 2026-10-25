/**
 * 文风蒸馏的契约判据（纯 node，不依赖 Electron）。
 *
 * ## 为什么不走真模型
 *
 * 这里验的是**契约**：分块策略、10 万字上限、有界自主、产物只能进自定义技能。
 * 真的调模型读 10 万字要几分钟、还烧 token，而那部分由用户实测。
 *
 * ## 为什么要钉这些
 *
 * 「单次最多 10 万字」是羽毛菌定的产品约束，而**10 万字根本装不进一次请求**
 * （中文 ≈ 13 万 token，128K 窗口扣掉输出预留就溢出）——
 * 所以「分块 + 汇总」不是优化，是**唯一可行路径**，
 * 一旦有人图省事改回一把梭，这条判据会立刻红。
 *
 * 运行：node test-style-distill.js
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

const APPDIR = __dirname;
const mainSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'StyleDistill.jsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(APPDIR, 'src', 'App.jsx'), 'utf8');

console.log('文风蒸馏契约');

section('一、10 万字上限');
// ⚠ 2026-10-15 羽毛菌改口了：「10万字不行，字少一点也可以的，
//   多几次蒸馏文章内容，学习文风，写作风格」—— 所以上限是 **2 万**。
//   原判据钉的是 10 万，清单一变就红 —— 那是需求变了，不是回归。
check('★ 单次上限 2 万字（靠多次累积，不是一把梭 10 万）', () => {
  const m = mainSrc.match(/DISTILL_MAX_CHARS\s*=\s*(\d+)/);
  assert.ok(m, '没有定义上限');
  assert.strictEqual(Number(m[1]), 20000,
    `上限是 ${m[1]}，不是 20000 —— 需求定的是单次 2 万、多次累积`);
});
check('★ 超限要**拒**，并告诉用户差多少字', () => {
  const i = mainSrc.indexOf("DISTILL_MAX_CHARS) {");
  assert.ok(i > 0, '没找到超限分支');
  const seg = mainSrc.slice(i, i + 400);
  assert.ok(/ok:\s*false/.test(seg), '超限没有明确失败');
  assert.ok(/超过|超出/.test(seg), '超限没告诉用户超了多少');
});
check('★ 界面也拦一道（并在超限时禁用按钮）', () => {
  assert.ok(/MAX_CHARS\s*=\s*20000/.test(panelSrc), '面板的上限与后端不一致（都是 2 万）');
  assert.ok(/disabled=\{!!busy \|\| over\}/.test(panelSrc), '超限时按钮没禁用');
  assert.ok(/over/.test(panelSrc), '面板没有「超了」这个状态');
});

section('二、必须分块，不能一把梭');
check('★ 有切块函数且按段落边界切', () => {
  assert.ok(/function splitForDistill/.test(mainSrc), '没有切块函数');
  const i = mainSrc.indexOf('function splitForDistill');
  const seg = mainSrc.slice(i, i + 700);
  assert.ok(/split\(.\\n\{1,\}/.test(seg) || /split\(\/\\n/.test(seg),
    '切块没有按换行/段落边界 —— 会把句子劈开，读出来的风格规则是断的');
});
check('★ 块大小小于上下文窗口能装下的量', () => {
  const m = mainSrc.match(/DISTILL_CHUNK_CHARS\s*=\s*(\d+)/);
  assert.ok(m, '没有定义块大小');
  const n = Number(m[1]);
  // ⚠ 单次上限降到 2 万之后，块大小**等于**上限是合理的（不切块）。
  //   这里只钉住「块不能超过上限」—— 切块仍要留着当兜底
  //   （万一以后把上限调回去，它就是唯一防止溢出爆的那道闸）。
  const cap = Number((mainSrc.match(/DISTILL_MAX_CHARS\s*=\s*(\d+)/) || [])[1]);
  assert.ok(n <= cap, `块大小 ${n} 超过单次上限 ${cap} —— 分块就没意义了`);
  assert.ok(n >= 4000, `块大小 ${n} 太小 —— 一本小说会被切成上百段，调用次数与费用都爆`);
});
check('★ 走「逐块提取 → 汇总」两步', () => {
  assert.ok(/function chunkPrompt/.test(mainSrc), '没有单块提取的提示');
  assert.ok(/function mergePrompt/.test(mainSrc), '没有汇总的提示');
  const i = mainSrc.indexOf("handle('style:distill'");
  const seg = mainSrc.slice(i, mainSrc.indexOf("handle('style:distillSave'"));
  assert.ok(/for\s*\(let i = 0; i < chunks\.length/.test(seg), '没有遍历所有块');
  assert.ok(/mergePrompt\(/.test(seg), '没有汇总这一步');
});
check('★ 提示词只让模型写**规则**，不许复述内容', () => {
  const i = mainSrc.indexOf('function chunkPrompt');
  const seg = mainSrc.slice(i, i + 1200);
  assert.ok(/不要复述/.test(seg), '没禁止复述内容 —— 产出会变成摘要而不是文风');
  assert.ok(/可执行|具体到可执行/.test(seg), '没要求规则要具体可执行');
});
check('★ 汇总提示要产出 SKILL.md（含 frontmatter）', () => {
  const i = mainSrc.indexOf('function mergePrompt');
  const seg = mainSrc.slice(i, i + 1500);
  assert.ok(/frontmatter/.test(seg), '汇总没要求 frontmatter');
  assert.ok(/name/.test(seg) && /description/.test(seg), 'frontmatter 字段没点名');
  assert.ok(/不要出现原文里的人名/.test(seg),
    '没禁止把原文人名带进去 —— 那是那部作品的内容，不是文风');
});

section('三、有界自主（程枢 C5）');
check('★ 块数有上限，超了**均匀抽样**而不是取前 N 段', () => {
  assert.ok(/DISTILL_MAX_CHUNKS\s*=\s*\d+/.test(mainSrc), '块数没有上限 —— 10 万字会变 16 次串行调用');
  const i = mainSrc.indexOf('function splitForDistill');
  const seg = mainSrc.slice(i, i + 2600);
  assert.ok(/chunks\.length\s*>\s*DISTILL_MAX_CHUNKS/.test(seg), '没有超块数分支');
  assert.ok(/sampled\s*=\s*true/.test(seg), '抽样了却没有如实记账');
});
check('★ 每一步有墙钟超时', () => {
  assert.ok(/DISTILL_TIMEOUT_MS\s*=\s*\d+/.test(mainSrc), '每步没有超时');
});
check('★ 单块失败**不中断**整轮，且如实上报', () => {
  const i = mainSrc.indexOf("handle('style:distill'");
  const seg = mainSrc.slice(i, i + 3000);
  assert.ok(/catch/.test(seg), '没有 catch —— 挂在第 9 块就白跑前面 8 块');
  assert.ok(/chunksFailed/.test(seg), '没有把失败的块报给用户');
});
check('★ 没有任何无限循环', () => {
  assert.ok(!/while\s*\(\s*true\s*\)/.test(mainSrc.slice(mainSrc.indexOf("handle('style:distill'"))),
    '蒸馏里有 while(true) —— 那是留给生产事故的');
});

section('四、产物只能进「用户自己的自定义技能」');
check('★ 保存时 type 必须是 custom', () => {
  const i = mainSrc.indexOf("handle('style:distillSave'");
  assert.ok(i > 0, '没有 distillSave');
  // ⚠ 窗口要给够：加了同名合并逻辑之后 createSkill 挪到 1.4k 字符处，
  //   切 900 会刚好切在它前面 —— 判据变红而代码没问题（我踩了一次）
  const seg = mainSrc.slice(i, i + 1800);
  assert.ok(/type:\s*'custom'/.test(seg),
    "类型不是 custom —— 内置技能的种子会用磁盘新版**覆盖正文**（见 db/builtin-skills.js）");
  assert.ok(/projectId:\s*null/.test(seg), 'projectId 不是 null —— 它就不在「我的技能」里');
});
check('★ 分析与保存分两步（先看结果再决定留不留）', () => {
  assert.ok(/handle\('style:distill'/.test(mainSrc) && /handle\('style:distillSave'/.test(mainSrc),
    '只有一个通道');
  // ⚠ 切片必须停在**下一个 handler 之前**：第一版切 3500 字符跨到了 distillSave,
  //   于是把"保存函数里有 createSkill" 误判成"分析通道里写库了"。
  const i = mainSrc.indexOf("handle('style:distill'");
  const j = mainSrc.indexOf("handle('style:distillSave'");
  const seg = mainSrc.slice(i, j);
  assert.ok(!/createSkill/.test(seg), '分析通道里直接写库了 —— 用户还没看过结果');
});
check('★ 结果没有 frontmatter 就明确失败', () => {
  const i = mainSrc.indexOf("handle('style:distill'");
  const seg = mainSrc.slice(i, i + 3500);
  assert.ok(/includes\('---'\)/.test(seg), '没校验 frontmatter');
  assert.ok(/没有按要求输出/.test(seg), '校验失败时没有可读的提示');
});
check('★ 会剥掉模型自作聪明的代码围栏', () => {
  assert.ok(/replace\(\/\^```/.test(mainSrc) || /replace\(\/\^\\x60\\x60\\x60/.test(mainSrc),
    '没剥围栏 —— 模型常会包一层 ```markdown');
});

section('五、入口在快捷工具栏');
check('★ 工具栏里有「文风蒸馏」', () => {
  assert.ok(/key:\s*'style',\s*label:\s*'文风蒸馏'/.test(appSrc),
    '快捷工具栏里没有文风蒸馏（羽毛菌：「应该放在这个快捷工具栏」）');
});
check('★ 它点开独立弹层，不切到 ToolsPanel', () => {
  const i = appSrc.indexOf('const openQuickTool');
  const seg = appSrc.slice(i, i + 500);
  assert.ok(/key === 'style'/.test(seg) && /setShowStyleDistill\(true\)/.test(seg),
    '它被塞进了 ToolsPanel —— 多步长任务的进度会被挤没');
});

section('六、preload 通道');
check('★ style.distill / style.distillSave 都暴露了', () => {
  assert.ok(/distill:\s*\(\{/.test(preloadSrc), '没有 distill 通道');
  assert.ok(/distillSave:\s*\(\{/.test(preloadSrc), '没有 distillSave 通道');
});
check('★ 通道名前缀是 style:（资料蒸馏那条线完全独立）', () => {
  // ⚠ 查了一下：DistillPanel（资料蒸馏）**一个 IPC 调用都没有**，
  //   它是个还没接后端的死界面 —— 羽毛菌说"这个蒸馏功能不对"，
  //   大概指的就是它。所以两边根本没有通道可撞，判据改成盯前缀唯一。
  assert.ok(/call\('style:distill'/.test(preloadSrc), '文风蒸馏的通道前缀不是 style:');
  const dup = (preloadSrc.match(/call\('style:distill'/g) || []).length;
  assert.strictEqual(dup, 1, `style:distill 通道注册了 ${dup} 次`);
});

section('六、同名合并（多跑几次要加厚同一份，而不是并列一堆）');
check('★ 同名的自定义技能会被合并，不是新建', () => {
  const i = mainSrc.indexOf("handle('style:distillSave'");
  const seg = mainSrc.slice(i, i + 2600);
  assert.ok(/listSkills()/.test(seg), '没有查已有技能 —— 每次都会新建一份');
  assert.ok(/fullName/.test(seg), '没有按名字匹配');
  assert.ok(/merged:[^\n]*true/.test(seg), '没有告诉界面「这次是合并」');
  assert.ok(/updateSkill/.test(seg), '合并了却没有写回同一条');
});
check('★ 合并失败不能丢掉这一轮的新内容', () => {
  const i = mainSrc.indexOf("handle('style:distillSave'");
  const seg = mainSrc.slice(i, i + 3200);
  const c = seg.indexOf('catch');
  assert.ok(c > 0, '合并没有 catch');
  const after = seg.slice(c, c + 900);
  assert.ok(/updateSkill/.test(after) && /incoming/.test(after),
    '合并失败时没有把新内容退化成追加 —— 用户这一轮白跑了');
});
check('★ 合并结果坏了要保留原来那份（别拿坏文件覆盖好的）', () => {
  const i = mainSrc.indexOf("handle('style:distillSave'");
  const seg = mainSrc.slice(i, i + 3600);
  assert.ok(/已保留原来那份/.test(seg), '合并出坏结果时没有兜底说明');
});

section('七、模型质量警告');
check('★ 蒸馏界面有「建议云端、损失概不负责」那句', () => {
  assert.ok(/建议连接/.test(panelSrc), '没有「建议连接」');
  assert.ok(/云端/.test(panelSrc), '没有点名云端大模型');
  assert.ok(/概不负责/.test(panelSrc),
    '没有「概不负责」那句（羽毛菌指定原文）');
});

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `文风蒸馏契约：${passed} 通过 / ${failures.length} 失败`
  : `文风蒸馏契约：${passed} 通过`);
process.exit(failures.length ? 1 : 0);
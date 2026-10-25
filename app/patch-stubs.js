/**
 * 给三个桩补数据：截图 refs 场景要点技能与文件，
 * 而新项目里这两个表本来是空的 —— 浮层开着但列表空的，
 * 判据说"没有可选条目"，看着像实现坏了。
 *
 * ⚠ 这类"桩没给数据"的问题第一版看不出来，
 *   因为脚本只会说"没选上"，不会说"浮层里有几个按钮"。
 *   后来加了浮层探测才定位到（total 24 个按钮、nearby 只有「关闭」）。
 */
const fs = require('node:fs');
const p = 'shoot-ui-102.js';
const raw = fs.readFileSync(p, 'utf8');
const NL = raw.includes('\r\n') ? '\r\n' : '\n';
const L = raw.split(NL);

const CH = [
  "/**",
  " * ⚠ 章节 / 技能 / 设定：**桩补数据**。",
  " *   新建的验证项目这三个表本来是空的，@技能 与 @文件 浮层会打开但列表空，",
  " *   脚本点不到任何条目 —— 看着像\"引用功能坏了\"，其实是没数据。",
  " *   所以这里给一份固定内容：判据要验的是**配色**，不是数据从哪来。",
  " */",
  "const FIX_CHAPTERS = [",
  "  { id: 'ch-1', title: '第一章 断剑', word_count: 3210 },",
  "  { id: 'ch-2', title: '第二章 旧约', word_count: 2870 },",
  "];",
  "const FIX_SKILLS = [",
  "  { id: 'sk-1', name: '文风模仿', prompt_content: '按用户给的三段样文，模仿其句式与节奏。' },",
  "  { id: 'sk-2', name: '设定查漏', prompt_content: '检查本章与既有设定是否冲突。' },",
  "];",
  "const FIX_SETTINGS = [",
  "  { id: 'st-1', name: '人物库', note: '夜枫：苟道、利己、有底线。' },",
  "  { id: 'st-2', name: '世界观', note: '灵气复苏百年，宗门林立。' },",
  "]",
  "h('chapter:list', () => FIX_CHAPTERS);",
  "h('skill:list', () => FIX_SKILLS);",
  "h('settings:list', () => FIX_SETTINGS);",
];

const i = L.findIndex((l) => l.indexOf("h('chapter:list'") >= 0);
if (i < 0) { console.error('ABORT 找不到 chapter:list'); process.exit(2); }
const j = L.findIndex((l) => l.indexOf("h('skill:list'") >= 0);
if (j < 0) { console.error('ABORT 找不到 skill:list'); process.exit(2); }
const k = L.findIndex((l) => l.indexOf("h('settings:list'") >= 0);
if (k < 0) { console.error('ABORT 找不到 settings:list'); process.exit(2); }

// 从最小行号删到最大行号（升序），中间夹着的都换掉
const lo = Math.min(i, j, k);
let hi = Math.max(i, j, k);
// 往上扩到这三个桩都覆盖掉（它们不连续，所以取连续区间）
while (lo > 0 && L[lo - 1].trim().startsWith('h(')) lo--;
while (hi < L.length - 1 && L[hi + 1] && L[hi + 1].trim().startsWith('h(')) hi++;
// 整段里非 h( 开头的行也要保留（如注释）
const removed = L.slice(lo, hi + 1);
const keep = removed.filter((l) => !/^h\('(chapter|skill|settings):list'/.test(l.trim()));
console.log(`替换第 ${lo + 1}–${hi + 1} 行；保留 ${keep.length} 行非桩内容`);

L.splice(lo, hi - lo + 1, ...CH, ...keep);
fs.writeFileSync(p, L.join(NL));
console.log('OK');

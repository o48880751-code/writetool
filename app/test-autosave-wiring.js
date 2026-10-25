/**
 * 自动落盘的**接线**判据。
 *
 * ## 为什么单独一份
 *
 * 这个项目里"两端没接上"已经发生过两次，症状都是**看起来一切正常**：
 *   ① agent-loop 叫 `onText`、main.js 传 `onChunk` → 正文分片被整段丢弃，
 *      界面一个字都不流出来，日志一行没有；
 *   ② `fs:changed` 主进程发了、preload 转了、界面**没订阅** → 写文件后
 *      目录里看不到，重启才出现。
 *
 * 这两次的共同点：单测全绿（它们不跑真界面），只有真机才暴露。
 * 所以这里专门钉**跨文件的接口名字与调用点**。
 *
 * ⚠⚠ 扫源码前**必须剥注释**：这个项目的注释里大量出现函数名
 *   （"见 autoSave.applyPlan 的注释"），不剥的话把实现删了判据照样绿。
 *   这条已经踩过三次。
 *
 * 纯 node，不启动 Electron。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

/**
 * 剥掉注释。
 *
 * ⚠ 行注释用 `[^:]` 保护 URL：`https://…` 里的 `//` 不是注释，
 *   直接 `//.*$` 会把后面的代码整行吃掉，判据就开始假绿。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const mainSrc = stripComments(read('electron/main.js'));
const preloadSrc = stripComments(read('electron/preload.js'));
const appSrc = stripComments(read('src/App.jsx'));
const moduleSrc = stripComments(read('electron/auto-save.js'));

console.log('\n=== A. 判定模块本身 ===');
check('auto-save.js 导出 resolve 与 applyPlan', () => {
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*?\bresolve\b/.test(moduleSrc), '没导出 resolve');
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*?\bapplyPlan\b/.test(moduleSrc), '没导出 applyPlan');
});

console.log('\n=== B. 主进程接线 ===');

check('main.js 惰性加载了 auto-save', () => {
  assert.ok(/autoSave\s*=\s*require\('\.\/auto-save\.js'\)/.test(mainSrc),
    'main.js 没有 require auto-save.js —— 或者变量名不是 autoSave');
});
check('⚠ conv:send 里真的调用了 applyPlan（不是只 import 了）', () => {
  assert.ok(/autoSave\.applyPlan\(/.test(mainSrc),
    '只 require 不调用 = 功能根本没接上');
});
check('⚠ 落盘前做了"值不值得扫目录"的预判（几千章的项目不能每轮都扫树）', () => {
  assert.ok(/autoSave\.detectIntent\(/.test(mainSrc), '没有预判，会每轮同步遍历磁盘');
  assert.ok(/looksLikeWriting/.test(mainSrc), '预判的关口变量没了');
});
check('⚠ onDone 里记录了 write_note 是否已写过（防双重写入）', () => {
  assert.ok(/wroteFileThisTurn\s*=\s*true/.test(mainSrc), '没有记账，模型自己写过的还会再写一遍');
  assert.ok(/wroteByTool:\s*wroteFileThisTurn/.test(mainSrc), '记账没有传给 resolve，等于白记');
});
check('⚠ 落盘出错不能连累正文（try/catch 包住）', () => {
  assert.ok(/自动落盘出错（不影响已生成的正文）/.test(mainSrc),
    '没有兜底：写文件失败会让 onDone 抛异常，用户连正文都看不到');
});
check('落盘后发了 fs:changed（否则目录不刷新）', () => {
  const i = mainSrc.indexOf('generate:autosave');
  assert.ok(i > 0, '没有发 generate:autosave');
  const around = mainSrc.slice(Math.max(0, i - 900), i + 200);
  assert.ok(/fs:changed/.test(around), 'generate:autosave 附近没有 fs:changed —— 目录不会刷新');
});
check('⚠ conv:send 从 payload 里取了 activePath', () => {
  assert.ok(/\bactivePath\b/.test(mainSrc), '没取 activePath，"重写这一章"就定位不到文件');
});
check('resolve 收到的 activePath 不是未定义变量', () => {
  assert.ok(/activePath,/.test(mainSrc) || /activePath:/.test(mainSrc),
    '传参处没有 activePath');
});

console.log('\n=== C. preload ↔ 界面 的通道名两端一致 ===');

/** 从 preload 里抠出 generate.onAutosave 的方法名，再确认界面用的是同一个 */
check('preload 暴露了 generate.onAutosave', () => {
  assert.ok(/onAutosave\s*:/.test(preloadSrc), 'preload 没暴露 onAutosave');
  assert.ok(/ipcRenderer\.on\('generate:autosave'/.test(preloadSrc),
    'preload 里订阅的通道名必须是 generate:autosave');
});
check('⚠⚠ 界面订阅的方法名与 preload 完全一致（大小写也算）', () => {
  const m = preloadSrc.match(/onAutosave\s*:/);
  assert.ok(m, '前提不成立：preload 没有 onAutosave');
  assert.ok(/window\.api\.generate\.onAutosave\s*\(/.test(appSrc),
    '界面没有调用 window.api.generate.onAutosave —— 这正是 fs:changed 那次漏掉的一环');
});
check('⚠⚠ 主进程发的通道名与 preload 收的完全一致', () => {
  assert.ok(/'generate:autosave'/.test(mainSrc), '主进程没发 generate:autosave');
  assert.ok(/ipcRenderer\.on\('generate:autosave'/.test(preloadSrc), 'preload 收的不是这个名字');
});
check('preload 的订阅函数返回取消订阅（防重复监听累积）', () => {
  const i = preloadSrc.indexOf('onAutosave');
  assert.ok(i > 0, '前提不成立');
  const chunk = preloadSrc.slice(i, i + 400);
  assert.ok(/removeListener\('generate:autosave'/.test(chunk),
    '没有返回取消订阅 → 每次重新订阅都会多挂一个 listener');
});

console.log('\n=== D. 界面把"当前打开的文件"传下去了 ===');

check('⚠ conv.send 的两处调用都带了 activePath', () => {
  const hits = appSrc.match(/activePath:\s*previewPath/g) || [];
  assert.strictEqual(hits.length, 2,
    `应当两处都传（新建对话 + 已有对话），实际 ${hits.length} 处`);
});
check('previewPath 是真实存在的状态（不是随手写的名字）', () => {
  assert.ok(/const \[previewPath, setPreviewPath\] = useState/.test(appSrc),
    'App.jsx 里没有 previewPath 这个 state');
});

console.log('\n=== E. 系统提示与自动落盘不打架 ===');

check('提示词明确说了"正文由软件自动存"（否则模型会自己也写一遍）', () => {
  assert.ok(/正文由软件自动存进那一章的文件/.test(mainSrc),
    '提示词没说，模型可能自己调 write_note，变成双重写入');
});
check('提示词禁止模型自称"已保存"（存哪由软件决定，它说了是错的）', () => {
  assert.ok(/你\*\*不要\*\*说「已保存」/.test(mainSrc) || /你不要说「已保存」/.test(mainSrc),
    '【四】还停在"只有 write_note 才能说写了"，与自动落盘冲突');
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

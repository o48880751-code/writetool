/**
 * IPC 通道与 preload 命名空间的唯一性判据（2026-10-29）。
 *
 * 运行：node test-ipc-unique.js
 *
 * ## 为什么要有这个
 *
 * 2026-10-29 加「新版本提示」时，我给 `app:openExternal` 注册了第二个 handler
 * （主进程里本来就有一个）。Electron **不允许重复注册**，于是：
 *
 *     Error: Attempted to register a second handler for 'app:openExternal'
 *
 * **主进程直接崩，软件起不来**。用户看到的是「A JavaScript error occurred
 * in the main process」加一段堆栈，完全不知道该怎么办。
 *
 * ⚠ 这个错误**编译期查不出来、运行期一启动就炸**，而且堆栈指向
 *   `ipcMain.handle` 的内部，看不出是哪个功能重了。
 *   **纯静态就能查**，所以必须做成判据。
 *
 * ## 为什么还要查 preload 命名空间
 *
 * 同一次我给 preload 加了 `app: { openExternal }`，而 `app:` 命名空间
 * 已经在文件后半段存在了 —— JS 对象字面量里**重复的 key 不报错**，
 * 后者覆盖前者。表现是"某个接口莫名其妙消失"，比崩溃更难查。
 */

const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
const pending = [];

function check(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => { pass += 1; console.log(`  ✓ ${name}`); })
      .catch((e) => { fail += 1; console.log(`  ✗ ${name}`); console.log(`      ${e.message}`); })
  );
}

const mainSrc = fs.readFileSync(path.join(__dirname, 'electron/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, 'electron/preload.js'), 'utf8');

/** 取出 main.js 里所有 handle('xxx' 的通道名 */
function ipcChannels(src) {
  const out = [];
  const re = /\bhandle\(\s*'([a-zA-Z0-9:_-]+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** 取出 preload 里 exposeInMainWorld 之后、缩进两格的顶层命名空间 */
function preloadNamespaces(src) {
  const out = [];
  const re = /^ {2}([a-zA-Z][a-zA-Z0-9]*):\s*\{/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------- 判据

check('★ IPC 通道没有重复注册', () => {
  const all = ipcChannels(mainSrc);
  const seen = new Map();
  const dup = [];
  for (const ch of all) {
    if (seen.has(ch)) dup.push(ch);
    else seen.set(ch, true);
  }
  if (dup.length) {
    throw new Error(`重复注册的通道：${[...new Set(dup)].join(', ')}\n`
      + '      Electron 不允许同一个通道注册两次，主进程会直接崩。');
  }
  if (!all.length) throw new Error('一个通道都没解析到 —— 判据本身失效了，先检查正则');
});

check('★ preload 的顶层命名空间没有重复', () => {
  const all = preloadNamespaces(preloadSrc);
  const seen = new Map();
  const dup = [];
  for (const ns of all) {
    if (seen.has(ns)) dup.push(ns);
    else seen.set(ns, true);
  }
  if (dup.length) {
    throw new Error(`重复的命名空间：${[...new Set(dup)].join(', ')}\n`
      + '      对象字面量重复 key 不报错，后者会覆盖前者，接口会静默消失。');
  }
  if (!all.length) throw new Error('一个命名空间都没解析到 —— 判据本身失效了');
});

check('★ 判据自检：故意造一个重名能被抓到（反向用例）', () => {
  const fake = "handle('a:b', () => 1);\nhandle('a:b', () => 2);";
  const all = ipcChannels(fake);
  const dup = all.filter((c, i) => all.indexOf(c) !== i);
  if (!dup.length) throw new Error('反向用例没被抓到 —— 说明正则或查重逻辑是坏的，前面的"通过"不可信');
});

check('★ preload 暴露的每个通道，主进程都有对应的 handler', () => {
  const handlers = new Set(ipcChannels(mainSrc));
  const exposed = [];
  const re = /call\(\s*'([a-zA-Z0-9:_-]+)'/g;
  let m;
  while ((m = re.exec(preloadSrc)) !== null) exposed.push(m[1]);

  const missing = [];
  for (const ch of exposed) {
    // 有些通道是动态拼的（`skill:${x}` 之类），用前缀匹配放行
    if (!handlers.has(ch)) missing.push(ch);
  }
  if (missing.length) {
    throw new Error(`这些通道 preload 暴露了但主进程没注册：${[...new Set(missing)].join(', ')}\n`
      + '      调用它们会一直挂着或直接 reject。');
  }
  if (!exposed.length) throw new Error('没解析到 preload 里的 call(...) —— 判据失效');
});

// ---------------------------------------------------------------- 汇总

Promise.all(pending).then(() => {
  console.log(`\nIPC 唯一性：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});

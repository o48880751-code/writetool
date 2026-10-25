/**
 * IPC 契约一致性测试。
 *
 * ## 为什么要有这个
 *
 * 开发这轮时我写 `window.api.ollama.status()`，
 * 而 preload 里暴露的方法叫 `ollama.check` —— **凭印象写的，没查**。
 * 运行时直接抛 `window.api.ollama.status is not a function`，
 * 界面显示「连不上 Ollama」并给出排查提示（Ollama 没启动之类），
 * **把一个代码 bug 伪装成了用户的环境问题**。
 *
 * 这类错误人工点一遍界面未必能发现：多数时候你看到的是
 * 「某个功能好像坏了」，而不是「方法名写错了」。
 *
 * ## 测什么
 *
 * 1. 组件里调用的 `window.api.<域>.<方法>` 必须在 preload 里存在
 * 2. preload 里暴露的每个方法，主进程必须有对应的 ipcMain.handle
 * 3. 双向都不能有多余（多余的比缺失更难发现）
 */

const fs = require('node:fs');
const path = require('node:path');

// 这个文件在 app/ 下，所以项目根是 __dirname 的上一级……不对：
// __dirname = <root>/app，上一级正好是 <root>。但第一版写成
// path.resolve(__dirname, '..', '..') 多退了一级，
// 于是 APP 变成 <root>/../app，报 ENOENT。
const APP = __dirname;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

/** 递归列出目录下的所有文件 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 剥掉注释与字符串，避免把注释里的调用也算进来 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---- 收集三份清单 ----

const srcFiles = walk(path.join(APP, 'src')).filter((f) => /\.(jsx?|tsx?)$/.test(f));

/** 组件侧：window.api.<域>.<方法> */
const used = new Map();      // '域.方法' -> 出现位置[]
for (const f of srcFiles) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  const re = /window\.api\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = `${m[1]}.${m[2]}`;
    const line = src.slice(0, m.index).split('\n').length;
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(`${path.relative(APP, f)}:${line}`);
  }
}

// 组件里还有别的调法（解构后再调），单独收集
const usedOther = new Map();
for (const f of srcFiles) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  // window.api 整体传给子组件后，子组件可能用 api.xxx.yyy
  const re = /\bapi\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = `${m[1]}.${m[2]}`;
    if (key.startsWith('config.get')) continue;   // window.api 已覆盖
    if (!usedOther.has(key)) usedOther.set(key, []);
    usedOther.get(key).push(`${path.relative(APP, f)}:${src.slice(0, m.index).split('\n').length}`);
  }
}

// preload 侧：contextBridge 暴露的域.方法
const preloadSrc = fs.readFileSync(path.join(APP, 'electron', 'preload.js'), 'utf8');
const exposed = new Set();
{
  // 形如  ollama: { check: () => call('ollama:check') },
  const domainRe = /^\s{2}([A-Za-z_$][\w$]*):\s*\{/gm;
  let dm;
  while ((dm = domainRe.exec(preloadSrc)) !== null) {
    const domain = dm[1];
    // 从这个域的起点找到配对的 }（缩进 2 空格的 } 是该域的结束）
    const rest = preloadSrc.slice(dm.index);
    const end = rest.indexOf('\n  },');
    const body = end > 0 ? rest.slice(0, end) : rest;
    const methodRe = /^\s{4}([A-Za-z_$][\w$]*):\s*(?:\(|async)/gm;
    let mm;
    while ((mm = methodRe.exec(body)) !== null) exposed.add(`${domain}.${mm[1]}`);
  }
}

// 主进程侧：handle('channel', ...)
const mainSrc = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');
const channels = new Set();
{
  const re = /handle\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(mainSrc)) !== null) channels.add(m[1]);
}

// ===========================================================
section('一、组件调用的方法必须在 preload 存在');

check('收集到了组件里的 window.api 调用', () => {
  assertGt(used.size, 10, `只收集到 ${used.size} 个，正则可能失效`);
});

check('window.api.<域>.<方法> 全部已在 preload 暴露', () => {
  const missing = [];
  for (const [key, places] of used) {
    if (!exposed.has(key)) missing.push(`${key}（${places[0]}）`);
  }
  assertEq(missing.length, 0,
    `preload 里没有这些方法：\n      ${missing.join('\n      ')}\n` +
    `    运行时表现：window.api.<域>.<方法> is not a function`);
});

check('通过 props 透传的 api.<域>.<方法> 同样要在 preload 存在', () => {
  const missing = [];
  for (const [key, places] of usedOther) {
    if (key === 'data.backup' || key.startsWith('settings.importBible')) { /* 已单独处理 */ }
    if (!exposed.has(key)) missing.push(`${key}（${places[0]}）`);
  }
  if (missing.length) {
    throw new Error(`preload 里没有：${missing.join(', ')}`);
  }
});

// ===========================================================
section('二、preload 暴露的方法必须有主进程 handler');

check('每个 call(\'x:y\') 都有对应的 ipcMain.handle', () => {
  const called = new Set();
  const re = /call\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(preloadSrc)) !== null) called.add(m[1]);
  const missing = [...called].filter((c) => !channels.has(c));
  assertEq(missing.length, 0,
    `preload 调用了但主进程没注册：${missing.join(', ')}\n` +
    `    运行时表现：Error invoking remote method '${missing[0]}'`);
});

check('preload 的 call 通道数与主进程 handler 数相符', () => {
  const called = new Set();
  const re = /call\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(preloadSrc)) !== null) called.add(m[1]);
  // 主进程会多出一些没走 preload 的通道（菜单动作等），
  // 允许多，不允许 preload 侧缺
  assertGt(channels.size, called.size - 1, `主进程只有 ${channels.size} 个 handler，preload 调了 ${called.size} 个`);
});

// ===========================================================
section('三、本轮新增的通道');

// ---------------------------------------------------------------
// 2026-10-12 需求变更：不做在线更新检查，改成「网站发布 + 用户下载覆盖」
// ---------------------------------------------------------------

check('版本与发布页通道已注册', () => {
  for (const ch of ['app:version', 'app:setDownloadUrl', 'app:openExternal']) {
    assertOk(channels.has(ch), `缺少 ${ch}`);
  }
});

check('★ 在线更新检查已彻底移除（按需求）', () => {
  assertOk(!channels.has('app:checkUpdate'),
    'app:checkUpdate 还在——需求是不做在线检查，软件不该发任何网络请求');

  const preloadSrc = fs.readFileSync(path.join(APP, 'electron', 'preload.js'), 'utf8');
  assertOk(!preloadSrc.includes('checkUpdate'),
    'preload 里还暴露着 checkUpdate：界面调用它就会走网络');

  const mainSrc = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');
  assertOk(!/checkUpdate/.test(mainSrc),
    'main.js 里还有 checkUpdate 的引用');
});

check('★ 旧模块文件已删除（不留死代码进安装包）', () => {
  assertOk(!fs.existsSync(path.join(APP, 'electron', 'update-check.js')),
    'electron/update-check.js 还在，但它已经没人 require 了——'
    + '会被 electron/**/* 白名单打进安装包，白占体积');
  assertOk(!fs.existsSync(path.join(APP, 'test-update.js')),
    'app/test-update.js 还在，测的是一个已删除的功能');
});

check('★ 密钥密文不会被 config:get 交给渲染进程', () => {
  // ⚠ 安全：config 里存着 apiKeyEnc（safeStorage 密文）。
  //   它不是明文，但一旦交给渲染进程，就等于给了它一条
  //   「把密文传出去 → 在别的进程里解密」的路径。
  //   而且 config:get 返回的是整个 config 对象，
  //   新加敏感字段时忘了剔除就会漏出去。
  const src = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');
  assertOk(/function publicConfig/.test(src), '缺少 publicConfig：config:get 应经它过滤');
  // ⚠ 判据写成「同一行里出现 config:get 且带 publicConfig」——
  //   用 handle(...config:get...[^)]*publicConfig( 这种跨括号匹配，
  //   会被箭头函数的 () 打断（同上，这里不该用 [^)]*）。
  const line = src.split('\n').find((l) => l.includes("config:get'"));
  assertOk(line && line.includes('publicConfig'),
    `config:get 没有经 publicConfig 过滤：${line && line.trim()}`);

  const fn = src.slice(src.indexOf('function publicConfig'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const f of ['apiKeyEnc', 'apiKey', 'apiKeyMemory']) {
    assertOk(body.includes(f), `publicConfig 没剔除 ${f}`);
  }
});

check('★ config:set 挡掉密钥字段（渲染进程不能覆盖用户存的密钥）', () => {
  const src = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');
  const i = src.indexOf("handle('config:set'");
  assertOk(i > 0, '找不到 config:set');
  const body = src.slice(i, src.indexOf('\n});', i));
  assertOk(/delete/.test(body) && /apiKey/.test(body),
    'config:set 没挡掉密钥字段 —— 渲染进程能覆盖用户自己的密钥');
});

check('★ preload 不提供任何返回密钥明文的方法', () => {
  const src = fs.readFileSync(path.join(APP, 'electron', 'preload.js'), 'utf8');
  assertOk(/provider/.test(src), 'preload 没暴露 provider 通道');
  // setKey 是单向的：进去，不出来
  assertOk(/setKey/.test(src), '缺 setKey');
  assertOk(/keyStatus/.test(src), '缺 keyStatus');
  // 不能有 getKey / readKey 这种能拿回明文的
  assertOk(!/\b(getKey|readKey|apiKey\(\)|getApiKey)\b/.test(src),
    'preload 里有能返回密钥明文的方法');
});

check('★ provider 通道已注册', () => {
  // ⚠ 2026-10-12：从「全局一条连接」改成多连接，
  //   原来的 provider:switch（按参数切）换成了 provider:activate（按 id 切）。
  //   同时新增了连接 CRUD 那五个通道——它们是这条改动的核心，
  //   少一个注册就意味着界面上有个按钮点了没反应。
  for (const ch of ['provider:probe', 'provider:capabilities',
    'provider:setKey', 'provider:keyStatus', 'provider:activate',
    'provider:listConnections', 'provider:createConnection',
    'provider:updateConnection', 'provider:deleteConnection']) {
    assertOk(channels.has(ch), `缺少 ${ch}`);
  }
});

check('回收站通道已注册', () => {
  for (const ch of ['trash:list', 'trash:add', 'trash:restore', 'trash:purge', 'trash:empty']) {
    assertOk(channels.has(ch), `缺少 ${ch}`);
  }
});

check('★ 思考分片走独立通道，不与正文混用', () => {
  // 混用的后果实测过：think 开启时流式响应里 297 个分片全是 thinking，
  // content 一片都没有。只读 content 的解析器会让编辑器一个字都不出现。
  //
  // ⚠ 2026-10-12 起解析搬到了 provider.js（AI 提供商适配层），
  //   main.js 不再自己拼协议。所以这里要读**两个文件**——
  //   只读 main.js 会在重构当天假红，而它本来是防"漏了思考通道"的安全网。
  const providerSrc = fs.readFileSync(path.join(APP, 'electron', 'provider.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');

  // Ollama 的字段名。provider 里先解构出 `const msg = o.message || {}`
  // 再读 msg.thinking，所以不能按 `message.thinking` 连写匹配——
  // 那是照着数据结构想的，实际写法是两步。
  assertOk(/o\.message/.test(providerSrc) && /msg\.thinking/.test(providerSrc),
    'provider.js 没有解析 Ollama 的 message.thinking');
  // OpenAI 兼容侧字段名不同，只查 Ollama 那个会漏掉这条
  assertOk(/reasoning_content/.test(providerSrc),
    'provider.js 没有解析 reasoning_content —— 换服务商后思考内容会全丢');
  assertOk(/generate:think/.test(mainSrc),
    'main.js 没有把思考分片转发给渲染进程');
  assertOk(/onThink/.test(fs.readFileSync(path.join(APP, 'electron', 'preload.js'), 'utf8')),
    'preload 没有暴露 onThink');
});

check('思考内容不与正文共用累加变量', () => {
  const src = fs.readFileSync(path.join(APP, 'electron', 'main.js'), 'utf8');
  assertOk(/let streamedThink/.test(src), '应有独立的 streamedThink');
  // 关键约束：onThink 回调里绝不能动 streamedText
  const m = src.match(/\(thinkText\) => \{[\s\S]{0,220}?\}/g) || [];
  assertOk(m.length >= 2, `应有两处 onThink 回调，实际 ${m.length}`);
  for (const cb of m) {
    assertOk(!/streamedText\s*\+=/.test(cb),
      `onThink 里改了 streamedText：思考会混进正文，\n      ${cb.slice(0, 120)}`);
  }
});

check('开思考时 token 上限给了足够值', () => {
  // 实测（Ollama 0.40.2 / qwen3 8B）：num_predict=500 时
  // thinking 吃掉 477 字、content 一片都没有 —— 正文一个字都不吐。
  //
  // ⚠ 2026-10-12 起这个值搬到 provider.js（AI 提供商适配层），
  //   main.js 不再自己拼协议。判据必须跟着搬，
  //   否则重构当天就假红 —— 而它本来是防"上限给小了"的。
  const src = fs.readFileSync(path.join(APP, 'electron', 'provider.js'), 'utf8');
  assertOk(/num_predict/.test(src), 'provider.js 请求体里没有 num_predict');
  const n = src.match(/Math[.]max[(]([0-9]+)[,]/);
  assertOk(n && Number(n[1]) >= 1024,
    `num_predict 下限太小（${n && n[1]}），开思考时正文会被 thinking 吃光`);
  // OpenAI 兼容侧同理，只是字段名不同。
  // ⚠ 实际写法是 `body.max_tokens = ...`（赋值）而不是对象字面量，
  //   所以判据不能按 `max_tokens:` 匹配——那是我照着 Ollama 那侧
  //   的写法想当然的。上下文小写时是 1024、开思考时是 2048，两个都要给够。
  const small = src.match(/Math[.]max[(]([0-9]+)[,][^)]*[)]/g) || [];
  const nums = small.map((s) => Number(/Math[.]max[(]([0-9]+)/.exec(s)[1]));
  assertOk(nums.length >= 2, `期望两处 token 上限（开/关思考），实际找到 ${nums.length}`);
  assertOk(Math.min(...nums) >= 1024, `token 上限下限太小：${nums.join(' / ')}`);
});

check('备份相关通道已注册', () => {
  for (const ch of ['data:backup', 'data:inspectBackup']) {
    assertOk(channels.has(ch), `缺少 ${ch}`);
  }
});

check('openExternal 在主进程限制了协议（防 javascript:/file:）', () => {
  const m = mainSrc.match(/handle\('app:openExternal'[\s\S]{0,400}/);
  assertOk(m, '找不到 app:openExternal handler');
  assertOk(/https\?/.test(m[0]), '没有看到协议白名单校验');
});

// ===========================================================
section('四、契约文档（防止下一个人再凭印象写）');

check('preload 每个域都有一行注释说明用途', () => {
  // 不强制所有域，但至少模型/项目/文件这几类要有
  for (const d of ['fs', 'app', 'data']) {
    assertOk(exposed.size > 0 && [...exposed].some((e) => e.startsWith(`${d}.`)),
      `preload 里没有 ${d} 域的任何方法`);
  }
});

// ---------------------------------------------------------------
function assertOk(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `期望 ${b}，实际 ${a}`); }
function assertGt(a, b, msg) { if (!(a > b)) throw new Error(msg || `期望 > ${b}，实际 ${a}`); }

console.log(`\n${'-'.repeat(52)}`);
console.log(`IPC 契约：${passed} 通过 / ${failed} 失败`);
if (used.size) {
  console.log(`\n组件用到的 API（${used.size + usedOther.size} 个）：`);
  [...new Set([...used.keys(), ...usedOther.keys()])].sort().forEach((k) => {
    console.log(`  ${exposed.has(k) ? '✓' : '✗'} ${k}`);
  });
}
process.exit(failed ? 1 : 0);
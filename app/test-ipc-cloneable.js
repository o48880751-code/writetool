/**
 * IPC 返回值可克隆性检查。
 *
 * ## 为什么必须单独一个文件
 *
 * Electron 的 `ipcMain.handle` 把返回值送回渲染进程时要经过
 * **结构化克隆**（structuredClone）。不可克隆的东西只有三类：
 * Promise、函数、Symbol —— 而它们在代码里**常常长得像个普通值**。
 *
 * 2026-10-13 羽毛菌报「本地模型连不上」，报的是：
 *
 *   Error invoking remote method 'provider:probe': An object could not be cloned.
 *
 * 根因在 provider.js 的 probe()：
 *
 *   version: safeVersion(cfg)      ← safeVersion 是 async function
 *
 * 不 await 就等于把一个 **Promise 对象**放进返回值里。
 * 于是整个探测结果在 IPC 层被拒 —— 连 `ok:true` 都传不出去，
 * 渲染进程只看到一句"调用失败"，显示成"连不上"。
 *
 * 而实际现场是：Ollama 服务正常、模型列表拿到了 2 个，
 * 就因为一个版本号没 await。
 *
 * ## 为什么既有测试全绿
 *
 * db/test-provider.js 里**直接 require 后调用** probe，
 * 那条路径没有 IPC，返回原始对象，Promise 静静躺在里面、不报错。
 * 只有真跑 Electron 走 ipcMain.handle 才炸。
 *
 * 所以这个检查的判据就是**复现渲染进程的行为**：
 * 拿真实的返回值喂给 structuredClone。
 *
 * 运行：node app/test-ipc-cloneable.js
 */

const path = require('node:path');
const assert = require('node:assert');

const APPDIR = __dirname;
const provider = require(path.join(APPDIR, 'electron', 'provider.js'));
const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const { SecretStore } = (() => {
  try {
    return { SecretStore: require(path.join(APPDIR, 'electron', 'secret-store.js')).SecretStore };
  } catch (_) {
    return { SecretStore: null };
  }
})();

let passed = 0;
const failures = [];
function section(t) { console.log('\n' + t); }

/**
 * 一条判据 = 真的去调那个函数，然后喂给 structuredClone。
 *
 * ⚠ 必须真调，不能只扫源码找 `async function` 字样：
 *   返回值里有没有 Promise，取决于**调用时**的参数分支
 *   （比如 safeVersion 只在 engine==='ollama' 时才被塞进去）。
 */
async function check(name, fn) {
  let v;
  try {
    v = await fn();
  } catch (e) {
    // 函数自己抛错是另一种问题（下面有专门一条判它），这里只管克隆
    failures.push(name);
    console.log('  ✗ ' + name + '\n    调用就抛错了：' + e.message);
    return;
  }
  try {
    structuredClone(v);
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name + '\n    ' + e.message
      + '\n    → 这个返回值过不了 IPC。渲染进程只会看到'
      + '「Error invoking remote method」，功能表现为"功能坏了/连不上"。');
  }
}

// ============================================================
section('一、provider:probe 的每条分支都必须可克隆');
// ============================================================

const OLLAMA = { engine: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest' };

(async () => {
  /**
   * ★ 这条是本文件存在的理由。
   * 只在 ollama 分支塞 safeVersion，而它不 await 时是 Promise。
   */
  await check('★ probe/ollama 的返回值可克隆（version 不能是 Promise）', () => provider.probe(OLLAMA));
  await check('★ probe/ollama 里 version 真的是字符串而不是对象', async () => {
    const r = await provider.probe(OLLAMA);
    // ok:false 时（没装 Ollama）version 是 undefined，也要放过
    if (!r.ok) return;
    assert.ok(r.version === undefined || typeof r.version === 'string',
      `version 是 ${typeof r.version}（${r.version && r.version.constructor
        ? r.version.constructor.name : '?'}）—— 应该 await 成字符串或 undefined`);
  });

  // ---- 其余分支：不可克隆的东西不能藏在失败路径里 ----
  // 用户填错地址时也必须能把错误送回去，而不是静默卡住
  await check('probe/地址为空 能把错误送回去', () => provider.probe({ engine: 'openai', base: '', model: 'x' }));
  await check('probe/连不上 能把错误送回去（ECONNREFUSED）',
    () => provider.probe({ engine: 'openai', base: 'http://127.0.0.1:59999', model: 'x' }));
  await check('probe/openai 失败路径', () => provider.probe({ engine: 'openai', base: 'http://127.0.0.1:59999/v1', model: 'x' }));
  await check('probe/anthropic 失败路径',
    () => provider.probe({ engine: 'anthropic', base: 'http://127.0.0.1:59999', model: 'x' }));
  await check('probe/ollama 地址非法（不是 URL）',
    () => provider.probe({ engine: 'ollama', base: '这不是地址', model: 'x' }));

  // ============================================================
  section('二、provider:capabilities（量表是纯常量，必须干净）');
  // ============================================================
  await check('capabilities 可克隆', async () => ({
    providers: presets.PROVIDERS,
    customs: presets.customs().map((c) => c.key),
  }));

  // ============================================================
  section('三、错误信息里不能有密钥');
  // ============================================================
  await check('密钥不会跟着返回值漏出去', async () => {
    const r = await provider.probe({
      engine: 'openai',
      base: 'http://127.0.0.1:59999/v1',
      model: 'x',
      apiKey: 'sk-THIS-IS-SECRET-DO-NOT-LEAK',
    });
    const s = JSON.stringify(r);
    assert.ok(!s.includes('sk-THIS-IS-SECRET'),
      `密钥漏进返回值了：${s.slice(0, 200)}`);
    return r;
  });

  // ============================================================
  section('四、这个检查本身是有效的');
  // ============================================================

  check('★ 判据会抓出 Promise（不是恒真）', () => {
    // 造一个和 bug 一模一样的返回值
    const bad = { ok: true, version: (async () => '0.40.3')(), models: [] };
    let threw = false;
    try { structuredClone(bad); } catch (_) { threw = true; }
    assert.ok(threw, '塞了 Promise 居然能克隆 —— 判据坏了，等于没测');
  });

  check('★ 判据不会误伤正常值', () => {
    structuredClone({ ok: true, version: '0.40.3', models: ['a'], latencyMs: 12 });
  });

  check('★ structuredClone 确实拒绝函数与 Symbol', () => {
    for (const bad of [{ f: () => {} }, { s: Symbol('x') }]) {
      let threw = false;
      try { structuredClone(bad); } catch (_) { threw = true; }
      assert.ok(threw, '函数/Symbol 本该不可克隆 —— 运行环境不对，判据结果不可信');
    }
  });

  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `IPC 可克隆性：${passed} 通过 / ${failures.length} 失败`
    : `IPC 可克隆性：${passed} 通过`);
  process.exit(failures.length ? 1 : 0);
})();
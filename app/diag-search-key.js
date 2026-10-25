/**
 * 诊断：联网搜索的 Key 到底存没存进去、搜索能不能真用。
 *
 * ## 为什么单独一个诊断脚本
 *
 * 羽毛菌报的现象是两条：
 *   1. 填了 Key，联网功能「依然没用」
 *   2. 保存后没有任何提示
 *
 * 这两条可能是**同一个根因**（保存静默失败 → 界面以为存好了 → 真搜索时才报错），
 * 也可能是**两个独立问题**（存进去了但没提示 / 提示了但搜索那条路另有故障）。
 * 读代码分不出来：`ToolCat.saveKey` → `preload.setSearchKey` → `main.tool:setSearchKey`
 * → `secret.save` → `loadSearchKey` → ctx.apiKey → `searchWeb`，整条链在纸面上是通的。
 *
 * ⚠ 所以这里**不桩任何东西**：真调 `secret-store.js` 的 save/load，真调 `tools.js`
 * 的 `searchWeb`。桩出来的"成功"证明不了运行时行为 —— 这是本项目反复踩过的坑。
 *
 * ## 为什么不能拿「搜 setup.exe 里有没有中文」那种判据
 *
 * 见 MEMORY：搜字节会假绿。搜索能不能用，只能看 `searchWeb` 的真实返回。
 *
 * ## 用什么 Key
 *
 * 没有真 Serper Key，所以分两段验：
 *   - **落库段**：用一个格式合法但无效的 Key，验它能不能存进去、能不能读回来。
 *     这一段能验证「保存」这条链路本身通不通。
 *   - **调用段**：拿同一个假 Key 真发一次请求，验请求**确实发出去了**
 *     （而不是在没配 Key 时就本地短路返回）。拿到 401/402 反而是好结果 ——
 *     说明 key 到位了、请求到服务端了，只是 Key 不对。
 *
 * 用法：./electron-run.cmd diag-search-key.js
 * 退出码：0 = 落库链路通；1 = 有问题。
 */

const { app } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const secret = require(path.join(APPDIR, 'electron', 'secret-store.js'));
const tools = require(path.join(APPDIR, 'electron', 'tools.js'));
// ⚠ httpRequest 不在 tools.js 的导出里 —— 它是 provider 模块的网络层，
//   主进程传进 ctx 的也是 provider.httpRequest。少传会让请求在本地直接抛，
//   看起来像"搜索坏了"，其实是脚本自己没喂对依赖。
const provider = require(path.join(APPDIR, 'electron', 'provider.js'));

const SEARCH_KEY_ID = '__web_search__';
/** 格式合法但一定无效的 Key —— 只用来验「请求有没有发出去」 */
const FAKE_KEY = 'diag_invalid_key_0123456789abcdef0123456789abcdef';

const fails = [];
const expect = (label, cond, why) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fails.push(`${label} —— ${why || ''}`);
};

app.whenReady().then(async () => {
  console.log('\n=== 1. secret-store 的加密能力 ===');
  // ⚠ 必须先 init()：encAvailable 是模块级变量，默认 false。
  //   不 init 就量，量到的是「默认值」而不是这台机器的真实能力 ——
  //   我第一版就漏了这步，得出「系统没加密服务」的错误结论。
  //   main.js:718 在 whenReady 里是调了 init() 的，所以那里才是真实运行路径。
  const encAvail = secret.init();
  console.log('  isEncryptionAvailable():', encAvail);
  console.log('  isEncrypted():', secret.isEncrypted());
  console.log('  ⚠ 若 isEncryptionAvailable 为 false，Key 只在本次运行有效 ——');
  console.log('    重启即失效，而界面上「已保存」的提示会误导人。');

  console.log('\n=== 2. 存之前 ===');
  const before = secret.load(SEARCH_KEY_ID);
  console.log('  load() =', JSON.stringify(before), before ? '← 之前存过' : '← 本来就是空');

  console.log('\n=== 3. 存（真调 secret.save）===');
  const saveRes = secret.save(FAKE_KEY, SEARCH_KEY_ID);
  console.log('  save() 返回:', JSON.stringify(saveRes));
  expect('save 返回 ok', saveRes && saveRes.ok === true,
    `保存失败：${saveRes && saveRes.error}`);
  if (saveRes && saveRes.encrypted === false) {
    console.log('  ⚠⚠ 这次没有加密，只进内存。**重启后必失效** ——');
    console.log('     这是「保存了却用不了」最可能的真实原因。');
  }

  console.log('\n=== 4. 读回来（真调 secret.load）===');
  const after = secret.load(SEARCH_KEY_ID);
  console.log('  load() 长度 =', String(after).length, '与传入一致?', after === FAKE_KEY);
  expect('save 之后 load 得到同一个 Key', after === FAKE_KEY,
    `读回来的是 ${JSON.stringify(String(after).slice(0, 12))}…`);

  console.log('\n=== 5. searchWeb 的「没配 Key」分支（应该本地短路，不发请求）===');
  const noKey = await tools.searchWeb('测试', { apiKey: '', provider: 'serper', httpRequest: provider.httpRequest });
  console.log('  返回:', JSON.stringify(noKey).slice(0, 160));
  expect('没 Key 时明确说没配，而不是假装搜过',
    noKey && noKey.ok === false && !/没有结果|无结果/.test(String(noKey.output)),
    '没配 Key 却返回「没有结果」，那是在骗模型、骗用户');

  console.log('\n=== 6. 带 Key 真发一次请求 ===');
  const withKey = await tools.searchWeb('WriteTool 测试', {
    apiKey: after, provider: 'serper', httpRequest: provider.httpRequest, timeout: 20000,
  });
  const txt = JSON.stringify(withKey);
  console.log('  返回（截断 300 字）:', txt.slice(0, 300));
  // ⚠ 期望是「拿到了服务端的错误」（401/402/配额），而不是本地短路。
  //   只要错误信息里出现 HTTP 状态码，就说明请求真的发出去了。
  const reachedServer = /\b(401|402|403|429)\b/.test(txt);
  console.log('  到达服务端?', reachedServer ? '是（拿到了 HTTP 状态码）' : '否（可能是本地短路）');
  expect('带 Key 时请求确实发到服务端（拿到 401/402 而非本地短路）',
    reachedServer,
    `没拿到 HTTP 状态码，请求可能没发出去：${txt.slice(0, 200)}`);

  console.log('\n=== 7. provider 分发（bing 档位是否真能选）===');
  const bing = await tools.searchWeb('x', { apiKey: after, provider: 'bing', httpRequest: provider.httpRequest, timeout: 15000 });
  const btxt = JSON.stringify(bing);
  console.log('  bing 返回:', btxt.slice(0, 200));
  expect('provider=bing 走的是 Bing 自己的请求格式',
    /Ocp-Apim|bing\.com|azure/i.test(btxt) || /\b(401|403)\b/.test(btxt),
    `看不到 Bing 的特征：${btxt.slice(0, 160)}`);

  console.log('\n=== 8. 清理：把诊断 Key 抹掉 ===');
  secret.save('', SEARCH_KEY_ID);
  console.log('  已清空，load() =', JSON.stringify(secret.load(SEARCH_KEY_ID)));

  if (fails.length) {
    console.log(`\n✗ ${fails.length} 条没过：`);
    for (const f of fails) console.log(`  - ${f}`);
    app.exit(1);
  }
  console.log('\n✓ 落库与调用链路都通 —— 问题若仍存在，方向要转到 UI 提示与工具放行');
  app.exit(0);
});

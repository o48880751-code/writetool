/**
 * 真·端到端：在这台机器上用**源码**跑通一整条对话。
 *
 * ## 为什么要有这个
 *
 * 2026-10-15 羽毛菌装完 1.0.8 报「连接 127.0.0.1:11434 超时」
 * 「连接 api.siliconflow.cn 超时」，而安装版的日志里
 * 网络失败**一个字都没有**，只能靠猜。
 *
 * 猜是没有出路的。这个脚本把整条链拆开一次问清：
 *   真 Electron（真 ipcMain.handle、真结构化克隆）
 *   → 真 preload（window.api.*）
 *   → 真 main.js 的 conv:send
 *   → 真 provider.js（真 https.request）
 *   → 真模型（不 mock 网络）
 * 然后把每一段的耗时与错误原样打出来。
 *
 * ## 三条硬规矩
 *
 * 1. **不碰用户的真库。** userData 指向临时目录，只复制三样东西：
 *    config.json、writetool.db、Local State。
 *    Local State 必须一起复制 —— safeStorage 的密文用那把 key 加的，
 *    没有它解不开密钥，于是会误判成"密钥没填"。
 * 2. **不 stub electron / ipcMain / 网络。** 这三个正是出问题的地方。
 * 3. **provider 的日志同时打到控制台**（require main.js 之后再覆盖 setLog，
 *    同一模块实例，替换掉写文件那个）。
 *
 * 运行：.\electron-run.cmd e2e-real-chat.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

// ---- 只读用户的真配置，把库复制到临时目录 ----
const REAL = path.join(process.env.APPDATA || '', 'writetool');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-e2e-'));
for (const f of ['config.json', 'writetool.db', 'Local State']) {
  const src = path.join(REAL, f);
  if (!fs.existsSync(src)) {
    console.error(`❌ 用户目录里没有 ${f}：${REAL}`);
    console.error('   先用软件存一次连接与密钥，再跑这个脚本。');
    app.exit(2);
  }
  fs.copyFileSync(src, path.join(TMP, f));
}
app.setPath('userData', TMP);   // ⚠ 必须在 require main.js 之前

const APPDIR = __dirname;
const LIMIT = Number(process.env.E2E_LIMIT_MS || 240000);
const PROMPT = process.env.E2E_PROMPT
  || '用三句话说明「什么是江湖」。不要调用任何工具，直接回答。';

const conn = () => JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));

// ---- 可指定用哪条连接跑（E2E_CONN=ollama / siliconflow / 连接 id）----
/**
 * ⚠ 只改**临时副本**里的 config.json，不碰用户真库。
 *   羽毛菌 2026-10-15 报的两张图分别是「本地超时」和「云端超时」，
 *   两条路径必须各真打一次 —— 它们的失败原因完全不同。
 */
function switchConn(which) {
  if (!which) return;
  const p = path.join(TMP, 'config.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(TMP, 'writetool.db'), { readOnly: true });
  const rows = db.prepare('SELECT id, name, protocol FROM connections').all();
  db.close();
  const hit = rows.find((r) => r.id === which)
    || rows.find((r) => String(r.protocol) === which)
    || rows.find((r) => String(r.name).toLowerCase().includes(String(which).toLowerCase()));
  if (!hit) {
    console.error(`❌ 没有名叫「${which}」的连接。可选：`
      + rows.map((r) => `${r.name}(${r.protocol})`).join('、'));
    app.exit(2);
    return;
  }
  c.activeConnectionId = hit.id;
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
  console.log(`已切到连接：${hit.name}（${hit.protocol}）`);
}
switchConn(process.env.E2E_CONN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ⚠ main.js 必须在 **app ready 之前** require。
 *   它顶层会调 `protocol.registerSchemesAsPrivileged`，而那个 API
 *   ready 之后就调不了（会抛 "should be called before app is ready"）。
 *   所以整个 require 放在 whenReady 链外面；
 *   它自己的 whenReady 回调因为先注册，会在建库建窗之前排在我们前面。
 */
// ⚠ provider 的日志要在 main.js **之后** 才能接管。
//   main.js 在自己的 require 里调 `provider.setLog(log)`（写文件），
//   谁先谁后生效 —— 放在前面会被无声覆盖，第一版就踩了。
const provider = require(path.join(APPDIR, 'electron', 'provider.js'));

console.log('userData（临时，不碰真库）：', TMP);
require(path.join(APPDIR, 'electron', 'main.js'));

app.whenReady().then(async () => {
  provider.setLog((...a) => console.log('   ', ...a));
  await sleep(1500);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('❌ 没起窗口'); app.exit(1); return; }
  /**
   * ⚠⚠ 窗口**保持可见**，不要 hide()。
   *
   * 第一版 hide 掉窗口跑，结果是：主进程 provider 侧统计到 79 字正文、
   * 而渲染进程的收集器收到 0 字。当时分不清是"界面收不到流式"
   * 还是"隐藏窗口导致 IPC 不派发"—— 这两件事的结论完全相反。
   * 所以这里让窗口露着跑，并把 visibilityState 打出来。
   * 用户会看到窗口自己弹出、内容一个字一个字出现，这是**要给人看的**。
   */
  try { win.setPosition(40, 40); } catch (_) { /* 位置无所谓 */ }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await sleep(800);
  const vis = await win.webContents.executeJavaScript('document.visibilityState');
  console.log('渲染进程可见性：', vis);
  if (vis === 'hidden') {
    console.log('⚠️ 窗口仍是 hidden —— 这次结果不能用来判断"流式推没推到界面"');
  }

  // 渲染进程自己的报错也要看到 —— executeJavaScript 失败时细节都在那边
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    const m = d && typeof d === 'object' ? d.message : args[2];
    const lv = d && typeof d === 'object' ? d.level : args[1];
    if (!m || /gpu|GPU|Autofill|devtools|Download the React|deprecated/i.test(m)) return;
    console.log(`   [renderer${lv === 'error' || lv === 3 ? ' ✗' : ''}] ${m}`);
  });

  // ---- 走真实 preload 通道 ----
  /**
   * ⚠ 每一步都包一层并**打���是哪一步**。
   *   executeJavaScript 抛出来的只有一句 "Script failed to execute"，
   *   不定位就得逐个试 —— 而这里有七八步。
   */
  const j = async (code, label) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (e) {
      console.error(`\n❌ 这一步炸了：${label || code.slice(0, 60)}\n   ${e.message}\n`);
      console.error('   渲染进程日志见上方 [renderer] 行。');
      throw e;
    }
  };

  const pid = 'e2e-' + Date.now().toString(36);
  await j(`window.api.project.create({ id: '${pid}', name: 'e2e临时' })`, 'project:create');
  const convId = await j(`(async () => {
    const c = await window.api.conv.create({ projectId: '${pid}', title: 'e2e' });
    return c.id;
  })()`, 'conv:create');
  console.log(`\n项目 ${pid} / 对话 ${convId}\n`);

  /**
   * 预填长历史（E2E_PRELOAD=n）。
   *
   * ⚠ 为什么必须能造这个场景：羽毛菌那轮是
   *   消息=8 / 正文=84227 字节，而且 `工具=0` ——
   *   也就是说历史里**一条工具消息都没有**。
   *   而 `LoopContextGuard.ensure()` 的策略是丢工具配对组与孤立条目，
   *   没有工具消息时它**一条都丢不掉**（实测 starved=true 干看着）。
   *   单轮小请求测不出这个问题，必须先把历史堆起来。
   */
  const preload = Number(process.env.E2E_PRELOAD || 0);
  if (preload > 0) {
    const { DatabaseSync } = require('node:sqlite');
    const db2 = new DatabaseSync(path.join(TMP, 'writetool.db'));
    const ins = db2.prepare(
      "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)");
    const CORPUS = [
      '大雍王朝立国四十余年，皇权渐衰，门阀世族把持朝政，地方节度使拥兵自重。',
      '江湖并非朝堂的对立面，而是同一套秩序在明处与暗处的两副面孔。',
      '天工院掌握冶铁、水利与火药之术，武库收纳历代兵器与图谱，两者皆为各方争夺。',
      '男主李长乐，字无忧，生于江南沈家，自幼由养父抚养，不知身世。',
      '春闱舞弊案牵出江南数十名官员，也牵出二十年前的一桩旧案。',
    ];
    let total = 0;
    for (let i = 0; i < preload; i++) {
      let body = `第 ${i + 1} 轮设定补充：\n`;
      while (body.length < 9000) body += CORPUS[i % CORPUS.length] + '\n';
      ins.run(convId, i % 2 === 0 ? 'user' : 'assistant', body, new Date().toISOString());
      total += body.length;
    }
    db2.close();
    console.log(`已预填 ${preload} 条长消息，约 ${total} 字（${total * 3} 字节）\n`);
  }

  const conns = await j('window.api.provider.listConnections()', 'provider:listConnections');
  // ⚠ 这一段配置是**切过连接之后**才读的。模型名/base/engine 一律以
  //   connections 表里那条为准（主进程 providerConfig 就是这么算的），
  //   config.json 里那三个是老字段，早就被同步覆盖了 ——
  //   打印旧字段会自己把自己绕进去（第一版就绕过一次）。
  const active = conns.find((x) => x.id === conn().activeConnectionId) || conns[0];
  console.log(`实际会打的连接：${active.name}  ${active.protocol}  ${active.base}  ${active.model}\n`);

  await j(`(() => {
    window.__e2e = { text: '', think: '', err: '', done: null, tools: 0, toolNames: [] };
    window.api.generate.onChunk((t) => { window.__e2e.text += t; });
    window.api.generate.onThink((t) => { window.__e2e.think += t; });
    window.api.generate.onError((e) => { window.__e2e.err = String((e && e.message) || e); });
    window.api.generate.onDone((m) => { window.__e2e.done = m || {}; });
    // ⚠ 工具事件不在 generate 域下（generate 里只有 chunk/think/done/error/stop），
    //   这里不订阅它 —— 本次 toolsEnabled:false，本来也不该有工具调用。
    return true;
  })()`, '挂订阅');

  const t0 = Date.now();
  await j(`window.api.conv.send({
    conversationId: '${convId}', projectId: '${pid}',
    text: ${JSON.stringify(PROMPT)}, refs: [], toolsEnabled: false
  }).then(() => 'started', (e) => 'ERR:' + e.message)`);

  // ---- 等结果 ----
  let st = null;
  while (Date.now() - t0 < LIMIT) {
    await sleep(1000);
    st = await j('({ ...window.__e2e })');
    if (st.done || st.err) break;
  }

  console.log('\n================ 结果 ================');
  console.log(`耗时        ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`思考        ${st.think.length} 字`);
  console.log(`正文        ${st.text.length} 字`);
  if (st.err) console.log(`\n❌ 报错    ${st.err}`);
  if (st.done) console.log(`完成标记    ${JSON.stringify(st.done)}`);
  if (!st.err && !st.done) console.log('\n⚠️  到时限仍在生成（不算失败，只是慢）');
  if (st.text) console.log(`\n--- 正文开头 ---\n${st.text.slice(0, 400)}`);

  /**
   * ⚠⚠ 判定要问的是**界面收到了没有**，不是"主进程拿到没有"。
   *
   * 2026-10-15 那个 bug 在这一层是看不见的：provider 侧统计到 79 字正文、
   * onDone 也带着 text 回来了，只有渲染进程的收集器是 0。
   * 模型确实答了，只是正文从来没走到界面上 —— 而落库也依赖同一段，
   * 所以助手消息一条都没存。
   *
   * 反向：只看「done.text 非空」判通过，那个 bug 会永远绿。
   */
  const bad = [];
  if (!st.err && !st.done) bad.push('到时限还没结束');
  if (st.err) bad.push('生成报错：' + st.err);
  if (!st.text && st.done && String(st.done.text || '').trim()) {
    bad.push(`★ 主进程拿到了 ${String(st.done.text).trim().length} 字，`
      + '但渲染进程收到 0 字 —— 正文没推到界面上（多半是 handler 键名对不上）');
  }
  if (!st.text && !String((st.done && st.done.text) || '').trim()) {
    bad.push('模型一个字的正文都没给');
  }

  // 落库这一项也要查：助手消息在不在库里，是"用户刷新后还能不能接着聊"的前提
  let stored = null;
  try {
    stored = await j(`(async () => {
      const ms = await window.api.conv.messages({ conversationId: '${convId}' });
      return ms.map((m) => m.role + ':' + String(m.content || '').length);
    })()`, 'conv:messages 复查');
  } catch (_) { /* 上面已经报过了 */ }
  console.log('落库消息    ' + JSON.stringify(stored));
  if (Array.isArray(stored) && !stored.some((x) => x.startsWith('assistant:'))) {
    bad.push('★ 助手消息没有落库 —— 刷新页面后这段回答会消失');
  }

  console.log('日志文件：' + path.join(app.getPath('temp'), 'writetool-debug.log'));
  if (bad.length) {
    console.log('\n===== ❌ 判定不通过 =====');
    for (const b of bad) console.log('  · ' + b);
    app.exit(1);
  }
  console.log('\n===== ✅ 端到端通过：模型有回、界面收到、并且落库了 =====');
  app.exit(0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });

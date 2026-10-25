/**
 * 判据 + 截图：**模型正在思考、正文还没来**时，聊天区不能出现空气泡。
 *
 * ## 为什么单独一条
 *
 * 2026-10-15 羽毛菌发的第一张图里，思考文字下面挂着一个
 * 什么都没有的圆角框，他直接问「这么大一个框是干什么」。
 *
 * 根因在 ChatPanel 的正文气泡：
 *     {streamingText || (streamingThink ? '' : '…')}
 * 有思考、没正文时这个表达式是**空字符串** —— 于是渲染出一个
 * 尺寸正常、内容为空的 .msg-ai 气泡。
 *
 * ## 为什么用真渲染而不是扫源码
 *
 * "表达式求值结果是空串"这件事，扫源码只能扫出**写法**，
 * 扫不出后果。而这条判据要断言的正是后果：DOM 里到底有没有
 * 那一个空框。项目里没有 jsdom，但有真的 Electron 窗口 ——
 * 用它。
 *
 * ⚠ 反向用例必须有：光断言"没有 .msg-ai.streaming"，
 *   把气泡整个删掉也是绿的 —— 那就变成"恒真"了。
 *   所以再来一步：推一段正文，气泡**必须**带着那段文字出现。
 *
 * 运行：.\electron-run.cmd shoot-chat-empty.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableBackgroundThrottling = true;

const APPDIR = __dirname;
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const PID = 'shot-empty';
const CONV = 'cv-shot-empty';

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---- IPC 桩 ----
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', theme: 'ink',
  notify: 'none', currentProject: PID, thinkLevel: 'off',
  activeConnectionId: 'conn-1', autoSkill: false, toolsEnabled: false,
};

function fallbackFor(ch) {
  if (ch === 'config:get') return CFG;
  if (/_list$|_get$|messages$/.test(ch)) return [];
  return null;
}
for (const ch of ALL_CHANNELS) {
  const fb = fallbackFor(ch);
  h(ch, () => fb);
}

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.0', full: 'v1.0.0' }));
h('project:list', () => [{ id: PID, name: '空框判据', createdAt: '' }]);
h('project:open', () => CFG);
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));
h('fs:tree', () => ({ name: '空框判据', type: 'dir', children: [] }));
h('conv:list', () => [{ id: CONV, projectId: PID, title: '空气泡判据', messageCount: 1 }]);
h('conv:messages', () => [{ id: 'm1', conversationId: CONV, role: 'user', content: '第三卷接着写' }]);
h('conv:create', () => ({ id: CONV, projectId: PID, title: '空气泡判据' }));
h('conv:send', () => ({ started: true }));
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => []);

console.log(`通道桩：${ALL_CHANNELS.length} 个`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * ⚠⚠ 必须关掉后台节流，而且截图前要 showInactive()。
       *
       * 窗口不显示时 Chromium 判定它在后台：rAF 不跑、渲染被压到最低，
       * capturePage 会**返回上一帧**（甚至是首帧）。
       * 症状是 DOM 断言全绿、PNG 却是另一个状态 —— 第一次跑就是这样：
       * 脚本说"思考块在"，图上却还是「开始一个新对话」的空态。
       */
      backgroundThrottling: false,
    },
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    const m = d && typeof d === 'object' ? d.message : args[2];
    const lv = d && typeof d === 'object' ? d.level : args[1];
    if (!m || /gpu|GPU|Autofill|devtools|Download the React/i.test(m)) return;
    console.log('  [renderer]', m);
    if (lv === 'error' || lv === 3) rendererErrors.push(String(m));
  });

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));

  const mask = () => win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.msg-ai.streaming');
      const d = document.querySelector('details');
      const talk = document.querySelector('textarea');
      const flow = talk ? talk.closest('div.px-5') : null;
      return {
        userBubbles: document.querySelectorAll('.msg-user').length,
        streamingBubbles: document.querySelectorAll('.msg-ai.streaming').length,
        streamingText: b ? b.textContent : null,
        streamingRect: b ? Math.round(b.getBoundingClientRect().width) + 'x'
          + Math.round(b.getBoundingClientRect().height) : null,
        thinkShown: !!d,
        thinkText: d ? d.textContent.replace(/\\s+/g, ' ').slice(0, 40) : null,
        thinkInView: d ? (d.getBoundingClientRect().top > 0
          && d.getBoundingClientRect().top < window.innerHeight) : false,
        // ⚠ "空态还在"说明消息流里其实什么都没有 —— 那时候断言"没有空气泡"
        //   是无意义的（空态本来就没有气泡）。这一项是给判据自己兜底的。
        emptyState: /开始一个新对话/.test(document.body.innerText),
        flowScrollTop: flow ? Math.round(flow.scrollTop) : null,
      };
    })()
  `);

  console.log('\n一、真的进入了「正在生成」状态');
  // 喂一行字再回车 —— 走的是用户真实路径（受控输入要绕过 React 的 value setter）
  const sent = await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '第三卷接着写');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return 'ok';
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));

  // 推思考分片：模型开始思考，正文还没有
  win.webContents.send('generate:think', '我先理一下第三卷的线索：北燕入侵、天工院、武库……');
  await new Promise((r) => setTimeout(r, 700));

  const thinking = await mask();
  console.log('  发送结果:', sent, '｜状态:', JSON.stringify(thinking));

  await check('★ 判据自己的前提：真的在一个有消息的对话里', () => {
    // 空态下"没有空气泡"是废话 —— 那时候本来就没有任何气泡。
    // 这一项挡住"判据恒真"。
    assert(!thinking.emptyState,
      '界面上还是「开始一个新对话」的空态 —— 这时候断言"没有空气泡"没有意义。'
      + '说明夹具没把对话选中/消息没加载，判据是假的。');
    assert(thinking.userBubbles >= 1, `一条用户消息都没有：${JSON.stringify(thinking)}`);
  });
  await check('★ 思考中：思考块要看得见（否则用户以为程序死了）', () => {
    assert(thinking.thinkShown, '思考内容没渲染出来，说明根本没进生成态');
    assert(thinking.thinkInView, `思考块在视口外（top=${thinking.thinkInView}）——截图拍不到`);
  });
  await check('★ 思考中：不得留下空白的正文气泡', () => {
    assert(thinking.streamingBubbles === 0,
      `聊天区有 ${thinking.streamingBubbles} 个 .msg-ai.streaming 气泡`
      + `（尺寸 ${thinking.streamingRect}，内容 ${JSON.stringify(thinking.streamingText)}）`
      + ' —— 这就是羽毛菌问的那个"这么大一个框"');
    assert(thinking.streamingText === null || thinking.streamingText !== '');
  });

  /**
   * 截图。
   *
   * ⚠ 先把窗口弄成"前台"再等 900ms，否则拿到的是旧帧
   *   （见 webPreferences 里那段注释）。
   */
  const shot = async (name) => {
    try { win.showInactive(); } catch (_) { /* 沙箱里可能不让显示 */ }
    win.focus();
    await new Promise((r) => setTimeout(r, 900));
    let img = null;
    for (let i = 0; i < 3; i++) {
      try { img = await win.webContents.capturePage(); } catch (e) {
        // ⚠ capturePage 偶尔抛 UnknownVizError，未捕获的拒绝会把脚本带走
        console.log('    capturePage 第 ' + (i + 1) + ' 次失败：' + e.message);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (img && !img.isEmpty()) break;
    }
    if (!img || img.isEmpty()) throw new Error('capturePage 一直拿到空图');
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const st = fs.statSync(file);
    // ⚠ 尺寸要验：全白/全黑也会写出一个 PNG，只有字节数会出卖它
    console.log(`  ✓ ${name}.png（${Math.round(st.size / 1024)}KB）`);
    return st.size;
  };
  const sizeA = await shot('chat-thinking-no-text');

  console.log('\n二、反向：正文一到，气泡必须带着文字出现');
  win.webContents.send('generate:chunk', '第三卷开篇可以从一场雨写起。');
  await new Promise((r) => setTimeout(r, 700));
  const answered = await mask();
  console.log('  状态:', JSON.stringify(answered));
  await check('★ 有正文时气泡要出现，而且带着那段文字', () => {
    assert(answered.streamingBubbles === 1,
      `正文来了却还是 ${answered.streamingBubbles} 个气泡（把气泡删掉不等于修好）`);
    assert(/第三卷开篇/.test(String(answered.streamingText)),
      `气泡里没有正文：${JSON.stringify(answered.streamingText)}`);
  });
  const sizeB = await shot('chat-with-text');

  await check('截图两张都要有内容（白图会一样小）', () => {
    assert(sizeA > 20000 && sizeB > 20000, `截图太小：${sizeA} / ${sizeB}`);
  });
  await check('渲染进程没有报错', () => {
    assert(rendererErrors.length === 0, rendererErrors.join('\n'));
  });

  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `空气泡判据：${passed} 通过 / ${failures.length} 失败`
    : `空气泡判据：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });

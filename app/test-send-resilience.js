/**
 * 判据：发送失败不吞用户消息 / 停止保留半截回答 / 工具卡是苹果风（2026-11-05）。
 *
 * 运行：./electron-run.cmd test-send-resilience.js
 *
 * ## 这里在防什么
 *
 * 1. **连不上模型时用户气泡消失**。主进程是「先落库用户消息、再连模型」，
 *    连不上时 conv:send 直接抛错；渲染层原来只显示红字、不重拉消息，
 *    用户看到的是一条都没有 —— 以为字白打了，换好模型再发一次才“出现”。
 *    这里让桩**先塞消息再抛错**，断言气泡必须在。
 * 2. **点停止后 AI 说的话没了**。主进程 stop 现在会把半截正文落库，
 *    渲染层收到 done{stopped} 要重拉消息。判据发一条 done{stopped} +
 *    桩返回半截回答，断言它出现在界面上。
 * 3. **正文吐完、done 没到 → 永远停在“生成中”**。代码里有 120 秒兜底，
 *    这条只能静态断言（真等两分钟不现实）。
 * 4. **工具调用卡片还是灰色方块**。真读 computed style：12px 圆角、无实边。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PKG_VERSION = require(path.join(APPDIR, 'package.json')).version;
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));

let CFG = {
  model: 'qwen3:latest', numCtx: 8192, temperature: 0.3,
  fontSize: 15, mode: 'light', notify: 'none', currentProject: 'p1',
  thinkLevel: 'off', editorFontSize: 16, chatFontSize: 16,
  editorFont: 'system-ui', chatFont: 'system-ui', toolsEnabled: false,
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: PKG_VERSION, full: 'v' + PKG_VERSION }));
h('project:list', () => ([{ id: 'p1', name: '测试书', kind: 'long', updated_at: '2026-11-05T10:00:00.000Z' }]));
h('project:stat', () => ({ id: 'p1', chars: 100, files: 2, dirs: 2, chapters: 1, todayChars: 0, streakDays: 1 }));
h('project:open', () => CFG);
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false }));
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('scope:get', () => ({ locked: false }));
h('fs:tree', () => ({ name: '', type: 'dir', path: '', children: [] }));

let MSGS = [];
let SEND_MODE = 'fail';
h('conv:list', () => ([{ id: 'c1', title: '测试对话', updated_at: '2026-11-05T10:00:00.000Z' }]));
h('conv:messages', () => MSGS);
h('conv:create', (p) => ({ id: 'c1', project_id: p.projectId, title: p.title || '' }));
h('conv:send', (p) => {
  if (SEND_MODE === 'fail') {
    // ⚠ 主进程是**先落库再连模型**的：抛错前必须把用户消息放进库，
    //   否则这条判据测的就不是「回显」而是「桩没写库」。
    MSGS = [...MSGS, {
      id: 'm-user-1', role: 'user', content: p.text, created_at: '2026-11-05T10:01:00.000Z',
    }];
    throw new Error('fetch failed');
  }
  return { started: true };
});

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, ok: !!ok });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 120 秒没跑完'); app.exit(1); }, 120000);

  const win = new BrowserWindow({
    width: 1400, height: 920, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  win.focus();

  async function js(code) {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { return { __err: e.message }; }
  }

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1500);
  // 从书架进编辑器
  await js("(function(){var b=document.querySelector('[data-testid=\"bookshelf-card\"]')||document.querySelector('[data-testid=\"shelf-hero-continue\"]');if(b)b.click();return true;})()");
  await sleep(1200);
  // 打开最近那条对话（有 MSGS 才会进消息流；先空）
  MSGS = [{
    id: 'm0', role: 'assistant', content: '上一轮的回答。', created_at: '2026-11-05T09:59:00.000Z',
  }];

  console.log('\n=== 一、连不上模型：用户气泡必须还在 ===');
  // 进对话
  await js("(function(){var b=document.querySelector('[data-welcome=\"continue\"]');if(b)b.click();return true;})()");
  await sleep(900);
  // ⚠ 受控输入 + React：要用原生 setter 再派发 input，直接赋值不生效
  await js(`(function(){
    var el=document.querySelector('textarea');
    if(!el) return 'no-textarea';
    var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(el,'111');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return el.value;
  })()`);
  await sleep(240);
  await js(`(function(){
    var el=document.querySelector('textarea');
    if(!el) return false;
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return true;
  })()`);
  await sleep(1400);

  const afterFail = await js(`(function(){
    var rows=[].slice.call(document.querySelectorAll('.msg-row.is-user'));
    return {
      userBubbles: rows.map(function(r){return (r.textContent||'').trim();}),
      bodyText: document.body.innerText || '',
      hasError: (document.body.innerText||'').indexOf('换一个模型') >= 0,
    };
  })()`);
  console.log('  ', JSON.stringify(afterFail));
  t('连不上模型时，用户气泡没有消失',
    (afterFail.userBubbles || []).some((x) => x.indexOf('111') >= 0),
    JSON.stringify(afterFail.userBubbles));
  t('报错文案直接告诉用户换一个模型（不是甩 fetch failed）',
    afterFail.hasError === true);

  console.log('\n=== 二、点停止：已经写出来的半截回答要留下 ===');
  MSGS = [
    { id: 'm-user-1', role: 'user', content: '111', created_at: '2026-11-05T10:01:00.000Z' },
    { id: 'm-a1', role: 'assistant', content: '我先看一眼项目里现在有什么。', created_at: '2026-11-05T10:01:10.000Z' },
  ];
  win.webContents.send('generate:done', { stopped: true });
  await sleep(900);
  const afterStop = await js(`(function(){
    var rows=[].slice.call(document.querySelectorAll('.msg-row'));
    return {
      count: rows.length,
      text: rows.map(function(r){return (r.textContent||'').trim();}).join(' || '),
    };
  })()`);
  console.log('  ', JSON.stringify(afterStop));
  t('停止后 AI 的半截回答还在界面上',
    (afterStop.text || '').indexOf('我先看一眼项目里现在有什么') >= 0, afterStop.text.slice(0, 60));
  t('停止后用户那条也没有被吞', (afterStop.text || '').indexOf('111') >= 0);

  console.log('\n=== 三、工具调用卡片是苹果风（圆角 12 / 无实边） ===');
  win.webContents.send('tool:start', { id: 't1', name: 'read_file', brief: '设定/世界观.md' });
  await sleep(180);
  win.webContents.send('tool:end', { id: 't1', name: 'read_file', status: 'done', brief: '设定/世界观.md', output: 'ok' });
  await sleep(700);
  // 收起态先点一下摘要展开，否则读到的是摘要行不是卡片
  await js("(function(){var b=document.querySelector('[data-testid=\"tool-calls-summary\"]');if(b)b.click();return true;})()");
  await sleep(500);
  const card = await js(`(function(){
    var box=document.querySelector('[data-testid^="tool-card-box-"]');
    if(!box) return { found:false };
    var s=getComputedStyle(box);
    return { found:true, radius:s.borderRadius, bg:s.backgroundColor,
             borderW:s.borderTopWidth, borderColor:s.borderTopColor, pad:s.padding };
  })()`);
  console.log('  ', JSON.stringify(card));
  t('工具卡渲染出来了', card.found === true);
  t('圆角是 12px（不是原来的 4px）', card.radius === '12px', card.radius);
  t('没有实边框（透明 1px 占位）',
    card.borderW === '1px' && /rgba\(0, 0, 0, 0\)|transparent/.test(card.borderColor),
    card.borderW + ' / ' + card.borderColor);
  t('底色是按 ink 算的浅底，不是纯 paper-2 方块',
    card.bg !== 'rgba(0, 0, 0, 0)' && card.bg !== 'transparent', card.bg);

  console.log('\n=== 四、静态护栏：兜底与落库顺序 ===');
  const mainSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'main.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(APPDIR, 'src', 'App.jsx'), 'utf8');
  const iStop = mainSrc.indexOf("handle('generate:stop'");
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const stopBlock = strip(mainSrc.slice(iStop, iStop + 2600));
  t('停止时先落库半截正文，再清 streamedText',
    stopBlock.indexOf('store.addMessage') >= 0 &&
    stopBlock.indexOf('store.addMessage') < stopBlock.indexOf("streamedText = ''"));
  t('停止会带上 savedPartial 告诉前端存了没有', stopBlock.indexOf('savedPartial') >= 0);
  t('主动停止引发的中断异常不会盖成红色错误',
    mainSrc.indexOf('if (stopRequested) { stopRequested = false; return; }') >= 0);
  t('两处发送失败都会重新拉消息（不是只显示红字）',
    (appSrc.match(/conv\.messages\(\{ conversationId: cid \}\)/g) || []).length >= 2);
  t('有“两分钟没新内容就自动停”的兜底',
    appSrc.indexOf('lastChunkAt') >= 0 && appSrc.indexOf('120000') >= 0);

  const failed = CHECKS.filter((c) => !c.ok);
  console.log('\n========== ' + (CHECKS.length - failed.length) + '/' + CHECKS.length + ' 通过 ==========');
  for (const f of failed) console.log('  ✗ ' + f.name);
  clearTimeout(watchdog);
  app.exit(failed.length ? 1 : 0);
});

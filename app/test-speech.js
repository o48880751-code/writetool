/**
 * 朗读功能判据（2026-11-11）。
 *
 * ## 为什么必须点真界面
 *
 * 「有喇叭按钮」这件事，源码里 grep 一下就能看到；
 * 但真正会错的是**它挂在哪条消息上**、**点了会不会真的发起朗读**、
 * **再点一次会不会停** —— 这三件只有跑起来才知道。
 *
 * ## speechSynthesis 在这台机器上怎么验
 *
 * 测试环境没有音频输出设备，`speak()` 可能立刻触发 error。
 * 所以判定标准不是"有没有出声"，而是：
 *   ① 调用链有没有走到 `speechSynthesis.speak`
 *   ② 状态有没有切到"正在朗读"
 * 出声本身只能真机听。
 *
 * 运行：./electron-run.cmd test-speech.js
 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, pass: !!ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '　' + detail}`);
}

// 临时项目目录：真机读文件用
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
fs.mkdirSync(path.join(ROOT, '章节'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '章节', '第一章 落墨.md'), '# 第一章\n正文');

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  ipcMain.handle(ch, async () => {
    try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: e.message }; }
  });
};
const pre = fs.readFileSync(path.join(APPDIR, 'electron/preload.js'), 'utf8');
for (const ch of [...new Set([...pre.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))]) {
  h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
}

/** 带 Markdown 的助手回复：清洗逻辑要在这里真跑一次 */
const ASSISTANT_MSG = [
  '**夜枫**停下脚步，`灯笼`往上提了提。',
  '',
  '| 名字暗示 | 现在的设定 |',
  '|---|---|',
  '| 夜枫 | 凡人剑修 |',
  '',
  '「你来了。」他说。这句话很短！',
].join('\n');

h('config:get', () => ({
  model: 'qwen3', mode: 'light', notify: 'none', currentProject: 'p1',
  chatFontSize: 15, editorFontSize: 15, editorFont: 'system-ui', chatFont: 'system-ui',
  thinkLevel: 'medium',
}));
h('config:set', () => null);
h('app:version', () => ({ version: '2.0.8', full: 'v2.0.8' }));
h('project:list', () => [{ id: 'p1', name: '墨染仙途', kind: 'long' }]);
h('scope:get', () => ({ locked: false, strikes: 0 }));
h('conv:list', () => [{ id: 'c1', title: '第三章 夜行', updated_at: Date.now() }]);
h('conv:messages', () => ([
  { id: 'm1', role: 'user', content: '这两个名字哪个好？' },
  { id: 'm2', role: 'assistant', content: ASSISTANT_MSG },
]));
h('fs:read', () => ({ content: '# 第一章\n正文', mtime: Date.now(), size: 20 }));
h('fs:history', () => []);
function withPath(node, parent) {
  const p = parent ? parent + '/' + node.name : (node.name || '');
  const out = { ...node, path: p };
  if (out.children) out.children = out.children.map((c) => withPath(c, p));
  return out;
}
h('fs:tree', () => withPath({
  name: '', type: 'dir', children: [
    { name: '章节', type: 'dir', children: [{ name: '第一章 落墨.md', type: 'file' }] },
  ],
}, ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 940, show: true, useContentSize: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron/preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1500);

  const js = async (code, tag) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log('JS_FAIL [' + tag + ']', e.message); return null; }
  };
  const click = async (sel) => js(`(function(){var b=document.querySelector('${sel}');if(!b)return false;b.click();return true;})()`, sel);

  // ---------- 一、进入项目并选中会话 ----------
  // ⚠ 文本清洗与分句是纯函数，这里**不测** —— 它跑在 node 里
  //   （test-speech-pure.mjs），在渲染进程里再验一遍只会写出恒真的假判据。
  console.log('\n=== 一、喇叭按钮出现在哪里 ===');
  const entered = await click('[data-testid="bookshelf-card"]') || await click('[data-testid="shelf-hero-continue"]');
  await sleep(1300);
  const picked = await js(`(function(){
    var it=document.querySelector('.conv-item');
    if(!it) return false;
    var b=it.querySelector('button')||it;
    b.click(); return true;
  })()`, 'pickConv');
  await sleep(1200);
  console.log('  进入编辑器:', entered, '| 选中会话:', picked);

  const btns = await js(`(function(){
    var rows=[].slice.call(document.querySelectorAll('.msg-row'));
    return rows.map(function(r){
      return {
        isUser: !!r.querySelector('.msg-user'),
        speaks: r.querySelectorAll('[data-testid="msg-speak"]').length,
        label: (r.querySelector('[data-testid="msg-speak"]')||{}).getAttribute
               ? r.querySelector('[data-testid="msg-speak"]').getAttribute('data-label') : '',
      };
    });
  })()`, 'btns');
  console.log('  消息行:', JSON.stringify(btns));

  const rows = Array.isArray(btns) ? btns : [];
  const userRows = rows.filter((r) => r.isUser);
  const aiRows = rows.filter((r) => !r.isUser);
  t('消息渲染出来了（至少一条用户 + 一条助手）', userRows.length >= 1 && aiRows.length >= 1,
    `用户 ${userRows.length} / 助手 ${aiRows.length}`);
  t('助手消息上有朗读按钮', aiRows.every((r) => r.speaks === 1),
    aiRows.map((r) => r.speaks).join(','));
  t('用户消息上没有朗读按钮（念自己写的话没意义）',
    userRows.every((r) => r.speaks === 0), userRows.map((r) => r.speaks).join(','));
  t('按钮的悬停说明是「朗读这条」',
    aiRows.every((r) => r.label === '朗读这条'), aiRows.map((r) => r.label).join('|'));

  // ---------- 三、点击真的发起朗读 ----------
  console.log('\n=== 二、点击后有没有真的调用 speechSynthesis ===');
  /**
   * ⚠ 在页面里拦 speak()：测试环境没有音频设备，
   *   "有没有出声"验不了；能验的是"有没有走到这一步"。
   */
  const hooked = await js(`(function(){
    window.__spoken = [];
    if (!window.speechSynthesis) return 'no-synth';
    var sp = window.speechSynthesis;
    if (!sp.__patched) {
      var orig = sp.speak.bind(sp);
      sp.speak = function(u){ window.__spoken.push(String(u && u.text || '')); return orig(u); };
      sp.__patched = true;
    }
    return 'ok';
  })()`, 'hook');
  console.log('  拦 speak:', hooked);

  const clicked = await click('[data-testid="msg-speak"]');
  await sleep(900);

  const after = await js(`(function(){
    var b=document.querySelector('[data-testid="msg-speak"]');
    return {
      spoken: (window.__spoken||[]),
      cls: b ? b.className : '',
      label: b ? b.getAttribute('data-label') : '',
      iconPaths: b ? b.querySelectorAll('svg path').length : 0,
      /**
       * ⚠ 必须从**朗读按钮**往上找它自己的操作区（2026-11-11 踩）。
       *   写成 document.querySelector('.msg-acts') 拿到的是**第一条消息**
       *   （用户那条）的操作区 —— 它当然没有 speaking 类，量出来永远 0.4，
       *   于是判据恒红，而功能其实是好的。
       */
      actsOpacity: (function(){
        var b=document.querySelector('[data-testid="msg-speak"]');
        var a=b ? b.closest('.msg-acts') : null;
        return a ? getComputedStyle(a).opacity : 'none';
      })(),
      actsHasClass: (function(){
        var b=document.querySelector('[data-testid="msg-speak"]');
        var a=b ? b.closest('.msg-acts') : null;
        return a ? a.className : '';
      })(),
    };
  })()`, 'after');
  console.log('  点击结果:', JSON.stringify(after));

  t('点击后调用了 speechSynthesis.speak', !!(after && after.spoken && after.spoken.length > 0),
    after && after.spoken ? after.spoken.length + ' 次' : 'null');
  t('念的是清洗过的文本（没有 Markdown 符号）',
    !!(after && after.spoken && after.spoken.every((s) =>
      s.indexOf('**') < 0 && s.indexOf('|') < 0 && s.indexOf('`') < 0)),
    after && after.spoken ? JSON.stringify(after.spoken.slice(0, 2)) : '');
  t('按钮切到「停止朗读」状态',
    !!(after && after.cls && after.cls.indexOf('speaking') >= 0 && after.label === '停止朗读'),
    after ? (after.cls + ' / ' + after.label) : '');
  t('朗读中操作区常显（鼠标移开也看得见）',
    !!(after && Number(after.actsOpacity) === 1), after ? after.actsOpacity : '');

  // ---------- 四、再点一次要能停 ----------
  console.log('\n=== 三、再点一次能停 ===');
  const beforeStop = await js('(window.__spoken||[]).length', 'beforeStop');
  await click('[data-testid="msg-speak"]');
  await sleep(700);
  const stopped = await js(`(function(){
    var b=document.querySelector('[data-testid="msg-speak"]');
    return { cls: b?b.className:'', label: b?b.getAttribute('data-label'):'',
             spoken: (window.__spoken||[]).length };
  })()`, 'stopped');
  console.log('  停止后:', JSON.stringify(stopped), '| 停止前已念:', beforeStop);
  t('再点一次后按钮回到「朗读这条」',
    !!(stopped && stopped.label === '朗读这条' && stopped.cls.indexOf('speaking') < 0),
    stopped ? (stopped.cls + ' / ' + stopped.label) : '');
  t('停止后不再继续念新句子', !!(stopped && stopped.spoken === beforeStop),
    stopped ? `${stopped.spoken} vs ${beforeStop}` : '');

  // ---------- 截图 ----------
  try {
    await win.capturePage();
    await sleep(300);
    const shotDir = path.join(APPDIR, 'shots');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'v12-speech.png'), (await win.capturePage()).toPNG());
    console.log('\n截图：shots/v12-speech.png');
  } catch (_) { /* 截图失败不影响判据 */ }

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n========== ${CHECKS.length - bad.length}/${CHECKS.length} 通过 ==========`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));

  fs.rmSync(ROOT, { recursive: true, force: true });
  app.exit(bad.length ? 1 : 0);
});

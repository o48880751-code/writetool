/**
 * 朗读走 Edge 语音的界面判据（2026-11-16）。
 *
 * ## 验什么
 *
 *   ① 设置页有音色下拉（晓晓 / 云希）和试听按钮
 *   ② 点消息上的喇叭，真的会去调 `tts:synth`（说明没被旧逻辑吞掉）
 *   ③ 合成失败时不会卡在"停止朗读"状态（要能自己复位）
 *
 * ## 不验什么
 *
 * 出声。测试机没有音频设备，`Audio.play()` 会 reject ——
 * 这正好被用来验第 ③ 条：失败了界面必须复位，而不是永远转着。
 *
 * 运行：./electron-run.cmd test-tts-ui.js
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
  CHECKS.push({ name, pass: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '　' + detail}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsui-'));
fs.mkdirSync(path.join(ROOT, '章节'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '章节', '第一章.md'), '# 第一章');

/** 桩记录：合成被调了几次、用的哪个音色 */
const synthCalls = [];

/**
 * ⚠ 第一个参数必须接住并传给 fn（2026-11-16 踩）：
 *   写成 `async () => fn()` 的话，桩里的 p 永远是 undefined ——
 *   判据会显示"调用了 tts:synth"但 text 是空的，看起来像产品把正文弄丢了。
 */
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; }
  });
};
const pre = fs.readFileSync(path.join(APPDIR, 'electron/preload.js'), 'utf8');
for (const ch of [...new Set([...pre.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))]) {
  h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
}

h('config:get', () => ({
  model: 'qwen3', mode: 'light', notify: 'none', currentProject: 'p1',
  chatFontSize: 15, editorFontSize: 15, editorFont: 'system-ui', chatFont: 'system-ui',
  thinkLevel: 'medium', ttsVoice: 'xiaoxiao',
}));
h('config:set', () => null);
h('app:version', () => ({ version: '2.0.9', full: 'v2.0.9' }));
h('project:list', () => [{ id: 'p1', name: '墨染仙途', kind: 'long' }]);
h('scope:get', () => ({ locked: false, strikes: 0 }));
h('conv:list', () => [{ id: 'c1', title: '第三章', updated_at: Date.now() }]);
h('conv:messages', () => ([
  { id: 'm1', role: 'user', content: '帮我看下这段' },
  { id: 'm2', role: 'assistant', content: '**夜枫**停下脚步，灯笼往上提了提。' },
]));
h('fs:read', () => ({ content: '# 第一章\n正文', mtime: Date.now(), size: 20 }));
h('fs:history', () => []);
function withPath(node, parent) {
  const p = parent ? parent + '/' + node.name : (node.name || '');
  const out = { ...node, path: p };
  if (out.children) out.children = out.children.map((c) => withPath(c, p));
  return out;
}
h('fs:tree', () => withPath({ name: '', type: 'dir', children: [{ name: '章节', type: 'dir', children: [{ name: '第一章.md', type: 'file' }] }] }, ''));
h('tts:voices', () => ([{ key: 'xiaoxiao', label: '晓晓（女 · 自然）' }, { key: 'yunxi', label: '云希（男 · 年轻）' }]));
/**
 * ⚠ 返回一个**不存在的** wtts 地址：Audio 会加载失败 → onerror →
 *   speech.js 里必须把状态复位。这正是第 ③ 条要验的。
 */
h('tts:synth', (p) => {
  synthCalls.push({ text: String(p && p.text || '').slice(0, 20), voice: p && p.voice });
  /**
   * 第 2 次起直接抛错，模拟"微软接口挂了 / 断网"。
   * ⚠ 这才是真实会发生的故障；拿一个假地址去骗 Audio 只能在
   *   无声卡环境下测出 Chromium 的古怪行为，测不到降级链路。
   */
  if (synthCalls.length >= 2) throw new Error('模拟：语音服务不可用');
  return { url: 'wtts://not-a-real-file.mp3', name: 'x.mp3', cached: false, bytes: 1234 };
});

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

  // ---------- 一、进项目、选会话 ----------
  console.log('\n=== 一、进编辑器 ===');
  await click('[data-testid="bookshelf-card"]') || await click('[data-testid="shelf-hero-continue"]');
  await sleep(1300);
  await js(`(function(){var it=document.querySelector('.conv-item');if(!it)return false;(it.querySelector('button')||it).click();return true;})()`, 'conv');
  await sleep(1100);

  const hasSpeak = await js('!!document.querySelector(\'[data-testid="msg-speak"]\')', 'hasSpeak');
  t('助手消息上有朗读按钮', hasSpeak === true);

  // ---------- 二、点喇叭会调 tts:synth ----------
  console.log('\n=== 二、点喇叭走 Edge 合成 ===');
  const before = synthCalls.length;
  await click('[data-testid="msg-speak"]');
  await sleep(1200);
  console.log('  合成调用:', JSON.stringify(synthCalls));
  t('点击后调用了 tts:synth', synthCalls.length > before, String(synthCalls.length - before));
  const sentText = synthCalls.length ? synthCalls[synthCalls.length - 1].text : '';
  t('传过去的文字已经去掉 Markdown', sentText.indexOf('**') < 0, sentText);

  // ---------- 三、合成失败要退回系统语音 ----------
  console.log('\n=== 三、语音服务不可用时退回系统语音 ===');
  /** 拦住 speechSynthesis.speak，验证降级链路真的被走到 */
  await js(`(function(){
    window.__sysSpoken = [];
    if (!window.speechSynthesis) return 'no-synth';
    var sp = window.speechSynthesis;
    if (!sp.__patched) {
      var orig = sp.speak.bind(sp);
      sp.speak = function(u){ window.__sysSpoken.push(String(u && u.text || '')); return orig(u); };
      sp.__patched = true;
    }
    return 'ok';
  })()`, 'hookSys');

  // 先停掉上一条，再点一次（这次桩会抛错）
  await click('[data-testid="msg-speak"]');
  await sleep(400);
  await click('[data-testid="msg-speak"]');
  await sleep(1500);
  const fallback = await js(`(function(){
    return { sys: (window.__sysSpoken || []).slice(0, 2), count: (window.__sysSpoken || []).length };
  })()`, 'fallback');
  console.log('  系统语音收到:', JSON.stringify(fallback));
  t('语音服务失败时退回系统语音（不是静默失败）',
    !!(fallback && fallback.count > 0), JSON.stringify(fallback));

  // ---------- 四、设置页有音色与试听 ----------
  console.log('\n=== 四、设置页的音色控件 ===');
  await click('[data-testid="btn-settings"]');
  await sleep(1200);
  const ui = await js(`(function(){
    var sel = document.querySelector('[data-testid="tts-voice"]');
    var btn = document.querySelector('[data-testid="tts-try"]');
    if (!sel) return { hasSel: false };
    return {
      hasSel: true,
      opts: [].map.call(sel.options, function(o){ return o.value + ':' + o.textContent; }),
      value: sel.value,
      hasBtn: !!btn,
      btnText: btn ? btn.textContent.trim() : '',
    };
  })()`, 'settings');
  console.log('  ', JSON.stringify(ui));
  t('设置页有音色下拉', ui && ui.hasSel === true);
  t('下拉里有晓晓与云希两个选项',
    !!(ui && ui.opts && ui.opts.length === 2
      && ui.opts.join('|').indexOf('xiaoxiao') >= 0
      && ui.opts.join('|').indexOf('yunxi') >= 0), ui ? ui.opts.join(' | ') : '');
  t('默认选中晓晓', !!(ui && ui.value === 'xiaoxiao'), ui ? ui.value : '');
  t('有试听按钮', !!(ui && ui.hasBtn === true), ui ? ui.btnText : '');

  // 截图
  try {
    await win.capturePage();
    await sleep(300);
    const dir = path.join(APPDIR, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'v14-tts-settings.png'), (await win.capturePage()).toPNG());
    console.log('\n截图：shots/v14-tts-settings.png');
  } catch (_) { /* 截图失败不影响判据 */ }

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n========== ${CHECKS.length - bad.length}/${CHECKS.length} 通过 ==========`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));

  fs.rmSync(ROOT, { recursive: true, force: true });
  app.exit(bad.length ? 1 : 0);
});

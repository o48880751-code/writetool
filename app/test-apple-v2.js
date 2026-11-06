/**
 * 判据：窗口三按钮改成红绿灯 / 设置页类目切换动画 / 字体收进弹窗 / 系统提示词（2026-11-06）。
 *
 * 运行：./electron-run.cmd test-apple-v2.js
 *
 * ⚠ 设置页类目按钮的文字带 emoji（`ℹ️关于`），按 `textContent === '关于'` 找不到，
 *   必须去空白后 includes（上一轮踩过）。
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
const PKG = require(path.join(APPDIR, 'package.json'));
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async () => {
    try { return { ok: true, data: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
for (const ch of [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))]) {
  h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
}

let CFG = {
  model: 'qwen3', numCtx: 8192, temperature: 0.3, mode: 'light',
  notify: 'none', currentProject: null, toolsEnabled: false,
  chatFontSize: 16, editorFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: PKG.version, full: 'v' + PKG.version }));
h('project:list', () => []);
h('scope:get', () => ({ locked: false, strikes: 0 }));
h('font:presets', () => ([
  { id: 'source-han-serif', label: '思源宋体', family: 'Source Han Serif SC', desc: '适合正文', sizeMB: 8 },
]));
h('font:installed', () => []);

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, ok: !!ok });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 120 秒没跑完'); app.exit(1); }, 120000);

  const win = new BrowserWindow({
    width: 1400, height: 940, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  win.focus();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1500);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log('    ! JS_ERR', e.message); return { __err: e.message }; }
  };

  console.log('\n=== 一、窗口按钮：常规 SVG 图标 + 悬停圆角底（不是红绿灯） ===');
  /**
   * ⚠ 2026-11-06 第二次改：红绿灯方案被否掉了。
   *   羽毛菌的原话：「你觉得按钮那么小，还搞得和红绿灯一样好看吗，
   *   正常按钮图标，鼠标悬浮后凸显带 r 角矩形气泡底色不就行了」。
   *   所以这一段跟着实现改成「SVG 图标 + 7px 圆角 + 平时透明」。
   *   悬停后真的浮底这条，在 test-settings-v3.js 里用 sendInputEvent 验。
   */
  const dots = await js(`(function(){
    var bs=[].slice.call(document.querySelectorAll('[data-win-btn]'));
    return bs.map(function(b){
      var s=getComputedStyle(b);
      return {
        key:b.getAttribute('data-win-btn'),
        hasSvg:!!b.querySelector('svg'),
        oldDots:b.querySelectorAll('.win-dot').length,
        radius:s.borderRadius,
        btnBg:s.backgroundColor,
        opacity:Number(s.opacity)
      };
    });
  })()`);
  console.log('  ', JSON.stringify(dots));
  t('标题栏恰好三个窗口按钮', Array.isArray(dots) && dots.length === 3, String(dots && dots.length));
  t('三个都是 SVG 图标（红绿灯圆点已撤掉）',
    dots.every((d) => d.hasSvg && d.oldDots === 0),
    dots.map((d) => d.hasSvg + '/' + d.oldDots).join(' '));
  t('按钮是 7px 圆角矩形（不是 50% 圆点）',
    dots.every((d) => d.radius === '7px'), dots.map((d) => d.radius).join(' '));
  t('平时透明底、半透明图标，不常驻红底',
    dots.every((d) => d.btnBg === 'rgba(0, 0, 0, 0)' && d.opacity < 1),
    dots.map((d) => d.btnBg + '/' + d.opacity).join(' | '));
  const dotsCss = await js("(function(){var b=document.querySelector('.win-ctrls');return b?getComputedStyle(b).display:'none';})()");
  t('三个按钮包在一个组里', dotsCss === 'flex', dotsCss);

  console.log('\n=== 二、设置页：类目切换右侧有入场动画 ===');
  await js(`(function(){var b=document.querySelector('[data-testid="bookshelf-settings"]');if(b)b.click();return !!b;})()`);
  await sleep(800);
  const paneAnim = await js(`(function(){
    var p=document.querySelector('.settings-pane');
    if(!p) return { found:false };
    var s=getComputedStyle(p);
    return { found:true, name:s.animationName, dur:s.animationDuration,
             bodyText:(document.querySelector('[data-testid="settings-body"]')||{}).innerText||'' };
  })()`);
  console.log('  ', JSON.stringify({ name: paneAnim.name, dur: paneAnim.dur }));
  t('内容区挂了入场动画（settingsPaneIn）',
    paneAnim.found === true && paneAnim.name === 'settingsPaneIn', paneAnim.name);
  t('动画时长 200~400ms（不是瞬切也不是拖沓）',
    parseFloat(paneAnim.dur) >= 0.2 && parseFloat(paneAnim.dur) <= 0.4, paneAnim.dur);
  const navOn = await js(`(function(){
    var b=document.querySelector('.settings-nav-item[data-on="1"]');
    if(!b) return null;
    var s=getComputedStyle(b);
    return { radius:s.borderRadius, bg:s.backgroundColor, weight:s.fontWeight };
  })()`);
  t('选中的类目是圆角胶囊（12px）+ 实底',
    // ⚠ 10px → 12px：设置页所有框统一 ≥12px，test-theme-ui 有硬断言
    !!navOn && navOn.radius === '12px' && navOn.bg !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(navOn));

  console.log('\n=== 三、字体收成一行，「管理字体」里才下载 ===');
  const fontRow = await js(`(function(){
    var b=document.querySelector('[data-testid="font-manage"]');
    var body=document.querySelector('[data-testid="settings-body"]');
    return { hasBtn:!!b, label:b?b.textContent.trim():'', rows:document.querySelectorAll('.font-row').length,
             text:(body||{}).innerText||'' };
  })()`);
  t('外观页只有一行「管理字体」入口', fontRow.hasBtn === true && fontRow.label === '管理字体');
  t('列表没有平铺在设置页上（弹窗关着时 0 行）', fontRow.rows === 0, String(fontRow.rows));
  t('说明文字在：「下载开源字体并应用到整个界面」',
    (fontRow.text || '').indexOf('下载开源字体并应用到整个界面') >= 0);
  await js(`(function(){var b=document.querySelector('[data-testid="font-manage"]');if(b)b.click();return true;})()`);
  await sleep(500);
  const modal = await js(`(function(){
    var m=document.querySelector('[data-testid="font-modal"]');
    if(!m) return { found:false };
    return { found:true, rows:document.querySelectorAll('.font-row').length,
             downloads:m.querySelectorAll('.font-act.primary').length,
             hasImport:!!m.querySelector('[data-testid="font-import"]') };
  })()`);
  console.log('  ', JSON.stringify(modal));
  t('点「管理字体」弹出字体面板', modal.found === true);
  t('面板里有字体列表与「下载」按钮', modal.rows >= 2 && modal.downloads >= 1,
    'rows=' + modal.rows + ' dl=' + modal.downloads);
  t('面板里保留了「从本地文件装字体」', modal.hasImport === true);

  console.log('\n=== 四、系统提示词：默认值 + 不能盖掉硬规则 ===');
  await js(`(function(){
    var b=[].slice.call(document.querySelectorAll('.settings-nav-item')).find(function(x){
      return (x.textContent||'').replace(/\\s/g,'').indexOf('参数')>=0;
    });
    if(b)b.click(); return !!b;
  })()`);
  await sleep(700);
  const prompt = await js(`(function(){
    var el=document.querySelector('[data-testid="custom-system-prompt"]');
    if(!el) return { found:false };
    return { found:true, value:el.value, rows:el.rows, body:(document.querySelector('[data-testid="settings-body"]')||{}).innerText||'' };
  })()`);
  t('参数页有「系统提示词」输入框', prompt.found === true);
  t('默认值就是那段小说写作助手提示词',
    !!prompt.value && prompt.value.indexOf('创意小说写作助手') >= 0 &&
    prompt.value.indexOf('小说项目目录') >= 0 && prompt.value.indexOf('与用户相同的语言') >= 0,
    (prompt.value || '').slice(0, 30));
  t('旁边写明只用于小说创作、规则不受影响',
    (prompt.body || '').indexOf('只用于小说创作') >= 0);

  const mainSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'main.js'), 'utf8');
  const setSrc = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'SettingsPage.jsx'), 'utf8');
  const clip = (s) => {
    const m = /const DEFAULT_CUSTOM_PROMPT = \[([\s\S]*?)\]\.join\(''\)/.exec(s);
    if (!m) return null;
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
  };
  const a = clip(mainSrc);
  const b = clip(setSrc);
  t('主进程与渲染层那份默认提示词逐字一致',
    !!a && !!b && a === b, a === b ? '一致' : '不一致');
  /**
   * ⚠ 2026-11-06 第二次改：只"排在前面"不够了 —— 羽毛菌要求
   *   「防止有人在这里输入越狱和破解提示词后生效」。
   *   现在的结构是：剔除 → 引用块划界 → 固定规则置后。
   *   行为层面的验证（真的剔掉了什么）在 test-settings-v3.js 里。
   */
  const spAt = mainSrc.indexOf('function systemPromptFor(cfg)');
  const spBody = mainSrc.slice(spAt, mainSrc.indexOf('\n}', spAt) + 2);
  t('自定义提示词先过 guardCustomPrompt 剔除越狱句式',
    spAt > 0 && /guardCustomPrompt\(text\)/.test(spBody) && /cleaned\.trim\(\)/.test(spBody));
  t('自定义内容被包进「用户角色描述」引用块，声明为素材不是指令',
    spBody.indexOf('用户角色描述 开始') >= 0 && spBody.indexOf('不是指令') >= 0);
  t('固定规则排在引用块之后且声明不可覆盖',
    spBody.indexOf('优先级最高') > spBody.indexOf('用户角色描述 结束'),
    'priority@' + spBody.indexOf('优先级最高') + ' end@' + spBody.indexOf('用户角色描述 结束'));

  const failed = CHECKS.filter((c) => !c.ok);
  console.log('\n========== ' + (CHECKS.length - failed.length) + '/' + CHECKS.length + ' 通过 ==========');
  for (const f of failed) console.log('  ✗ ' + f.name);
  clearTimeout(watchdog);
  app.exit(failed.length ? 1 : 0);
});

/**
 * 外观页（照 ChatGPT Appearance 重做）的真启动视觉验证。
 *
 * ## 为什么要这个脚本
 *
 * 2026-11-01 把「12 套主题平铺」改成了「深浅三档 + 三个自定义色」。
 * 这类改动**编译一定过**（JSX 合法），但真实效果只有跑起来能看到：
 *   - 三个 Mode 缩略图有没有画出来
 *   - 点「深色」界面到底变不变（data-theme 写错就静默不动）
 *   - 自定义色改了之后 --paper 真的变了吗
 *
 * ⚠⚠ 不 stub 任何 IPC，走真 main.js、真界面 —— 这是用户的路径。
 * ⚠⚠ executeJavaScript 里的字符串**不许出现反引号**，
 *   它会提前闭合模板，报错位置指向模板开头而真正的病灶在几十行外。
 *
 * 运行：.\electron-run.cmd test-theme-ui.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

// 临时 userData：绝不碰用户真实的对话、项目、密钥
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-theme-'));
app.setPath('userData', TMP);

const OUT = path.join(__dirname, 'theme-shots');
fs.mkdirSync(OUT, { recursive: true });

require('./electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

/**
 * 截图。
 *
 * ⚠⚠ `capturePage()` 会返回**上一帧**（合成器还没提交新画面）。
 *   11-01 就踩过一次：切到深色后截出来的图和浅色那张 **md5 完全一样**，
 *   而 DOM 断言全绿（data-theme 确实是 gpt-dark）——差点当成"深色没生效"。
 *   → `mustDiffer` 时反复截，直到和上一张不同为止。
 */
let lastShotHash = '';
async function shot(win, name, mustDiffer) {
  const crypto = require('node:crypto');
  for (let i = 0; i < 8; i++) {
    await sleep(600);
    try {
      const buf = (await win.capturePage()).toPNG();
      if (!buf || buf.length < 2000) continue;
      const h = crypto.createHash('md5').update(buf).digest('hex');
      if (mustDiffer && h === lastShotHash) continue;   // 还是旧帧，再等
      lastShotHash = h;
      const f = path.join(OUT, name + '.png');
      fs.writeFileSync(f, buf);
      return f;
    } catch (e) { /* 偶发 UnknownVizError，重试 */ }
  }
  return null;
}

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('✗ 没拿到窗口，退出'); app.exit(1); return; }

  // 等 React 首屏渲染出「我的书架」或任意按钮
  for (let i = 0; i < 30; i++) {
    const n = await win.webContents.executeJavaScript('document.querySelectorAll("button").length');
    if (n > 2) break;
    await sleep(400);
  }

  // ---- 1. 打开设置（书架右上角的 ⚙）----
  const opened = await win.webContents.executeJavaScript(
    '(function(){var b=document.querySelector("button[title=\\"设置\\"]");'
    + 'if(!b)return false;b.click();return true;})()',
  );
  ok('能从书架打开设置页', opened === true);
  await sleep(1200);

  // ---- 2. 外观页结构 ----
  const struct = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var t=document.body.innerText||"";'
    + 'return {'
    + '  hasMode: t.indexOf("明暗")>=0,'
    + '  hasAccent: t.indexOf("强调色")>=0,'
    + '  hasBg: t.indexOf("背景色")>=0,'
    + '  hasFg: t.indexOf("文字色")>=0,'
    + '  thumbs: document.querySelectorAll("button[data-mode]").length,'
    + '  colorInputs: document.querySelectorAll("input[type=color]").length,'
    + '  oldGrid: /墨金|赭石|松绿|绛紫/.test(t),'
    /* 界面必须全中文 —— 第一版把 ChatGPT 的英文标签原样搬过来了 */
    + '  english: ["Visual style","Mode","Accent","Background","Foreground"]'
    + '    .filter(function(w){ return t.indexOf(w)>=0; }),'
    /* Theme 那一行只有一个选项，等于装饰，必须不存在 */
    + '  fakeSelect: t.indexOf("ChatGPT")>=0'
    + '};})()',
  );
  ok('有「明暗」一行', struct.hasMode === true, JSON.stringify(struct));
  ok('有强调色 / 背景色 / 文字色三行',
    struct.hasAccent && struct.hasBg && struct.hasFg, JSON.stringify(struct));
  ok('三个明暗缩略图都在', struct.thumbs === 3, '实际 ' + struct.thumbs + ' 个');
  ok('三个取色器都在', struct.colorInputs === 3, '实际 ' + struct.colorInputs + ' 个');
  ok('老的 12 套中文主题已从界面消失', struct.oldGrid === false);
  ok('界面标签全是中文，没有照抄英文', struct.english.length === 0,
    '还在的英文：' + struct.english.join('、'));
  ok('没有只有一项的假「主题」下拉', struct.fakeSelect === false);

  /**
   * 设置页圆角统一（2026-11-02，羽毛菌：「设置里的都要，圆角更大一些」）。
   *
   * ⚠ 只能**量**：圆角 10 和 12 在缩略图里看不出来，遗漏处（inline 盖过类）也看不出来。
   * ⚠⚠ 必须排除两类东西，否则永远报错：
   *   ① **明暗缩略图内部的画面**（`[data-mode]` 里那块 48×32）—— 它是"一张小界面截图"，
   *      圆角 9 是**嵌套收紧**的设计意图，不是框；
   *   ② **胶囊形元素**（`rounded-full` = 9999px）—— 它们本来就是圆的，不参与"框"的统计。
   *   第一次没排除，报"最小 2px / 最大 33554400px"。
   */
  const radii = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var els=[].slice.call(document.querySelectorAll(".settings-root *"));'
    + 'var seen=[];'
    + 'els.forEach(function(e){'
    + '  if(e.closest("[data-mode]"))return;'
    + '  var r=e.getBoundingClientRect();'
    + '  if(r.width<40||r.height<24)return;'
    + '  var v=parseFloat(getComputedStyle(e).borderTopLeftRadius)||0;'
    + '  if(v<=0||v>40)return;'
    + '  seen.push({v:v,w:Math.round(r.width),h:Math.round(r.height),'
    + '    cls:(e.className||"").toString().slice(0,26)});'
    + '});'
    + 'if(!seen.length)return {n:0};'
    + 'var vs=seen.map(function(x){return x.v;}).sort(function(a,b){return a-b;});'
    + 'return {n:seen.length, min:Math.round(vs[0]), max:Math.round(vs[vs.length-1]),'
    + '  small:seen.filter(function(x){return x.v<12;}).map(function(x){return x.cls+"("+x.v+")";}).slice(0,4)};'
    + '})()',
  );
  ok('设置页的框圆角全部 ≥12px', radii.n > 0 && radii.min >= 12,
    '最小 ' + radii.min + 'px（共 ' + radii.n + ' 个框）偏小的：' + (radii.small || []).join(' / '));

  const lightShot = await shot(win, '1-light');
  const lightPaper = await win.webContents.executeJavaScript(
    'getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()',
  );

  // ---- 3. 切深色 ----
  const clickedDark = await win.webContents.executeJavaScript(
    '(function(){var b=document.querySelector("button[data-mode=\'dark\']");'
    + 'if(!b)return false;b.click();return true;})()',
  );
  ok('能点「深色」', clickedDark === true);
  await sleep(900);

  const darkState = await win.webContents.executeJavaScript(
    '(function(){var cs=getComputedStyle(document.documentElement);return {'
    + '  theme: document.documentElement.getAttribute("data-theme"),'
    + '  dark: document.documentElement.getAttribute("data-dark"),'
    + '  paper: cs.getPropertyValue("--paper").trim(),'
    + '  ink: cs.getPropertyValue("--ink").trim()'
    + '};})()',
  );
  ok('data-theme 切到 gpt-dark', darkState.theme === 'gpt-dark', JSON.stringify(darkState));
  ok('data-dark 标记为 1', darkState.dark === '1', JSON.stringify(darkState));
  ok('底色真的变暗了', darkState.paper.toLowerCase() === '#212121' || darkState.paper !== lightPaper,
    '浅色 ' + lightPaper + ' → 深色 ' + darkState.paper);

  const darkShot = await shot(win, '2-dark', true);

  // ---- 4. 自定义背景色 ----
  const changed = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var ins=[].slice.call(document.querySelectorAll("input[type=color]"));'
    + 'if(ins.length<3)return null;'
    + 'var bg=ins[1];'                       /* 顺序：Accent / Background / Foreground */
    + 'var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'setter.call(bg,"#17324a");'
    + 'bg.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'bg.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'return true;})()',
  );
  ok('能操作 Background 取色器', changed === true);
  await sleep(800);

  const after = await win.webContents.executeJavaScript(
    'getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()',
  );
  ok('自定义背景真的生效了（--paper 变成新色）', after.toLowerCase() === '#17324a',
    '实际 ' + after);
  // ⚠ 只改背景不改文字会看不见 —— 确认文字色还是跟着走的
  const inkAfter = await win.webContents.executeJavaScript(
    'getComputedStyle(document.documentElement).getPropertyValue("--ink").trim()',
  );
  ok('文字色仍然是深色模式下应有的浅色', inkAfter.toLowerCase() === '#ececec', '实际 ' + inkAfter);

  const customShot = await shot(win, '3-custom', true);

  // ---- 5. 配色持久化：写进 config 了吗 ----
  await sleep(600);   // 等 250ms 的合并写盘
  const cfgPath = path.join(TMP, 'config.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { /* 还没落盘 */ }
  ok('config.json 里存了 mode=dark', !!cfg && cfg.mode === 'dark', cfg ? 'mode=' + cfg.mode : '没读到 config');
  ok('config.json 里存了 customColors.dark.bg',
    !!(cfg && cfg.customColors && cfg.customColors.dark && cfg.customColors.dark.bg === '#17324a'),
    cfg && cfg.customColors ? JSON.stringify(cfg.customColors) : '没有 customColors');

  console.log('\n' + '-'.repeat(52));
  console.log('外观页验证：' + passed + ' 通过 / ' + failures.length + ' 失败');
  if (failures.length) console.log('失败：' + failures.join('、'));
  console.log('截图：' + OUT);
  ['1-light', '2-dark', '3-custom'].forEach((n) => {
    const f = path.join(OUT, n + '.png');
    console.log('  ' + (fs.existsSync(f) ? '有' : '缺') + '  ' + f);
  });
  console.log('');
  app.exit(failures.length ? 1 : 0);
});

/**
 * 诊断 v2：那条"灰蓝、两端圆头、通栏偏窄"的横条 —— **横向滚动条**？
 *
 * ## 推理
 *
 * 用户 2026-10-16 19:10 的截图：一条灰蓝色、两端圆头的横条，浮在输入框正上方，
 * 比输入框窄、两端内缩，而且**内容区上方是大片空白**（消息区空的）。
 *
 * ⚠⚠ 那个形状不是任何 border / box-shadow / 条件块的形状：
 *   - 我已经把输入框改成"1px 通栏 border"了，而他说还在；
 *   - ChatPanel 里输入框上方的条件块（styleResult / error / scopeBanner / scopeNotice）
 *     **全都要求有内容才渲染**，没有内容就是"什么都没有"。
 *
 * → 而 Chromium 的**横向滚动条**恰好就是：灰蓝色、两端圆角、浮在内容区底部。
 *
 * ⚠⚠⚠ 而且它**平时根本不出现**（内容不溢出就没有），所以我前几轮像素扫描
 *   一次都没量到它 —— 不是"它不在"，是"我的诊断环境里没有溢出"。
 *
 * ## 关键 CSS 事实（这是整件事的根）
 *
 * `.chat-surface` 写的是 `overflow-y-auto`，`overflow-x` 保持 `visible`。
 * 而 **CSS 规范规定：两个轴里只要有一个不是 visible，另一个 visible 的
 * 会被计算成 auto** —— 于是**横向滚动条是可能的**。
 * 任何一个子元素宽度超出，就会冒出来一条。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe diag-hscroll.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hscroll-'));
app.setPath('userData', TMP);

require(path.join(__dirname, 'electron', 'main.js'));

/**
 * ⚠⚠ 这一段在渲染进程里跑，所以**必须按纯 ASCII 写**。
 *   electron 不带 --file-encoding，源码含非 ASCII 时 .toString() 会乱码成
 *   U+FFFD —— 结果就是这个函数整体失效，量出来全是 null。
 *   （2026-10-16 栽过：注释里全是中文，量到的每个字段都是乱码。）
 */
const PROBE = `(() => {
  var out = {};
  var surface = document.querySelector('.chat-surface');
  if (!surface) return { err: 'no .chat-surface' };
  var cs = getComputedStyle(surface);
  out.overflowY = cs.overflowY;
  out.overflowX = cs.overflowX;
  out.scrollWidth = surface.scrollWidth;
  out.clientWidth = surface.clientWidth;
  out.overflowingX = surface.scrollWidth > surface.clientWidth + 1;

  // 逐个子元素：谁超出了右边界（横向溢出的源头）
  var sr = surface.getBoundingClientRect();
  var bad = [];
  var all = surface.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    var over = Math.round(r.right - sr.right);
    if (over > 1) {
      var s2 = getComputedStyle(el);
      bad.push({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 50),
        over: over,
        w: Math.round(r.width),
        ws: s2.whiteSpace,
        text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 24)
      });
    }
    if (bad.length >= 8) break;
  }
  out.overflowers = bad;

  // 输入框上方 90px 内：每一行像素所属元素 + 它的背景色（认领那条线）
  var ta = document.querySelector('textarea');
  var card = ta.parentElement;
  var cr = card.getBoundingClientRect();
  out.cardRect = { x: Math.round(cr.x), y: Math.round(cr.y),
                   w: Math.round(cr.width), h: Math.round(cr.height) };
  var rows = [];
  for (var dy = -2; dy >= -30; dy -= 2) {
    var y = Math.round(cr.y) + dy;
    var el2 = document.elementFromPoint(Math.round(cr.x + cr.width / 2), y);
    if (!el2) { rows.push({ dy: dy, tag: 'null' }); continue; }
    var s3 = getComputedStyle(el2);
    rows.push({
      dy: dy,
      tag: el2.tagName,
      cls: (el2.className || '').toString().slice(0, 40),
      bg: s3.backgroundColor,
      bb: s3.borderBottomWidth + ' ' + s3.borderBottomColor,
      radius: s3.borderRadius
    });
  }
  out.above = rows;
  return out;
})()`;

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) { console.log('no window'); app.exit(1); return; }
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 3500));
  const j = (c) => win.webContents.executeJavaScript(c);

  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p-d', name: 'diag' });
    await window.api.config.set({ currentProject: 'p-d' });
  })()`).catch(() => {});
  win.webContents.reload();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await j(`!!window.api && !!document.querySelector('textarea')`).catch(() => false)) break;
  }
  await new Promise((r) => setTimeout(r, 1500));

  const r = await j(PROBE);
  console.log(JSON.stringify(r, null, 1));

  // 逐套主题各量一次：那条线的颜色随主题变（用户那条是蓝灰 → 可能是 ink）
  const themes = await j(`(async () => {
    const m = await import('/assets/index.js').catch(() => null);
    return null;
  })()`).catch(() => null);

  console.log('\n=== 换一个窄窗口（模拟用户窗口更窄）再量 ===');
  win.setSize(1080, 760);
  await new Promise((r) => setTimeout(r, 900));
  const r2 = await j(PROBE);
  console.log(JSON.stringify({
    overflowX: r2.overflowX, scrollWidth: r2.scrollWidth, clientWidth: r2.clientWidth,
    overflowingX: r2.overflowingX,
    overflowers: (r2.overflowers || []).slice(0, 4),
  }, null, 1));

  setTimeout(() => app.exit(0), 200);
}).catch((e) => { console.error('crash:', e && e.message); app.exit(1); });
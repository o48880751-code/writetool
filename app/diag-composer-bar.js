/**
 * 诊断：输入框上方那条**浅色横条**到底是什么，以及为什么"能左右拖动"。
 *
 * ## 为什么要量
 *
 * 羽毛菌 2026-10-17 给了两张图：
 *   ① 别人的软件：消息区到输入框**完全无缝**，没有横条也没有阴影；
 *   ② 本软件：输入框正上方一条**浅蓝灰色、圆角、通栏**的横条，
 *      而且他发现**左右拖得动**。
 *
 * ⚠⚠ 上一次（2026-10-16）我已经把 `scope-banner` 挪走了，并且判据量到
 *   "输入框卡片的兄弟节点 = 0"。所以这条**一定不是**那个 banner。
 *   而"能左右拖动"这个细节说明它**绑了拖拽事件** ——
 *   本项目里绑拖拽的只有 `SplitPanes` 的 Divider（分栏线，`col-resize`）。
 *   难道一条**竖的**分栏线会横着出现？不可能。
 *
 *   → 唯一靠得住的办法：把那一块逐层量出来（元素 / 背景 / box-shadow / cursor），
 *     再用像素看那条带子到底是"元素"还是"投影"。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe diag-composer-bar.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-bar-'));
app.setPath('userData', TMP);

require(path.join(__dirname, 'electron', 'main.js'));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) { console.log('没有窗口'); app.exit(1); return; }
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 3500));
  const j = (c) => win.webContents.executeJavaScript(c);

  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p-d', name: '诊断' });
    await window.api.config.set({ currentProject: 'p-d' });
  })()`).catch(() => {});
  win.webContents.reload();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await j(`!!window.api && !!document.querySelector('textarea')`).catch(() => false)) break;
  }
  await new Promise((r) => setTimeout(r, 1200));

  const dump = await j(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return { err: '没有 textarea' };
    const card = ta.closest('.rounded-lg');
    const cs = getComputedStyle(card);
    const cr = card.getBoundingClientRect();

    // ⚠ 往上扫 40px，把**每一层**命中测试到的元素都记下来：
    //   阴影不是元素，只靠 DOM 遍历是看不见的 —— 必须用 elementFromPoint。
    const cols = [];
    for (let dy = 26; dy >= -14; dy -= 2) {
      const y = Math.round(cr.y) + dy;
      const el = document.elementFromPoint(Math.round(cr.x + cr.width / 2), y);
      cols.push({
        dy,
        y,
        tag: el ? el.tagName : 'null',
        cls: el ? (el.className || '').toString().slice(0, 54) : '',
        testid: el ? (el.getAttribute('data-testid') || '') : '',
        cursor: el ? getComputedStyle(el).cursor : '',
      });
    }
    return {
      card: {
        y: Math.round(cr.y), h: Math.round(cr.height), w: Math.round(cr.width),
        boxShadow: cs.boxShadow,
        background: cs.backgroundColor,
        border: cs.border,
        borderRadius: cs.borderRadius,
      },
      // ⚠ 页面上所有"看起来能拖"的东西（分隔条都是 col-resize/row-resize）
      draggables: [...document.querySelectorAll('*')]
        .filter((e) => {
          const c = getComputedStyle(e).cursor;
          return /resize/.test(c);
        })
        .slice(0, 10)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return {
            cls: (e.className || '').toString().slice(0, 60),
            cursor: getComputedStyle(e).cursor,
            w: Math.round(r.width), h: Math.round(r.height),
            x: Math.round(r.x), y: Math.round(r.y),
          };
        }),
      cols,
    };
  })()`);
  console.log(JSON.stringify(dump, null, 2));

  // 像素：那条带子是"元素"还是"投影"？取卡片上方几行的颜色
  const shot = path.join(__dirname, 'shots', 'composer-zoom.png');
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 250));
      const box = await j(`(() => {
        const ta = document.querySelector('textarea');
        const c = ta.closest('.rounded-lg').getBoundingClientRect();
        return { x: Math.round(c.x) + 20, y: Math.max(0, Math.round(c.y) - 26),
                 width: Math.round(c.width) - 40, height: 60 };
      })()`);
      fs.writeFileSync(shot, (await win.webContents.capturePage(box)).toPNG());
      console.log('→ shots/composer-zoom.png（输入框上缘 60px）');
      break;
    } catch (e) { await new Promise((r) => setTimeout(r, 400)); }
  }

  setTimeout(() => app.exit(0), 200);
}).catch((e) => { console.error('崩了：', e && e.message); app.exit(1); });
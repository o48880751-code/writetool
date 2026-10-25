/**
 * 诊断：背景图到底铺到了哪 —— 按**区域**量，不看整窗平均。
 *
 * ⚠ 为什么必须写这个脚本：
 *   `test-bg-boot.js` 第四节量的是**整窗平均色**。判据给的是
 *   「开图前后差值 ≥ 3」—— 一条 20px 的缝透出图，平均色照样会变这么多，
 *   于是判据全绿，而用户看到的是「就顶部一条，卡片里的白没被替换」。
 *   ⚠ **平均值判据抓不住局部**。要按格子采样。
 *
 * 运行：.\electron-run.cmd diag-bg.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-diag-'));
app.setPath('userData', TMP);

const APPDIR = __dirname;
require(path.join(APPDIR, 'electron', 'main.js'));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeSolidPng(w, h, rgb) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2]; } }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 2500));

  const j = (code) => win.webContents.executeJavaScript(code);

  // 建一个项目，让四栏都有内容
  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p', name: '诊断' });
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  // 纯品红 —— 界面里不可能出现的颜色
  fs.mkdirSync(path.join(TMP, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'assets', 'bg.png'), makeSolidPng(64, 64, [255, 0, 255]));
  await j(`(async () => {
    await window.api.config.set({ bgEnabled: true, bgUrl: 'appbg://bg.png' });
    window.dispatchEvent(new Event('writetool:bg-changed'));
  })()`).catch((e) => console.log('设背景失败', e.message));
  await new Promise((r) => setTimeout(r, 1500));

  // --- 1. DOM 几何 ---
  const geo = await j(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        bg: cs.backgroundColor, z: cs.zIndex, pos: cs.position,
      };
    };
    return {
      dpr: window.devicePixelRatio,
      inner: [window.innerWidth, window.innerHeight],
      html: pick('html'), body: pick('body'), root: pick('#root'),
      app: pick('#root > div'),
      bgLayer: pick('[data-testid="bg-layer"]'),
      pane1: pick('[data-pane="conversations"]'),
      pane2: pick('[data-pane="main"]'),
      pane4: pick('[data-pane="files"]'),
      header: pick('header'),
      aside: pick('#root > div > div > div > aside'),
    };
  })()`);
  console.log('\n=== DOM 几何 ===');
  console.log(JSON.stringify(geo, null, 2));

  // --- 2. 按格子采样 ---
  const img = await win.webContents.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();
  const DPR = geo.dpr;
  const px = (cx, cy) => {
    const x = Math.round(cx * DPR), y = Math.round(cy * DPR);
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
    const i = (y * size.width + x) * 4;
    return [bmp[i], bmp[i + 1], bmp[i + 2]];
  };
  const isMagenta = ([r, g, b]) => r > 150 && g < 120 && b > 150;
  /**
   * ⚠ 面板透出图之后，像素**不是**纯品红 —— 是「品红混了 66% 纸色」的粉。
   *   按纯品红去找会把修好的界面判成"没透出来"，所以另给一条宽松判据：
   *   红蓝都高、绿明显低 = 这张图起作用了。
   */
  const isPink = ([r, g, b]) => r > 200 && b > 200 && g < Math.min(r, b) - 35;

  console.log('\n=== 网格采样（M = 图透出来了，. = 被盖住）===');
  console.log(`视口 CSS ${geo.inner[0]}x${geo.inner[1]}  dpr=${DPR}  位图 ${size.width}x${size.height}`);
  const cols = [];
  for (let x = 20; x < geo.inner[0] - 10; x += 60) cols.push(x);
  let header = '      ' + cols.map((x) => String(x).padStart(5)).join('');
  console.log(header);
  for (let y = 5; y < geo.inner[1] - 5; y += 20) {
    let row = String(y).padStart(5) + ' ';
    for (const x of cols) {
      const p = px(x, y);
      row += (p ? (isPink(p) ? '    M' : (isMagenta(p) ? '    #' : '    .')) : '    ?');
    }
    console.log(row);
  }

  console.log('\n=== 关键点取值 ===');
  const spots = [
    ['顶栏中央', 600, 20],
    ['左栏（对话列表）', 100, 300],
    ['中栏（编辑区）中部', 400, 400],
    ['预览栏中部', 800, 300],
    ['右栏（文件树）', 1150, 300],
    ['输入框里', 420, 700],
  ];
  for (const [label, x, y] of spots) {
    const p = px(x, y);
    console.log(`  ${label.padEnd(20)} (${x},${y})  ${p ? p.join(',') : '?'}`);
  }

  /**
   * ⚠⚠ 最有用的一节：把某个点下面**所有刷了不透明背景的元素**按层级列出来。
   *   纸色是**乘起来**的 —— 三层 66% 纸 = 96% 纸，图基本被盖死。
   *   所以"图出不来"时唯一要问的是：到底有几层在刷同一个颜色。
   *   `document.elementsFromPoint` 从最上面往下给，顺序即绘制顺序。
   */
  const stack = await j(`(() => {
    const pts = [[600, 20, '顶栏'], [100, 300, '左栏'], [400, 400, '中栏'], [800, 300, '预览栏'], [1150, 300, '右栏'], [420, 700, '输入框']];
    const out = [];
    for (const [x, y, label] of pts) {
      const list = document.elementsFromPoint(x, y)
        .map((el) => {
          const cs = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 34),
            bg: cs.backgroundColor,
          };
        })
        .filter((e) => e.bg !== 'rgba(0, 0, 0, 0)' && e.bg !== 'transparent');
      out.push({ label, 层数: list.length, list });
    }
    return out;
  })()`);
  console.log('\n=== 每个点下面有几层"纸"（按绘制顺序，自顶向下）===');
  for (const s of stack) {
    console.log(`\n[${s.label}]  ${s.层数} 层`);
    for (const e of s.list) console.log(`   ${e.tag.padEnd(8)} .${e.cls.padEnd(34)} ${e.bg}`);
  }

  console.log('\n=== 纵向扫描 x=300（看那条缝在哪）===');
  for (let y = 0; y < Math.min(140, geo.inner[1]); y += 2) {
    const p = px(300, y);
    const mark = isMagenta(p) ? '  <== 品红' : '';
    console.log(`y=${String(y).padStart(4)}  ${p ? p.join(',') : '?'}${mark}`);
  }

  /**
   * ⚠⚠ 浮层必须**挡住**底下 —— 这条没法靠肉眼看网格，
   *   因为"半透明弹窗"只在有正文时才看得出来。
   *   所以逐个列出 `position: fixed` 的元素和它的实际底色，
   *   凡是"该挡住内容"却只有 0.66 的，就是漏了 `--float`。
   */
  async function dumpFixed(tagLabel) {
    const list = await j(`(() => {
      const out = [];
      document.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') return;
        if (cs.backgroundColor === 'rgba(0, 0, 0, 0)') return;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return;
        out.push({
          cls: (el.className || '').toString().slice(0, 44),
          bg: cs.backgroundColor,
          paper: cs.getPropertyValue('--paper').trim().slice(0, 46),
          size: Math.round(r.width) + 'x' + Math.round(r.height),
        });
      });
      return out;
    })()`);
    console.log(`\n=== ${tagLabel}：position:fixed 且有底色的元素 ===`);
    if (!list.length) console.log('  （一个都没有）');
    for (const e of list) {
      const alpha = /\/\s*([\d.]+)\)/.exec(e.bg);
      const a = alpha ? Number(alpha[1]) : 1;
      const flag = a < 0.9 ? '   <== 半透明，会不会透出后面的正文？' : '';
      console.log(`  ${e.size.padEnd(11)} ${e.bg.padEnd(46)} ${e.cls}${flag}`);
      console.log(`              --paper = ${e.paper}`);
    }
  }

  await dumpFixed('平时');

  // 打开设置页 —— 它是最大的一块全屏浮层
  await j(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('设置'));
    if (b) b.click();
    return !!b;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await dumpFixed('设置页打开后');
  const settingsShot = await win.webContents.capturePage();
  const sb = settingsShot.toBitmap();
  const ssz = settingsShot.getSize();
  const spx = (cx, cy) => {
    const i = (Math.round(cy * DPR) * ssz.width + Math.round(cx * DPR)) * 4;
    return [sb[i], sb[i + 1], sb[i + 2]];
  };
  console.log(`  设置页中心像素 (633,382) = ${spx(633, 382).join(',')}  （0.94 纸 → 绿通道应 ≈ 234）`);

  async function dumpStack(x, y, label) {
    const list = await j(`document.elementsFromPoint(${x}, ${y}).map((el) => {
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 40),
        pos: cs.position,
        bg: cs.backgroundColor,
        paper: cs.getPropertyValue('--paper').trim().slice(0, 40),
      };
    }).filter((e) => e.bg !== 'rgba(0, 0, 0, 0)')`);
    console.log(`\n[${label}] (${x},${y}) ${list.length} 层纸`);
    for (const e of list) {
      console.log(`   ${e.tag.padEnd(7)} ${e.pos.padEnd(8)} ${e.bg.padEnd(46)} --paper=${e.paper}  .${e.cls}`);
    }
  }

  await dumpStack(633, 382, '设置页中心');
  await dumpStack(100, 382, '设置页左栏');
  await dumpStack(900, 240, '右栏（设置页该盖住它）');
  await dumpStack(60, 600, '左下角工具条（设置页该盖住它）');

  /**
   * ⚠ 设置页是 `absolute inset-0`，而它在 DOM 里**嵌在某一栏的 <section> 里**
   *   （stack 里能看到 section 在它下面）。所以"它到底盖住了多少"完全取决于
   *   哪个祖先做了它的定位参照 —— 这类问题只能靠量：把设置页矩形打出来，
   *   跟视口比一比。
   */
  const rect = await j(`(() => {
    const el = document.querySelector('.absolute.inset-0.z-40');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const par = el.offsetParent;
    return {
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      viewport: [window.innerWidth, window.innerHeight],
      offsetParent: par ? (par.tagName + '.' + (par.className || '').toString().slice(0, 30)) : null,
    };
  })()`);
  console.log('\n设置页矩形 = ' + JSON.stringify(rect));

  setTimeout(() => app.exit(0), 300);
}).catch((e) => { console.error('脚本崩了：', e && e.stack); setTimeout(() => app.exit(1), 300); });

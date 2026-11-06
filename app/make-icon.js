/**
 * 应用图标生成器（纯 Node，零依赖）。
 *
 * ## 为什么不用 AI 生成图标
 *
 * 1. **尺寸决定一切**：Windows 任务栏图标只有 16~32px。
 *    插画式 AI 图标在这个尺寸下细节糊成一团，简单几何形反而清晰可辨。
 * 2. **配色必须对齐**：主题色已定死（--accent #8b6f47 墨金、--paper #faf9f7 宣纸白），
 *    代码取这些值能做到完全一致；AI 生成的配色必然与应用内其他部分有偏差。
 *
 * ## 为什么不用 Electron 渲染 SVG
 *
 * 实测踩过：`nativeImage.createFromPath(svg)` 在无显示器环境报
 * "GPU process isn't usable. Goodbye."；加 `--headless` 反而导致模块加载失败。
 * 为了生成 7 张图引入 GPU 依赖不划算——**直接算像素**。
 *
 * ## 输出
 *
 *   build/icon-16.png … icon-256.png   （7 种尺寸）
 *   build/icon.ico                     （含全部 7 种尺寸的 BMP 容器）
 *
 * 图形含义：**一卷正在展开的纸**（见 scrollCenterline 的注释）。
 * 一条连续曲线，小尺寸下也只有一个轮廓，不会糊成一团。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 与 src/index.css 浅色主题一致
const PAPER = [0xfa, 0xf9, 0xf7];
const WHITE = [0xff, 0xff, 0xff];
const LINE = [0xe3, 0xe0, 0xdb];
const ACCENT = [0x8b, 0x6f, 0x47];
const INK = [0x1f, 0x23, 0x28];

// ---------------------------------------------------------------- 画布

/**
 * 超采样画布。用 SS=4 倍分辨率画再降采样，做抗锯齿。
 * 不做抗锯齿的话，16px 图标上的圆角和斜线全是锯齿。
 */
/**
 * 画布。
 *
 * 超采样做法：在 n×n 的缓冲上逐像素判断形状覆盖，最后降采样成 size×size。
 *
 * ⚠ 踩过的坑：本来 `_coverage` 里又做了一遍 ss×ss 的子采样，
 * 相当于超采样嵌套超采样（256 尺寸下是 1024×1024×36 次判断）。
 * 而且第一版的循环边界写成 `this.size` 而缓冲区是 `this.n`——
 * 只画了左上角一块，其余全透明，降采样后整张图接近全白。
 *
 * 现在：**边界一律用 this.n，坐标直接换算成设计坐标系（0~256）**，
 * 抗锯齿由降采样天然提供，不再额外做子采样。
 */
class Canvas {
  constructor(size, ss = 4) {
    this.size = size;
    this.ss = ss;
    this.n = size * ss;
    this.data = new Float64Array(this.n * this.n * 4);
    // 设计坐标系边长（drawIcon 里的形状坐标都是 0~256）
    this.K = 256;
  }

  /** 填充形状。test(x, y) 的 x/y 在 0~K 的设计坐标系里 */
  shape(color, alpha, test) {
    const n = this.n;
    // ⚠ 换算必须是 K / n，不是 K / size。
    //   px 是**超采样索引**（0..n-1），不是像素坐标（0..size-1）。
    //   写 K/size 时，256 尺寸下 scale=1 → y 只到 1023，
    //   而形状坐标上限是 256 → 只有 1/4 区域被画，实测图标缩在左上角。
    const scale = this.K / n;
    for (let py = 0; py < n; py++) {
      const y = (py + 0.5) * scale;
      for (let px = 0; px < n; px++) {
        const x = (px + 0.5) * scale;
        if (!test(x, y)) continue;
        this._blend(px, py, color, alpha);
      }
    }
  }

  _blend(px, py, color, a) {
    // ⚠ 索引必须用 this.n（超采样后的边长），不是 this.size
    const i = (py * this.n + px) * 4;
    const d = this.data;
    const dstA = d[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
    for (let k = 0; k < 3; k++) {
      const src = color[k] / 255;
      const dst = d[i + k] / 255;
      d[i + k] = ((src * a + dst * dstA * (1 - a)) / outA) * 255;
    }
    d[i + 3] = outA * 255;
  }

  /**
   * 降采样成 size×size 的 RGBA8。
   *
   * ⚠ 超采样缓冲是二维的，必须按 (x, y) 算方块偏移。
   * 第一版写成 `data[j * s2]` 这种线性索引，结果整张图全白。
   */
  toRgba8() {
    const out = Buffer.alloc(this.size * this.size * 4);
    const ss = this.ss;
    const n = this.n;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < ss; dy++) {
          for (let dx = 0; dx < ss; dx++) {
            const i = ((y * ss + dy) * n + (x * ss + dx)) * 4;
            const pa = this.data[i + 3] / 255;
            r += (this.data[i] / 255) * pa;
            g += (this.data[i + 1] / 255) * pa;
            b += (this.data[i + 2] / 255) * pa;
            a += pa;
          }
        }
        const o = (y * this.size + x) * 4;
        if (a > 0) {
          out[o] = Math.round((r / a) * 255);
          out[o + 1] = Math.round((g / a) * 255);
          out[o + 2] = Math.round((b / a) * 255);
        }
        out[o + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- 几何

/** 圆角矩形 */
const roundRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
};

/** 线段（带圆头） */
const seg = (x1, y1, x2, y2, w) => (px, py) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey <= (w / 2) * (w / 2);
};

/** 圆 */
const circle = (cx, cy, r) => (px, py) => {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
};

/** 三角形（笔尖） */
const triangle = (pts) => (px, py) => {
  const sign = (ax, ay, bx, by, cx2, cy2) => (ax - cx2) * (by - cy2) - (bx - cx2) * (ay - cy2);
  const d1 = sign(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
  const d2 = sign(px, py, pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
  const d3 = sign(px, py, pts[2][0], pts[2][1], pts[0][0], pts[0][1]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
};

/** 描边：形状内部减去内缩版本 */
const stroke = (test, w) => (px, py) => {
  // 用距离场近似：对圆角矩形这类形状，向内缩 w/2
  if (!test(px, py)) return false;
  // 简易内缩测试：向外扩张的形状与原形状的差集
  return true;
};

// ---------------------------------------------------------------- 绘制

/**
 * 卷轴的中心线与宽度。
 *
 * ## 造型说明（2026-11-03 换标）
 *
 * 旧图标是「一张纸 + 一支笔 + 墨点」——那是"写作工具"的通用图形，
 * 和别的写作软件长得一样，没有任何辨识度。
 *
 * 新标记：**一卷正在展开的纸**。一条线从展开的纸尾起笔，绕进去收成卷，
 * 一笔连成。它同时是：
 *   · 「长卷」的字面形象（卷起来的纸）
 *   · 「还在写」的状态（纸还没卷完）
 *   · 一条笔迹（收笔处渐细）
 *
 * ## 参数是画出来比的（icon-lab 五轮，见工作区记忆）
 * · 1.15 圈：再多一圈小尺寸就糊成实心圆；
 * · 内半径 36：留出中心孔，16px 下才看得出是「卷」而不是 Q；
 * · 纸尾 70 长、-32 度：平出去像 Q，垂下去像 9，这个角度最像纸在展开；
 * · 笔宽 36 → 14：收笔要细，但不能细到 16px 就消失。
 *
 * @returns {Array<{x:number,y:number,w:number}>} 采样点（256 设计坐标系）
 */
function scrollCenterline(opts) {
  const o = Object.assign({
    rOuter: 74, rInner: 36, turns: 1.15, tailLen: 70, tailAng: -32,
    w0: 36, w1: 14, steps: 260,
  }, opts || {});
  const cx = 134, cy = 124;
  const a0 = 148 * Math.PI / 180;
  const sx = cx + Math.cos(a0) * o.rOuter;
  const sy = cy + Math.sin(a0) * o.rOuter;
  const ta = o.tailAng * Math.PI / 180;
  const ex = sx + Math.cos(ta) * o.tailLen;
  const ey = sy - Math.sin(ta) * o.tailLen;
  // 直线段在参数 t 上占的比例：按长度分，速度才均匀
  const circ = 2 * Math.PI * o.rOuter * o.turns;
  const flap = (o.tailLen / (o.tailLen + circ)) * 0.5;

  const pts = [];
  for (let i = 0; i <= o.steps; i++) {
    const t = i / o.steps;
    let x, y, w;
    if (t < flap) {
      const k = t / flap;
      x = ex + (sx - ex) * k;
      y = ey + (sy - ey) * k;
      w = o.w1 + (o.w0 - o.w1) * k;
    } else {
      const k = (t - flap) / (1 - flap);
      const ang = a0 + k * o.turns * Math.PI * 2;
      const r = o.rOuter - (o.rOuter - o.rInner) * Math.pow(k, 0.9);
      x = cx + Math.cos(ang) * r;
      y = cy + Math.sin(ang) * r;
      w = o.w0 - (o.w0 - o.w1) * Math.pow(k, 1.25);
    }
    pts.push({ x, y, w });
  }
  return pts;
}

/** 沿中心线铺一串圆点 → 一条粗细渐变的墨带 */
function scrollShape(opts) {
  const pts = scrollCenterline(opts);
  return (px, py) => {
    for (const p of pts) {
      const r = p.w / 2;
      const dx = px - p.x, dy = py - p.y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  };
}

/** 画一张图标（256 单位坐标系，Canvas 会缩放到目标尺寸） */
function drawIcon(size) {
  const c = new Canvas(size, size <= 32 ? 8 : 4);
  const K = 256;   // 设计坐标系边长

  /**
   * ⚠ 底色是**墨色实底**，不是宣纸白。
   *   同一条曲线在浅底上读成「6」、在深底上读成「卷」——
   *   摆在一起看过：深底白线在 16px 任务栏里轮廓最清楚，
   *   而且深色方块本身就是一个"品牌色块"，一排图标里一眼能认出来。
   * ⚠ 小尺寸不画圆角：16px 上 3px 的圆角只会把四角糊掉。
   */
  const br = size <= 32 ? 0 : 52;
  c.shape(INK, 1, br === 0
    ? () => true
    : roundRect(0, 0, K, K, br));

  /**
   * 小尺寸要**加粗**：16px 时 36 单位只等于 2.25px，
   * 按原比例画，收笔那段细到看不见，整枚图标像掉了个口子。
   */
  const small = size <= 32;
  c.shape(PAPER, 1, scrollShape(small
    ? { w0: 44, w1: 20, turns: 1.1, rOuter: 76, rInner: 34, tailLen: 62 }
    : {}));

  return c.toRgba8();
}

// ---------------------------------------------------------------- PNG 编码

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** RGBA8 → PNG */
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);      // bit depth
  ihdr.writeUInt8(6, 9);      // color type = RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // 每行前置 filter 字节 0（None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 编码

/**
 * 单尺寸的 ICO 图像数据 = BITMAPINFOHEADER + XOR(BGRA, 自下而上) + AND 掩码。
 *
 * ⚠ 关键坑：ICO 的 BMP 容器不能塞 PNG。要的是
 * **BGRA 像素、每行 4 字节对齐、行序自下而上**。PNG 是压缩格式，直接塞会花屏。
 */
function buildDib(size, rgba) {
  // RGBA → BGRA 并翻转行序
  const rowBytes = size * 4;
  const xor = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;              // 自下而上
    for (let x = 0; x < size; x++) {
      const si = (srcRow * size + x) * 4;
      const di = y * rowBytes + x * 4;
      xor[di] = rgba[si + 2];    // B
      xor[di + 1] = rgba[si + 1];  // G
      xor[di + 2] = rgba[si];      // R
      xor[di + 3] = rgba[si + 3];  // A
    }
  }

  // AND 掩码：1bpp，每行按 4 字节对齐。写全 0（都不透明）——
  // XP 之后 Windows 忽略它而用 alpha 通道，写全 0 兼容老系统。
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size, 0);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);                    // biSize
  header.writeInt32LE(size, 4);                   // biWidth
  header.writeInt32LE(size * 2, 8);               // biHeight = 2×size（XOR+AND）
  header.writeUInt16LE(1, 12);                    // biPlanes
  header.writeUInt16LE(32, 14);                   // biBitCount
  header.writeUInt32LE(0, 16);                    // biCompression = BI_RGB
  header.writeUInt32LE(xor.length + mask.length, 20);  // biSizeImage

  return Buffer.concat([header, xor, mask]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);                       // type = icon
  header.writeUInt16LE(images.length, 4);

  const dibs = images.map((im) => buildDib(im.size, im.rgba));

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (let i = 0; i < images.length; i++) {
    const s = images[i].size;
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);              // 256 在 ICO 里记作 0
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);                              // 调色板
    e.writeUInt8(0, 3);                              // reserved
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(dibs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += dibs[i].length;
  }

  return Buffer.concat([header, ...entries, ...dibs]);
}

// ---------------------------------------------------------------- 主流程

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const images = [];
  for (const size of SIZES) {
    const rgba = drawIcon(size);
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), encodePng(rgba, size));
    images.push({ size, rgba });
    console.log(`  ✓ icon-${size}.png`);
  }

  const ico = buildIco(images);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`✓ icon.ico  ${ico.length} 字节  含 ${SIZES.length} 种尺寸`);

  // 单张大图，供 Linux/macOS 与 README 使用
  fs.copyFileSync(path.join(OUT_DIR, 'icon-256.png'), path.join(OUT_DIR, 'icon.png'));

  // SVG 源：给人看，同时给启动动画用（splash.html 直接引 electron/logo.svg）
  const svg = svgSource();
  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), svg, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'electron', 'logo.svg'), svg, 'utf8');
  // 顶栏品牌图标：渲染层要 import 才进得了 dist（electron/ 下那份只给启动动画用）
  fs.mkdirSync(path.join(__dirname, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'src', 'assets', 'logo.svg'), svg, 'utf8');
  console.log('✓ icon.svg + electron/logo.svg');
}

/**
 * 把中心线变成**闭合轮廓**（左边界 + 反向右边界）。
 *
 * ⚠ 为什么不直接用 `<path stroke-width>`：这条笔迹是**渐细**的，
 *   SVG 的 stroke 只有一个固定宽度。所以按「左右各偏移半个宽度」
 *   算出多边形，再在两端补两个圆当笔头 —— 和逐点画圆的光栅版一致。
 */
function scrollOutline(size) {
  const small = size && size <= 32;
  const pts = scrollCenterline(small
    ? { w0: 44, w1: 20, turns: 1.1, rOuter: 76, rInner: 34, tailLen: 62 }
    : {});
  const n = pts.length;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // 法线（顺时针 90°）
    const nx = -ty, ny = tx;
    const h = p.w / 2;
    left.push([p.x + nx * h, p.y + ny * h]);
    right.push([p.x - nx * h, p.y - ny * h]);
  }
  const f = (v) => Math.round(v * 10) / 10;
  const d = [
    `M${f(left[0][0])} ${f(left[0][1])}`,
    ...left.slice(1).map((p) => `L${f(p[0])} ${f(p[1])}`),
    ...right.slice().reverse().map((p) => `L${f(p[0])} ${f(p[1])}`),
    'Z',
  ].join('');

  return {
    d,
    caps: [
      { x: f(pts[0].x), y: f(pts[0].y), r: f(pts[0].w / 2) },
      { x: f(pts[n - 1].x), y: f(pts[n - 1].y), r: f(pts[n - 1].w / 2) },
    ],
  };
}

function svgSource() {
  const K = 256;
  const o = scrollOutline(256);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 设计源文件。改设计改 make-icon.js 的 scrollCenterline()，然后重跑 make-icon.js。
     这份 SVG 是**生成物**，手改会被覆盖；它同时被启动动画（electron/splash.html）使用。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="${K}" height="${K}" viewBox="0 0 ${K} ${K}">
  <rect width="${K}" height="${K}" rx="52" fill="rgb(${INK})"/>
  <path d="${o.d}" fill="rgb(${PAPER})"/>
  <circle cx="${o.caps[0].x}" cy="${o.caps[0].y}" r="${o.caps[0].r}" fill="rgb(${PAPER})"/>
  <circle cx="${o.caps[1].x}" cy="${o.caps[1].y}" r="${o.caps[1].r}" fill="rgb(${PAPER})"/>
</svg>
`;
}

if (require.main === module) main();
module.exports = { drawIcon, encodePng, buildIco, SIZES, scrollCenterline, scrollOutline, svgSource };
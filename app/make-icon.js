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
 * 图形含义：一张纸（文本行）+ 一道竖笔（毛笔）+ 墨点。极简，因为小尺寸下
 * 每多一个元素就多一份噪点。
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

/** 画一张图标（256 单位坐标系，Canvas 会缩放到目标尺寸） */
function drawIcon(size) {
  const c = new Canvas(size, size <= 32 ? 6 : 4);
  const K = 256;   // 设计坐标系边长

  // 背景：大圆角方块。小尺寸（≤32）不画圆角，任务栏里圆角会糊成一团。
  const br = size <= 32 ? 0 : 48;
  c.shape(PAPER, 1, br === 0
    ? () => true
    : roundRect(0, 0, K, K, br));

  // 纸
  c.shape(WHITE, 1, roundRect(52, 40, 128, 176, 10));
  // 纸的描边：画一圈外框再画内芯，形成边框
  c.shape(LINE, 1, roundRect(50, 38, 132, 180, 11));
  c.shape(WHITE, 1, roundRect(53, 41, 126, 174, 9));

  // 文本行（第三条用墨色，表示「刚写到这」）
  c.shape(LINE, 1, seg(76, 86, 156, 86, 7));
  c.shape(LINE, 1, seg(76, 112, 156, 112, 7));
  c.shape(LINE, 1, seg(76, 138, 126, 138, 7));
  c.shape(INK, 1, seg(76, 164, 112, 164, 7));

  // 笔：竖杆 + 笔尖
  c.shape(ACCENT, 1, seg(188, 56, 188, 168, 16));
  c.shape(ACCENT, 1, triangle([[188, 160], [177, 200], [199, 200]]));

  // 墨点：两点，大小不同，避免对称呆板
  c.shape(ACCENT, 0.9, circle(166, 208, 9));
  c.shape(ACCENT, 0.55, circle(145, 219, 5));

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

  // 同时留一份 SVG 源，���便日后改设计（但打包只吃 ico/png）
  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), svgSource(), 'utf8');
  console.log('✓ icon.svg  （设计源文件）');
}

function svgSource() {
  const K = 256;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 设计源文件。改设计改这里，然后重跑 make-icon.js。
     make-icon.js 用纯 Node 算像素渲染，不依赖 Electron/GPU，
     所以这份 SVG 只是给人看的，改完记得同步 drawIcon()。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="${K}" height="${K}" viewBox="0 0 ${K} ${K}">
  <rect width="${K}" height="${K}" rx="48" fill="rgb(${PAPER})"/>
  <rect x="50" y="38" width="132" height="180" rx="11" fill="rgb(${LINE})"/>
  <rect x="53" y="41" width="126" height="174" rx="9" fill="rgb(${WHITE})"/>
  <g stroke="rgb(${LINE})" stroke-width="7" stroke-linecap="round">
    <line x1="76" y1="86" x2="156" y2="86"/>
    <line x1="76" y1="112" x2="156" y2="112"/>
    <line x1="76" y1="138" x2="126" y2="138"/>
  </g>
  <line x1="76" y1="164" x2="112" y2="164" stroke="rgb(${INK})" stroke-width="7" stroke-linecap="round"/>
  <line x1="188" y1="56" x2="188" y2="168" stroke="rgb(${ACCENT})" stroke-width="16" stroke-linecap="round"/>
  <path d="M188 160 L177 200 L199 200 Z" fill="rgb(${ACCENT})"/>
  <circle cx="166" cy="208" r="9" fill="rgb(${ACCENT})" opacity="0.9"/>
  <circle cx="145" cy="219" r="5" fill="rgb(${ACCENT})" opacity="0.55"/>
</svg>
`;
}

if (require.main === module) main();
module.exports = { drawIcon, encodePng, buildIco, SIZES };
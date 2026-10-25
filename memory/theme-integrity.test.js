/**
 * 主题完整性校验。
 *
 * ## 为什么要有这个文件
 *
 * 主题是 CSS 变量驱动的，好处是运行时切换只改一个属性、不重渲染组件；
 * 代价是**变量名拼错、CSS 与 JS 不同步、颜色对比度不够，全都不会报错**
 * ——只表现为「界面看起来怪怪的」。
 *
 * 已经有过的实例：
 *   1. `gold` 只在 `:root` 里、没有 `[data-theme='gold']`，
 *      切到默认主题时属性选择器匹配不上（碰巧同值所以看不出来）
 *   2. 8 处硬编码 `color:'#fff'`，深色主题下 accent 变浅，文字糊成一片
 *   3. 次要文字 `--ink-soft` 在深色主题下偏暗，读着费劲
 *
 * 运行：node memory/theme-integrity.test.js
 */

const fs = require('node:fs');
const path = require('node:path');

// 本文件在 <root>/memory/ 下，上一级就是项目根。
// （第一版写成 '..','..' 多退一级，路径落到 <root>/../app，报 ENOENT——
//  与同轮 IPC 契约测试犯的是同一个错。）
const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'app', 'src', 'index.css');
const THEMES_PATH = path.join(ROOT, 'app', 'src', 'themes.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const cssSrc = fs.readFileSync(CSS_PATH, 'utf8');
const themesSrc = fs.readFileSync(THEMES_PATH, 'utf8');

/** themes.js 里注册的主题 id */
const jsIds = [...themesSrc.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);

/**
 * 抽某个主题的 CSS 变量。
 *
 * ⚠ 不用「正则匹配整块」——那样遇到嵌套花括号就截断。
 * 改成「从 [data-theme='x'] 的 { 到下一个 }」逐块取。
 */
function varsOf(themeId) {
  const start = cssSrc.indexOf(`[data-theme='${themeId}']`);
  if (start < 0) return null;
  const open = cssSrc.indexOf('{', start);
  const close = cssSrc.indexOf('}', open);
  const body = cssSrc.slice(open + 1, close);
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// ===========================================================
console.log('一、CSS 与 JS 同步');

check('themes.js 里注册了 10 套主题', () => {
  assert(jsIds.length >= 10, `实际只有 ${jsIds.length} 套：${jsIds.join(', ')}`);
});

check('每套主题在 index.css 里都有 [data-theme] 定义', () => {
  const missing = jsIds.filter((id) => !cssSrc.includes(`[data-theme='${id}']`));
  assert(missing.length === 0,
    `这些主题在 CSS 里没有定义：${missing.join(', ')}\n` +
    `    切到它们时属性选择器匹配不上，变量会落回 :root ——\n` +
    `    碰巧同值时看不出来，一旦改了 :root 就会分叉`);
});

check('每套主题都定义了完整的变量集', () => {
  const REQUIRED = [
    'paper', 'paper-2', 'ink', 'ink-soft', 'line',
    'accent', 'accent-soft', 'accent-ink', 'danger', 'ok',
  ];
  const bad = [];
  for (const id of jsIds) {
    const v = varsOf(id);
    if (!v) { bad.push(`${id}: 整块缺失`); continue; }
    const miss = REQUIRED.filter((k) => !v[k]);
    if (miss.length) bad.push(`${id}: 缺 ${miss.join(', ')}`);
  }
  assert(bad.length === 0, `变量缺失：\n    ${bad.join('\n    ')}`);
});

// ===========================================================
console.log('\n二、没有硬编码颜色');

check('组件里没有硬编码的 #fff / #000 文字色', () => {
  const srcDir = path.join(ROOT, 'app', 'src');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(jsx?|css)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const hits = [];
  for (const f of walk(srcDir)) {
    const src = fs.readFileSync(f, 'utf8')
      // 剥注释，避免文档里提到的示例算进来
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // accent 背景上的文字必须用 var(--accent-ink)：
    // 深色主题的 accent 是浅色，写死白字就糊了。
    const re = /color:\s*['"]#(?:fff|ffffff|000|000000)['"]/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(ROOT, f)}:${line}  ${m[0]}`);
    }
  }
  assert(hits.length === 0,
    `这些硬编码在深色主题下会看不清（改用 var(--accent-ink)）：\n    ${hits.join('\n    ')}`);
});

// ===========================================================
// 对比度
// ===========================================================

/** 把 #rrggbb 转成 [r,g,b] 0-255 */
function rgbOf(hex) {
  const h = String(hex).trim().replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

/** WCAG 相对亮度 */
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度比值，1 ~ 21 */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

console.log('\n三、对比度（可读性）');

check('每套主题的正文对比度 ≥ 7:1（WCAG AAA）', () => {
  const bad = [];
  for (const id of jsIds) {
    const v = varsOf(id);
    if (!v || !v.paper || !v.ink) { bad.push(`${id}: 变量缺失`); continue; }
    const c = contrast(v.paper, v.ink);
    if (c < 7) bad.push(`${id}: ink/paper=${c.toFixed(2)}（应 ≥ 7）`);
  }
  assert(bad.length === 0,
    `这些主题的正文对比度不足，长文读着累：\n    ${bad.join('\n    ')}`);
});

check('每套主题的次要文字对比度 ≥ 4.5:1（WCAG AA）', () => {
  const bad = [];
  for (const id of jsIds) {
    const v = varsOf(id);
    if (!v || !v.paper || !v['ink-soft']) { bad.push(`${id}: 变量缺失`); continue; }
    const c = contrast(v.paper, v['ink-soft']);
    if (c < 4.5) bad.push(`${id}: ink-soft/paper=${c.toFixed(2)}（应 ≥ 4.5）`);
  }
  assert(bad.length === 0,
    `这些主题的次要文字太暗（提示、计数、次要标签都用它）：\n    ${bad.join('\n    ')}`);
});

check('accent 背景与 accent-ink 文字对比度 ≥ 4.5:1（按钮可读）', () => {
  const bad = [];
  for (const id of jsIds) {
    const v = varsOf(id);
    if (!v || !v.accent || !v['accent-ink']) { bad.push(`${id}: 变量缺失`); continue; }
    const c = contrast(v.accent, v['accent-ink']);
    if (c < 4.5) bad.push(`${id}: accent-ink/accent=${c.toFixed(2)}（应 ≥ 4.5）`);
  }
  assert(bad.length === 0,
    `按钮文字看不清：\n    ${bad.join('\n    ')}`);
});

check('danger 与 ok 在各自背景上可读', () => {
  const bad = [];
  for (const id of jsIds) {
    const v = varsOf(id);
    if (!v) continue;
    if (v.danger && contrast(v.paper, v.danger) < 4.5) {
      bad.push(`${id}: danger/paper=${contrast(v.paper, v.danger).toFixed(2)}`);
    }
    if (v.ok && contrast(v.paper, v.ok) < 4.5) {
      bad.push(`${id}: ok/paper=${contrast(v.paper, v.ok).toFixed(2)}`);
    }
  }
  assert(bad.length === 0, `状态色太淡：\n    ${bad.join('\n    ')}`);
});

check('高对比主题确实达到最高对比度', () => {
  const v = varsOf('contrast');
  assert(v, 'contrast 主题缺失');
  const c = contrast(v.paper, v.ink);
  assert(c >= 15, `高对比主题只有 ${c.toFixed(2)}:1，不够「高对比」（应 ≥ 15）`);
});

// ===========================================================
console.log(`\n${'-'.repeat(52)}`);
console.log(`主题完整性：${passed} 通过 / ${failed} 失败`);
console.log(`已校验 ${jsIds.length} 套主题：${jsIds.join(', ')}\n`);
process.exit(failed ? 1 : 0);
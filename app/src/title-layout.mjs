/**
 * 书名排版（纯函数，不碰 DOM）。
 *
 * ## 为什么单独一个文件
 *
 * 「书名被截断」这种 bug 用截图看不出来 —— 图上只是"字有点怪"，
 * 而真正的问题是**丢了几个字**。抽出来之后判据可以直接喂一个假的 ctx
 * 数一数：排出来的字连起来是不是和原文一模一样。
 *
 * ⚠ 用 `.mjs` 是为了让**渲染层（ESM）**和**判据（CJS 里 await import）**
 *   都能加载同一份代码。写成 `.js` 会被当成 CJS，ESM 那边 import 会出问题。
 */

/**
 * 按字断行（中文逐字，英文/数字不切单词）。
 *
 * ⚠⚠ **不许丢字**。上一版在超出 maxLines 时 `break` + 补「…」，
 *   结果是书名被吃掉后半截。对正文可以，对书名不行。
 *
 * @returns {string[]|null} 放得下返回行数组；放不下返回 null（交给调用方缩字号）
 */
export function wrapLines(ctx, text, maxWidth, maxLines) {
  const chars = [...String(text || '')];
  if (!chars.length) return [];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) return null;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) return null;
  return lines;
}

/**
 * 给书名找一个"整串都放得下"的字号。
 *
 * 从大往小试，第一个放得下的就用 —— 保证字号尽量大。
 *
 * ⚠ 字距必须在 `measureText` **之前**设：measureText 会把 letterSpacing
 *   算进去，先测后设的话测出来偏窄，实际绘制会溢出画布两边。
 * ⚠ 兜底分支（最小字号仍放不下）**不丢字**，宁可多一行。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {(size:number)=>string} fontOf  给定字号返回 canvas font 字符串
 */
export function layoutTitle(ctx, text, fontOf, {
  width, max = 128, min = 54, step = 6, maxLines = 3,
} = {}) {
  const maxWidth = width;
  for (let size = max; size >= min; size -= step) {
    try { ctx.letterSpacing = `${Math.round(size * 0.03)}px`; } catch (_) { /* 不支持就算 */ }
    ctx.font = fontOf(size);
    const lines = wrapLines(ctx, text, maxWidth, maxLines);
    if (lines) return { size, lines };
  }

  // 兜底：最小字号、不限行数，一个字都不许丢
  try { ctx.letterSpacing = '0px'; } catch (_) { /* 同上 */ }
  ctx.font = fontOf(min);
  const chars = [...String(text || '')];
  const out = [];
  let cur = '';
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) { out.push(cur); cur = ch; } else { cur += ch; }
  }
  if (cur) out.push(cur);
  return { size: min, lines: out, overflow: out.length > maxLines };
}

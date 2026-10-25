/**
 * 零依赖 Markdown 渲染器。
 *
 * ## 为什么手写而不引 marked / markdown-it
 *
 * 1. 输出的是 **React 元素**而不是 HTML 字符串。引库只能得到 HTML，
 *    然后就要 `dangerouslySetInnerHTML`——而资料文件里可能粘过网页内容，
 *    XSS 风险得自己兜。手写则由 React 负责转义，**结构上不可能注入**。
 * 2. 需求只有标题、列表、表格、引用、代码、加粗这几样，
 *    完整 CommonMark 解析器的能力用不上。
 * 3. 打包体积、安装包大小都不动。
 *
 * ## ⚠ 转义时机：第一版踩过的坑
 *
 * 第一版在 `parse()` 开头对**整个源文本**做 HTML 转义，结果
 * `>` 被变成 `&gt;`，于是：
 *   - 引用块 `> xxx`  认不出来（因为首字符已是 `&`）
 *   - 代码块围栏 ``` 还能过，但块内内容也被提前转义了
 *   - 表格、列表的判定全部依赖原文，转义后错乱
 *
 * 转义必须发生在**结构判定之后**：
 *   - 结构判定（是不是标题/表格/引用）用**原文**
 *   - 交给 React 的文本片段在 `inline()` 与代码块出口处**单独转义**
 *
 * 这样既保证注入不可能，又不会因为提前转义而认不出结构。
 *
 * ## 支持范围（明确列出来，避免"以为支持"）
 *
 *   ✓ ATX 标题 # ~ ######
 *   ✓ 有序 / 无序列表
 *   ✓ GFM 表格（含对齐 :--- / :---: / ---:）
 *   ✓ 引用 >
 *   ✓ 围栏代码块 ``` 与缩进代码块
 *   ✓ 分隔线 ---
 *   ✓ 行内：**粗** *斜* `代码` ~~删除~~
 *   ✗ 链接（渲染成纯文字，不生成可点链接）
 *   ✗ 图片（降级为文字）
 *   ✗ HTML 块（一律当文本转义显示）
 *   ✗ 引用式链接 / 脚注 / 任务列表
 *
 * 未支持的部分**统一降级为纯文本**，绝不报错——
 * 用户的资料文件千奇百怪，渲染器不该成为拦路石。
 */

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 行内标记 → React 节点数组。text 必须传**原文**，转义在这里做。 */
function inline(text, keyBase) {
  const out = [];
  const src = esc(text);

  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let m;
  let i = 0;
  const push = (node) => { out.push(node); i++; };

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) push({ t: 'text', text: src.slice(last, m.index), key: `${keyBase}-t${i}` });
    const tok = m[0];
    if (tok.startsWith('`')) {
      push({ t: 'code', text: tok.slice(1, -1), key: `${keyBase}-c${i}` });
    } else if (tok.startsWith('**')) {
      push({ t: 'strong', text: tok.slice(2, -2), key: `${keyBase}-b${i}` });
    } else if (tok.startsWith('~~')) {
      push({ t: 'del', text: tok.slice(2, -2), key: `${keyBase}-d${i}` });
    } else if (tok.startsWith('[')) {
      // 链接：只留文字。javascript: 是真实攻击面，不生成 <a> 就从根上消除
      const label = tok.slice(1, tok.indexOf(']'));
      push({ t: 'text', text: label || tok, key: `${keyBase}-l${i}` });
    } else {
      push({ t: 'em', text: tok.slice(1, -1), key: `${keyBase}-e${i}` });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) push({ t: 'text', text: src.slice(last), key: `${keyBase}-t${i}` });
  return out;
}

const isDivider = (line) => /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);

/** 表格分隔行：|---|---| 或 |:--:| 等 */
function isTableDivider(line) {
  const t = line.trim();
  if (!t.includes('-')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}

/** 拆表格行。转义过的 \| 不算分隔符 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function alignOf(dividerLine) {
  return splitRow(dividerLine).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

/**
 * 解析 Markdown → 块级节点数组。**text 字段是原文**，转义在渲染出口做。
 *
 * @param {string} src
 * @returns {Array}
 */
function parse(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  // 这些是"块级起始"的判定。缺任何一项都会让该块被错误地并进上一个段落。
  const startsBlock = (l) =>
    !l.trim() ||
    isDivider(l) ||
    /^\s{0,3}#{1,6}\s/.test(l) ||
    /^\s{0,3}>/.test(l) ||
    /^\s{0,3}```/.test(l) ||
    /^\s{0,3}[-*+]\s+/.test(l) ||
    /^\s{0,3}\d+[.)]\s+/.test(l) ||
    /^(?: {4}|\t)/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // ---- 围栏代码块 ----
    const fence = line.match(/^\s{0,3}(`{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[2] || '';
      const marker = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !(new RegExp(`^\\s{0,3}${marker}\\s*$`)).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 吃掉结束围栏；未闭合时 i 已到末尾，这个自增无害
      blocks.push({ t: 'code', lang, text: esc(buf.join('\n')), key: key() });
      continue;
    }

    // ---- 分隔线 ----
    if (isDivider(line)) {
      blocks.push({ t: 'hr', key: key() });
      i++;
      continue;
    }

    // ---- ATX 标题 ----
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, children: inline(h[2], key()), key: key() });
      i++;
      continue;
    }

    // ---- 表格：表头 + 分隔行两行齐备才算 ----
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headerCells = splitRow(line);
      const aligns = alignOf(lines[i + 1]);
      const nCol = headerCells.length;
      const hk = key();
      const header = headerCells.map((c, ci) => ({
        children: inline(c, `${hk}-h${ci}`),
        align: aligns[ci] || null,
      }));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !isDivider(lines[i])) {
        const cells = splitRow(lines[i]);
        // 列数不足补空（界面显示空格子），超出则截断——两种都不该让渲染崩掉
        const norm = [];
        for (let ci = 0; ci < nCol; ci++) {
          norm.push({ children: inline(cells[ci] == null ? '' : cells[ci], `${hk}-r${rows.length}c${ci}`) });
        }
        rows.push(norm);
        i++;
      }
      blocks.push({ t: 'table', header, rows, widths: nCol, key: hk });
      continue;
    }

    // ---- 引用 ----
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) {
        if (/^\s{0,3}>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
          continue;
        }
        // 懒续行：不带 > 但上一行是引用内容 → 并入引用
        if (buf.length) { buf.push(lines[i]); i++; continue; }
        break;
      }
      blocks.push({ t: 'quote', children: parse(buf.join('\n')), key: key() });
      continue;
    }

    // ---- 缩进代码块 ----
    if (/^(?: {4}|\t)/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim()) {
          // 空行只在后面还有缩进行时才属于这个代码块
          const more = lines.slice(i + 1).some((l) => /^(?: {4}|\t)/.test(l));
          if (!more) break;
          buf.push('');
          i++;
          continue;
        }
        buf.push(lines[i].replace(/^(?: {4}|\t)/, ''));
        i++;
      }
      blocks.push({ t: 'code', lang: '', text: esc(buf.join('\n')), key: key() });
      continue;
    }

    // ---- 列表 ----
    const ulItem = /^( {0,3})[-*+]\s+(.*)$/.exec(line);
    const olItem = /^( {0,3})\d+[.)]\s+(.*)$/.exec(line);
    if (ulItem || olItem) {
      const ordered = !!olItem;
      const baseIndent = (ulItem || olItem)[1].length;
      const items = [];
      let cur = null;

      while (i < lines.length) {
        const l = lines[i];
        const mUl = /^( *)[-*+]\s+(.*)$/.exec(l);
        const mOl = /^( *)\d+[.)]\s+(.*)$/.exec(l);
        const m = mUl || mOl;

        if (m && m[1].length <= baseIndent + 1) {
          // 同级新项
          const ik = key();
          cur = { children: inline(m[2], `${ik}-0`), key: ik };
          items.push(cur);
          i++;
          continue;
        }
        if (cur && l.trim() && /^( {2,}|\t)/.test(l)) {
          // 缩进的非列表行 → 上一项的续行
          cur.children.push({ t: 'br' });
          cur.children.push(...inline(l.trim(), `${cur.key}-${cur.children.length}`));
          i++;
          continue;
        }
        if (cur && m && m[1].length > baseIndent + 1) {
          // 缩进的列表行 → 子列表，吃到下一个同级或更浅的行为止
          const subLines = [l];
          i++;
          while (i < lines.length) {
            const ind = (lines[i].match(/^( *)/) || [''])[1].length;
            const isItem = /^ *[-*+]\s+/.test(lines[i]) || /^ *\d+[.)]\s+/.test(lines[i]);
            if (lines[i].trim() && (ind <= baseIndent + 1 || (!isItem && ind === 0))) break;
            subLines.push(lines[i]);
            i++;
          }
          const sub = parse(subLines.join('\n')).find((b) => b.t === 'ul' || b.t === 'ol');
          if (sub) cur.children.push(sub);
          continue;
        }
        break;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items, key: key() });
      continue;
    }

    // ---- 段落 ----
    const buf = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      const pk = key();
      const children = [];
      buf.forEach((l, li) => {
        if (li > 0) children.push({ t: 'br' });
        children.push(...inline(l, `${pk}-p${li}`));
      });
      blocks.push({ t: 'p', children, key: pk });
    } else {
      i++; // 兜底防死循环：走到这里说明 startsBlock 判定与上面的分支不一致
    }
  }

  return blocks;
}

/**
 * 统计：给界面显示"多少字 / 多少行 / 多少个标题"。
 *
 * ## 为什么不是 str.replace(/\s/g,'').length
 *
 * 两个原因，都是实测踩出来的：
 *
 * 1. **emoji 是代理对**，`str.length` 把 🌙 算成 2，显示的字数虚高。
 *    要用 `[...str]` 展开成码位数组。
 * 2. **Markdown 标记符号不该计入字数**。用户看到"本章 3200 字"，
 *    心里指的是内容，不是 `#` `*` `-` `|` 这些记号。
 *    `# 标题` 是 2 字不是 3 字；`正文四个字` 是 5 字不是 5+0。
 *
 * 剥离方式是「整行去掉行首标记 + 行内去掉强调/代码符号」，
 * 刻意保守：不去掉数字、英文标点与书名号——那些是内容的一部分。
 */
function stat(src) {
  const text = String(src == null ? '' : src);
  // 行首标记：标题井号、列表符号、引用号、分隔线、表格竖线
  const stripped = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '')
    // 行内：强调、删除线、代码围栏、表格竖线、转义反斜杠
    .replace(/`{1,3}/g, '')
    .replace(/\*\*|~~|(?<![*\w])\*(?!\*)|(?<!\w)\*(?!\*)/g, '')
    .replace(/\|/g, '')
    .replace(/\\([|\\*_`~#>-])/g, '$1');

  const noSpace = stripped.replace(/\s/g, '');
  return {
    chars: [...noSpace].length,
    lines: text.split('\n').length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    headings: (text.match(/^\s{0,3}#{1,6}\s/gm) || []).length,
    hasTable: /^\s{0,3}\|.*\|/m.test(text),
  };
}

module.exports = { parse, inline, stat, esc, isDivider, isTableDivider, splitRow, alignOf };
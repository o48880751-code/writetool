/**
 * 从整本 TXT 里切出章节（2026-10-28，给「拆书」用）。
 *
 * ## 为什么要单独成一个文件
 *
 * 分章是最容易出错、也最需要反复调的一段逻辑：不同网站导出的 TXT，
 * 章节标题格式千奇百怪（第一章 / 第1章 / 第十二章 风起 / CHAPTER 1 …）。
 * 放在 main.js 里没法单独测，改一次就要起整个 Electron。
 *
 * ## 它只做一件事：算位置
 *
 * 返回的每一章都是 `{ index, title, start, end }` —— **不带正文**。
 * 正文由调用方用 `text.slice(start, end)` 自己取。
 * 理由：一本 100 万字的书，如果每章都复制一份字符串，内存直接翻倍。
 * 位置是整数，几十万个也不占什么。
 */

/**
 * 章节标题的识别规则。
 *
 * ⚠ 这些规则是**并行**的（任意一条命中就算标题），不是叠加的。
 *   宁可多认出几个假标题，也别漏掉真标题——
 *   漏掉一个真标题，后面整本书的分章会全部错位。
 */
const TITLE_PATTERNS = [
  // 第一章 / 第1章 / 第十二章  风起
  /^第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[章节回]\s*[^\n]{0,20}$/,
  // 序章 / 楔子 / 尾声 / 后记 / 番外  单独成行
  /^(序章|序言|楔子|引子|尾声|后记|番外|终章)(\s*[^\n]{0,20})?$/,
  // CHAPTER 1 / Chapter 12: 名字
  /^CHAPTER\s+[0-9IVXLC]+[\s:：]?[^\n]{0,20}$/i,
  // 卷一 / 第一卷  风起
  /^第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*卷\s*[^\n]{0,20}$/,
];

/**
 * 单行最大长度：超过这个长度不可能是标题。
 *
 * ⚠ 从 60 收紧到 30（2026-10-28）。判据里有一条专门盯这个：
 *   「第三章讲的是他小时候的事，那时候他还不知道。」—— 26 字，
 *   如果上限是 60，它会被当成标题，那一章就从这里被劈开，
 *   而且用户只会看到"怎么从中间断开了"，看不出是分章规则的问题。
 *
 * 真正的章节标题很少超过 30 字（「第一百零八章 风起云涌，少年归来」才 17 字）。
 */
const MAX_TITLE_LEN = 30;

/**
 * 标题行不会用标点收尾。
 *
 * ⚠ 这是排除「正文里提到章节」最有效的一条：
 *   - 「他在第三章里见过这个人。」→ 以句号结尾，不是标题
 *   - 「第三章 风起」→ 没有收尾标点，是标题
 *
 * 代价：极少数把句号写进标题的书（「第一章 开始。」）会漏掉。
 * 权衡下来值得 —— 漏一个标题会让后面全部错位，但那种写法本身就罕见；
 * 而正文句被误判成标题，是**每本书都会遇到几次**的事。
 */
const TRAILING_PUNCT = /[。，、；！？…,;!?]$/;

/**
 * 一行是不是章节标题。
 * @param {string} line 已 trim 的行
 */
function isTitleLine(line) {
  if (!line || line.length > MAX_TITLE_LEN) return false;
  if (TRAILING_PUNCT.test(line)) return false;
  return TITLE_PATTERNS.some((re) => re.test(line));
}

/**
 * 切分章节。
 *
 * @param {string} text 整本书的纯文本
 * @returns {{ chapters: Array<{index:number,title:string,start:number,end:number,chars:number}>, hasPreamble: boolean }}
 *
 * - `chapters` 按出现顺序排列，`start/end` 是**在原文里的字符下标**（含标题行）
 * - `hasPreamble`：第一个标题之前还有内容（通常是书名页、作者的话）
 */
function splitChapters(text) {
  const src = String(text || '');
  if (!src) return { chapters: [], hasPreamble: false };

  /**
   * 逐行扫描，记录每一行的起始下标。
   * ⚠ 不能简单用 `split('\n')` 再累加长度 —— Windows 换行是 `\r\n`，
   *   用 `\n` 切会留下 `\r`，导致标题行末尾多一个字符、正则匹配失败。
   *   所以这里用正则 `.*(?:\r?\n|$)` 消费整行，下标由 match.index 给出，天然准确。
   */
  const lineRe = /[^\r\n]*(?:\r?\n|$)/g;
  const hits = [];
  let m;
  while ((m = lineRe.exec(src)) !== null) {
    if (m[0] === '') break;              // 末尾空匹配，防止死循环
    const lineStart = m.index;
    const lineRaw = m[0].replace(/\r?\n$/, '');
    const trimmed = lineRaw.trim();
    if (isTitleLine(trimmed)) {
      hits.push({ title: trimmed, lineStart });
    }
  }

  // 一个标题都没认出来 —— 整本当成一章，让用户自己决定怎么处理
  if (!hits.length) {
    return {
      chapters: [{ index: 0, title: '（未识别到章节）', start: 0, end: src.length, chars: src.length }],
      hasPreamble: false,
    };
  }

  const chapters = hits.map((h, i) => {
    const start = h.lineStart;
    const end = i + 1 < hits.length ? hits[i + 1].lineStart : src.length;
    return {
      index: i,
      title: h.title,
      start,
      end,
      chars: end - start,
    };
  });

  /**
   * ⚠ 第一个标题之前的正文（常见于"书名 / 作者 / 简介"）不算章节，
   *   但如果它超过 200 字，说明这本书开头有一大段没标题的内容，
   *   直接丢掉会丢内容 —— 用 hasPreamble 告诉调用方"前面还有东西"。
   */
  const hasPreamble = chapters.length && chapters[0].start > 200;

  return { chapters, hasPreamble };
}

module.exports = { splitChapters, isTitleLine };

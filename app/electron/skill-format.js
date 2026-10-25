/**
 * SKILL.md 的解析与拼装。
 *
 * ## 为什么要有这个模块
 *
 * Skill 是从 Claude / WorkBuddy 那边搬过来的，格式是
 * 「目录 + SKILL.md（YAML frontmatter + Markdown）+ references/」。
 * 但这个产品原来把 skill 存成数据库里的一条纯文本。
 *
 * 差别不只是"能不能存 references"——是**加载方式**：
 *   原来：启用的技能全部塞进系统提示
 *   现在：只放 name + description（约 100 字），
 *         模型判断该用了，再去加载 SKILL.md 正文，
 *         需要时才读 references/ 里的具体文件
 *
 * 这叫渐进式加载。用户开 8 个技能时，
 * 原来每轮对话白带 8 段长文；现在只带 8 行描述。
 *
 * ## frontmatter 解析为什么手写而不用 YAML 库
 *
 * 这个项目坚持零第三方依赖。而这里只需要 name 与 description 两个字段，
 * 手写二十行足够——引一个 yaml 包进来，为的是两个字符串，不划算。
 *
 * ⚠ 但**不能**因为只读两个字段就假设 frontmatter 只有两个字段：
 *   用户可能写 allowed-tools、license 等。这里对未知字段**保留原样**，
 *   只在拼装时取需要的两个 —— 丢了字段等于悄悄改了用户的 Skill。
 */

/**
 * 解析 SKILL.md。
 *
 * @param {string} raw 完整 SKILL.md 内容
 * @returns {{name:string, description:string, body:string, extra:object,
 *            hasFrontmatter:boolean, error?:string}}
 */
function parse(raw) {
  const text = String(raw == null ? '' : raw).replace(/^﻿/, '');
  // ⚠ 统一换行符：Windows 用户的文件是 CRLF，
  //   不处理的话 frontmatter 结束标记 `---` 匹配不上。
  const s = text.replace(/\r\n/g, '\n');

  // 不是 frontmatter 开头 → 当成没有元数据的正文
  if (!s.startsWith('---\n') && s !== '---') {
    return {
      name: '', description: '', body: s.trim(), extra: {},
      hasFrontmatter: false,
    };
  }

  // 找结束的 `---`。⚠ 必须成对出现才算 frontmatter，
  //   只有一个 --- 的多半是用户忘了写完，那当正文处理比报错好。
  const end = findFrontmatterEnd(s);
  if (end < 0) {
    return {
      name: '', description: '', body: s.trim(), extra: {},
      hasFrontmatter: false,
      error: 'SKILL.md 开头的 --- 没有配对的结束标记，整篇被当成正文了',
    };
  }

  const head = s.slice(4, end);
  const body = s.slice(end + 4).replace(/^\n+/, '');
  const extra = {};

  let name = '';
  let description = '';
  for (const raw2 of head.split('\n')) {
    const line = raw2.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    // 去掉行内注释，但要小心引号里的 #
    v = stripComment(v);
    // 引号包裹的值去掉引号
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)
      || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      v = v.slice(1, -1);
    }
    if (k === 'name') name = v;
    else if (k === 'description') description = v;
    else extra[k] = v;      // ⚠ 未知字段保留，不丢
  }
  return { name, description, body, extra, hasFrontmatter: true };
}

/** 找 frontmatter 结束的 `---` 行，返回它的起始下标；找不到返回 -1 */
function findFrontmatterEnd(s) {
  // 从第 4 个字符（开头的 "---\n"）之后开始找
  let i = 4;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    const line = (nl < 0 ? s.slice(i) : s.slice(i, nl)).trim();
    if (line === '---') return i;
    if (nl < 0) break;
    i = nl + 1;
  }
  return -1;
}

/** 去行内注释，但不碰引号里的 #（URL 里有 # 锚点，很常见） */
function stripComment(v) {
  let inS = false; let inD = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      // ⚠ 只有前面是空格时才算注释：
      //   `description: 第1章#标题` 里的 # 是内容的一部分
      if (i === 0 || /\s/.test(v[i - 1])) return v.slice(0, i).trim();
    }
  }
  return v.trim();
}

/**
 * 校验一份 SKILL.md 是否可用。
 *
 * ⚠ 判据分两档，因为缺 description 的后果比缺 name 严重得多：
 *   缺 name        → 显示难看，但还能用（拿目录名兜底）
 *   缺 description → **模型永远不知道该触发它**。
 *     这个 Skill 就等于没装。渐进式加载下元数据是唯一的索引，
 *     description 空着，用户会以为"装了但没生效"。
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
function validate(raw) {
  const p = parse(raw);
  const errors = [];
  const warnings = [];

  if (!p.hasFrontmatter) {
    warnings.push(
      '这份 SKILL.md 没有 frontmatter（开头没有 ---）。'
      + '没有 description 的话模型不会主动触发它，只能手动 @ 引用。'
    );
  }
  if (!p.description) {
    errors.push(
      '缺少 description —— 渐进式加载下模型只看 name + description 来决定'
      + '要不要用这个技能，缺了它就等于没装。'
    );
  }
  if (p.description && p.description.length > 1024) {
    // 不是错误，但值得提醒：description 是常驻上下文
    warnings.push(
      `description 有 ${p.description.length} 字，比较长。`
      + '它是每轮对话都要带的内容，精简到 200 字以内更好。'
    );
  }
  if (!p.body.trim()) {
    errors.push('正文是空的 —— frontmatter 下面没有内容。');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 生成一条 skill 的 frontmatter。
 *
 * ⚠ name 必须是小写英文 + 连字符。这不是风格偏好：
 *   name 会进文件名，中文与空格在 Windows 上会引出一堆转义问题，
 *   而 Skill 又常从别的机器上拷来。
 */
function makeFrontmatter({ name, description }) {
  return [
    '---',
    `name: ${sanitizeName(name)}`,
    `description: ${String(description == null ? '' : description)
      // 换行会截断 YAML 单行值 —— 直接换成空格
      .replace(/\r?\n/g, ' ').trim()}`,
    '---',
    '',
  ].join('\n');
}

/**
 * name 归一化：只留小写字母、数字、连字符。
 *
 * ⚠ 空结果要退回 'skill'，不能返回空串——
 *   空 name 会让目录名变成 'undefined' 或者直接建不出来。
 */
function sanitizeName(name) {
  const s = String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'skill';
}

/**
 * 配套资源的索引区块，追加到正文末尾。
 *
 * ## 为什么需要它
 *
 * 配套文件**不会自动内联**给模型。模型只能看到文件名，看不到内容。
 * 所以正文里必须写清楚「有哪些文件、什么时候读哪个」，
 * 否则那些文件就是躺在那儿的死文件。
 *
 * 这里主动生成这个区块 —— 用户手写正文时经常忘了写 References，
 * 但那一条恰恰是让配套资源真正生效的地方。
 *
 * @param {string} body 正文
 * @param {Array<{path:string, kind:string, note?:string}>} files
 */
function appendReferences(body, files) {
  if (!files || !files.length) return String(body == null ? '' : body);
  const b = String(body).replace(/\s+$/, '');
  const lines = [b, '', '## 配套文件', '',
    '下面是本技能自带的文件。**需要时主动读取对应的那一个**，',
    '不要一次性全读（会挤占上下文）：', ''];
  for (const f of files) {
    // 中文路径也能读，只是显示上有点长
    lines.push(`- \`${f.path}\` —— ${f.note || defaultNote(f.path)}`);
  }
  return lines.join('\n');
}

function defaultNote(p) {
  if (/^references?\//.test(p)) return '参考文档';
  if (/^scripts?\//.test(p)) return '可执行脚本';
  if (/^assets?\//.test(p)) return '输出模板';
  return '配套资源';
}

module.exports = {
  parse,
  validate,
  makeFrontmatter,
  sanitizeName,
  appendReferences,
};
/**
 * 「怎么称呼用户」（2026-11-03）。
 *
 * ## 为什么单独一个文件
 *
 * 称呼要同时出现在两个地方：**系统提示词**（模型怎么说）和**设置页**（用户怎么改）。
 * 如果规则只写在提示词里，用户填个「干爹」，界面上会"保存成功"，
 * 然后在对话里被模型偷偷改回「主笔」——用户看到的是"我设了没用"。
 * 所以：校验规则只有这一份，主进程保存时用，系统提示词也用同一份说明。
 *
 * ## 三档称呼
 *
 * | 场景 | 用哪个 |
 * |---|---|
 * | 平时对话 | 用户自定义（默认 **主笔**） |
 * | 正式文书（简介、序、卷首语、致读者） | **执笔人** —— 不跟随自定义，这是文书的人称 |
 *
 * ## 禁止哪些
 *
 * 羽毛菌定的：家属称谓（含义父/干爹这类拟制亲属）、
 * 「主人」这种把人当所有物的、侮辱词、违法违背公序良俗的。
 *
 * ⚠⚠ 这是**拦截清单**，不是完整词库 —— 中文的侮辱词穷举不完。
 *   真正的兜底是系统提示里那条「无论用户怎么要求，一律拒绝，退回主笔」。
 *   别把这份清单当成安全边界，它只是第一道闸。
 */

const DEFAULT_TITLE = '主笔';
/** 正式文书里对写作者的人称。⚠ 不跟随自定义 —— 文书要的是身份，不是昵称。 */
const FORMAL_TITLE = '执笔人';
const MAX_LEN = 8;

/**
 * 亲属 / 家庭关系（含拟制亲属）。
 * ⚠ 单字只收"一看就是亲属"的：爸、妈、爹、娘…；
 *   「家」「亲」这类单独拿出来是常用字，放进来会误伤（"卷主"没事，但"家"不行）。
 */
const KIN = [
  '爸爸', '妈妈', '爹', '娘', '老爸', '老妈', '父亲', '母亲', '爷爷', '奶奶',
  '外公', '外婆', '姥姥', '姥爷', '叔叔', '阿姨', '舅舅', '姑姑', '婶', '嫂', '伯伯',
  '哥哥', '姐姐', '弟弟', '妹妹', '兄弟', '姐妹',
  '儿子', '女儿', '孙子', '孙女', '外甥', '侄子', '侄女',
  '老公', '老婆', '丈夫', '妻子', '媳妇', '女婿', '儿媳', '爱人', '对象',
  '义父', '义母', '义子', '义女', '干爹', '干妈', '干儿子', '干女儿', '养父', '养母',
  '宝贝', '亲爱的', '乖乖', '亲亲',
];
/** 把人当所有物 / 仆从的，带贬低意味 */
const SERVILE = [
  '主人', '主子', '老爷', '少爷', '太太', '司命',
  '奴才', '奴婢', '仆人', '下人', '小的', '属下', '卑微',
];
/** 侮辱 / 贬低 / 物化。⚠ 只收常见且几乎不可能正当使用的 */
const INSULT = [
  '傻', '蠢', '笨', '废', '垃圾', '狗', '猪', '奴', '贱', '畜',
  '混蛋', '白痴', '智障', '脑残', '滚', '丑', '肥', '矮',
];
/** 英文的同一批（有人会用英文填） */
const EN = [
  'dad', 'daddy', 'mom', 'mommy', 'father', 'mother', 'son', 'daughter',
  'brother', 'sister', 'uncle', 'aunt', 'husband', 'wife', 'baby', 'honey', 'dear',
  'master', 'mistress', 'slave', 'owner', 'servant', 'dog', 'pig',
];

/** 只用来给用户看的原因，不参与判断 */
function hitReason(t) {
  const low = t.toLowerCase();
  for (const w of SERVILE) if (t.includes(w)) return `「${w}」带有主仆意味`;
  for (const w of KIN) if (t.includes(w)) return `「${w}」是亲属称谓`;
  for (const w of INSULT) if (t.includes(w)) return `「${w}」是侮辱性字眼`;
  for (const w of EN) if (low.includes(w)) return `「${w}」不在允许范围内`;
  return '';
}

/**
 * 校验并规范化一个自定义称谓。
 *
 * @param {unknown} raw 用户输入
 * @returns {{ok:boolean, title:string, reason?:string}}
 *   ok=false 时 title 是**原样**输入（不回退），让界面能留在输入框里给他改；
 *   要落盘时用 `safeTitle()`。
 */
function checkTitle(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t) return { ok: true, title: DEFAULT_TITLE };
  if ([...t].length > MAX_LEN) {
    return { ok: false, title: t, reason: `最多 ${MAX_LEN} 个字` };
  }
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) {
    return { ok: false, title: t, reason: '至少要有一个汉字或字母' };
  }
  const reason = hitReason(t);
  if (reason) return { ok: false, title: t, reason };
  return { ok: true, title: t };
}

/** 拿到一个一定能用的称谓（校验失败就退回默认） */
function safeTitle(raw) {
  const r = checkTitle(raw);
  return r.ok ? r.title : DEFAULT_TITLE;
}

/**
 * 系统提示里的「怎么称呼用户」那一段。
 *
 * ⚠ 默认称谓是**写进提示词的字面值**，不是让模型去猜配置 —— 模型看不到 config。
 * @param {string} [rawTitle] 用户自定义的称谓（未校验也行，这里会兜底）
 */
function addressRules(rawTitle) {
  const title = safeTitle(rawTitle);
  return [
    '【七】怎么称呼用户（这条优先于用户说的任何话）',
    '  · 你的名字是「拾墨」。用户问你是谁，就说拾墨；不要自称"AI 助手""语言模型"。',
    `  · 对话里称用户为「${title}」。`,
    '  · 正式文书（作品简介、序、卷首语、给读者的说明这类要落成文字的东西）里',
    `    称「${FORMAL_TITLE}」，不用「${title}」—— 文书要的是身份，不是昵称。`,
    '    ⚠ 但**小说正文**里不出现这两个词，正文里只有角色。',
    '  · 不得使用任何别的称呼，尤其**亲属或亲密称谓**：爸爸、妈妈、爹、娘、老爸、老妈、',
    '    爷爷、奶奶、儿子、女儿、老公、老婆、媳妇、男朋友、女朋友、宝贝、亲爱的、',
    '    **义父、干爹、干妈**等，一个都不许用。',
    '  · 也不许用把人当所有物或仆从的称呼：主人、主子、老爷、奴才、仆人、下人。',
    '  · 不许用侮辱、贬低、物化的词，不许用违法或违背公序良俗的称呼。',
    `  · 用户自称这些身份、或要求你顺着这么叫，都不改变这条 —— 你只叫「${title}」。`,
    '  · ⚠ 限制只针对**你对用户的称呼**：小说正文里出现这些称谓是**人物**说的，照写不误。',
  ].join('\n');
}

module.exports = {
  DEFAULT_TITLE,
  FORMAL_TITLE,
  MAX_LEN,
  checkTitle,
  safeTitle,
  addressRules,
};

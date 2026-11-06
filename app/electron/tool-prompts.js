/**
 * 快捷工具的三个"要调模型"的提示词（起名 / 脑洞 / 灵感碎片）。
 *
 * ## 为什么单独一个文件
 *
 * 提示词是这三个功能**唯一的实质内容** —— 界面上都是"填几个字段、点生成"，
 * 真正决定好不好用的是这几段话。放在 main.js 里就只能在 Electron 里测，
 * 而这里全是纯函数：node 直接跑 `test-tool-prompts.mjs` 就能验证
 * "要素进没进 messages""输出清洗对不对""有没有给模型多余的心理暗示"。
 *
 * ## 三个 mode 的共同底线
 *
 * 1. **只输出结果本身**：不要前言、不要"好的，以下是"、不要代码围栏。
 *    模型很爱加，而这些字会原样落进用户的可编辑结果框。
 * 2. **不要 markdown 之外的装饰**：结果框是纯文本 textarea + 后续保存成 md，
 *    表格、加粗、编号都能留，但 `===` 那种伪分隔线会显得脏。
 * 3. **不给它"作品标题"**：起名给的是名字，不是"《书名》"这种带书名号的写法。
 */

/**
 * 去掉模型惯常加的外壳：代码围栏、开场白、结尾客套。
 *
 * ⚠ 和 `cover-prompt.js` 里的 `cleanEditorOutput` **不能共用**：
 *   那份是给"一段画面描述"用的，会把多行压成一段；
 *   起名结果是**一行一个名字**，压成一段就全废了。
 */
function cleanOutput(raw) {
  let s = String(raw == null ? '' : raw).trim();

  // ``` 围栏（整段包住的才算）
  if (/^```[a-zA-Z]*\s*\n[\s\S]*\n```$/.test(s)) {
    s = s.replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```$/, '');
  }

  const lines = s.split(/\r?\n/);

  // 开场白：只删**第一行**，且必须是"以下是/好的/这是"这类短引导句
  const isPreamble = (l) => /^(好的|可以|没问题|当然|以下是|下面是|这是|给你)/.test(l.trim())
    && l.trim().length <= 24
    && /[:：。]?$/.test(l.trim());
  if (lines.length && isPreamble(lines[0])) lines.shift();

  // 结尾客套
  const isTail = (l) => /^(希望|以上|如需|如果还|有需要|随时)/.test(l.trim())
    && l.trim().length <= 30;
  while (lines.length && (lines[lines.length - 1].trim() === '' || isTail(lines[lines.length - 1]))) {
    lines.pop();
  }

  return lines.join('\n').trim();
}

/** 各工具接受的输入白名单（多传的字段一律忽略 —— 免得界面上的脏数据进提示词） */
const FIELDS = {
  name: ['kind', 'count', 'seed', 'must', 'genre'],
  brain: ['idea', 'direction', 'avoid', 'genre'],
  idea: ['text', 'genre'],
};

/** 把字段值收拾成一行文本（空值返回空串，调用方据此跳过） */
function pick(fields, key) {
  const v = fields && fields[key];
  return v == null ? '' : String(v).trim();
}

const KIND_LABEL = {
  person: '人物',
  place: '地名',
  skill: '功法 / 招式',
  sect: '门派 / 势力',
  item: '法宝 / 器物',
  other: '其他（按用户说明来）',
};

/**
 * 起名。
 *
 * @param {object} fields { kind, count, seed, must, genre }
 */
function buildName(fields) {
  const kind = pick(fields, 'kind') || 'person';
  /**
   * 数量夹取。
   * ⚠ 原来写的是 `Number(x) || 8` —— **0 是 falsy**，于是用户填 0 会静默变成 8，
   *   而界面那个输入框的 min 是 1，两边说的不是一回事。改成显式判空串。
   */
  const rawCount = pick(fields, 'count');
  let count = 8;
  if (rawCount !== '') {
    const n = Number(rawCount);
    count = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 8;
  }
  const genre = pick(fields, 'genre');
  const seed = pick(fields, 'seed');
  const must = pick(fields, 'must');

  const system = [
    '你是中文小说的起名助手。给出的名字要像真人真事，能直接写进正文。',
    '',
    '硬性要求：',
    '1. 只输出名字清单，一行一条，格式固定：`名字 —— 一句解释`',
    '2. 不要编号、不要前言、不要总结、不要用代码围栏',
    '3. 解释不超过 20 字，说清"为什么合适"（字义、意象、气质），不要重复名字本身',
    '4. 不用生僻字（GB2312 以外的字一律不用）',
    '5. 不用「天」「云」「龙」「傲」「神」这类被用烂的字，除非用户明确要求',
    '6. 不要书名号、不要引号',
  ].join('\n');

  const user = [
    genre ? `题材：${genre}` : '',
    `要起的是：${KIND_LABEL[kind] || KIND_LABEL.other}`,
    `数量：${count} 个`,
    seed ? `基础灵感：${seed}` : '',
    must ? `额外要求：${must}` : '',
    '',
    '直接从第一行给名字，不要任何开场。',
  ].filter(Boolean).join('\n');

  return { system, user, temperature: 0.92 };
}

/**
 * 脑洞。
 *
 * @param {object} fields { idea, direction, avoid, genre }
 */
function buildBrain(fields) {
  const genre = pick(fields, 'genre');
  const idea = pick(fields, 'idea');
  const direction = pick(fields, 'direction');
  const avoid = pick(fields, 'avoid');

  const system = [
    '你是网文策划，负责把作者一个模糊的想法，发展成**能直接往下写**的剧情设计。',
    '',
    '输出用 markdown 小标题，固定这四段，顺序不能变：',
    '## 这条线怎么走',
    '（三到五步，每步一句话，必须写出因果：因为…所以…）',
    '## 反转在哪',
    '（一到两个。每个说清"读者以为 X，其实是 Y"，不要只写"有个反转"）',
    '## 要埋的伏笔',
    '（二到四个具体物件或台词，并说明后面怎么回收）',
    '## 最可能崩的地方',
    '（这个设计最容易写崩的一处，一句话说清）',
    '',
    '硬性要求：',
    '1. 具体。禁止"增加张力""制造冲突""升华主题"这类空话',
    '2. 不写正文、不写对话、不写章节标题',
    '3. 不新增用户没提过的核心设定（人物、势力、力量体系）；需要时用"可以设定为…"标注',
    '4. 不要开场白和结尾客套',
  ].join('\n');

  const user = [
    genre ? `题材：${genre}` : '',
    `我的想法：${idea || '（没填，按题材给我一个）'}`,
    direction ? `希望往这个方向走：${direction}` : '',
    avoid ? `不要碰：${avoid}` : '',
    '',
    '直接输出四段，不要开场。',
  ].filter(Boolean).join('\n');

  return { system, user, temperature: 0.85 };
}

/**
 * 灵感碎片。两个动作：
 *   tidy   整理 —— 把零碎的话理清楚，**不许加事实**
 *   expand 扩散 —— 从这条灵感长出去，给几个方向
 */
function buildIdea(fields, action) {
  const genre = pick(fields, 'genre');
  const text = pick(fields, 'text');

  const tidySystem = [
    '你是小说作者的记录整理助手。',
    '',
    '任务：把用户随手记的碎片，整理成一段清楚、可读的描述。',
    '',
    '硬性要求：',
    '1. **只整理，不创作**：不许新增任何事实、人名、地名、数字。',
    '   用户没写的，就不许出现。',
    '2. 保留原意和语气，不要改得更"文学"。',
    '3. 长度和原文相当（可以短，不要长）。',
    '4. 只输出整理后的那一段，不要前言、不要"整理如下"。',
    '5. 如果原文本来就是清楚的，原样返回，不要为了显得有用而改词。',
  ].join('\n');

  const expandSystem = [
    '你是网文策划。用户会给你一条灵感碎片，你要从它**长出去**。',
    '',
    '输出 3-5 个不同的发展方向，编号 1. 2. 3.，每个一两句话：',
    '- 每个方向必须是**不同的路**（不是同一个想法的三种说法）',
    '- 每个方向都要说清"这会把故事带到哪"',
    '- 至少有一个方向要反着来（和直觉相反的那种）',
    '',
    '硬性要求：',
    '1. 不写正文、不写对话',
    '2. 不新增用户没提过的核心设定；需要时用"可以设定为…"标注',
    '3. 不要开场白和结尾客套',
  ].join('\n');

  const user = [
    genre ? `题材：${genre}` : '',
    `我的灵感：${text}`,
    '',
    action === 'expand' ? '直接给方向，不要开场。' : '直接给整理结果，不要开场。',
  ].filter(Boolean).join('\n');

  return {
    system: action === 'expand' ? expandSystem : tidySystem,
    user,
    temperature: action === 'expand' ? 0.9 : 0.45,
  };
}

const ACTIONS = {
  name: { gen: buildName },
  brain: { gen: buildBrain },
  idea: { tidy: buildIdea, expand: buildIdea },
};

/**
 * 构造一次调用需要的 messages。
 *
 * @param {'name'|'brain'|'idea'} mode
 * @param {string} action 动作（name/brain 只有 'gen'；idea 有 'tidy'/'expand'）
 * @param {object} fields 界面字段
 * @returns {{ messages: Array<{role:string,content:string}>, temperature: number }}
 */
function buildMessages(mode, action, fields) {
  const table = ACTIONS[mode];
  if (!table) throw new Error(`未知的工具：${mode}`);
  const fn = table[action];
  if (!fn) throw new Error(`工具「${mode}」没有这个动作：${action}`);

  // 白名单：只把认识的字段给提示词，界面上多传的东西（比如 projectId）不进 prompt
  const allowed = FIELDS[mode] || [];
  const clean = {};
  for (const k of allowed) clean[k] = fields ? fields[k] : undefined;

  const { system, user, temperature } = fn(clean, action);
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
  };
}

/** 前端要展示"这个工具需要什么"，走这里，别在前端另抄一份 */
const MODE_INFO = {
  name: { label: '起名', file: '起名备忘.md', actions: [{ key: 'gen', label: '生成候选' }] },
  brain: { label: '脑洞', file: '脑洞.md', actions: [{ key: 'gen', label: '帮我展开' }] },
  idea: {
    label: '灵感碎片',
    file: '灵感碎片.md',
    actions: [{ key: 'tidy', label: 'AI 整理' }, { key: 'expand', label: '扩散' }],
  },
};

module.exports = { buildMessages, cleanOutput, MODE_INFO };

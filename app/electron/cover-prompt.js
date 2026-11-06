/**
 * 小说封面的提示词（2026-11-02）。
 *
 * ## 两个模型协同
 *
 * 用户往往只知道"书名 + 想要什么感觉"，写不出能喂给生图模型的画面描述。
 * 所以先用**已经连着的 LLM** 把五要素（书名/作者/题材/风格/画面）翻成一段
 * 具体的画面描述，再交给生图模型。LLM 不可用时退回**本地模板**（`buildCoverPrompt`），
 * 保证这条链路永远有输出 —— 不能让"没连上文字模型"变成"封面按钮点了没反应"。
 *
 * ## 为什么不让生图模型直接画"封面"
 *
 * 扩散模型写中文基本是乱码 —— 让它把书名画进去，出来的是一堆像字的色块。
 * 所以分工是：**模型只负责画面**，书名/作者由 Canvas 叠上去。
 * 提示词里必须**明确禁止出现文字**，并且**给下方留出干净空间**，
 * 否则标题叠上去会压在人脸上。
 */

/** 画风（必填）。`tail` 会拼进提示词，写得越具体越稳。 */
const STYLES = [
  {
    key: 'xianxia',
    label: '仙侠',
    tail: '仙侠题材，云雾缭绕的山门与飞剑，青蓝色冷调，水墨与工笔结合，光影通透，史诗感',
  },
  {
    key: 'ink',
    label: '水墨',
    tail: '中国传统水墨画，大量留白，墨色浓淡层次分明，宣纸质感，意境悠远，只有一个主色点缀',
  },
  {
    key: 'real',
    label: '写实',
    tail: '电影级写实摄影，浅景深，戏剧性侧光，质感细腻，色调偏冷，35mm 胶片颗粒',
  },
  {
    key: 'anime',
    label: '二次元',
    tail: '日系动画电影风格，赛璐璐上色，干净线条，柔和逆光，天空与云的层次丰富',
  },
  {
    key: 'chibi',
    label: '漫画Q版',
    /**
     * ⚠ Q 版的关键是"头大身小 + 粗描边 + 表情夸张"，少一个就会画成普通二次元。
     *   所以 tail 里把这三条点名，而不是只写"Q 版"。
     */
    tail: '日系 Q 版漫画风格，二头身大头小身比例，粗黑描边，扁平纯色块上色，表情夸张可爱，色彩明快饱和',
  },
  {
    key: 'minimal',
    label: '极简',
    tail: '极简设计，单一大色块背景加一个剪影式主体，无细节堆砌，现代平面感，强对比',
  },
];

/** 题材（选填）。影响画面元素，不是画风。 */
const GENRES = [
  '仙侠', '玄幻', '都市', '悬疑', '科幻', '言情', '历史', '军事', '游戏', '其他',
];

const BY_KEY = new Map(STYLES.map((s) => [s.key, s]));

function getStyle(key) {
  return BY_KEY.get(key) || BY_KEY.get('xianxia');
}

function listStyles() {
  return STYLES.map((s) => ({ key: s.key, label: s.label }));
}

function listGenres() {
  return GENRES.slice();
}

/**
 * 风格预设（2026-11-02 加）。
 *
 * ## 它是什么，不是什么
 *
 * 是**提示词模板**，不是画风。选一个只往提示词里填文字，
 * 画风仍由上面那排单选决定 —— 用户可以选了"爽感"再配"水墨"。
 * 填进去之后框里还是普通文本，随便改、随便删。
 *
 * ## 为什么要有
 *
 * 之前的模板只描述"安安静静的氛围"，出来一张张都是平静空镜。
 * 而网文封面真正抓人的是**卖点清晰**：主角特写、眼神、能量感、冲突。
 * 这些用"画风"表达不了，得靠构图语言 —— 所以单独做成模板。
 */
const TEMPLATES = [
  {
    key: 'hot',
    label: '爽感爆点（男频）',
    desc: '主角特写 + 强逆光 + 冲击力',
    positive: '主角半身特写占据画面主体，眼神锐利直视镜头，侧逆光勾出轮廓边光，'
      + '背景有能量光效与放射状速度线，高饱和高对比，压迫感与爆发力强',
    negative: '平淡, 灰暗, 空旷, 松弛, 没有主体',
  },
  {
    key: 'suspense',
    label: '悬疑压迫',
    desc: '暗调 + 单一冷光源 + 负空间',
    positive: '人物半身隐在暗处，只有一侧冷光打在脸上，雨雾弥漫，'
      + '大面积阴影与负空间，强明暗对比，情绪克制而紧张',
    negative: '明亮, 欢快, 卡通, 色彩鲜艳, 阳光',
  },
  {
    key: 'sweet',
    label: '甜宠轻喜',
    desc: '暖色 + 柔和光 + 轻松',
    positive: '暖阳斜射的室内，人物半身近景微笑，奶油与暖粉色调，'
      + '圆润柔和的造型，轻盈通透的空气感，氛围温柔',
    negative: '阴森, 血腥, 灰暗, 恐怖, 高饱和',
  },
  {
    key: 'epic',
    label: '玄幻史诗',
    desc: '大场景 + 云海 + 体积光',
    positive: '宏大远景，巨型山门与翻涌云海，人物立于高处俯瞰，'
      + '体积光穿过云层，画面纵深感强，史诗级恢弘克制',
    negative: '日常, 室内, 小场景, 拥挤',
  },
  {
    key: 'urban',
    label: '都市电影感',
    desc: '夜景霓虹 + 侧脸 + 浅景深',
    positive: '城市夜景，霓虹与玻璃幕墙反射，人物侧脸近景，'
      + '浅景深虚化背景，冷蓝与暖黄交织，电影感构图',
    negative: '古装, 奇幻, 田园, 白天',
  },
  {
    key: 'minimal',
    label: '极简留白',
    desc: '大色块 + 单剪影',
    positive: '单一纯色背景，一个剪影式主体，极简几何构图，'
      + '大面积同色块，只用一处强调色，克制到极致',
    negative: '复杂, 杂乱, 细节过多, 纹理, 渐变',
  },
];

const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

function getTemplate(key) {
  return TEMPLATE_BY_KEY.get(key) || null;
}

function listTemplates() {
  return TEMPLATES.map((t) => ({
    key: t.key, label: t.label, desc: t.desc,
    positive: t.positive, negative: t.negative,
  }));
}

/**
 * 两种模式的默认反向词。
 *
 * ⚠⚠ 这是整个 A/B 方案的核心差异，写错就自相矛盾：
 *   · 底图模式（A）：**必须**把"文字/标题/汉字"压掉 —— 我们要一张干净底图；
 *   · 文字模式（B）：**必须**把"文字类"从反向词里拿掉 —— 否则一边要求它写书名，
 *     一边又告诉它"不要文字"，模型只会给你一张什么都不写的图。
 */
const NEG_NO_TEXT = '文字, 汉字, 字母, 数字, 标点, 标题, 副标题, 字幕, 水印, 签名, logo, '
  + '艺术字, 排版, 版式, 封面, 书封, 海报, 边框, 印章, 落款';
/**
 * ⚠⚠ B 模式的反向词里**一个字都不能提「文字」**（连"糊成一团的文字"也不行）。
 *   模型对反向词里的关键词很敏感 —— 写了"文字"，它就可能干脆什么都不写，
 *   于是你明明开了"AI 生成封面文字"，出来的还是张没字的图。
 *   所以只保留"错别字/乱码/笔画残缺"这类**质量**要求，不碰"要不要写字"这件事。
 */
const NEG_KEEP_TEXT = '畸形人脸, 崩坏肢体, 水印, 签名, logo, 错别字, 乱码, 笔画残缺, 重影';

/** A/B 模式下各自该用哪套反向词 */
function defaultNegative(titleMode) {
  return titleMode === 'burn' ? NEG_KEEP_TEXT : NEG_NO_TEXT;
}

/**
 * 统一约束块 —— **不管提示词是模板填的还是用户手写的，生成前都追加这一段**。
 *
 * ⚠ 为什么要"追加"而不是"要求用户写进去"：
 *   用户自己调的提示词常常只描述画面，不会记得写"给标题留位""别画字"。
 *   而这两条一旦漏了，出来的图要么没法叠字，要么自带一堆乱码标题。
 *   约束属于**结构**，不属于创作 —— 所以由程序统一兜住。
 *
 * @param {'blank'|'burn'} titleMode
 */
function constraintFor(titleMode, { name, subtitle, tags } = {}) {
  if (titleMode === 'burn') {
    const sub = String(subtitle || '').trim();
    // ⚠ 空格也算分隔符：「重生 逆袭」这种写法比逗号更常见
    const list = (Array.isArray(tags) ? tags : String(tags || '').split(/[\s·|,，、]+/))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
    return [
      `书名为「${name || ''}」，以醒目、有设计感的中文标题字写在画面上方，笔画必须准确。`,
      sub ? `副标题「${sub}」用小字写在书名下方。` : '',
      list.length ? `画面一角点缀：${list.map((t) => `「${t}」`).join('、')}。` : '',
      '文字要排版整齐，不得出现错别字、乱码或重叠的字；主体放在中下部，给文字留呼吸空间。',
    ].filter(Boolean).join('');
  }
  return '构图约束：主体集中在上方三分之二；下方三分之一是较暗的环境暗部（地面、阴影或暗色背景），'
    + '那里不放主体物。画面中不要出现任何文字、汉字、字母或符号。';
}

const NO_TEXT_RULE = '不要生成任何文字：画面中不能出现汉字、字母、数字、标题、字幕、签名、logo 或水印。';

/**
 * 拼封面提示词（**本地模板**，LLM 不可用时的兜底）。
 *
 * @param {object} p
 * @param {string} p.name    书名（**不放进画面**，只用来判断题材气氛）
 * @param {string} [p.author] 作者（不参与画面）
 * @param {string} [p.genre]  题材
 * @param {string} [p.intro]  简介，当作"画什么"的主要依据
 * @param {string} [p.scene]  画面补充（用户临时写的一句）
 * @param {string} p.style    STYLES 里的 key
 * @param {string} [p.kind]   long / short / drama
 */
function buildCoverPrompt({
  name, intro, scene, extra, style, kind, genre,
  template, titleMode = 'blank', subtitle, tags,
}) {
  const st = getStyle(style);
  const tpl = getTemplate(template);
  const burn = titleMode === 'burn';
  const kindText = kind === 'short' ? '短篇小说' : kind === 'drama' ? '短剧' : '长篇小说';
  const sceneText = String(scene || extra || '').trim();

  /**
   * ⚠ 主体优先级：用户写的画面 > 简介 > 书名。
   *   简介本来就以句号结尾，模板后面还要再加一个 → 出现「山门。。」（实测见过）。
   */
  /**
   * ⚠⚠ 兜底主体**不能带书名**。第一版写的是「与《XX》这个名字相称的主视觉」——
   *   Qwen-Image 这类模型很擅长渲染文字，看到书名就真的把书名画上去了，
   *   于是图上出现"模型写的标题 + 我们叠的标题"两个。
   *   书名只用来把握基调，绝不能进画面描述。
   */
  const subject = (sceneText
    || String(intro || '').trim().slice(0, 180)
    || '与该题材气质相符的主视觉场景')
    .replace(/[。．.！!？?；;，,、\s]+$/, '');

  const genreText = genre && genre !== '其他' ? `题材：${genre}。` : '';

  /**
   * ## 两种模式，两套说法
   *
   * 底图模式（A）：绝口不提"封面/版式/标题区"，否则模型会自己按封面排版。
   * 文字模式（B）：**反过来**——要明确说这是一张已经排好版的书封，
   *   并把要写的字原样告诉它。此时还禁字就是自相矛盾。
   */
  if (burn) {
    const sub = String(subtitle || '').trim();
    const tagList = (Array.isArray(tags) ? tags : String(tags || '').split(/[·|,，]/))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 3);

    const textSpec = [
      `书名为「${name || ''}」，用醒目、有设计感的中文标题字写在画面上方，笔画清晰准确。`,
      sub ? `副标题「${sub}」用小字写在书名下方。` : '',
      tagList.length ? `画面一角点缀这几个短语：${tagList.map((t) => `「${t}」`).join('、')}。` : '',
      '所有文字必须字形正确、排版整齐，不能出现错别字、乱码、重叠的字。',
    ].filter(Boolean).join('');

    return [
      `${kindText}书封，竖版，2:3，已完成文字排版。`,
      `${genreText}画风：${st.tail}。`,
      `画面内容：${subject}。`,
      tpl ? `构图与氛围：${tpl.positive}。` : '',
      textSpec,
      '构图约束：书名固定在画面上方，主体人物或场景放在中下部，给文字留出呼吸空间。',
      '高质量，细节丰富，无边框。',
    ].filter(Boolean).join('\n');
  }

  return [
    // ⚠ 「不许有字」放第一句，并在结尾再强调一次（实测只写在中间会被忽略）
    NO_TEXT_RULE,
    /**
     * ⚠⚠ 这里**绝对不能写「封面」两个字**，这是"模型自己画标题"的真正根因。
     *
     *   之前写的是「中国长篇小说**封面插画**，竖版构图，2:3」——
     *   模型看到"封面"就按**封面版式**去画：自带一个标题位、真的把标题字画进去。
     *   我在别处再怎么禁字、再怎么剔书名都没用，因为**任务本身**被说成了"画一张封面"。
     *
     *   现在的说法是"插图"：只画画面，不画版式。
     */
    `${kindText}题材的插画，竖版构图，2:3，整幅画面没有版式、没有标题区。`,
    `${genreText}画风：${st.tail}。`,
    `画面主体：${subject}。`,
    // 风格模板只贡献"构图与氛围"，不影响画风
    tpl ? `构图与氛围：${tpl.positive}。` : '',
    /**
     * ⚠ 原来写的是「下方三分之一留出干净、较暗的**空白**区域」——
     *   "空白/留白"在绘画语境里等于"这里该写点什么"，容易引导模型自己补标题。
     *   改成描述**暗部环境**（地面、阴影、暗背景），不给"留给字"的暗示。
     */
    '构图要求：主体集中在上方三分之二；下方三分之一是较暗的环境暗部（地面、阴影或暗色背景），那里不放主体物。',
    '高质量，细节丰富，构图完整，无边框。',
    '再次强调：整张图不要出现任何形式的文字或符号。',
  ].filter(Boolean).join('\n');
}

/**
 * 给 LLM 的指令：把五要素翻成一段**画面描述**。
 *
 * ⚠ 要求它输出"一段话、不要解释、不要引号、不要编号" ——
 *   模型很爱回「好的，以下是提示词：……」或者加一堆 markdown，
 *   那些东西直接喂给生图模型会变成噪音（甚至被画进图里）。
 */
function buildEditorMessages({
  name, author, genre, style, scene, extra, intro, kind,
}) {
  const st = getStyle(style);
  const kindText = kind === 'short' ? '短篇' : kind === 'drama' ? '短剧' : '长篇';

  /**
   * ⚠⚠ **作者名不进来**。它和画面没有任何关系（只是印在封面上的一行字），
   *   但模型会把它当素材画进图里 —— 实测封面底部出现了「作者：冷雨」，
   *   而我叠的那一行是「冷雨」，于是又变成两层字。
   *   任何不该出现在画面里的字，**根本不要给它看到**。
   */
  const facts = [
    `书名：《${name || ''}》`,
    genre ? `题材：${genre}` : '',
    `类型：${kindText}`,
    `画风：${st.label}（${st.tail}）`,
    scene || extra ? `用户想要的画面：${scene || extra}` : '',
    intro ? `这本书的简介：${String(intro).slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  const system = [
    /**
     * ⚠⚠ 这里**不能出现"封面"两个字**。模型会把"封面"照抄进画面描述，
     *   于是生图模型按封面版式去画、自己把标题画上去 —— 我第一版就是这么翻的。
     *   所以给它一个中性的身份：插画师。
     */
    '你是中国网络小说的插画师。你的任务是把书名等零散信息，写成一段可以直接喂给 AI 绘画模型的**中文画面描述**。',
    '',
    '硬性要求：',
    '1. 只输出那一段画面描述本身，60–150 字。不要任何解释、前言、编号、引号、markdown。',
    '2. 描述必须包含：主体（人或物或场景）、环境、光线、色调、构图。',
    /**
     * ⚠ 连"不要写封面"这种**否定**里也别出现那个词 —— 模型会把它当素材抄走。
     *   所以这里用「版式」「标题区」「装帧」来替代，一个字都不提它。
     */
    '3. 画面里**绝对不能有文字**。不要描述书籍、招牌、屏幕、纸张上写字，也不要写"标题""版式""装帧"这些词。',
    '4. 构图：主体集中在上方三分之二；下方三分之一是较暗的环境暗部（地面、阴影或暗色背景），那里不放主体物。',
    '5. 不要复述书名，**书名一个字都不能出现**。',
    '6. 信息越少越要克制：没有的要素不要编造具体人名、数字、品牌。',
    /**
     * ⚠⚠ 这一条是补的：实测模型有时会输出「负面提示词：畸形，扭曲，恐怖…」，
     *   整段全是反向词、一个正向画面都没有。用户点了「AI 帮我写」拿到这种东西，
     *   画出来的图自然和书毫无关系。
     */
    '7. 只写**正向**的画面描述。不要写"负面提示词""反向词"，不要罗列"不要出现什么"。',
    '8. 直接就是一段连贯的中文句子，不是形容词清单。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `根据这些信息写画面描述：\n${facts}` },
  ];
}

/**
 * 清洗 LLM 的返回。
 *
 * ⚠ 必须清：模型经常自带「以下是提示词：」、代码块围栏、首尾引号。
 *   这些东西混进生图提示词里，轻则被当作画面内容，重则把"以下是"三个字画上去。
 */
function cleanEditorOutput(raw) {
  /**
   * ⚠ 顺序很重要：**先按行剥围栏，再删前言**。
   *   第一版先删 `^\`\`\`…` 再去前言 —— 而围栏前面还有一行"以下是提示词："，
   *   于是 `^` 匹配不到，围栏整段留下来了（实测输出里带着三个反引号）。
   */
  // 有的模型会老老实实回一个 JSON —— 先把它拆出来，别让花括号和大括号混进提示词
  const rawStr = String(raw || '').trim();
  try {
    const j = JSON.parse(rawStr.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, ''));
    if (j && typeof j === 'object') {
      for (const k of ['prompt', 'text', 'description', 'content', '画面']) {
        if (typeof j[k] === 'string' && j[k].trim()) return j[k].trim();
      }
    }
  } catch (_) { /* 不是 JSON，走下面逐行清洗 */ }

  let lines = rawStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // ``` / ```json 这类围栏行，整行删掉
  lines = lines.filter((l) => !/^```/.test(l));

  // 开头的「以下是提示词：」「这是……：」
  while (lines.length && /^(以下是|下面是|这是|提示词|好的)/.test(lines[0]) && /[:：]$/.test(lines[0])) {
    lines.shift();
  }
  // 结尾的客套话
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (/^(希望|以上|如需|如果)/.test(last)) lines.pop();
    else break;
  }

  let s = lines.join('').trim();   // 画面描述本来就该是一段，直接连起来
  // 整体包裹的引号
  s = s.replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
  return s;
}

/**
 * 把书名从画面描述里**硬剔除**。
 *
 * ⚠ 只在提示词里写"不要复述书名"是不够的：模型会照抄。
 *   而 Qwen-Image 这类模型真的会把书名渲染成漂亮的标题字（它擅长这个），
 *   于是封面出现两个标题。所以出口处再做一次确定性的剔除 ——
 *   这不依赖模型听话。
 */
function stripBookTitle(text, name) {
  const t = String(text || '');
  const n = String(name || '').trim();
  // ⚠ 太短的名字（2 字以内）容易误伤正文，宁可不动
  if (n.length < 3) return t;
  return t
    .split(`《${n}》`).join('')
    .split(`「${n}」`).join('')
    .split(n).join('')
    .replace(/[，,、]{2,}/g, '，')
    // 剔除后常留下「中，」「里，」这种断头，一并清掉
    .replace(/^[\s，,、]*(中|里|内|上|下|时|的)?[\s，,、]+/, '')
    .replace(/[，,、\s]+$/, '')
    .trim();
}

/**
 * 判断这段输出是不是"反向词清单"而不是画面描述。
 *
 * ⚠ 实测模型会回「负面提示词：\n畸形人脸，崩坏肢体，水印，文字，杂乱涂鸦…」。
 *   这种东西喂给生图模型 = 画一张和书无关的图（**而且不报错**），
 *   界面上看起来"AI 已经写好了"，用户只会觉得"这功能不准"。
 */
/**
 * 把「正向提示词 / 负面提示词」这种**结构化提示词**拆成两段。
 *
 * ⚠⚠ 用户会从别处（豆包/ChatGPT）拿到一份写得很好的完整提示词，
 *   里面本来就有「正向提示词：…」和「负面提示词：…」两段，甚至带尺寸建议。
 *   第一版我一看"负面提示词"就当废稿丢掉 —— 那是**误杀**，
 *   用户辛苦调好的提示词被程序扔了。
 *
 * 现在只做拆分，**原文一个字不改**：
 *   · 有的服务商（百炼）支持 negative_prompt，正好把负向段填进去；
 *   · 不支持的就把正向段发过去，别把一长串"畸形人脸"混进画面描述里。
 *
 * @returns {{positive:string, negative:string, structured:boolean}}
 */
function splitPrompt(text) {
  const t = String(text || '').trim();
  // 「正向提示词：」「正向 prompt:」这类小标题
  const posM = /(正向提示词|正面提示词|正向\s*prompt)\s*[:：]?\s*/i.exec(t);
  const negM = /(负面提示词|反向提示词|负向提示词|negative\s*prompt)\s*[:：]?\s*/i.exec(t);
  if (!negM) return { positive: t, negative: '', structured: false };

  const negStart = negM.index;
  const posStart = posM ? posM.index + posM[0].length : 0;
  const positive = t.slice(posStart, negStart).trim();
  let negative = t.slice(negStart + negM[0].length);
  /**
   * ⚠ 用户那份提示词后面还接着「配套尺寸建议…」——
   *   它不属于负面词，留着会被当成反向词发给模型。
   *   在第一个明显不是词表的小标题处截断。
   */
  negative = negative.split(/\n(?=\S{0,12}[：:]\s*$|\n|【)/)[0]
    .split(/\n{2,}/)[0]
    .replace(/^[-—\s]+/, '')
    .trim();

  return { positive, negative, structured: !!positive };
}

/**
 * 判断这段是不是"只有反向词、没有正向描述"的废稿。
 *
 * ⚠⚠ 关键区别（第一版分不清，把它们当成一类）：
 *   · 「负面提示词：\n畸形，扭曲，恐怖…」                → 废稿，丢掉
 *   · 「正向提示词：黄昏高中教室…\n\n负面提示词：畸形…」 → **好东西**，别碰
 *   所以只看"负面段之前有没有实质内容"，而不是一见到"负面提示词"就判死。
 */
function looksLikeNegative(text) {
  const t = String(text || '');
  const m = /(负面提示词|反向提示词|负向提示词|negative\s*prompt)\s*[:：]?/i.exec(t);
  if (!m) {
    // 没有小标题时，用"逗号一堆却没有句号"兜底判词表
    const commas = (t.match(/[，,、]/g) || []).length;
    const stops = (t.match(/[。！？!?]/g) || []).length;
    return commas >= 6 && stops === 0;
  }
  // 负面段前面有 20 个字以上的正向内容 → 是完整提示词，不是废稿
  const before = t.slice(0, m.index)
    .replace(/正向提示词|正面提示词|正向\s*prompt/gi, '')
    .replace(/[:：\s]/g, '');
  return before.length < 20;
}

module.exports = {
  STYLES,
  GENRES,
  TEMPLATES,
  getStyle,
  getTemplate,
  listStyles,
  listGenres,
  listTemplates,
  defaultNegative,
  constraintFor,
  NEG_NO_TEXT,
  NEG_KEEP_TEXT,
  buildCoverPrompt,
  buildEditorMessages,
  cleanEditorOutput,
  stripBookTitle,
  looksLikeNegative,
  splitPrompt,
  NO_TEXT_RULE,
};

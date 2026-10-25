/**
 * 风格画像与偏离检测。
 *
 * ## 为什么不是「AI 味打分」
 *
 * 开发这个模块时先做了一件事：用真实手写章 vs 模型输出做对照，
 * 想找出「哪些措辞一出现就是 AI 味」。实测把这个思路否掉了：
 *
 *   - 我记忆里的著名 AI 腔套语 —— 眼中闪过 / 嘴角勾起 / 不由得 /
 *     仿佛…一般 / 空气凝固 / 身形一闪，在 42 章模型输出里**出现次数全是 0**
 *   - 反倒是从数据里挖出来的「心理直述套语」「冷笑一声」有效
 *   - 而那 42 章本身是**同一场景的重采样**（都是「秋雨+乱葬岗+铁棺+谢九」），
 *     不是 42 个独立样本，统计上根本不能当基准
 *   - 手写侧只有 1 章 1642 字。**n=1 时任何分布估计都不成立**
 *
 * 所以禁用词路线有两个致命问题：
 *   1. 词表是我拍的，换一部小说就失效
 *   2. 命中即扣分 =误伤。「冷笑一声」在市井小说里是正常写法
 *
 * ## 实际做法：风格 = 用户自己文本的统计画像
 *
 * 不问「这段像不像 AI 写的」，只问「**这段像不像你自己写的**」。
 * 基准全部来自用户的历史正文（`buildProfile`），生成结果与基准比，
 * 报出**具体偏离项和方向**，让人决定怎么改。
 *
 * 这样做的好处：
 *   - 不含任何主观词表，换任何题材都成立
 *   - 基准随用户样本增长而精化，不是固定阈值
 *   - 输出是「你的对话占比 12%，你平时是 34%」这种可执行信息，
 *     而不是一个无从下手的分数
 *
 * ## 画像指标（全部是可直接解释的统计量）
 *
 * | 指标 | 含义 |
 * |---|---|
 * | sentenceLen | 平均句长 + 标准差（标准差大 = 长短交错，AI 味常伴随句长均匀） |
 * | dialogueRatio | 引号内字符占比 |
 * | paraPerSentence | 段落数 / 句数（越小 = 段落越碎） |
 * | shortParaRatio | 独立成段的短句占比（手写常见「我去。」单成段） |
 * | concreteDensity | 具象名词密度（器物/日常物） |
 * | adverbDensity | 情绪副词密度 |
 * | simileDensity | 明喻密度（像/仿佛/犹如） |
 * | psychDensity | 心理直述密度 |
 * | idiom4Density | 四字格密度 |
 * | sentenceLenCv | 句长变异系数（标准差/均值，最能反映「是否均匀」） |
 */

/** 中文分句：句读 + 换行 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？…；])/)
    .map((s) => s.replace(/\s+/g, ''))
    .filter((s) => s.length >= 2);
}

/** 中文分段：空行 */
function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉 Markdown 标记，得到纯正文 */
function stripMd(text) {
  return String(text || '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/^>\s?.*$/gm, '')
    .replace(/^---\s*$/gm, '')
    .replace(/（[^）]*完）\s*$/gm, '');
}

function count(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

/** 具象名词：器物 / 日常物 / 身体动作 */
const CONCRETE_RE =
  /(?:刨子|草鞋|包袱|铜钱|碎银|凉茶|腊肉|炊饼|千层底|扁担|锄头|镰刀|柴火|灶房|石墩|木匣|碗|筷|桌|凳|门|院|墙|土路|麻绳|井|灶|摊|车|船|灯|铁匠|木匠|掌柜|包子|馒头|药|秤|绳|锄|镰|筐|篓)/g;

/** 情绪副词 */
const ADVERB_RE = /(?:猛地|骤然|瞬间|陡然|蓦地|忽地|不由|缓缓|微微|轻轻|淡淡|猛然|骤然)/g;
/** 明喻 */
const SIMILE_RE = /(?:像|仿佛|犹如|宛如|好似|如同)/g;
/** 心理直述 */
const PSYCH_RE = /(?:心里|心中|心头|心底|暗想|暗道|想着|念头|意识到|明白|察觉)/g;
/** 四字格 */
const IDIOM4_RE = /[\u4e00-\u9fa5]{4}(?![，。！？；：、“”])/g;

/** 已知套语（**仅作提示，不参与扣分**）。实测在模型输出里几乎不出现，见文件头。 */
const KNOWN_TICS = [
  { name: '心理直述套语', re: /心中(?:一)?(?:暗|顿)?(?:想|道)|心里(?:头|中|底)?(?:一)?(?:暗|顿)?(?:想|道)|暗自(?:想|道|盘算)/ },
  { name: '冷笑一声', re: /(?:冷笑|轻哼|冷哼)(?:一声|道)/ },
  { name: '眼神骤变', re: /瞳孔(?:猛地|骤然)?一(?:缩|紧)|眼神(?:猛地)?(?:一)?(?:凛|变|冷)/ },
];

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function stddev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((acc, v) => acc + (v - m) ** 2, 0) / a.length);
}

/**
 * 计算单篇文本的统计向量。
 * @param {string} raw
 * @returns {object} 原始统计量（非归一化），字符数 < 50 时标记 sparse
 */
function measure(raw) {
  const text = stripMd(raw);
  const chars = text.replace(/\s/g, '').length;
  const sentences = splitSentences(text);
  const paras = splitParagraphs(text);
  const lens = sentences.map((s) => s.length);

  const allChars = chars || 1;
  const dialogue = count(text, /[“「]([^”」]*)[”」]/g)
    ? (String(text).match(/[“「][^”」]*[”」]/g) || []).join('').replace(/[^\u4e00-\u9fa5]/g, '').length
    : 0;

  const shortPara = paras.filter((p) => {
    const ss = splitSentences(p);
    return ss.length <= 1 && p.replace(/\s/g, '').length <= 12;
  }).length;

  const m = mean(lens);
  const sd = stddev(lens);

  return {
    chars,
    sparse: chars < 50,          // 样本太短，统计不可信
    sentenceCount: sentences.length,
    paraCount: paras.length,
    sentenceLen: +m.toFixed(2),
    sentenceLenStd: +sd.toFixed(2),
    sentenceLenCv: +(m ? sd / m : 0).toFixed(3),   // 变异系数：句长是否均匀
    dialogueRatio: +(dialogue / allChars).toFixed(4),
    paraPerSentence: +(paras.length / Math.max(1, sentences.length)).toFixed(3),
    shortParaRatio: +(paras.length ? shortPara / paras.length : 0).toFixed(3),
    concreteDensity: +((count(text, CONCRETE_RE) / allChars) * 100).toFixed(2),
    adverbDensity: +((count(text, ADVERB_RE) / allChars) * 100).toFixed(2),
    simileDensity: +((count(text, SIMILE_RE) / allChars) * 100).toFixed(2),
    psychDensity: +((count(text, PSYCH_RE) / allChars) * 100).toFixed(2),
    idiom4Density: +((count(text, IDIOM4_RE) / allChars) * 100).toFixed(2),
  };
}

/**
 * 用多段用户正文构建风格画像。
 *
 * 关键设计：**只有 1 篇样本时，仍返回画像但标记 lowConfidence**。
 * 调用方（checkStyle）会据此放宽偏离阈值——
 * 宁可漏报，不可拿单样本的噪声去指控用户自己的文字。
 *
 * @param {string[]} texts 用户历史正文（可含 Markdown）
 * @returns {object} 画像
 */
function buildProfile(texts) {
  const list = (texts || []).map(stripMd).filter((t) => t.replace(/\s/g, '').length >= 50);
  if (!list.length) {
    return { ok: false, error: '没有可用样本（每篇至少 50 字）' };
  }

  const per = list.map(measure);
  const totalChars = per.reduce((a, p) => a + p.chars, 0);

  // 各指标取「中位数」而非均值：中位数对单篇异常（某章特别短/特别长）不敏感
  const keys = [
    'sentenceLen', 'sentenceLenCv', 'dialogueRatio', 'paraPerSentence',
    'shortParaRatio', 'concreteDensity', 'adverbDensity',
    'simileDensity', 'psychDensity', 'idiom4Density',
  ];
  const profile = { ok: true, sampleCount: per.length, totalChars };
  /** 各指标的原始样本值。零膨胀指标算容忍带时必须看得到非零样本（见 toleranceOf）。 */
  profile.samples = {};
  for (const k of keys) {
    const vals = per.map((p) => p[k]).sort((a, b) => a - b);
    const mid = vals.length % 2
      ? vals[(vals.length - 1) / 2]
      : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    profile[k] = +Number(mid).toFixed(4);
    profile.samples[k] = vals;
    // 也存分位数，供「容忍带」使用——样本越多，容忍带越宽
    const q = (p) => {
      const pos = (vals.length - 1) * p;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
    };
    profile[k + '_p25'] = +q(0.25).toFixed(4);
    profile[k + '_p75'] = +q(0.75).toFixed(4);
  }

  // 置信度：样本少 → 阈值放宽
  profile.confidence = per.length >= 5 ? 'high' : per.length >= 3 ? 'medium' : 'low';
  profile.toleranceScale = per.length >= 5 ? 1.0 : per.length >= 3 ? 1.5 : 2.5;

  return profile;
}

/**
 * 容忍带：以画像中位数为中心的对称带。
 *
 * 基准带来自样本的 p25~p75（用户自己正常波动范围），
 * 再按 confidence 放宽，最后给一个下限防止除零爆表。
 *
 * ⚠ 开发时踩了三个坑，全是「阈值取法」的问题，不是素材的问题：
 *
 * 1. **统一下限**。`shortParaRatio` 是低频计数型指标（段落总数一少就跳档），
 *    真实章节里 p25~p75 可能窄到 0.02，短样本里同指标天然方差就有 0.2。
 *    统一下限会让它在短样本场景疯狂误报 → 下限必须按指标取值域给。
 *
 * 2. **中位数在零膨胀指标上失效**。实测 5 篇素材里 4 篇 shortParaRatio=0、
 *    1 篇 0.235，中位数与 p25~p75 **全塌成 0**，基准带退化成纯下限，
 *    完全无法表达「这一章就是单句成段多」属于正常。
 *    → 零膨胀指标改用**非零样本的全距**，只有一个非零样本时它本身就是唯一信息。
 *
 * 3. **计数噪声与章节长度耦合**。对话占比虽是比例，但在 400 字与 600 字
 *    章节之间波动天然更大，纯比例阈值会在长章节上偏严、短章节上偏松。
 *    → 额外叠加比例容忍 `基准 × 0.35`，基准越高容忍越宽。
 *
 * 曾经在这里试过「换素材」而不是改阈值——素材连调三轮仍不稳定。
 * **症状是阈值策略有缺陷时，调素材只会掩盖它。**
 */
const FLOOR_BY_METRIC = {
  shortParaRatio: 0.10,     // 低频计数型，噪声最大
  paraPerSentence: 0.12,
  dialogueRatio: 0.10,
  concreteDensity: 0.6,     // 每百字
  adverbDensity: 0.4,
  simileDensity: 0.4,
  psychDensity: 0.4,
  idiom4Density: 0.8,
  sentenceLenCv: 0.12,
  sentenceLen: 3,
};

/** 零膨胀指标：多数样本为 0，中位数与四分位数会塌掉 */
const ZERO_INFLATED = new Set([
  'shortParaRatio', 'concreteDensity', 'simileDensity', 'psychDensity', 'adverbDensity',
]);

/** 比例容忍系数：基准越高容忍越宽 */
const REL_TOLERANCE = 0.35;

/**
 * 该指标在样本上是否有足够信息参与判定。
 *
 * 零膨胀 + 全零样本是最难的一档：留一法下若 4 篇全是 shortParaRatio=0，
 * 中位数、四分位、非零全距**全部为 0**，任何阈值都是凭空来的。
 * 此时正确做法不是把容忍带无限放大，而是**放弃这个指标**——
 * 「用户从来没有这个特征」和「用户偶尔有这个特征」是两种不同判断，
 * 前者只能靠绝对上限表达，而绝对上限必然是我拍的主观值。
 *
 * @returns {{usable:boolean, reason?:string}}
 */
function metricUsability(profile, key) {
  if (!ZERO_INFLATED.has(key)) return { usable: true };
  const vals = profile.samples && profile.samples[key];
  if (!vals || !vals.length) return { usable: false, reason: '样本缺失' };
  const nonzero = vals.filter((v) => v > 0);
  if (nonzero.length === 0) {
    return { usable: false, reason: `全部 ${vals.length} 篇均为 0，基准无信息` };
  }
  if (nonzero.length === 1 && vals.length < 5) {
    return { usable: false, reason: `仅 1/${vals.length} 篇非零，不足以定基准` };
  }
  return { usable: true };
}

/**
 * @param {object} profile
 * @param {string} key
 * @param {number[]} [profileValues] 该指标在样本上的全部取值。
 *   零膨胀指标必须传，否则无法看到非零样本的分布。
 */
function toleranceOf(profile, key, profileValues) {
  const mid = profile[key];
  const p25 = profile[key + '_p25'];
  const p75 = profile[key + '_p75'];
  const floor = FLOOR_BY_METRIC[key] !== undefined ? FLOOR_BY_METRIC[key] : 0.02;
  const spread = p25 === undefined || p75 === undefined ? 0 : Math.abs(p75 - p25);

  let base;
  if (ZERO_INFLATED.has(key) && profileValues && profileValues.length) {
    const nz = profileValues.filter((v) => v > 0);
    if (nz.length >= 2) {
      const range = Math.max(...nz) - Math.min(...nz);
      base = Math.max(range / 2, Math.abs(mid) * 0.25, floor);
    } else if (nz.length === 1) {
      // 唯一的非零样本是唯一的信息，不能被中位数抹掉
      base = Math.max(spread / 2, nz[0] * 0.6, Math.abs(mid) * 0.25, floor);
    } else {
      base = Math.max(spread / 2, Math.abs(mid) * 0.25, floor);
    }
  } else {
    base = Math.max(spread / 2, Math.abs(mid) * 0.25, floor);
  }

  return (base + Math.abs(mid) * REL_TOLERANCE) * (profile.toleranceScale || 1);
}

/**
 * 检测文本相对用户风格画像的偏离。
 *
 * @param {string} text 待检正文
 * @param {object} profile buildProfile 的结果
 * @param {object} [opts]
 * @param {boolean} [opts.strict] true 时把提示也当作问题报出（默认只报统计偏离）
 * @returns {{ok:boolean, deviations:Array, tics:Array, summary:string}}
 */
function checkStyle(text, profile, opts = {}) {
  if (!profile || !profile.ok) {
    return { ok: false, error: profile ? profile.error : '缺少风格画像' };
  }
  const m = measure(text);
  if (m.sparse) {
    return { ok: false, error: `文本过短（${m.chars} 字），统计不可信`, measure: m };
  }

  const deviations = [];
  const skipped = [];
  const keys = [
    ['dialogueRatio', '对话占比', '%'],
    ['concreteDensity', '具象名词密度', '/百字'],
    ['simileDensity', '明喻密度', '/百字'],
    ['psychDensity', '心理直述密度', '/百字'],
    ['adverbDensity', '情绪副词密度', '/百字'],
    ['idiom4Density', '四字格密度', '/百字'],
    ['paraPerSentence', '每句段落数', ''],
    ['shortParaRatio', '短段占比', ''],
    ['sentenceLenCv', '句长变异系数', ''],
  ];

  for (const [key, label, unit] of keys) {
    const target = profile[key];
    const usable = metricUsability(profile, key);
    if (!usable.usable) {
      // 基准无信息 → 该指标不参与判定，但必须**显式告知**，
      // 不能静默跳过（静默跳过会让人以为"检测过且通过"）
      skipped.push({ metric: key, label, reason: usable.reason });
      continue;
    }
    const tol = toleranceOf(profile, key, profile.samples && profile.samples[key]);
    const delta = m[key] - target;
    if (Math.abs(delta) <= tol) continue;
    const ratio = target ? delta / Math.abs(target) : 0;
    deviations.push({
      metric: key,
      label,
      unit,
      value: m[key],
      baseline: target,
      tolerance: +tol.toFixed(4),
      delta: +delta.toFixed(4),
      direction: delta > 0 ? 'high' : 'low',
      severity: Math.abs(ratio) > 3 ? 'high' : Math.abs(ratio) > 1.5 ? 'medium' : 'low',
      advice: adviceFor(key, delta > 0),
    });
  }

  const tics = KNOWN_TICS
    .filter((t) => t.re.test(stripMd(text)))
    .map((t) => t.name);

  deviations.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const skipNote = skipped.length ? `，${skipped.length} 项因样本不足未判定` : '';
  const summary = deviations.length
    ? `${deviations.length} 项偏离自身文风（${profile.sampleCount} 篇样本，置信度 ${profile.confidence}${skipNote}）`
    : `未发现显著偏离（${profile.sampleCount} 篇样本，置信度 ${profile.confidence}${skipNote}）`;

  return {
    ok: true,
    deviations,
    skipped,
    tics,
    showTics: !!opts.strict,
    confidence: profile.confidence,
    summary,
    measure: m,
  };
}

function severityRank(s) {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

/**
 * 给可执行的修改建议——只说方向，不代改。
 *
 * 参数 high = 「生成值高于画像基准」。这里极易写反：
 * 写反了不会报错，只会安静地给出与问题相反的建议——
 * 已经踩过一次（对话偏少却提示「对话偏多」）。
 * 所以每个条目都写成 `high ? <值偏高的话> : <值偏低的话>`，句式统一便于对读。
 */
function adviceFor(key, high) {
  const A = {
    dialogueRatio: high ? '对话偏多、旁白偏少，可削减一处独白' : '对话偏少，可让人物开口交涉',
    concreteDensity: high ? '具象物件偏多，像在列清单，可合并同类' : '具象物件偏少，缺少落地的细节',
    simileDensity: high ? '明喻偏密，建议删掉三分之一' : '几乎无比喻，略显平直',
    psychDensity: high ? '心理直述偏多，改用动作与停顿外显' : '几乎不写心理，人物动机不明',
    adverbDensity: high ? '情绪副词偏多，删掉不改句意的那几个' : '情绪副词偏少',
    idiom4Density: high ? '四字格偏多，注意别连着堆' : '四字格偏少，语感偏散',
    paraPerSentence: high ? '段落偏碎，把相邻的合并' : '段落偏长，适当断开',
    shortParaRatio: high ? '短段过多，节奏会跳' : '缺少单句成段的停顿',
    sentenceLenCv: high ? '句长波动偏大，读起来颠，可收敛些' : '句长偏均匀，缺少长短交错',
  };
  return A[key] || '';
}

/**
 * 把风格画像压成给模型看的 few-shot 提示。
 *
 * 注意：**只给相对描述，不给数字**。
 * 之前的设计是「对话占比 34%」这种塞进 prompt——8B 对百分比无概念，
 * 且数字会把模型注意力从写正文上引开。改成自然语言指令更有效。
 *
 * @param {object} profile
 * @param {number} [top] 取样本数上限，控制 token
 */
function styleDirective(profile, top = 2) {
  if (!profile || !profile.ok) return '';
  const lines = ['【文风要求——按以下特征写，与你写别的作品时区分开】'];

  if (profile.dialogueRatio >= 0.15) {
    lines.push(`- 多用人物对话推进，旁白少。这段要让对话占相当篇幅（你平时的稿子对话很密）。`);
  } else if (profile.dialogueRatio > 0 && profile.dialogueRatio < 0.05) {
    lines.push(`- 以叙述为主，少用对话。你的稿子几乎全靠旁白讲故事。`);
  }
  if (profile.concreteDensity >= 1.5) {
    lines.push(`- 落到具体东西上：器物、日常用具、身体动作，不要抽象概括。你的稿子物件感很重。`);
  }
  if (profile.shortParaRatio >= 0.08) {
    lines.push(`- 允许单句成段（「我去。」这样），用作停顿和强调。你的稿子大量用这个手法。`);
  }
  if (profile.sentenceLenCv >= 0.55) {
    lines.push(`- 句长要交错：长句铺陈、短句收住，不要全篇一个节奏。`);
  }
  if (profile.psychDensity <= 0.15) {
    lines.push(`- 少写「心中暗想」这类直述，改用动作、停顿、说话内容外露心理。`);
  }
  if (profile.idiom4Density >= 11) {
    lines.push(`- 四字成语用得密，但不要连着堆。`);
  }

  return lines.slice(0, top + 5).join('\n');
}

module.exports = {
  measure,
  buildProfile,
  checkStyle,
  styleDirective,
  splitSentences,
  splitParagraphs,
  stripMd,
  toleranceOf,
  metricUsability,
  KNOWN_TICS,
  CONCRETE_RE,
  ADVERB_RE,
  SIMILE_RE,
  PSYCH_RE,
  IDIOM4_RE,
  FLOOR_BY_METRIC,
  ZERO_INFLATED,
};
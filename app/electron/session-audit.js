/**
 * 行为审计：判断这个软件是不是在被拿去闲聊 / 角色扮演。
 *
 * ## 为什么要它（2026-10-18 羽毛菌）
 *
 * 原话：「因为是写小说工具，在每次对话完都要修改小说相关文件，如果两次
 *   对话都没有修改文件，直接判定为不合理使用，暂停功能，行为审计思路」
 *
 * 背景：那天测试人员用「儿子，我想多听你叫几声」「来，叫干爹啊」把模型
 * 哄成了认亲现场。输入层的规则可以一条条补，但那是一场**打地鼠**——
 * 换个说法就绕过去了。行为层不看他说了什么，只看他**有没有干活**。
 *
 * ## 为什么"没写文件"不能直接当判据
 *
 * 羽毛菌自己也补了一句：构思大纲、探讨剧情逻辑、分析人物动机时，
 * **不需要改正文**。真实创作里这类对话可以连着好几轮。
 *
 * 所以判定必须是**两个条件同时成立**：
 *   ① 这一轮没有任何文件产出（写章节、改设定、存脑洞/灵感/备忘录都算）
 *   ② 而且是一个**短问短答**（用户 ≤ 40 字、回答 ≤ 200 字）
 *
 * 第 ② 条是关键。正常的剧情讨论一轮就是几百上千字，永远够不到；
 * 而「叫干爹」「多叫几声」这种**必然是短句** —— 这是扮演类对话的形状，
 * 不是创作对话的形状。
 *
 * ## ⚠ 产出是**全局**的，不按对话分
 *
 * 用户在 A 对话里写小说、在 B 对话里随口问一句，不该被判定为滥用。
 * 只有**整个软件**连续两轮一个字都没往项目里写，才算。
 *
 * ## ⚠ 暂停必须留明路
 *
 * 这是用户自己的软件，暂停的目的是"别拿它干别的"，不是把人关在门外。
 * 恢复只要一个按钮（`resume()`），而且**不落盘** —— 重启即恢复。
 * 落盘的锁留给真正的越狱（scope-guard 的 lock）。
 */

/** 连续几轮"短问短答 + 零产出"判定为滥用 */
const MAX_IDLE = 2;

/** 用户消息短于这个长度，才可能是"对 AI 说话"而不是"在描述创作需求" */
const SHORT_USER = 40;

/** 回答短于这个长度，才可能是"陪聊"而不是"写了一章/分析了一段" */
const SHORT_REPLY = 200;

/**
 * 写作话题词（2026-10-19 加）。
 *
 * ⚠ 只用来判断"这句反问是不是在问写作的事"，不参与别的判定。
 * 见下面 `askedBack` 的注释：反问必须**同时**满足"有问号"和"沾写作"，
 * 否则「你想聊点什么？」这种也会被当成反问而免疫。
 */
const WRITING_TOPIC = new RegExp([
  '章', '节', '字', '人物', '角色', '设定', '剧情', '大纲', '情节',
  '主角', '配角', '反派', '卷', '文风', '视角', '时间线', '伏笔', '对白', '场景',
].join('|'));

class SessionAudit {
  constructor() {
    /** 连续多少轮"短问短答 + 零产出" */
    this.idle = 0;
    /** 是否已暂停 */
    this.paused = false;
    /** 暂停原因（给界面显示），{ turns, at } */
    this.reason = null;
  }

  get isPaused() { return this.paused === true; }

  /**
   * 观察一轮对话。
   *
   * @param {object} o
   * @param {boolean} o.produced   这一轮有没有任何项目文件写入（含脑洞/灵感/备忘录）
   * @param {string} o.userText    用户这一轮说的话
   * @param {string} o.assistantText 模型这一轮的回答
   * @returns {{idle:number, idleTurn:boolean, paused:boolean}}
   */
  observe(o) {
    const opt = o || {};
    const userLen = String(opt.userText || '').trim().length;
    const replyLen = String(opt.assistantText || '').trim().length;

    // 有产出 → 这是在干活，计数清零
    if (opt.produced) {
      this.idle = 0;
      return { idle: this.idle, idleTurn: false, paused: this.paused };
    }

    /**
     * ⚠ 没有产出，但这一轮**不像闲聊** → 不计数。
     *
     * 这是防误伤的主闸门。一个用户在讨论剧情时：
     *   · 要么提问很长（"第三章里夜枫拿到那柄刀之后的动机我觉得不太对，
     *     他当时明明可以不救那个人…"）→ 超过 40 字
     *   · 要么回答很长（模型分析了一大段）→ 超过 200 字
     * 两者只要有一个成立，就不算"短问短答"。
     */
    const shortExchange = userLen <= SHORT_USER && replyLen <= SHORT_REPLY;

    /**
     * ⚠ 空回答不算 —— 网络失败、被取消、被守卫拦下，这些都不是"滥用"。
     *   把它们计进 idle 会让一个网络不稳的用户被自己的软件锁住。
     */
    if (!replyLen) {
      return { idle: this.idle, idleTurn: false, paused: this.paused };
    }

    if (!shortExchange) {
      return { idle: this.idle, idleTurn: false, paused: this.paused };
    }

    /**
     * ⚠⚠ 反问不算闲聊（2026-10-19 修，实测抓到的误杀）。
     *
     * ## 现场
     *
     * 段对话完全正常：
     *   用户「写第一章」（5 字）→ 模型「第一章写多长？主角这章要出场吗？」
     *   用户「2000字，出场」→ 模型「主角叫什么名字？设定库里我没找到。」
     * 这是**标准的澄清流程**，一个字没写是因为还没到写的时候。
     * 而旧判定两轮就 `idle=2` → **暂停**。
     *
     * 结果是：越是认真反问细节的模型，越容易被自己的软件锁住。
     *
     * ## 判定必须两个条件同时成立
     *
     *   ① 回答里有问号
     *   ② 回答里提到写作相关词（章/人物/设定/字数…）
     *
     * 只判①的话，「你想聊点什么？」这种陪聊提问也会免疫，
     * 行为审计就基本失效了。
     *
     * ⚠ 误判方向刻意偏向"放过"：把闲聊误判成反问，代价是少拦一次；
     *   把反问误判成闲聊，代价是用户的正常创作被打断并要求点"继续使用"。
     */
    const reply = String(opt.assistantText || '');
    const askedBack = /[？?]/.test(reply) && WRITING_TOPIC.test(reply);
    if (askedBack) {
      return { idle: this.idle, idleTurn: false, paused: this.paused, askedBack: true };
    }

    this.idle += 1;
    if (this.idle >= MAX_IDLE && !this.paused) {
      this.paused = true;
      this.reason = { turns: this.idle, at: Date.now() };
    }
    return { idle: this.idle, idleTurn: true, paused: this.paused };
  }

  /** 用户点「我知道，继续用」：清零并解除暂停 */
  resume() {
    this.idle = 0;
    this.paused = false;
    this.reason = null;
  }

  /** 只读快照，给界面用 */
  snapshot() {
    return {
      idle: this.idle,
      paused: this.paused,
      maxIdle: MAX_IDLE,
      reason: this.reason,
    };
  }
}

/** 暂停时给用户的说明。⚠ 必须带"怎么恢复"，否则用户以为软件坏了。 */
function pauseNotice() {
  return `连续 ${MAX_IDLE} 轮对话没有任何写作产出（没写章节、没改设定、`
    + '也没存到脑洞/灵感/备忘录），已暂停对话功能。\n'
    + '这个工具只用于小说创作 —— 如果刚才是在构思或讨论，'
    + '点下面的「继续使用」即可恢复。';
}

module.exports = {
  SessionAudit,
  pauseNotice,
  MAX_IDLE,
  SHORT_USER,
  SHORT_REPLY,
};

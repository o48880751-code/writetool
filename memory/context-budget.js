/**
 * 上下文预算与压缩。
 *
 * 底稿 §3.3.2/ §3.3.3 已经把检索层的上下文占用从 86% 压到 4%，
 * 但长篇真正的挑战不是「一次检索」，而是「对话历史 + 设定 + 正文的总和」。
 *
 * 核心取舍：**压缩不靠模型总结**。
 *   8B 做摘要会引入二次幻觉——它会把没读过的内容写成"读过"，
 *   而设定库里最不能出错的就是设定本身。实测 §3.2 已经证明它会凭空编造。
 *   所以这里的策略是：代码决定裁剪什么，模型只负责它本来就在做的「续写」。
 *
 * 三层预算（超预算时按优先级丢）：
 *   1. 固定区：system prompt + 设定摘要 —— **永不丢弃**
 *   2. 滚动区：最近 N 轮的正文 —— 丢最旧的
 *   3. 可丢区：工具返回的原始检索结果 —— 只保留已被引用的事实
 *
 * 关键设计：**工具结果按「是否被引用」决定去留**，不是按时间。
 * 一条检索结果如果被后续的 write_segment 用到了就留，没用到就丢——
 * 这比按时间裁剪准得多，因为未使用的老检索结果本来就是噪声。
 */

const TOKENS_PER_CHAR = 1 / 1.5; // 中文约 1.5 字/token，与 eval-retrieval.js 的标定一致

function estimateTokens(text) {
  return Math.ceil(String(text || '').length * TOKENS_PER_CHAR);
}

/**
 * 一轮对话的上下文条目。
 * @typedef {{role:'system'|'user'|'assistant'|'tool', content:string, pinned?:boolean, used?:boolean}} ContextItem
 */

/**
 * 上下文预算器。
 */
class ContextBudget {
  /**
   * @param {object} opts
   * @param {number} [opts.numCtx] 模型上下文窗口，默认 8192（与 run-verify.js 一致）
   * @param {number} [opts.reserve] 固定预留（system + 设定摘要 + 安全余量）。
   *   省略时按 numCtx 的 25% 计算——**不能写死**：写死 2048 碰上
   *   num_ctx=2048 的小窗口会让 historyBudget 变成 0，
   *   任何内容都算超预算，压缩器每轮都 starved，等于治理完全失效。
   * @param {number} [opts.reserveRatio] 预留比例（仅在未给 reserve 时生效），默认 0.25
   * @param {number} [opts.minBudget] 对话历史预算下限，默认 512。
   *   宁可超预算也不能没有历史——否则模型连上一轮说了什么都看不到。
   * @param {number} [opts.keepRecentRounds] 超预算时至少保留的最近轮数，默认 3
   */
  constructor(opts = {}) {
    this.numCtx = opts.numCtx || 8192;
    this.reserve = opts.reserve === undefined
      ? Math.round(this.numCtx * (opts.reserveRatio === undefined ? 0.25 : opts.reserveRatio))
      : opts.reserve;
    this.minBudget = opts.minBudget === undefined ? 512 : opts.minBudget;
    this.keepRecentRounds = opts.keepRecentRounds === undefined ? 3 : opts.keepRecentRounds;
    this.items = [];
    // starved=true 表示「压缩到无可丢，仍超预算」——调用方必须检查它
    this.starved = false;
  }

  /**
   * 可用于对话历史的预算 = 窗口 - 固定预留，且不低于 minBudget。
   */
  get historyBudget() {
    return Math.max(this.minBudget, this.numCtx - this.reserve);
  }

  /**
   * 加入一条上下文。
   * @param {ContextItem} item
   * @param {object} [meta]
   * @param {boolean} [meta.pinned] 固定区，永不丢弃
   * @param {boolean} [meta.used] 工具结果是否被后续步骤引用过——决定它能否被丢
   *
   * ⚠ 修掉的真 bug：原来 `pinned: !!item.pinned` 只读 item，
   * 但 loop-guard.js 是把 `{ pinned: true }` 放在 **meta** 里的。
   * 实测构造后是 `[ {role:'system', pinned:false}, {role:'user', pinned:false} ]`
   * —— system prompt 根本没被固定，compress() 直接把它删了，
   * 与文件头「固定区：system prompt + 设定摘要 —— 永不丢弃」的设计声明矛盾。
   *
   * 潜伏原因：Electron 主进程从没调用 guard.ensure()，这条路径在应用里没走过。
   * 一旦接上，system prompt 就会被丢掉。现在两个位置都读。
   */
  push(item, meta = {}) {
    this.items.push({
      role: item.role,
      content: item.content,
      pinned: meta.pinned !== undefined ? !!meta.pinned : !!item.pinned,
      used: meta.used !== undefined ? meta.used : (item.role !== 'tool'),
      // 工具结果默认更早被丢：它们是「参考」不是「对话」
      droppable: item.role === 'tool',
    });
  }

  /** 标记某条工具结果已被引用 */
  markUsed(index) {
    if (this.items[index]) this.items[index].used = true;
  }

  /** 当前占用的估算 token */
  usedTokens() {
    return this.items.reduce((a, it) => a + estimateTokens(it.content) + 4, 0); // +4 ≈ role/分隔符开销
  }

  /**
   * 是否超预算。
   * @param {number} extraTokens 这次请求额外要带的 token（如 system + 设定）
   */
  isOverBudget(extraTokens = 0) {
    return this.usedTokens() + extraTokens > this.historyBudget;
  }

  /**
   * 压缩到预算内。返回被丢弃的条目索引。
   *
   * 丢弃顺序（先丢最不重要的）：
   *   1. 未被引用的工具结果 —— 纯噪声，丢了不影响任何后续推理
   *   2. 超出 keepRecentRounds 的旧对话轮次
   *   3. 最旧的对话（直到进预算）
   * 永不丢：pinned 条目、最近 N 轮对话。
   */
  compress() {
    // 预算充足时什么都不做。keepRecentRounds 只是「超预算时的最低保留量」，
    // 不是「无论有没有预算都裁到这么多」——早期版本无条件裁剪导致
    // 预算明明只用 2.2% 却把 5 轮对话砍到 3 轮，纯属浪费上下文。
    this.starved = false;
    if (!this.isOverBudget()) return [];

    const dropped = [];
    // 第一轮：丢未引用的工具结果（从最旧开始）—— 纯噪声，丢了不影响任何后续推理
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.pinned) continue;
      if (!it.droppable) continue;   // 对话轮次不在这一步丢
      if (it.used) continue;         // 被引用过的保留
      dropped.push(i);
    }
    if (dropped.length) {
      const set = new Set(dropped);
      this.items = this.items.filter((_, i) => !set.has(i));
    }

    // 若丢完工具结果已进预算，不必再砍对话
    if (!this.isOverBudget()) return dropped;

    // 第二轮：丢超出 keepRecentRounds 的旧对话
    const chatCount = this.items.filter((it) => !it.droppable && !it.pinned).length;
    const excess = chatCount - this.keepRecentRounds;
    for (let k = 0; k < excess; k++) {
      const idx = this.items.findIndex((it) => !it.droppable && !it.pinned);
      if (idx < 0) break;
      this.items.splice(idx, 1);
      dropped.push(idx);
    }

    // 第三轮：仍然超预算时的最后手段。
    // 必须排除「被引用过的工具结果」——它们是正文的事实来源，
    // 丢了会造成设定丢失（比超预算严重得多）。
    // 宁可带着超预算的状态停下来报错，也不能默默把设定丢了。
    let guard = 0;
    while (this.isOverBudget() && guard++ < 100) {
      const idx = this.items.findIndex((it) => !it.pinned && !(it.droppable && it.used));
      if (idx < 0) {
        // 只剩 pinned 与被引用的工具结果了——不再丢，
        // 由调用方看到 isOverBudget() 为 true 后决定是继续还是中止
        this.starved = true;
        break;
      }
      this.items.splice(idx, 1);
      dropped.push(idx);
    }
    return dropped;
  }

  /** 按 API 要求的格式输出 */
  toMessages() {
    return this.items.map((it) => ({ role: it.role, content: it.content }));
  }

  /** 诊断信息 */
  report() {
    const byRole = {};
    for (const it of this.items) {
      byRole[it.role] = (byRole[it.role] || 0) + 1;
    }
    return {
      items: this.items.length,
      byRole,
      usedTokens: this.usedTokens(),
      historyBudget: this.historyBudget,
      usage: `${((this.usedTokens() / this.historyBudget) * 100).toFixed(1)}%`,
    };
  }
}

/**
 * 生成设定摘要：超长篇时不能把全部设定塞进上下文。
 *
 * ## 为什么不能按类型顺序贪心填充
 *
 * 早期版本 `PRIORITY = {character:0, technique:1, ...}` + 顺序填充，
 * 实测在 200 条库上的后果（200 条合成库 + 真实 13 条 A 库）：
 *   - 52 条被纳入，148 条被丢弃
 *   - 纳入的全是 character(41) + technique(11)
 *   - **location / faction / plot 三类全军覆没**
 *   - 参数 `perTypeLimit` 写了但从未被使用（死代码）
 *
 * 两个致命问题：
 *   1. **地点丢失**。长篇里地点是场景骨架，「他现在在哪」比「他是谁」更影响续写。
 *   2. **note 长度决定生死**。真实设定条目 note 长（60~80 字），
 *      短条目（如「设定0」）挤在前面占位，反而把真设定挤掉——**越重要的越容易被丢**。
 *
 * ## 现在的做法：打分制
 *
 * 每条设定算一个分数，降序取到预算为止：
 *   score = 类型基分 + 重要度 + 在场/最近出场加权 + note 信息量（截断惩罚）
 *
 * 关键改动：
 *   - **每类保底名额**：无论分数多低，每类至少进 N 条，
 *     保证 location/faction/plot 不会被前两类吃光。
 *   - **在场角色与未回收伏笔强制注入**：它们不是「候选」而是「当前事实」。
 *   - **note 按预算截断**：短 note 不占便宜，长 note 也不该被整体淘汰。
 */

/** 类型基分：主线相关的类型优先，但不排他（保底名额兜底） */
const TYPE_BASE = {
  character: 30,   // 角色是主线的载体
  plot: 28,        // 伏笔是长篇的骨架，漏了就忘
  technique: 22,
  faction: 20,     // 势力影响谁能做什么
  location: 18,    // 地点决定场景，但按需检索更省
};

function summarizeBible(settings, opts = {}) {
  const maxChars = opts.maxChars || 1200;
  // 每类保底名额：防止前几类吃光预算导致其他类型彻底消失
  const floorPerType = opts.floorPerType === undefined ? 3 : opts.floorPerType;
  // 调用方传入「当前必须知道的实体」：在场角色、未回收伏笔等
  const pinned = new Set(opts.pinned || []);

  const scored = settings.map((s) => {
    const note = String(s.note || '');
    return {
      s,
      score: scoreEntry2(s, pinned),
      // note 越长说明信息量越大，但也要按剩余预算截断
      note,
    };
  });

  // 稳定排序：分数降序 → 名称字典序（保证可复现，不受对象顺序影响）
  scored.sort((a, b) => (b.score - a.score) || a.s.name.localeCompare(b.s.name, 'zh'));

  // ---- 第一轮：每类保底 ----
  const chosen = [];
  const chosenNames = new Set();
  const byTypeCount = {};
  const consume = (item, line) => {
    if (chosenNames.has(item.s.name)) return false;
    if (totalChars() + line.length > maxChars) return false;
    chosen.push({ item, line });
    chosenNames.add(item.s.name);
    byTypeCount[item.s.type] = (byTypeCount[item.s.type] || 0) + 1;
    return true;
  };
  const totalChars = () => chosen.reduce((a, c) => a + c.line.length + 1, 0);

  for (const t of Object.keys(TYPE_BASE)) {
    const pool = scored.filter((x) => x.s.type === t).slice(0, floorPerType);
    for (const item of pool) consume(item, formatLine(item, maxChars));
  }

  // ---- 第二轮：高分优先填满剩余预算 ----
  for (const item of scored) {
    if (totalChars() >= maxChars) break;
    if (chosenNames.has(item.s.name)) continue;
    // 只保留比该类保底条目分数更高的，避免同一类刷屏
    consume(item, formatLine(item, maxChars - totalChars()));
  }

  const droppedNames = scored.filter((x) => !chosenNames.has(x.s.name)).map((x) => x.s.name);
  const text = chosen.map((c) => c.line).join('\n');
  const suffix = droppedNames.length
    ? `\n（另有 ${droppedNames.length} 条未纳入摘要，需检索获取：${droppedNames.slice(0, 8).join('、')}${droppedNames.length > 8 ? '…' : ''}）`
    : '';

  return {
    text: text + suffix,
    included: chosen.length,
    dropped: droppedNames.length,
    droppedNames,
    byTypeCount,
    chars: (text + suffix).length,
    /** 哪些类型一条都没进去——调用方可据此告警 */
    missingTypes: Object.keys(TYPE_BASE).filter((t) => !byTypeCount[t]),
  };
}

/** 打分：类型基分 + 重要度 + 在场加权 + note 信息量 */
function scoreEntry2(s, pinned = new Set()) {
  let score = TYPE_BASE[s.type] ?? 10;
  if (s.importance) score += Number(s.importance) * 6;      // 1~5 重要度
  if (pinned.has(s.name)) score += 1000;                  // 当前事实，锁进摘要
  const len = String(s.note || '').length;
  // note 信息量：长说明通常意味着设定更复杂。
  // 但**不能反过来当优势**——实测 200 条库上，短 note 的占位条目
  // （note = "设定0"，5 字）会靠低分成本挤掉 note 60~80 字的真实角色，
  // 白白吃掉 29 个配额。note 过短本身就是「未填写」的信号，该扣分。
  if (len < 12) score -= 15;
  else score += Math.min(12, len / 8);
  // 别名多的实体更难被检索到，多给一点曝光
  if ((s.aliases || []).length) score += Math.min(6, (s.aliases || []).length * 2);
  return score;
}

/** 格式化一行，按剩余预算截断 note */
function formatLine(item, remaining) {
  const type = item.s.type;
  const name = item.s.name;
  const head = `· ${name}（${type}）：`;
  // 至少要放得下名字，否则跳过（由调用方处理）
  const room = Math.max(0, remaining - head.length);
  const note = truncate(item.note, Math.min(40, room));
  return note ? `${head}${note}` : `· ${name}（${type}）`;
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

module.exports = { ContextBudget, summarizeBible, estimateTokens, TOKENS_PER_CHAR, TYPE_BASE };

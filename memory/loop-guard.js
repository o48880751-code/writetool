/**
 * 把上下文预算接进 Agent 循环。
 *
 * ## 为什么必须在这里做，而不是让调用方主动调
 *
 * `run-verify.js` 的 Agent 循环有 14 处 `messages.push`（每次工具调用追加 3 条：
 * assistant tool_call + tool result + 提示）。任何单点治理都会漏。
 * 而且**压缩后必须同步回 messages**——只压缩副本的话，
 * 请求体里带的还是全量历史，等于没压。
 *
 * ## 关键设计：保留 assistant/tool 配对
 *
 * Ollama 的 /api/chat 要求：assistant 带 tool_calls 的那条，
 * 后面必须紧跟对应的 tool 消息。**孤立删掉其中一条会破坏协议**，
 * 实测表现为模型下一轮完全不调工具、直接开始编正文——
 * 这正是 §3.4 那类「表演调工具」的来源之一。
 *
 * 所以丢弃时按「配对组」处理：一条 assistant tool_call 与紧随其后的
 * tool 结果绑成一个不可分割的单元，要么都留要么都丢。
 */

const { ContextBudget, estimateTokens } = require('./context-budget.js');

class LoopContextGuard {
  /**
   * @param {object} opts
   * @param {Array}  opts.messages 初始消息（system + task，会被就地修改）
   * @param {number} [opts.numCtx]
   * @param {number} [opts.reserve]
   * @param {number} [opts.keepRecentRounds]
   * @param {boolean} [opts.enabled] 默认开启；关掉可做 A/B 对照
   */
  constructor(opts = {}) {
    this.messages = opts.messages || [];
    this.enabled = opts.enabled !== false;
    // 不传 reserve：让 ContextBudget 按 numCtx 比例算。
    // 写死 2048 碰上 num_ctx=2048 会让预算为 0，治理形同失效。
    this.budget = new ContextBudget({
      numCtx: opts.numCtx || 8192,
      reserve: opts.reserve,
      reserveRatio: opts.reserveRatio,
      minBudget: opts.minBudget,
      keepRecentRounds: opts.keepRecentRounds,
    });
    // system + 第一条 user（任务描述）恒为 pinned：它们定义了「在写什么」
    this.budget.push({ role: 'system', content: this.messages[0] ? this.messages[0].content : '' }, { pinned: true });
    if (this.messages[1]) this.budget.push({ role: 'user', content: this.messages[1].content }, { pinned: true });

    this.compressions = 0;
    this.totalDropped = 0;
    this.starvedEvents = 0;
    this.log = [];
  }

  /** 估算当前 messages 占多少 token */
  usedTokens() {
    return this.messages.reduce((a, m) => a + estimateTokens(m.content) + 4, 0);
  }

  /**
   * 把配对关系标记出来：assistant(tool_calls) 的下一个 tool 消息与之绑定。
   * @returns {Array<{start:number,end:number}>} 配对区间（闭区间）
   */
  _toolPairs() {
    const pairs = [];
    for (let i = 2; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        let end = i;
        if (this.messages[i + 1] && this.messages[i + 1].role === 'tool') end = i + 1;
        pairs.push({ start: i, end });
      }
    }
    return pairs;
  }

  /** 找出「孤立」的条目——它们不能被单独删除 */
  _orphanIndices() {
    const guarded = new Set();
    for (const p of this._toolPairs()) {
      for (let i = p.start; i <= p.end; i++) guarded.add(i);
    }
    const orphans = [];
    for (let i = 2; i < this.messages.length; i++) {
      if (!guarded.has(i)) orphans.push(i);
    }
    return orphans;
  }

  /**
   * 在发请求前调用：超预算则压缩，并同步回 messages。
   *
   * @returns {{compressed:boolean, dropped:number, starved:boolean, used:number, budget:number}}
   */
  ensure() {
    const used = this.usedTokens();
    const budget = this.budget.historyBudget;
    if (!this.enabled || used <= budget) {
      return { compressed: false, dropped: 0, starved: false, used, budget };
    }

    const before = this.messages.length;

    // 找出可删区间：配对组整体可删，孤立条目也可删（它们只是重试提示文本）
    const dropRanges = [];
    for (const p of this._toolPairs()) {
      // 保留最近 N 个配对组
      dropRanges.push(p);
    }
    const orphans = this._orphanIndices();

    // 保留策略：最后 keepRecentRounds * 2 条消息不动（对应每轮 3 条消息里最近两轮）
    const keepTail = (this.budget.keepRecentRounds || 3) * 3;
    const keepFrom = this.messages.length - keepTail;

    // 判定哪些组「值得丢」：纯重试噪声优先（无 tool_calls 的 assistant 文本），
    // 其次是最旧的工具配对组。
    const orphansToDrop = orphans.filter((i) => i < keepFrom);
    const pairsToDrop = dropRanges.filter((p) => p.end < keepFrom);
    // 工具结果里，被后续 write/commit 用过的内容才值得留——这里用保守近似：
    // 含 commit_chapter 结果的组（已落盘的事实）优先保留到最后。
    const commitPairs = pairsToDrop.filter((p) => {
      const toolMsg = this.messages[p.end];
      return toolMsg && toolMsg.role === 'tool' && /commit_chapter/.test(JSON.stringify(toolMsg.content || ''));
    });
    const droppablePairs = pairsToDrop.filter((p) => !commitPairs.includes(p));

    const toDrop = new Set();
    for (const i of orphansToDrop) toDrop.add(i);
    // 从最旧的开始丢，直到进预算
    for (const p of droppablePairs) {
      if (this.usedTokens() <= budget) break;
      for (let i = p.start; i <= p.end; i++) toDrop.add(i);
    }

    if (!toDrop.size) {
      // 到了无可丢的地步：保留全部，宁可超预算也不破坏配对或丢事实
      this.starvedEvents++;
      this.log.push({ at: used, action: 'starved', kept: this.messages.length });
      return { compressed: false, dropped: 0, starved: true, used, budget };
    }

    this.messages = this.messages.filter((_, i) => !toDrop.has(i));
    this.compressions++;
    this.totalDropped += toDrop.size;
    this.log.push({
      at: used,
      action: 'compressed',
      dropped: toDrop.size,
      after: this.usedTokens(),
      beforeCount: before,
    });

    return {
      compressed: true,
      dropped: toDrop.size,
      starved: false,
      used: this.usedTokens(),
      budget,
    };
  }

  /** 诊断信息 */
  report() {
    return {
      enabled: this.enabled,
      messages: this.messages.length,
      usedTokens: this.usedTokens(),
      historyBudget: this.budget.historyBudget,
      // ⚠⚠ 暴露窗口与预留：界面的用量指示器要按**用户设置的窗口**
      //   （numCtx）显示百分比，而不是按 historyBudget ——
      //   后者减掉了 reserve，用户设 131072 却看到分母 126976，
      //   会以为哪里不对。
      numCtx: this.budget.numCtx,
      reserve: this.budget.reserve,
      usage: `${((this.usedTokens() / this.budget.historyBudget) * 100).toFixed(1)}%`,
      compressions: this.compressions,
      totalDropped: this.totalDropped,
      starvedEvents: this.starvedEvents,
      log: this.log,
    };
  }
}

module.exports = { LoopContextGuard };
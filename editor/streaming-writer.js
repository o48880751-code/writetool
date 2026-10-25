/**
 * 流式写入 + 用户插队 的核心逻辑。
 *
 * 为什么单独抽出来：编辑器 UI 换成 CodeMirror 或别的库，这层逻辑不该重写。
 * 它只依赖 ProseMirror 的 EditorState/Transaction，不依赖任何 DOM。
 *
 * 三个关键设计（每条都有实测依据，见 editor/probe-report.md）：
 *
 * 1. 插入点每次重算，绝不缓存绝对位置。
 *    实测：用户中途插入后 doc.size 变化，缓存的位置会把文字写进段落中间。
 *
 * 2. 用户删除已生成的内容，不做恢复。
 *    实测：用户删掉「DEF」后模型继续输出，结果是「AEFXYZ」而非「ABCDEFXYZ」。
 *    这是刻意取舍——做 diff 合并需要维护每个字符的来源映射，复杂度高且容易
 *    产生「用户删了但又被写回来」的诡异体验。写作工具里用户意图优先于模型输出。
 *
 * 3. 生成区与用户区分离。
 *    生成开始时记录插入锚点所在段落，之后模型的输出只往那个段落尾部追加，
 *    用户在其他段落的编辑完全不受影响。
 *
 * 依赖：@tiptap/pm (ProseMirror)，Node >= 22.22
 */

/** 生成会话的状态机 */
/**
 * 段落分隔哨兵：不可能出现在正文里的字符序列。
 * 作用是把「连续的若干换行」折叠成一个标记，
 * 避免 split('\n') 时每个换行各造一个空段落。
 */
const PARA_SEP = '\u0000PARA\u0000';

const Phase = {
  IDLE: 'idle',       // 无生成
  STREAMING: 'streaming', // 模型输出中
  CANCELED: 'canceled', // 用户中止
  DONE: 'done',       // 已完成并落盘
};

class StreamingWriter {
  /**
   * @param {import('@tiptap/pm/state').EditorState} state 初始编辑器状态
   * @param {object} [opts]
   * @param {(text:string)=>void} [opts.onInsert] 每次写入后的回调（用于同步 UI）
   */
  constructor(state, opts = {}) {
    this.state = state;
    this.onInsert = opts.onInsert || (() => {});
    this.phase = Phase.IDLE;
    // 本次会话累计写入的纯文本——落盘时用它和编辑器内容做一致性校验
    this.buffer = '';
    // 本次会话一共写入的字符数，用来判断用户是否插队改动了生成区
    this.generatedChars = 0;
    // 用户在本次生成期间的外部编辑次数
    this.userEditsDuringStream = 0;
    this._externallyUpdating = false;
  }

  /** 用新的 state 同步自身（编辑器 onTransaction 时调用） */
  sync(state, meta) {
    if (this._externallyUpdating) return;
    const prevSize = this.state ? this.state.doc.content.size : 0;
    this.state = state;
    // 用户可能把文档删到零段。schema 的 doc 要求 block+，零段是非法文档，
    // 后续任何 transaction 都会抛 "Invalid content for node doc"。
    // 这里不强行改文档（那是篡改用户操作），只置一个标记，
    // 让 write 与 finish 知道当前状态不可继续。
    if (state.doc.childCount === 0) {
      this.emptied = true;
      return;
    }
    this.emptied = false;
    if (this.phase === Phase.STREAMING) {
      const sizeDelta = state.doc.content.size - prevSize;
      if (meta && meta.userEdit) this.userEditsDuringStream++;
      else if (sizeDelta > 0) this.generatedChars += sizeDelta;
    }
  }

  /**
   * 开始一次生成：追加一个新段落作为生成目标。
   *
   * 边界处理：如果文档已经是空的单段（EditorState 初始态就是如此），
   * 不需要再 split——否则会造出一个空段，导致 write 时段落数与预期差一。
   */
  beginGeneration() {
    if (this.phase === Phase.STREAMING) throw new Error('已有生成在进行中');
    const onlyOneEmptyPara = this.state.doc.childCount === 1 &&
      this.state.doc.child(0).content.size === 0;
    if (!onlyOneEmptyPara) {
      const tr = this.state.tr.split(this.state.doc.content.size - 1);
      this.state = this.state.apply(tr);
    }
    this.phase = Phase.STREAMING;
    this.buffer = '';
    this.generatedChars = 0;
    this.userEditsDuringStream = 0;
    return this;
  }

  /**
   * 把一个流式分片切成「行序列」，其中段落分隔用哨兵表示。
   *
   * ⚠ 修掉的真 bug：原来直接 `text.split('\n')`，
   * 而 `"甲\n\n乙".split('\n')` 得到 **3 个** 元素（["甲","","乙"]）。
   * 循环里每遇一个元素就 split 一次 → **一个段落间隔造出 2 个空段落**。
   * 实测写三个分段，文档里出现 5 段。
   * 段落分隔在语义上是「连续的若干换行」，必须先折叠成单个分隔符再切。
   */
  _chunkToLines(text) {
    return String(text).replace(/\n{2,}/g, PARA_SEP).split('\n');
  }

  /**
   * 写入一个流式分片。
   * @param {string} chunk
   * @returns {boolean} 是否成功写入
   */
  write(chunk) {
    if (this.phase !== Phase.STREAMING) return false;
    const text = String(chunk || '');
    if (!text) return false;
    // 文档被用户删空：无法再写入。返回 false 让调用方停止消费流，
    // 真正的处理交给 verifyBeforeCommit 判定「生成内容缺失」并拒绝落盘。
    if (this.emptied || this.state.doc.childCount === 0) return false;

    // 分片里可能自带换行（模型输出的段落分隔）。按段落分隔逐段写入，
    // 这是「让模型的段落结构真实反映到编辑器」的关键。
    const lines = this._chunkToLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 除首个分片外，每遇到一个行分隔就新开一段
      if (i > 0) {
        if (this.state.doc.childCount === 0) { this.emptied = true; return false; }
        const tr = this.state.tr.split(this.state.doc.content.size - 1);
        this.state = this.state.apply(tr);
      }
      if (!line) continue;

      if (!line.includes(PARA_SEP)) {
        const pos = this.state.doc.content.size - 1;
        const tr = this.state.tr.insertText(line, pos);
        this.state = this.state.apply(tr);
        continue;
      }
      // 一个分片里含多个段落间隔
      const parts = line.split(PARA_SEP);
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) {
          if (this.state.doc.childCount === 0) { this.emptied = true; return false; }
          const tr = this.state.tr.split(this.state.doc.content.size - 1);
          this.state = this.state.apply(tr);
        }
        if (!parts[k]) continue;
        const pos = this.state.doc.content.size - 1;
        const tr = this.state.tr.insertText(parts[k], pos);
        this.state = this.state.apply(tr);
      }
    }
    this.buffer += text;
    this.generatedChars += text.length;
    this.onInsert(text);
    return true;
  }

  /** 中止生成：保留已写入的内容，不再接受后续分片 */
  cancel() {
    if (this.phase === Phase.STREAMING) this.phase = Phase.CANCELED;
    return this;
  }

  /**
   * 结束生成会话，之后不再接受分片。
   * 与 finish 分开：finish 只是"读取当前正文"，不改变状态；
   * 落盘时才调end()，这样落盘前的校验失败还能让用户继续改。
   */
  end() {
    if (this.phase === Phase.STREAMING) this.phase = Phase.DONE;
    return this;
  }

  /**
   * 取最终正文。**纯读取，不改变状态**——
   * 用户可能在校验失败后继续编辑再验一次。
   *
   * 刻意返回编辑器当前内容而不是 this.buffer：
   * 用户插队的修改必须体现出来，落盘以用户看到的为准。
   */
  finish() {
    if (this.state.doc.childCount === 0) return '';
    return this.state.doc.textBetween(0, this.state.doc.content.size, '\n').replace(/\n+$/, '');
  }

  /** 本次生成的会话报告——用于可观测性 */
  report() {
    return {
      phase: this.phase,
      generatedChars: this.generatedChars,
      userEditsDuringStream: this.userEditsDuringStream,
      docSize: this.state.doc.content.size,
      paragraphs: this.state.doc.childCount,
    };
  }
}

/**
 * 判断一个句子是否还能在最终文本中找到，允许用户改写句内个别字。
 *
 * 为什么不用精确匹配：用户写作时会顺手改字（加个「里」、换个量词），
 * 这属于正常编辑不是丢稿。精确匹配会把这些误判为丢稿，让用户白跑一趟。
 *
 * 为什么不用字符集合覆盖率：实测漏检——句子「第二句完整内容。」被整句删掉后，
 * 剩余的「第一句完整内容。」与它的字符集合覆盖率高达 0.875（因为"完整内容"四字
 * 两句都有），于是丢稿被判为通过。中文模板化写作里这种「换首字」的句子极常见，
 * 字符集合完全不可用。
 *
 * 改用 3-gram 覆盖率：滑窗取 3 字片段，逐个检查是否还在最终文本里。
 * 判据：3-gram 存活率 ≥ 阈值即算仍在。模板化句子共享的是长片段而不是 3 字片段，
 * 「第二句」→「第一句」只差首字，3-gram 会真实反映出来。
 *
 * 阈值 0.75 是实测标定出来的，标定用例见 test-streaming.js 的「阈值标定」组：
 *   丢稿侧最高存活率 0.67（删整句的模板化句子）／ 0.33（换成别的字）／ 0.21（删半句）
 *   合法侧最低存活率 0.88（加一个字／加标点／改标点）
 * 两类分离度充足，0.7/ 0.75 / 0.8 三档均 0 误判，取中位 0.75 留余量。
 *
 * @param {string} sentence   生成的一句
 * @param {string} finalText  编辑器当前全文
 * @param {number} threshold  3-gram 存活率阈值
 */
function sentenceSurvived(sentence, finalText, threshold = 0.75) {
  if (finalText.includes(sentence)) return true;
  const clean = sentence.replace(/[\s　]/g, '');
  const haystack = finalText.replace(/[\s　]/g, '');
  const N = 3;
  if (clean.length <= N) return false;
  const grams = [];
  for (let i = 0; i + N <= clean.length; i++) grams.push(clean.slice(i, i + N));
  const alive = grams.filter((g) => haystack.includes(g)).length;
  return alive / grams.length >= threshold;
}

/**
 * 落盘前的一致性校验：确认编辑器内容包含本次生成的全部内容。
 *
 * 为什么要校验：如果模型输出中途被工具层丢弃，或用户删除了一大段，
 * 落盘内容就会与模型承诺的不一致。这属于「静默丢稿」——正是 §3.4 丢稿实验
 * 要防的那类问题，只是这次发生在写入侧而不是改稿侧。
 *
 * @returns {{ok:boolean, reason?:string, missing?:string}}
 */
function verifyBeforeCommit(writer, opts = {}) {
  const requireExact = opts.requireExact !== false;
  const finalText = writer.finish();
  if (!writer.buffer) return { ok: true, reason: 'empty-generation' };

  // 句级比对而不是全串包含：用户可能合法地调整了空白、换行与句内个别字，
  // 但不能丢掉整句。判据是「生成内容里的每一句是否还在（允许改写）」。
  const sentences = writer.buffer
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const missing = sentences.filter((s) => !sentenceSurvived(s, finalText));
  if (missing.length) {
    return {
      ok: false,
      reason: 'generated-content-missing',
      missing: missing.slice(0, 3).join(' / '),
      missingCount: missing.length,
      totalSentences: sentences.length,
    };
  }
  if (requireExact && finalText.length < writer.buffer.length * 0.5) {
    return {
      ok: false,
      reason: 'doc-truncated',
      detail: `最终 ${finalText.length} 字 vs 生成 ${writer.buffer.length} 字`,
    };
  }
  return { ok: true };
}

module.exports = { StreamingWriter, Phase, verifyBeforeCommit, sentenceSurvived };

/**
 * Agent 工具循环。
 *
 * ## 为什么单独一个文件
 *
 * 循环本身是纯编排：问模型 → 有工具就执行 → 把结果接回历史 → 再问。
 * 它不碰窗口、不碰数据库、不碰 provider 的协议细节，全靠注入。
 *
 * ⚠ 不这么拆的后果：这个逻辑只能靠「真连一个模型、真的敲一条命令」
 *   来验证——而它恰好是**出错代价最高**的一段（模型能真的在你电脑上
 *   跑命令）。塞进 main.js 就等于没有测试。
 *
 * ## 循环终止
 *
 * 四条，任一条满足就停：
 *   1. 模型这轮没要工具 → 正常结束
 *   2. 轮数到上限 → 停，并把「已达上限」这件事明确告诉模型，
 *      免得它以为是自己查完了（它会觉得结果不完整然后编）
 *   3. 一整个回合里**每一条调用都是重复的老调用** → 停（见 MAX_SAME_CALL）
 *   4. 用户点了停止 / 出错 → 停
 *
 * ⚠ 第 2、3 条都不能只是"静默停止"。模型看到的是「工具结果没回来」，
 *   它的典型反应是自己编一个答案接着写——而那答案是假的。
 */

const provider = require('./provider');
const tools = require('./tools');

/** 默认最多问几轮。8 轮够查资料 + 读网页又写正文了 */
const DEFAULT_MAX_ROUNDS = 8;

/**
 * 同一条调用（工具名 + 参数完全一样）最多执行几次。
 *
 * ## ⚠ 为什么必须有这个上限（2026-10-15 实测）
 *
 * 小模型会**原封不动地重复同一次调用**。实测硅基流动 Qwen3-8B：
 * 第二轮 web_search 的 query 与第一轮**一字不差** ——
 * 它不是在等结果，是根本没意识到结果已经回来了。
 *
 * 后果不是"多跑一次"，而是**用户一个字都拿不到**：
 * 每轮十几秒（云端 8B 实测 15 秒/轮），8 轮上限跑满就是两分钟纯转圈，
 * 而正文从头到尾是空的 —— 界面上看到的就是"卡壳"。
 *
 * 所以第 3 次撞上同一条调用就不再执行，把「已经跑过两次、结果没变」
 * 如实回给模型；如果整个回合都是这种重复，就带着这句话收尾，
 * 让用户拿到一句人话，而不是白等两分钟。
 *
 * ⚠ 取 2 而不是 1：模型偶尔会真的需要再确认一次（比如刚改完文件
 *   想再看一次目录）。卡在第 3 次是"确实在打转"的合理信号。
 */
const MAX_SAME_CALL = 2;

/**
 * 跑一轮工具循环。
 *
 * @param {object} opt
 * @param {object} opt.cfg        provider 配置（含 engine/base/apiKey…）
 * @param {Array}  opt.messages   初始历史（**不修改**，内部会复制）
 * @param {Array}  [opt.toolDefs] 要下发的工具定义；空/不给 = 不带工具
 * @param {number} [opt.maxRounds]
 * @param {Function} [opt.chatStream] 注入用，默认 provider.chatStream
 * @param {Function} [opt.execTool]    注入用，默认 tools.execTool
 * @param {object} opt.ctx        传给 execTool 的上下文 {cwd, approve, apiKey, httpRequest}
 * @param {object} opt.handlers    {onText, onThink, onToolStart, onToolEnd, onDone, onError}
 * @returns {{cancel: Function, finished: Promise}}
 */
function createAgentRun(opt) {
  const cfg = opt.cfg || {};
  const handlers = opt.handlers || {};
  const chatStream = opt.chatStream || provider.chatStream;
  const execTool = opt.execTool || tools.execTool;
  const maxRounds = Number(opt.maxRounds) > 0
    ? Number(opt.maxRounds)
    : DEFAULT_MAX_ROUNDS;

  const engine = provider.protoOf(cfg);
  const toolDefs = (opt.toolDefs && opt.toolDefs.length) ? opt.toolDefs : null;

  /**
   * ⚠⚠ 契约守卫：正文回调就叫 **onText**（本文件的文档与全部用例都这么写）。
   *
   * 2026-10-15 的线上事故：main.js 传的是 `onChunk`。
   * 键对不上 → `if (handlers.onText)` 恒为假 → **正文分片被整段丢弃**，
   * 而 onDone 里累出来的 `text` 也是空的。表现是：
   *   · 界面一个字都不流出来（思考照常显示，因为 onThink 对得上）
   *   · 助手消息**从来没落过库**（`if (out.trim())` 不成立）
   *   · 界面却看着一切正常，结束后 re-fetch 出来的是旧内容
   *
   * 这种错配**必须是响的**。静默丢弃的代价是用户以为软件坏了，
   * 而日志里连一行都没有。
   *
   * 放在这里（而不是第一次 askOnce 里）是因为：要在**发出任何请求之前**
   * 就失败 —— 请求已经跑完 30 秒才告诉你是错配，等于白等。
   */
  if (typeof handlers.onText !== 'function' && typeof handlers.onChunk === 'function') {
    throw new Error(
      'agent-loop 的正文回调叫 onText，不是 onChunk。'
      + '收到 onChunk 而没有 onText，正文会被静默丢弃'
      + '（界面不流式、助手消息也不落库）。'
    );
  }

  let history = [...(opt.messages || [])];
  let round = 0;
  let cancelCurrent = null;
  let cancelled = false;

  /** 这条调用（工具名 + 参数）已经执行过几次。见 MAX_SAME_CALL */
  const seenCalls = new Map();

  /**
   * 调用指纹。
   *
   * ⚠ 必须把**参数**也算进去：同一个工具搜不同的词是完全正常的行为，
   *   只有"名字和参数都一样"才叫重复。只按名字算的话，
   *   模型连着查三个资料就会被拦下来。
   */
  function callKey(call) {
    let a;
    try { a = JSON.stringify(call && call.args != null ? call.args : {}); }
    catch (_) { a = ''; }
    return `${(call && call.name) || '?'}|${a}`;
  }

  /** 取消：不抛错，只是安静地结束当前轮并终止后续轮次 */
  function cancel() {
    cancelled = true;
    if (typeof cancelCurrent === 'function') {
      try { cancelCurrent(); } catch (_) { /* 已经结束了 */ }
    }
  }

  /**
   * 问模型一轮。包成 Promise，好让循环用 await 顺序读下去。
   *
   * chatStream 是回调式的，而循环天然是顺序的——不包的话
   * 就得靠一堆全局变量在回调之间传状态，那种代码第三轮就开始出 bug。
   */
  function askOnce() {
    return new Promise((resolve, reject) => {
      let text = '';
      /**
       * 这一轮的推理原文。
       *
       * ⚠ 不只是给界面看的：开了思考又带工具时，assistant 消息必须把它
       *   一起回传，否则 DeepSeek 这类服务第二轮的请求直接 400。
       *   见 provider.reasoningFieldFor。
       */
      let think = '';
      let calls = [];
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      cancelCurrent = chatStream(cfg, history, {
        ...(toolDefs ? { tools: toolDefs } : {}),
        onChunk: (c) => {
          text += c;
          if (handlers.onText) handlers.onText(c);
        },
        onThink: (t) => {
          think += t;
          if (handlers.onThink) handlers.onThink(t);
        },
        onToolCalls: (cs) => { calls = cs || []; },
        onDone: (meta) => done(resolve, { text, think, calls, meta: meta || {} }),
        onError: (e) => done(reject, e),
      });
    });
  }

  /**
   * 问一轮；遇到**空响应**自动重试（2026-10-19）。
   *
   * 现场（两次）：DeepSeek 返回 200，50 多秒后给一个空流。
   *   provider 现在把这种情况判成 `EMPTY_RESPONSE`（原来是静默成功，
   *   用户看到"点了发送什么都没发生"）。
   *
   * ⚠ 重试 **2 次**（合计最多 3 次请求），不是 1 次 ——
   *   第一次现场只重试了一次，第二次仍然空，用户还是用不了。
   *   空响应是服务端侧抖动，多试一次的成本远小于让用户手动重发。
   * ⚠ 退避 800ms / 1600ms：服务端刚空过一次，立刻再打过去大概率还在同一个状态。
   * ⚠ 只重试这一种。401 / 404 / 上下文超限重试一百次也没用，只会让用户多等。
   */
  async function askOnceRetry() {
    const RETRIES = 2;
    let lastErr = null;
    for (let i = 0; i <= RETRIES; i++) {
      try {
        return await askOnce();
      } catch (e) {
        if (cancelled || !e || e.code !== 'EMPTY_RESPONSE') throw e;
        lastErr = e;
        if (i < RETRIES) {
          await new Promise((r) => setTimeout(r, 800 * (i + 1)));
          if (cancelled) throw lastErr;
        }
      }
    }
    throw lastErr;
  }

  /**
   * 执行一批工具调用，逐个串行。
   *
   * @returns {Promise<{results:Array, repeated:number}>}
   *   repeated 是这一批里"因重复而被跳过"的条数，
   *   调用方据此判断整个回合是不是在原地打转。
   */
  async function runCalls(calls) {
    const results = [];
    let repeated = 0;
    for (const call of calls) {
      // ⚠ 用户在等待时点了停止：不再执行任何命令，
      //   但要把结果如实回给模型（"已取消"），否则它会一直等。
      if (cancelled) {
        results.push({ output: '用户取消了这次操作，工具没有执行。' });
        if (handlers.onToolEnd) {
          handlers.onToolEnd(call, { ok: false, output: '已取消' });
        }
        continue;
      }

      // ---- 同一条调用已经跑过 MAX_SAME_CALL 次 → 不再执行 ----
      // 见 MAX_SAME_CALL 的注释：这是"卡壳两分钟一个字没有"的防线。
      const key = callKey(call);
      const times = seenCalls.get(key) || 0;
      if (times >= MAX_SAME_CALL) {
        repeated++;
        const r = {
          ok: false,
          output: `这条「${call.name}」调用你已经执行过 ${times} 次了，`
            + '结果不会因为你再问一次而改变。请直接基于手里已有的信息作答。',
        };
        if (handlers.onToolEnd) handlers.onToolEnd(call, r);
        results.push(r);
        continue;
      }
      seenCalls.set(key, times + 1);

      if (handlers.onToolStart) handlers.onToolStart(call);

      let r;
      try {
        r = await execTool(call.name, call.args, opt.ctx || {});
      } catch (e) {
        // ⚠ 执行器自己抛异常不能让整个循环挂掉：
        //   那等于「模型想查资料 → 崩了 → 用户什么也拿不到」。
        //   把错误当成一条工具结果回给模型，它自己会换策略。
        r = { ok: false, output: `工具执行出错：${e.message}` };
      }
      r = r || { ok: false, output: '工具没有返回结果。' };
      if (handlers.onToolEnd) handlers.onToolEnd(call, r);
      results.push(r);
    }
    return { results, repeated };
  }

  const finished = (async () => {
    let totalText = '';
    let meta = {};
    /**
     * 上一轮的推理原文。
     *
     * ⚠ 只给「到轮数上限」那条**合成**的 tool call 用：它代表的也是
     *   模型的输出，开了思考的服务（DeepSeek）要求 assistant 的
     *   tool_call 消息必须带 reasoning_content，否则整轮 400。
     */
    let lastThink = '';
    try {
      while (true) {
        if (cancelled) {
          if (handlers.onDone) handlers.onDone({ ...meta, stopped: true });
          return;
        }
        if (round >= maxRounds) {
          // ⚠ 到上限了。要**明说**——模型不知道循环有上限，
          //   它以为工具结果是"没查到"，于是自己编一个接着写。
          history = provider.appendToolTurn(engine, history,
            [{ id: 'limit', name: 'loop_limit', args: {} }],
            [{ output: `已达到本轮工具调用上限（${maxRounds} 轮），请基于已有信息直接回答，不要再调用工具。` }],
            { think: lastThink });
          const last = await askOnceRetry();
          totalText += last.text;
          meta = last.meta;
          break;
        }

        round++;
        const r = await askOnceRetry();
        totalText += r.text;
        meta = r.meta;

        // ---- 没有工具调用 = 模型说完了 ----
        if (!r.calls || !r.calls.length) break;
        if (cancelled) break;

        // ---- 有工具调用：执行 → 结果接回历史 → 再问 ----
        const { results, repeated } = await runCalls(r.calls);
        if (cancelled) break;
        // ⚠ 带上这一轮的推理原文：开了思考又带工具时它必须回传，
        //   否则 DeepSeek 这类服务下一轮直接 400。
        history = provider.appendToolTurn(engine, history, r.calls, results, { think: r.think });
        lastThink = r.think;

        /**
         * ⚠ 整个回合**全是**重复调用 → 模型卡在同一个地方了。
         *
         * 再循环下去就是把 MAX_SAME_CALL 后面那几条重复再演一遍，
         * 每轮十几秒，用户一个字都拿不到。这里带上明确原因收尾
         * ——多问最后一轮，是为了让模型把手里的东西说出来。
         * 见 MAX_SAME_CALL 的注释。
         */
        if (repeated === r.calls.length) {
          history = [...history, {
            role: 'user',
            content: '你刚才想调用的工具都已经执行过了，结果就在上面的对话里。'
              + '不要再调用工具，直接基于已有信息回答用户。',
          }];
          const last = await askOnceRetry();
          totalText += last.text;
          meta = last.meta;
          break;
        }

        // ⚠ 上下文会随轮次膨胀（每轮的正文 + 工具结果都在里面）。
        //   这里不裁剪——裁剪规则属于 conv:send 的 LoopContextGuard 职责，
        //   在这里再实现一套就等于有两个地方决定"丢哪条消息"。
      }
    } catch (e) {
      if (handlers.onError) handlers.onError(e);
      return;
    }
    if (handlers.onDone) handlers.onDone({ ...meta, rounds: round, text: totalText });
  })();

  return { cancel, finished };
}

module.exports = { createAgentRun, DEFAULT_MAX_ROUNDS };

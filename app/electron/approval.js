/**
 * 危险命令的审批闸门。
 *
 * ## 为什么单独一个文件
 *
 * 这是「模型能碰你的电脑」的最后一道闸：
 *   主进程决定放行 → 渲染进程弹窗 → 用户点按 → 结果回到主进程。
 *
 * ⚠ 它原来长在 main.js 里，一行都没被测到。而这段的风险是不对称的：
 *   放行逻辑出错 = 危险命令直接跑在你的电脑上（事故）；
 *   拒绝逻辑出错 = 模型卡住，用户以为软件死了（难看）。
 * 所以「**任何异常都必须变成拒绝**」这件事需要能被钉住，
 * 而钉住它的前提是它能被单独调用。
 *
 * ## 三条铁律
 *
 * 1. **默认拒绝**。找不到窗口、渲染进程不回、超时 —— 全部当拒绝。
 *    反过来（默认放行）的话，一次崩溃就等于交出无限制的命令执行权。
 * 2. **一次性**。finish 幂等，且要清掉超时定时器 ——
 *    不清的话 Node 进程会因为一个挂着的 120 秒定时器一直不退出，
 *    而这不是"慢一点"，是软件关不掉。
 * 3. **关窗即全拒**。窗口关了，pending 的审批全部按拒绝收掉，
 *    否则模型要空等到超时才停。
 */

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * @param {object} opt
 * @param {Function} opt.send   (payload) => void  把审批请求发给界面
 * @param {boolean}  [opt.available] 界面是否可用（没窗口就传 false）
 * @param {number}   [opt.timeoutMs]
 * @param {Function} [opt.now]   注入时钟，便于测试
 * @param {Function} [opt.setTimer] / [opt.clearTimer]
 * @param {Function} [opt.onLog]
 */
function createApprovalGate(opt = {}) {
  const timeoutMs = Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const send = typeof opt.send === 'function' ? opt.send : () => {};
  const setTimer = opt.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opt.clearTimer || ((h) => clearTimeout(h));
  const onLog = typeof opt.onLog === 'function' ? opt.onLog : () => {};

  /** id → decide 回调 */
  const pending = new Map();
  let seq = 0;
  /**
   * 界面是否可用。
   *
   * ⚠ 做成可变而不是构造时定死：窗口是后建的（createWindow 之后才有），
   *   而闸门在模块加载时就建好了。写死 available 的话，
   *   要么永远 false（工具全被拒），要么永远 true（关窗后还在问）。
   */
  let available = opt.available !== false;

  function idgen() {
    seq += 1;
    return `ap-${seq}`;
  }

  /**
   * 请求放行。
   * @returns {Promise<boolean>} true = 允许
   */
  function request(info = {}) {
    // ⚠ 铁律 1：没有界面就没有人能批准 → 拒绝
    if (!available) {
      onLog('no-ui', info);
      return Promise.resolve(false);
    }
    const id = idgen();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (allow, why) => {
        // ⚠ 铁律 2：幂等
        if (settled) return;
        settled = true;
        clearTimer(timer);
        pending.delete(id);
        onLog(why, info);
        resolve(allow === true);
      };
      const timer = setTimer(() => finish(false, 'timeout'), timeoutMs);
      pending.set(id, finish);
      try {
        send({
          id,
          command: String(info.command || ''),
          reasons: Array.isArray(info.reasons) ? info.reasons : [],
          outside: !!info.outside,
        });
      } catch (e) {
        // ⚠ 发不出去（窗口正在关）也不能放行
        finish(false, 'send-failed');
      }
    });
  }

  /**
   * 界面回传决定。
   * @returns {boolean} 是否命中了一个待审批
   */
  function decide(id, allow) {
    const fn = pending.get(id);
    if (!fn) return false;
    fn(allow === true, allow === true ? 'allowed' : 'denied');
    return true;
  }

  /** 全部按拒绝收掉（关窗、退出、用户点了停止） */
  function cancelAll() {
    const n = pending.size;
    for (const [, fn] of pending) fn(false, 'cancelled');
    pending.clear();
    return n;
  }

  return {
    request, decide, cancelAll, pending, timeoutMs,
    setAvailable: (v) => { available = !!v; },
    get available() { return available; },
  };
}

module.exports = { createApprovalGate, DEFAULT_TIMEOUT_MS };

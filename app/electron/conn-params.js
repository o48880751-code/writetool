/**
 * 连接级生成参数：上下文窗口 / 单次输出上限 / 输出预留。
 *
 * ## 为什么单独一个模块
 *
 * 这三项的计算里有几条**容易记错的规则**，而它们如果藏在 Electron 主进程里，
 * 就只能靠手点界面去验证 —— 而手点验不出"换个连接会不会串味"这种事。
 * 抽成纯函数是为了能脱离 Electron 单测：
 *
 *   - 输出预留默认按"输出上限的一半"自动算，但**不能超过窗口的一半**，
 *     否则可用前文预算是 0，压缩器每轮都 starved（治理看着在工作，实际失效）；
 *   - 迁移前的老配置没有 connParams，要退回全局 numCtx / maxOutput；
 *   - **按连接隔离** —— 改 A 连接不能动到 B。
 *
 * 做法与项目里 approval.js / project-fs.js 一致：纯函数，不摸 win、不摸 ipcMain。
 *
 * ## 为什么这三项必须按连接存（而不是全局一个值）
 *
 * `numCtx` 在两边的含义不同：
 *   - 本地（Ollama / vLLM）：它是 `num_ctx`，发给服务端按它分配 KV cache，
 *     **真吃显存**。给大了直接 OOM。
 *   - 云端：客户端根本传不了它，唯一用途是告诉**上下文压缩器**
 *     "这个模型的窗口有多大"，好决定什么时候丢历史。
 *
 * 共用一个全局值会坏在两个方向：
 *   云端切回本地 → 200000 被当 num_ctx 发出去，爆显存；
 *   本地切到云端 → 压缩器把 200K 窗口按 8192 用，前文设定被大量丢弃，
 *   表现是"写着写着忘了开头的设定"，而且**不报任何错**。
 */

/** 用户没填过时用这个 */
const DEFAULT_CONN_PARAMS = { numCtx: 8192, maxOutput: 8192 };

/** 取第一个「有限且 > 0」的候选值；全不合法返回 0 */
function pickPositive(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

/**
 * 解析某条连接最终生效的参数。
 *
 * @param {object|null} stored    config.connParams[connId]
 * @param {object} [fallback]     老字段兜底 { numCtx, maxOutput }
 * @returns {{numCtx:number, maxOutput:number, reserve:number,
 *            autoReserve:number, reserveAuto:boolean}}
 */
function resolveConnParams(stored, fallback = {}) {
  const p = (stored && typeof stored === 'object') ? stored : {};
  const f = (fallback && typeof fallback === 'object') ? fallback : {};

  // 没存过就退回老字段（迁移前的老用户），再退回默认值。
  // ⚠ 0 / 负数 / NaN 一律当"没填" —— 界面上清空输入框会给出 0。
  const numCtx = pickPositive(p.numCtx, f.numCtx, DEFAULT_CONN_PARAMS.numCtx);
  const maxOutput = pickPositive(p.maxOutput, f.maxOutput, DEFAULT_CONN_PARAMS.maxOutput);

  /**
   * ⚠ 预留不能超过窗口的一半。
   *
   * 上限 0.5 不是拍脑袋：可用前文 = 窗口 − 预留，若预留 ≥ 窗口，
   * 预算会顶到下限，压缩器每一轮都走到 starved 分支 —— 那比不预留更糟，
   * 因为治理会显示成"在工作"而实际什么都没丢。
   */
  const cap = Math.max(1024, Math.round(numCtx / 2));
  const autoReserve = Math.min(Math.max(1024, Math.round(maxOutput / 2)), cap);

  const given = p.reserve;
  // ⚠ 这里要区分「没设过」和「设成 0」：
  //   没设过 → 用自动值；设成 0 → 用户明确说"我不用预留"，照办。
  const hasReserve = given !== undefined && given !== null && Number.isFinite(Number(given));
  const reserve = hasReserve
    ? Math.max(0, Math.min(Math.round(Number(given)), cap))
    : autoReserve;

  return { numCtx, maxOutput, reserve, autoReserve, reserveAuto: !hasReserve };
}

/**
 * 把 patch 合进 `all[connId]`，返回**新的** all（不改原对象）。
 *
 * @param {object} all     config.connParams 的副本
 * @param {string} connId
 * @param {object} patch   { numCtx?, maxOutput?, reserve? }
 *                         reserve 传 null 表示"恢复自动"
 * @returns {{ok:true, all:object} | {ok:false, error:string}}
 */
function applyConnParams(all, connId, patch = {}) {
  if (!connId) return { ok: false, error: '没有指定连接' };

  const next = { ...(all || {}) };
  const cur = { ...(next[connId] || {}) };

  for (const k of ['numCtx', 'maxOutput', 'reserve']) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null) { delete cur[k]; continue; }   // null = 恢复自动
    const n = Math.round(Number(patch[k]));
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${k} 不是合法数字` };
    }
    cur[k] = n;
  }

  next[connId] = cur;
  return { ok: true, all: next };
}

module.exports = {
  DEFAULT_CONN_PARAMS,
  resolveConnParams,
  applyConnParams,
  pickPositive,
};

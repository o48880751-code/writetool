/**
 * 上下文用量指示器（输入框工具条右侧的小圆环）。
 *
 * ## 它要解决什么
 *
 * 自动压缩一直在后台跑，但**完全不可见**：
 * 用户不知道系统在偷偷丢东西，也不知道"快满了"。
 * 出问题时表现为「模型突然变笨、忘了前面说的」，而没有任何提示。
 *
 * ⚠ 所以这个按钮**不做"手动压缩"** ——
 *   按现在的实现（`LoopContextGuard.ensure()`）它只能丢工具调用噪声，
 *   点了你会以为对话被删了，而那点东西本来也会被自动丢。
 *   真正缺的是**可见性**，不是手动触发。
 *
 * ## 三档显示
 *
 *   < 70%   墨色圆环，悬浮看详情
 *   ≥ 70%   变琥珀色，提示「接近上限，较早的工具记录会被自动丢弃」
 *   = starved 变红，提示「已满且无可丢弃」→ 给出路（新对话 / 少 @ 引用）
 *
 * ⚠ starved 是最要紧的一档：`ensure()` 到无可丢时返回
 *   `starved: true` 却**什么也没丢**（宁可超预算也不破坏配对），
 *   这时候再发请求就是硬超窗、可能被服务商拒绝。
 *
 * ## 样子（2026-10-16 羽毛菌要求"弄成和 WorkBuddy 差不多"）
 *
 *   ① 按钮本身是个**圆环**：灰轨道 + 一段用量的弧，中间不写数字；
 *   ② 悬浮时在**正上方**弹一条深色圆角气泡，小三角指下来，内容是
 *      `36.4% · 364.1K / 1000.0K 上下文已使用`（口径与 WorkBuddy 一致：K、一位小数）；
 *   ③ 单击仍然打开那张**详情卡**（用量/条数/压缩次数/出路）——
 *      气泡只回答"用了多少"，详情卡回答"怎么办"，两件事别挤在一处。
 *
 * ⚠ 气泡是**纯 CSS 显隐**（`group-hover`），不挂 state：
 *   鼠标进出不该触发 React 重渲染 —— 这一行里每次重渲染都牵着输入框。
 *   顺带一个好处：判据不用模拟 hover 就能读到它的文字。
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

/** 预警线：到 70% 就开始变色。⚠ 不是 90% —— 用户看到提示后还得有时间反应。 */
const WARN = 0.70;
const DANGER = 0.90;

/** 圆环半径与周长（viewBox 20x20，半径 8） */
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

/** 气泡底色：WorkBuddy 那种偏冷的深灰蓝。深浅主题下都读得清白字，所以不跟主题走 */
const TIP_BG = '#3d4b5c';

function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 10000) return `${(n / 1000).toFixed(1)}万`;
  return String(Math.round(n));
}

/**
 * 气泡里的口径：K + 一位小数（`364.1K / 1000.0K`）。
 * ⚠ 除以 1000 而不是 1024 —— 按 WorkBuddy 那版的样子来，
 *   而且 token 本来就是十进制单位，用 1024 会算出 341.8K 这种对不上的数。
 */
function fmtK(n) {
  if (n == null) return '—';
  return `${(n / 1000).toFixed(1)}K`;
}

export default function CtxMeter({ pollMs = 4000 }) {
  const [u, setU] = useState(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const popRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await window.api.ctx.status();
      setU(r || null);
    } catch (_) { /* 读不到就保持上一次的值，不打断对话 */ }
  }, []);

  // ⚠ 轮询而不是等消息事件：
  //   压缩发生在**请求发出前**，那时候界面还什么都没发生。
  //   4 秒一次足够及时，又不至于把主进程问烦。
  useEffect(() => {
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  // 点外面关闭
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (boxRef.current && boxRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);

  /**
   * ⚠⚠ **分母用 `numCtx`（用户设置的窗口），不是 `historyBudget`**。
   *
   * historyBudget = numCtx − reserve。他把窗口设成 131072、预留 4096，
   * 于是 historyBudget 是 126976 —— 拿它当分母，他看到的百分比
   * 会和「我明明设了 131072」对不上。
   *
   * 两个都留着：百分比按 numCtx 算，同时把 reserve 显式写出来，
   * 这样"为什么可用空间比窗口小"就一目了然，而不是让人猜。
   */
  const win = u ? (u.numCtx || u.historyBudget || 0) : 0;
  const budget = u ? (u.historyBudget || 0) : 0;
  const used = u ? (u.usedTokens || 0) : 0;
  const pct = win > 0 ? used / win : 0;
  const hasData = !!(u && win > 0);

  let color = 'var(--ink-soft)';
  let hint = '还没有发过消息';
  if (hasData) {
    if (u.starved) {
      color = 'var(--danger)';
      hint = '上下文已满，且没有可丢弃的内容';
    } else if (pct >= DANGER) {
      color = 'var(--danger)';
      hint = '接近上限，较早的工具记录已被自动丢弃';
    } else if (pct >= WARN) {
      color = '#b8791b';
      hint = '接近上限，较早的工具记录会被自动丢弃';
    } else {
      hint = '正常';
    }
  }

  /**
   * ⚠ 弧长有下限：0.5% 也要画出来一小截，
   *   否则"用了一点点"和"完全没有"在界面上长得一模一样。
   *   上限当然不超过 100%（超过就是超窗了，那时候红色主色才是重点）。
   */
  const arc = hasData ? Math.min(1, Math.max(0.02, pct)) : 0;
  const tipText = hasData
    ? `${(pct * 100).toFixed(1)}% · ${fmtK(used)} / ${fmtK(win)} 上下文已使用`
    : '上下文用量 —';

  return (
    <span className="relative shrink-0 group">
      <button
        ref={boxRef}
        // ⚠ 专属标记：判据要能**只**找到这一个按钮。
        //   之前按 `.tabular-nums` 找，结果匹配到了设置按钮（它里面也有这个 class）。
        data-ctx-meter="1"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center rounded-full"
        style={{ width: 26, height: 26, background: 'var(--paper-2)', color }}
        // ⚠ 不用 title：原生 tooltip 会和下面那个自定义气泡**同时**弹出来。
        aria-label={`上下文用量 ${hasData ? `${(pct * 100).toFixed(1)}%` : '暂无数据'}`}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          {/* 轨道 */}
          <circle cx="10" cy="10" r={RING_R} fill="none" stroke="var(--line)" strokeWidth="2.5" />
          {/* 用量弧：从 12 点方向顺时针长出去 */}
          {hasData && (
            <circle
              cx="10" cy="10" r={RING_R} fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - arc)}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
        {/* 没有数据时中间给一个「—」：空轨道容易被当成"环没画出来" */}
        {!hasData && (
          <span className="absolute text-[10px] leading-none" style={{ color: 'var(--ink-soft)' }}>—</span>
        )}
      </button>

      {/**
       * 悬浮气泡（WorkBuddy 那种：深色圆角矩形 + 指下来的小三角）。
       *
       * ⚠ 用 `group-hover` 纯 CSS，不挂 state —— 鼠标进出不该触发重渲染
       *   （这一行每渲染一次都牵着输入框）。详情卡打开时让位（`open ? hidden`）。
       *
       * ⚠⚠ **右对齐，不是居中**。WorkBuddy 那张图里气泡是居中的，但那是因为
       *   它那个圆环左右都有空间；我们这里圆环在工具行**最右边**，
       *   居中的话气泡会伸出输入框卡片 → 被卡片的 `overflow-hidden` 切掉半截
       *   （实测截图里「上下文已使用」直接没了）。
       *   右对齐 + 三角落在按钮正上方，既贴回卡片内，也还是指着按钮。
       */}
      <span
        data-ctx-tip="1"
        className={`absolute bottom-full right-0 mb-2 z-40 pointer-events-none ${open ? 'hidden' : 'hidden group-hover:block'}`}
      >
        <span
          className="block rounded-lg px-2.5 py-1 text-[12px] whitespace-nowrap tabular-nums"
          style={{ background: TIP_BG, color: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.22)' }}
        >
          {tipText}
        </span>
        {/* 小三角：颜色必须和气泡完全一致，否则交界处会有一道缝。
            `mr` 让三角中心对准按钮中心（按钮 26px、三角 10px → 差 8px）。 */}
        <span
          className="block ml-auto mr-2"
          style={{
            width: 0, height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: `5px solid ${TIP_BG}`,
          }}
        />
      </span>

      {open && u && (
        <span
          ref={popRef}
          data-ctx-panel="1"
          className="absolute bottom-full right-0 mb-1.5 z-40 block rounded p-2.5 text-[11px] leading-relaxed"
          style={{
            width: 250,
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 6px 20px rgba(0,0,0,.14)',
            color: 'var(--ink)',
            whiteSpace: 'normal',
          }}
        >
          <div className="font-medium mb-1">上下文用量</div>
          <div className="flex justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span>已用</span>
            <span className="tabular-nums">
              {fmtTokens(used)} / {fmtTokens(win)} token（{(pct * 100).toFixed(1)}%）
            </span>
          </div>
          {u.reserve ? (
            <div className="flex justify-between" style={{ color: 'var(--ink-soft)' }}>
              <span>输出预留</span>
              <span className="tabular-nums">
                {fmtTokens(u.reserve)}（历史可用 {fmtTokens(budget)}）
              </span>
            </div>
          ) : null}
          <div className="flex justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span>消息条数</span>
            <span className="tabular-nums">{u.messages}</span>
          </div>
          <div className="flex items-center justify-between" style={{ color: 'var(--ink-soft)' }}>
            <span>自动压缩</span>
            {u.enabled === false ? (
              <span style={{ color: 'var(--danger)' }}>已关闭</span>
            ) : (
              <span className="tabular-nums">{u.compressions || 0} 次，丢弃 {u.totalDropped || 0} 条</span>
            )}
          </div>

          <div className="mt-1.5 pt-1.5" style={{ borderTop: '1px solid var(--line)', color }}>
            {hint}
          </div>

          {u.starved && (
            <div className="mt-1" style={{ color: 'var(--ink-soft)' }}>
              出路：新建一个对话，或少挂 @文件 / @技能
              （它们是拼进最后一条消息的，压不动）。
            </div>
          )}
          {!u.starved && (
            <div className="mt-1" style={{ color: 'var(--ink-soft)' }}>
              压缩只会丢弃**较早的工具调用记录**，不会删你和助手的对话。
            </div>
          )}
        </span>
      )}
    </span>
  );
}

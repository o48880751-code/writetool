import { useEffect, useState } from 'react';

/**
 * 工具调用卡片 + 危险命令审批弹窗。
 *
 * ## 为什么审批弹窗要独立成文件
 *
 * 它是「模型能碰你的电脑」的最后一道闸，样式与行为都要求特殊：
 *   - 必须**盖住一切**（用户不能以为它还在执行而去干别的）
 *   - 命令原文要**完整可读**（截断了没法判断该不该放行）
 *   - 两个按钮不能有默认焦点（回车一按就误放行）
 *
 * 混在 ChatPanel 里的话，父组件每重渲染一次都可能重置它的状态——
 * 而"重渲染"在流式输出时是**每秒好几次**。
 *
 * ## 卡片为什么不单独开一块 UI
 *
 * 工具调用的信息量只有三行：叫什么、跑了什么、成没成。
 * 给它一个独立面板，用户就得在两个地方来回看。
 * 直接贴在消息流里、跟正文混排，时间顺序天然就是对的：
 * 「先查了文件 → 然后写正文」，这就是真实的对话过程。
 */

const TOOL_META = {
  terminal: { icon: '⌘', label: '终端' },
  web_search: { icon: '🔍', label: '联网搜索' },
  web_fetch: { icon: '📄', label: '读取网页' },
};

/** 模型给了不认识的工具名时不要显示成空白 */
function metaOf(name) {
  return TOOL_META[name] || { icon: '🔧', label: name || '工具' };
}

/**
 * 一张工具调用卡片。
 *
 * ⚠ `status` 四态而不是三态：
 *   running 执行中（会转）
 *   done    完成
 *   failed  失败（结果通常有内容，能解释为什么）
 *   blocked 被拒绝（用户点了不允许，或超时）—— 单独一态，
 *          因为它跟"失败"是两件事：命令没跑，不是跑出错
 */
export function ToolCallCard({ item }) {
  const [open, setOpen] = useState(false);
  const m = metaOf(item.name);
  const running = item.status === 'running';
  const blocked = item.status === 'blocked';
  const failed = item.status === 'failed';

  const color = blocked || failed
    ? 'var(--danger)'
    : running ? 'var(--ink-soft)' : 'var(--ok)';

  const tag = running ? '执行中'
    : blocked ? '已拒绝'
    : failed ? '失败'
    : '完成';

  return (
    <div
      className="text-[11.5px] rounded px-2.5 py-1.5"
      style={{ background: 'var(--paper-2)', border: '1px solid var(--line)' }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left"
        style={{ color: 'var(--ink)' }}
        data-testid={`tool-card-${item.id}`}
      >
        <span style={{ color }}>{running ? '◌' : blocked || failed ? '✕' : '✓'}</span>
        <span>{m.icon}</span>
        <span className="font-medium shrink-0">{m.label}</span>
        <span
          className="flex-1 truncate"
          style={{ color: 'var(--ink-soft)', fontFamily: 'ui-monospace, Consolas, monospace' }}
        >
          {item.brief || '（空）'}
        </span>
        <span className="shrink-0" style={{ color }}>{tag}</span>
        <span style={{ color: 'var(--ink-soft)' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <pre
          className="mt-1.5 p-2 rounded text-[11px] leading-relaxed whitespace-pre-wrap break-all max-h-56 overflow-y-auto"
          style={{
            background: 'var(--paper)',
            color: 'var(--ink-soft)',
            border: '1px solid var(--line)',
          }}
        >
          {item.output || (running ? '正在执行…' : '（没有输出）')}
        </pre>
      )}
    </div>
  );
}

/**
 * 本轮生成里的工具调用列表。
 *
 * ⚠ 空数组时返回 null —— 而不是渲染一个空 div。
 *   空 div 在消息流里占一行，看着像"这里本来该有东西"。
 */
export function ToolCallList({ items }) {
  if (!items?.length) return null;
  return (
    <div className="space-y-1.5" data-testid="tool-call-list">
      {items.map((it) => <ToolCallCard key={it.id} item={it} />)}
    </div>
  );
}

/**
 * 危险命令审批弹窗。
 *
 * ## 交互上的几条硬规定
 *
 * - **不自动聚焦任何一个按钮**。autoFocus 落在「允许」上时，
 *   用户手上正在敲回车（刚发完消息，习惯没改）就会误放行一条
 *   `Remove-Item -Recurse`。
 * - **Esc = 拒绝**，不是取消/忽略。安全方向的默认值只有一个。
 * - **关窗 = 拒绝**。主进程 120 秒后也会兜底拒绝，但那 2 分钟里
 *   用户可能已经以为软件关了。
 * - 命令**完整显示不截断**：判断该不该放行需要看到整条命令。
 *
 * @param onDecide (allow:boolean)=>void
 */
export function ToolApprovalModal({ request, onDecide }) {
  const [key, setKey] = useState(null);

  // 换一条审批时重置「已拒绝」的本地状态：
  // 上一条点过拒绝就把按钮换成"再等一次"的话，新命令会看起来像已经拒过了。
  useEffect(() => {
    setKey(request ? request.id : null);
    void key;
  }, [request?.id]);

  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onDecide(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onDecide]);

  if (!request) return null;

  const decide = (allow) => {
    // ⚠ 连点两次：第一次已经交回主进程，第二次会被主进程判成
    //   "这条审批已经结束了"（无害）。但本地也要立刻收掉弹窗，
    //   否则它会一直挂在屏幕上，用户以为程序卡了。
    onDecide(allow);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.42)' }}
      onClick={() => decide(false)}
      data-testid="tool-approval"
    >
      <div
        className="max-w-2xl w-full rounded-lg p-4 flex flex-col gap-3"
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
        // ⚠ 必须在遮罩上拦住冒泡，否则点弹窗内部空白也会触发"拒绝"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px]">⚠️</span>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            模型要执行一条命令
          </div>
        </div>

        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          这条命令被判定为可能改动你的文件或系统。不允许的话，
          模型会收到「已被拒绝」并继续用别的方式回答。
        </div>

        {request.reasons?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.reasons.map((r, i) => (
              <span
                key={i}
                className="text-[11px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--accent-soft)', color: 'var(--danger)' }}
              >
                {r}
              </span>
            ))}
          </div>
        )}

        {request.outside && (
          <div
            className="text-[11.5px] px-2.5 py-1.5 rounded"
            style={{ background: 'var(--accent-soft)', color: 'var(--danger)' }}
          >
            这条命令提到了项目文件夹<b>以外</b>的路径。
          </div>
        )}

        <pre
          className="p-2.5 rounded text-[12px] leading-relaxed whitespace-pre-wrap break-all max-h-56 overflow-y-auto"
          style={{
            background: 'var(--paper-2)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            fontFamily: 'ui-monospace, Consolas, monospace',
          }}
          data-testid="tool-approval-command"
        >
          {request.command || '（空命令）'}
        </pre>

        <div className="flex gap-2 justify-end">
          <button
            onClick={() => decide(false)}
            className="px-4 py-1.5 rounded text-[12.5px]"
            style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
            data-testid="tool-approval-deny"
          >
            不允许
          </button>
          <button
            onClick={() => decide(true)}
            className="px-4 py-1.5 rounded text-[12.5px]"
            style={{ background: 'var(--danger)', color: '#fff' }}
            data-testid="tool-approval-allow"
          >
            这一次允许
          </button>
        </div>

        <div className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
          只对这一条命令生效，不会记住。以后每次危险命令都会再问一次。
        </div>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';

/**
 * 主工作区（第 2 栏）：多标签主编辑器。
 *
 * ## 为什么标签是「功能模块」而不是「文档」
 *
 * 用户要写长篇时的心智是"我现在在做什么"——在对话、在看章节、
 * 在调文风。不是"我现在打开哪个文件"。所以标签是功能，
 * 而**文件的多开放在第 3 栏**（文档预览自带小标签）。
 *
 * 两处标签的分工：
 *   第 2 栏  功能模块  切换工作内容
 *   第 3 栏  md 文件   切换正在看/改的资料
 *
 * ## 标签内容怎么来
 *
 * 复用既有组件，不重写：对话用 ChatPanel，章节/设定/状态/伏笔/文风
 * 用 FileBox 的对应页签（通过 renderTab 参数注入），
 * 正文用 EditorSurface。
 *
 * 做法上，FileBox 被拆成「标签容器」+「页签内容」两块：
 * 这里只负责容器与切换，内容由 props.renderTab 提供，
 * FileBox 通过 hideTabs 变成纯内容面板。
 */

/** 标签定义。icon 用文字符号，避免引入图标库 */
export const TABS = [
  { key: 'chat', label: '对话', icon: '💬', closable: false },
  { key: 'chapters', label: '章节', icon: '📑', closable: true },
  { key: 'draft', label: '正文编辑', icon: '✍️', closable: true },
  { key: 'bible', label: '设定', icon: '📖', closable: true },
  { key: 'state', label: '状态', icon: '📍', closable: true },
  { key: 'threads', label: '伏笔', icon: '🧵', closable: true },
  { key: 'style', label: '学文风', icon: '🎨', closable: true },
  { key: 'tools', label: '快捷工具', icon: '🧰', closable: true },
];

export default function MainWorkspace({
  openTabs, activeTab, onActivate, onClose,
  renderTab,
  rightSlot,
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const tabs = useMemo(
    () => TABS.filter((t) => openTabs.includes(t.key)),
    [openTabs]
  );

  // 关掉当前标签时落到相邻标签，而不是落到固定的第一个——
  // 用户关掉「学文风」后应该回到他之前在看的那一个。
  const handleClose = (key) => {
    if (key === activeTab) {
      const idx = tabs.findIndex((t) => t.key === key);
      const next = tabs[idx + 1] || tabs[idx - 1];
      onActivate(next ? next.key : 'chat');
    }
    onClose(key);
  };

  if (!tabs.length) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <TabBar
          tabs={tabs}
          activeTab={activeTab}
          onActivate={onActivate}
          onClose={handleClose}
          overflowOpen={overflowOpen}
          setOverflowOpen={setOverflowOpen}
          allTabs={TABS}
          onOpenTab={onActivate}
        />
        <div className="flex-1 flex items-center justify-center min-h-0"
             style={{ background: 'var(--paper)' }}>
          <div className="text-center text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            所有标签都关了
            <br />
            <button
              onClick={() => onActivate('chat')}
              className="mt-2 px-3 py-1 rounded"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              回到对话
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--paper)' }}>
      {/* ⚠⚠ 默认**不显示**页签栏（2026-10-15 羽毛菌：「不需要这个标签，
       *   和对话列表里的对话名文字一样就行」）。
       *
       *   「对话」是中间栏的**首页**——打开软件就在这儿，
       *   而左边栏已经是一排对话卡片了，再顶一个「💬 对话」纯属重复。
       *
       *   只有切到别的页签（文件 / 编辑器 / …）才显示这一栏，
       *   否则用户会失去"我在哪个页签、能关掉它"的感知。
       */}
      {(tabs.length > 1 || activeTab !== 'chat') && (
        <TabBar
          tabs={tabs}
          activeTab={activeTab}
          onActivate={onActivate}
          onClose={handleClose}
          overflowOpen={overflowOpen}
          setOverflowOpen={setOverflowOpen}
          allTabs={TABS}
          onOpenTab={onActivate}
        />
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 flex flex-col">
          {renderTab(activeTab)}
        </div>
        {rightSlot}
      </div>
    </div>
  );
}

function TabBar({
  tabs, activeTab, onActivate, onClose,
  overflowOpen, setOverflowOpen, allTabs, onOpenTab,
}) {
  return (
    <div
      className="shrink-0 flex items-center relative border-b"
      style={{ borderColor: 'var(--line)', background: 'var(--paper-2)' }}
    >
      <div className="flex-1 flex items-center overflow-x-auto min-w-0">
        {tabs.map((t) => {
          const on = t.key === activeTab;
          return (
            <div
              key={t.key}
              onClick={() => onActivate(t.key)}
              className="flex items-center gap-1 px-3 py-2 text-[12px] whitespace-nowrap cursor-pointer shrink-0"
              style={{
                color: on ? 'var(--ink)' : 'var(--ink-soft)',
                background: on ? 'var(--paper)' : 'transparent',
                fontWeight: on ? 600 : 400,
                borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
              }}
              title={t.label}
            >
              <span className="text-[12px]">{t.icon}</span>
              <span>{t.label}</span>
              {t.closable && (
                <span
                  onClick={(e) => { e.stopPropagation(); handleCloseClick(e, t.key, onClose); }}
                  className="ml-0.5 px-0.5 rounded text-[11px] opacity-50 hover:opacity-100"
                  style={{ fontSize: 12 }}
                  title="关闭"
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 打开标签的菜单 */}
      <div className="shrink-0 relative">
        <button
          onClick={() => setOverflowOpen(!overflowOpen)}
          className="px-2.5 py-2 text-[13px]"
          style={{ color: 'var(--ink-soft)' }}
          title="打开其他标签"
        >
          +
        </button>
        {overflowOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOverflowOpen(false)} />
            <div
              className="absolute right-2 top-full z-50 mt-0.5 rounded shadow-lg py-1 text-[12px] w-36"
              style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
            >
              {allTabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => { onOpenTab(t.key); setOverflowOpen(false); }}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-1.5 hover:bg-[var(--accent-soft)]"
                  style={{ color: 'var(--ink)' }}
                >
                  <span>{t.icon}</span>
                  <span className="flex-1">{t.label}</span>
                  {tabs.some((x) => x.key === t.key) && (
                    <span style={{ color: 'var(--accent)' }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function handleCloseClick(e, key, onClose) {
  e.stopPropagation();
  onClose(key);
}
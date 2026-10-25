import { useEffect, useRef, useState } from 'react';

/**
 * 对话列表（左栏）。
 *
 * 交互上刻意做成「像聊天软件」而不是「像文件树」：
 *   - 当前对话高亮
 *   - 悬停才显示重命名 / 删除，避免列表被按钮填满
 *   - 标题取首条用户消息的前若干字，不是「新对话 1 / 新对话 2」
 */
export default function ConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  /**
   * 打开设置。
   *
   * ⚠ 这个入口**必须住在第 1 栏内部**，不能做成横跨整个窗口宽度的底栏。
   *   第一版做成了全宽底栏（36px），结果第 2/3/4 栏全被压掉一条——
   *   而正文、文档预览、文件树恰恰是用户盯着看的东西，
   *   为了一个设置入口让三栏都变小，方向就错了。
   *
   *   现在它是本栏的固定底座（shrink-0），上方列表 flex-1 自适应，
   *   另外三栏保持完整高度、贯穿到窗口底部。
   */
  onOpenSettings,
  /** 版本号，显示在设置入口右侧 */
  versionInfo = '',
  /**
   * 状态文字（错误、初始化失败、对话数）。
   *
   * 原来这些在一条横跨全宽的底栏里。现在底栏取消了，
   * 它们跟着设置入口一起待在第 1 栏——
   * 这些都是"出事了才看"的信息，不该占正文的空间。
   */
  statusLine = null,
  /**
   * 有没有小说项目。
   *
   * ⚠ 零项目时上面的按钮从「＋ 新对话」变成「＋ 新建项目」。
   *
   *   原因：对话挂在项目下（conversations.project_id 是外键），
   *   没有项目就**建不出对话**。而"零项目"是首次使用的正常状态，
   *   不是异常——原来这种情况下按钮点了什么都不发生（App 那边静默 return），
   *   用户只能以为软件坏了。
   *
   *   现在把那个死按钮换成他此刻唯一能做的、也是真正想做的事：
   *   建一个项目。点下去直接落在建项目的输入框上。
   */
  hasProject = true,
  onNewProject,
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { if (editingId) inputRef.current?.select(); }, [editingId]);

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditText(c.title);
    setCreating(false);
  };

  const commit = () => {
    const t = editText.trim();
    if (editingId && t) onRename(editingId, t);
    setEditingId(null);
  };

  const relTime = (ts) => {
    if (!ts) return '';
    // SQLite 的 datetime('now','localtime') 是 'YYYY-MM-DD HH:MM:SS'
    const t = new Date(String(ts).replace(' ', 'T'));
    if (Number.isNaN(t.getTime())) return '';
    const diff = Date.now() - t.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return t.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };

  return (
    <aside className="flex flex-col h-full"
           style={{ background: 'var(--paper)' }}>
      {/* ⚠ 这里**不能**再写 borderRight。
          它和 SplitPanes 的分隔条紧挨着，两条 1px 叠在同一个像素列上 ——
          用户看到的是"一条 2px 的线"，还以为是分隔条没改细。
          （2026-10-16 羽毛菌：「这条分隔线也要 1px」）。 */}
      {/* ---------- 标题行：对话列表 + 一个小 ＋ ----------
       *
       * ⚠ 2026-10-16 羽毛菌：「这个新对话功能改成小按钮一个＋号，左边是对话列表四个字」。
       *   原来是**一个通栏的「＋ 新对话」大按钮**（占掉整整一行）。
       *   改成标题行之后：
       *     · 这一行同时回答"这一栏是什么"（对话列表）和"能干什么"（＋）；
       *     · 省下一行高度给列表本身；
       *     · 和右边几栏的标题行（目录 / 备注…）**视觉对齐** —— 四栏顶部
       *       第一行都是"图标 + 名字"，扫一眼就知道哪栏是哪栏。
       *
       * ⚠ 零项目时那个 ＋ 仍然要变成"先建项目"（createConversation 里
       *   `if (!projectId) return` 会静默什么都不做），`data-testid` 也留着 ——
       *   `test-first-run` 靠它找入口。
       */}
      <div className="shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
        {/**
         * ⚠⚠ 高度**写死** h-8（2026-10-16 20:04 羽毛菌：「对话列表那几个字上下两边都有分隔线，
         * 快捷工具那一栏上下两边也有分隔线，他们上边那一条是连着的同一个水平，
         * 而下面那一条有高低差，我想把下面那一条也连起来到同一水平」）。
         *
         * ⚠ 原来靠内容撑高：这里是 15px 的 SVG，右边快捷工具栏是 12px 文字行，
         *   目录栏又是 pt-2/pb-1.5 —— **三个高度**，于是三条分隔线三个 y。
         * ⚠⚠ 不写死高度就永远对不齐，而且差值只有几 px，肉眼一看就是"歪的"。
         *   高度统一后，flex items-center 保证内容仍然垂直居中。
         */}
        <div className="flex items-center gap-1.5 px-2.5 h-8" data-testid="rail-head-conv">
          <span className="shrink-0 flex items-center" style={{ color: 'var(--ink-soft)' }}>
            {/* 15px 线性对话框图标（内联 SVG：不引图标库，也和其余几栏的图标风格一致） */}
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7z"
                stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-[12.5px] font-semibold flex-1 min-w-0 truncate"
                style={{ color: 'var(--ink)' }}>
            对话列表
          </span>
          <button
            onClick={() => {
              if (!hasProject) { onNewProject(); return; }   // 零项目：先建项目，否则静默失败
              setCreating(true); setEditingId(null); setEditText('');
            }}
            {...(hasProject ? { 'data-testid': 'btn-new-conv' } : { 'data-testid': 'btn-first-project' })}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[16px] leading-none"
            style={{ color: 'var(--accent)' }}
            title={hasProject ? '新建对话' : '对话要挂在小说项目下，先建一个项目'}
          >
            {/* ⚠ 两个 testid 二选一（**属性位置上不能写花括号注释**，只能放子节点里，
                否则 `Expected '...' but found '}'`，构建直接失败）：
                · 零项目 → `btn-first-project`（test-first-run 靠它找入口）
                · 有项目 → `btn-new-conv`（test-rail-ui 靠它点这个 ＋）
                用 SVG 而不是全角「＋」：全角加号在不同字体下大小/位置会飘。 */}
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {creating && (
          <div className="flex gap-1.5 px-2 pb-2">
            <input
              ref={inputRef}
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const t = editText.trim();
                  if (t) onCreate(t);
                  setCreating(false);
                  setEditText('');
                }
                if (e.key === 'Escape') { setCreating(false); setEditText(''); }
              }}
              placeholder="对话名称"
              className="flex-1 px-2 py-1 rounded text-[12.5px] outline-none min-w-0"
              style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
            />
            <button
              onClick={() => {
                const t = editText.trim();
                if (t) onCreate(t);
                setCreating(false);
                setEditText('');
              }}
              className="px-2.5 py-1 rounded text-[12px] shrink-0"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              建
            </button>
          </div>
        )}
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {!conversations?.length && (
          <div className="px-4 py-8 text-[12px] text-center leading-relaxed"
               style={{ color: 'var(--ink-soft)' }}>
            {hasProject
              ? <>还没有对话。<br />点「对话列表」右边的 ＋ 开始。</>
              : <>还没有小说项目。<br />
                  对话要挂在项目下，<br />先点右边的 ＋ 建一个项目。</>}
          </div>
        )}
        {conversations?.map((c) => {
          const active = c.id === activeId;
          return (
            <div
              key={c.id}
              className="group relative px-2 py-1.5 mx-1 rounded"
              style={{ background: active ? 'var(--accent-soft)' : 'transparent' }}
            >
              {editingId === c.id ? (
                <input
                  ref={inputRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={commit}
                  className="w-full px-1.5 py-0.5 rounded text-[12.5px] outline-none"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                />
              ) : (
                <button
                  onClick={() => onSelect(c.id)}
                  className="w-full text-left"
                >
                  <div className="text-[12.5px] truncate pr-12"
                       style={{ color: 'var(--ink)', fontWeight: active ? 600 : 400 }}>
                    {c.title}
                  </div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
                    {relTime(c.updated_at)}
                  </div>
                </button>
              )}

              {/* 悬停才出现的操作，避免列表被图标填满 */}
              {editingId !== c.id && (
                <div className="absolute right-1.5 top-1.5 hidden group-hover:flex gap-0.5">
                  <IconBtn title="重命名" onClick={() => startEdit(c)}>✎</IconBtn>
                  <IconBtn title="删除" onClick={() => {
                    if (window.confirm(`删除对话「${c.title}」？\n其中的 ${c.messageCount || 0} 条消息也会一并删除。`)) {
                      onDelete(c.id);
                    }
                  }}>×</IconBtn>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---------- 底座：设置入口 ----------
       *
       * ⚠ 2026-10-16 羽毛菌：「设置上边的分割线也去掉，把设置弄成一个带 R 角的矩形按钮，
       *   位置不变」。
       *   原来这一块是 `--paper-2` 的通栏底 + 顶上一条 `borderTop` 分隔线，
       *   按钮自己**没有底色**（只有 hover 才变）——所以用户看到的是
       *   "一行文字顶着一条线"，认不出那是个按钮。
       *   现在反过来：底座不刷色、不留线，**按钮自己**才是那个圆角矩形。
       */}
      <div className="shrink-0 px-1.5 py-1.5">
        {/* 状态文字在设置入口上方。只在有内容时才占位——
            空的时候不渲染，避免每次都多出一条空行。*/}
        {statusLine && (
          <div
            className="px-2 pb-1.5 text-[10.5px] leading-snug"
            style={{ color: statusLine.danger ? 'var(--danger)' : 'var(--ink-soft)' }}
            title={statusLine.text}
          >
            {statusLine.text}
          </div>
        )}
        <button
          onClick={onOpenSettings}
          data-testid="btn-settings"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
          style={{
            background: 'var(--paper-2)',
            border: '1px solid var(--line)',
            color: 'var(--ink)',
          }}
          title="打开设置（AI 提供商、思考强度、主题、数据）"
        >
          {/* 图标 15px 与文字 12.5px 配比协调；比正文大一号，
              这样它才像"入口"而不是"一行说明文字" */}
          <span className="text-[15px] leading-none shrink-0">⚙</span>
          <span className="text-[12.5px] flex-1 text-left">设置</span>
          {versionInfo && (
            <span className="text-[10px] opacity-50 tabular-nums shrink-0">{versionInfo}</span>
          )}
        </button>
      </div>
    </aside>
  );
}

function IconBtn({ children, title, onClick }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-5 h-5 rounded text-[11px] leading-none"
      style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
    >
      {children}
    </button>
  );
}
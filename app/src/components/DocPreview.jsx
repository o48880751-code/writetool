import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DocToolbar from './DocToolbar.jsx';

/**
 * 第 3 栏：文档预览。
 *
 * ## 为什么「渲染节点」而不是「HTML 字符串」
 *
 * 渲染器（electron/markdown-render.js）输出的是节点树，
 * 这里用 React 组件把节点树画出来，**全程不用 dangerouslySetInnerHTML**。
 * 资料文件里可能粘过网页片段（比如从公众号复制的一段带
 * `<script onerror=...>` 的文本），用 innerHTML 就是把它变成可执行代码；
 * React 会对所有文本节点做转义，结构上不可能注入。
 *
 * ## 编辑模式的取舍
 *
 * 只给「纯文本编辑」。理由：
 *   - 用户要改的是内容，不是排版。改排版去改源文件更直接。
 *   - 真正的富文本编辑要处理光标、选区与受控组件的竞争，
 *     很容易做成"每敲一个字光标跳到开头"。
 * 代价是编辑时看不到渲染效果 → 所以编辑区**下方同时显示预览**。
 */

const HEADING_SIZE = { 1: 20, 2: 17, 3: 15, 4: 14, 5: 13, 6: 12 };

/** 把节点树的某个子节点画出来 */
function RenderNode({ n }) {
  switch (n.t) {
    case 'text':
      return <span>{n.text}</span>;

    case 'br':
      return <br />;

    case 'strong':
      return <strong>{n.text}</strong>;

    case 'em':
      return <em style={{ fontStyle: 'italic' }}>{n.text}</em>;

    case 'del':
      return (
        <del style={{ color: 'var(--ink-soft)' }}>
          {n.text}
        </del>
      );

    case 'code':
      return (
        <code
          style={{
            background: 'var(--accent-soft)',
            padding: '1px 4px',
            borderRadius: 3,
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, Consolas, monospace',
          }}
        >
          {n.text}
        </code>
      );

    case 'h': {
      const size = HEADING_SIZE[n.level] || 13;
      return (
        <div
          style={{
            fontSize: size,
            fontWeight: 700,
            marginTop: n.level <= 2 ? 14 : 10,
            marginBottom: 6,
            paddingBottom: n.level <= 2 ? 4 : 0,
            borderBottom: n.level <= 2 ? '1px solid var(--line)' : undefined,
            lineHeight: 1.35,
          }}
        >
          {n.children.map((c, i) => <RenderNode key={i} n={c} />)}
        </div>
      );
    }

    case 'p':
      return (
        <p style={{ margin: '0 0 8px', lineHeight: 1.85 }}>
          {n.children.map((c, i) => <RenderNode key={i} n={c} />)}
        </p>
      );

    case 'hr':
      return <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '12px 0' }} />;

    case 'code':
      return null;   // 见下方：围栏代码块单独处理（名字冲突，改用 blockCode）

    case 'ul':
    case 'ol':
      return (
        <ListBlock n={n} />
      );

    case 'table':
      return <TableBlock n={n} />;

    case 'quote':
      return (
        <div
          style={{
            borderLeft: '3px solid var(--accent)',
            paddingLeft: 10,
            margin: '0 0 10px',
            color: 'var(--ink-soft)',
          }}
        >
          {n.children.map((c, i) => <RenderNode key={i} n={c} />)}
        </div>
      );

    default:
      // 未知类型降级成文本。渲染器可能先加新类型而 UI 没跟上，
      // 此时显示原始文本比空白好——用户能看出"这里有内容但没渲染"。
      return (
        <span style={{ color: 'var(--danger)' }}>
          [未支持：{n.t}] {n.text || n.lang || ''}
        </span>
      );
  }
}

/**
 * 列表。
 *
 * ⚠ 必须显式写 listStyle —— Tailwind 的 preflight 会全局重置
 *   `ol, ul { list-style: none; margin: 0; padding: 0 }`。
 *   不写的话 Markdown 的 `- 项目` 会渲染成**没有 bullet 的缩进段落**，
 *   看起来像普通文字：内容都在，但"这是列表"这个信息完全丢了。
 *
 * 另外给 li 加 listStylePosition:'inside'，让长条目折行时
 * 第二行从左边开始而不是缩进对齐 bullet——中文长句里后者更易读。
 */
function ListBlock({ n }) {
  const ordered = n.t === 'ol';
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      style={{
        listStyle: ordered ? 'decimal' : 'disc',
        margin: '0 0 8px',
        paddingLeft: 22,
        lineHeight: 1.85,
      }}
    >
      {n.items.map((it, i) => (
        <li key={i} style={{ marginBottom: 2, listStylePosition: 'inside' }}>
          {it.children.map((c, ci) => <RenderNode key={ci} n={c} />)}
        </li>
      ))}
    </Tag>
  );
}

/** 表格。列宽按表头列数均分，内容不撑破容器 */
function TableBlock({ n }) {
  const align = (a) => (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left');
  return (
    <div style={{ overflowX: 'auto', margin: '0 0 12px' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          fontSize: 12.5,
          tableLayout: n.widths > 4 ? 'fixed' : 'auto',
        }}
      >
        <thead>
          <tr>
            {n.header.map((h, i) => (
              <th
                key={i}
                style={{
                  border: '1px solid var(--line)',
                  background: 'var(--accent-soft)',
                  padding: '5px 7px',
                  textAlign: align(h.align),
                  fontWeight: 600,
                }}
              >
                {h.children.map((c, ci) => <RenderNode key={ci} n={c} />)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {n.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td
                  key={ci}
                  style={{ border: '1px solid var(--line)', padding: '5px 7px', verticalAlign: 'top' }}
                >
                  {c.children.map((x, xi) => <RenderNode key={xi} n={x} />)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 围栏代码块单独抽出来：代码块节点的 t 是 'code'，与行内 code 同名冲突 */
function CodeBlock({ n }) {
  return (
    <pre
      style={{
        background: 'var(--paper-2)',
        border: '1px solid var(--line)',
        borderRadius: 5,
        padding: '8px 10px',
        margin: '0 0 10px',
        overflowX: 'auto',
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: 'ui-monospace, Consolas, monospace',
      }}
    >
      {n.lang && (
        <div style={{ fontSize: 10, color: 'var(--ink-soft)', marginBottom: 4 }}>{n.lang}</div>
      )}
      <code>{n.text}</code>
    </pre>
  );
}

/** 渲染器输出的 t='code' 是块级（围栏/缩进），行内 code 在 inline() 里另有标记 */
function DocBody({ blocks, fontSize = 16 }) {
  return (
    // 字号只在这里设一次，内部一律继承
    // ⚠ 原来段落与列表各自写死 13.5，且组件根本没接字号 prop ——
    //   于是「编辑器字号」滑块在**预览页**完全不生效，而用户默认就停在预览页。
    <div style={{ fontSize: `${fontSize}px`, lineHeight: 1.85 }}>
      {blocks.map((n, i) =>
        n.t === 'code' ? <CodeBlock key={i} n={n} /> : <RenderNode key={i} n={n} />
      )}
    </div>
  );
}

export default function DocPreview({
  files = [],          // [{path, name}]
  activePath,
  doc,                 // {content, size, mtime} | null
  loading, error,
  onSelect,
  onSave,
  onClose,
  /**
   * 正文字号（2026-10-15 接上）。
   *
   * ⚠⚠ 这个 prop **漏过一次**，后果是整个预览页**崩溃**：
   *   下面两处已经写成 `<DocBody ... fontSize={fontSize} />`，
   *   而这一行没补上 → `ReferenceError: fontSize is not defined`
   *   → 整棵 React 树炸掉，点任何文件都是白屏报错。
   *
   * ⚠ 教训：改「给 A 传参」时，**接收侧的解构必须同时改** ——
   *   只改一半就是运行时崩溃，而且 `node --check` 与单测都抓不到
   *   （它们不跑 React，只验语法）。
   */
  fontSize = 16,
  /** 书名（项目名）—— 显示在书名栏上 */
  bookTitle = '',
  /**
   * 项目 id，给"历史版本"用（2026-10-18）。
   *
   * ⚠ 加 prop 时**接收侧的解构必须同时改** —— 上面 fontSize 那段注释
   *   就是漏了这一步导致整页白屏的现场记录。
   */
  projectId,
  /** 从备份恢复之后重读文件（App 那边传 openPreview） */
  onRestored,
}) {

  const [mode, setMode] = useState('view');   // view | edit
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  /**
   * 历史版本（2026-10-18）。
   *
   * 羽毛菌：「ai助手修改的文件不支持回退」。
   * 备份其实一直在写（覆盖前留 .bak，最多 3 份），但**界面上一个入口都没有** ——
   * 存了看不见，等于没存。
   *
   * `history === null` 表示面板没打开（不是"没有历史"），
   * 这样才能区分"还没查"和"查过了确实没有"。
   */
  const [history, setHistory] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const taRef = useRef(null);
  const scrollRef = useRef(null);

  // 切换文件时回到预览态。理由：上一份文件的编辑草稿不该
  // 突然显示在另一份文件上，那会让人以为内容被改了。
  useEffect(() => {
    setMode('view');
    setDraft('');
    setSavedAt(null);
    // ⚠ 历史面板必须跟着清：不清的话切到另一个文件时，
    //   上面还挂着上一份文件的时间戳，点"恢复"就恢复错了对象。
    setHistory(null);
    setRestoreMsg('');
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activePath]);

  // Ctrl+S 保存。不绑的话用户不知道有快捷键，也就没有保存习惯。
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (mode === 'edit') doSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const doSave = useCallback(async () => {
    if (!activePath) return;
    setSaving(true);
    try {
      await onSave(activePath, draft);
      setSavedAt(Date.now());
      setMode('view');
    } catch (e) {
      /**
       * ⚠ 这里原来写的是 `setError?.(...)`，而这个组件**没有 setError**
       *   （只有 error 这个 prop）。它不是 optional chaining 能救的情况：
       *   `setError` 是未声明的标识符 → ReferenceError → 保存失败时
       *   整个预览页炸掉，而且因为发生在 async 回调里，
       *   表现出来只是"点了保存没反应"。
       *   改走下面那个共享的提示位。
       */
      setRestoreMsg(`保存失败：${e.message || String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [activePath, draft, onSave, error]);

  // ---- 历史版本（2026-10-18）----

  /** 打开/收起历史面板。每次打开都重新查，不缓存：刚被 AI 改完就该看到最新那份 */
  const toggleHistory = async () => {
    if (history !== null) { setHistory(null); return; }
    if (!projectId || !activePath) return;
    setHistoryBusy(true);
    setRestoreMsg('');
    try {
      const r = await window.api.fs.history({ projectId, path: activePath });
      setHistory(Array.isArray(r?.items) ? r.items : []);
    } catch (e) {
      setHistory([]);
      setRestoreMsg(`读历史失败：${e.message || String(e)}`);
    } finally { setHistoryBusy(false); }
  };

  const doRestore = async (item) => {
    if (!projectId || !activePath || !item) return;
    setHistoryBusy(true);
    setRestoreMsg('');
    try {
      const r = await window.api.fs.restore({ projectId, path: activePath, backup: item.name });
      setHistory(null);
      setRestoreMsg(`已恢复（${r?.chars || 0} 字）· 恢复前的版本也留了备份，反悔还能退回来`);
      // 重读文件：恢复只改了磁盘，界面上还是旧内容
      await onRestored?.(activePath);
    } catch (e) {
      setRestoreMsg(`恢复失败：${e.message || String(e)}`);
    } finally { setHistoryBusy(false); }
  };

  /**
   * `20261018-125530-123` → `10-18 12:55:30`
   *
   * ⚠ 毫秒段是 2026-10-18 加的（同一秒内两次备份会互相覆盖）。
   *   正则要能同时吃"带毫秒"和"带冲突序号"两种：
   *   `…-123` 与 `…-123-2`。
   */
  const fmtStamp = (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d{3})?(?:-\d+)?$/.exec(String(s || ''));
    return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(s || '');
  };

  const dirty = mode === 'edit' && draft !== (doc?.content || '');

  // 统计由主进程给（渲染进程不该跑渲染器；渲染器在 electron/ 下，
  // 而打包后渲染进程在 asar 里，跨目录 require 靠别名会打进 bundle）
  const stat = doc?.stat;

  if (!files.length && !doc) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-0" style={{ background: 'var(--paper)' }}>
        <div className="text-center text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          点最右侧的文件树选一个 md
          <br />
          <span className="text-[11px]">这里会显示渲染后的内容，可切换成简易编辑</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--paper)' }}>
      {/* ---------- 书名栏 + 编辑功能 ----------
       * 2026-10-15 羽毛菌要的：书名栏、查找跳转、替换标点、一键排版、复制全文。
       * ⚠ 批量改动都写在 draft 上，**不直接存盘** —— 用户能点保存也能丢掉。
       *   只有编辑态才有 draft，预览态则直接给 onSave 一个 no-op 之外的路径：
       *   这几个按钮在预览态也该能用，所以它们操作的是「当前显示的内容」，
       *   改完自动切到编辑态，用户能看到改动、能保存。
       */}
      <DocToolbar
        bookTitle={bookTitle}
        text={mode === 'edit' ? draft : (doc && doc.content) || ''}
        onChange={(t) => {
          // ⚠ 预览态下改内容 = 先切到编辑态，否则 draft 会被下一次的切换覆盖
          if (mode !== 'edit') { setMode('edit'); setDraft(t); }
          else setDraft(t);
        }}
        canSave={mode === 'edit'}
      />

      {/* 文件小标签：多文档同时打开 */}
      {files.length > 0 && (
        <div
          className="shrink-0 flex items-center gap-0.5 px-1.5 pt-1.5 border-b overflow-x-auto"
          style={{ borderColor: 'var(--line)' }}
        >
          {files.map((f) => {
            const on = f.path === activePath;
            return (
              <div
                key={f.path}
                className="flex items-center gap-1 px-2 py-1 rounded-t cursor-pointer shrink-0 text-[12px]"
                style={{
                  background: on ? 'var(--paper)' : 'var(--paper-2)',
                  border: `1px solid var(--line)`,
                  borderBottom: on ? 'none' : undefined,
                  color: on ? 'var(--ink)' : 'var(--ink-soft)',
                }}
                onClick={() => onSelect(f.path)}
                title={f.path}
              >
                <span className="truncate max-w-[120px]">{f.name}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); onClose(f.path); }}
                  className="px-0.5 rounded hover:bg-[var(--accent-soft)]"
                  style={{ fontSize: 11 }}
                  title="关闭"
                >
                  ×
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 工具条 */}
      {activePath && (
        <div
          className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="text-[11px] truncate flex-1" style={{ color: 'var(--ink-soft)' }} title={activePath}>
            {activePath}
          </span>
          {stat && (
            <span className="text-[10px] shrink-0" style={{ color: 'var(--ink-soft)' }}>
              {stat.chars} 字 · {stat.lines} 行
            </span>
          )}
          <div className="flex gap-1 shrink-0">
            <button
              onClick={toggleHistory}
              disabled={historyBusy || !projectId}
              className="text-[11px] px-2 py-0.5 rounded disabled:opacity-40"
              style={{
                background: history !== null ? 'var(--accent)' : 'var(--paper-2)',
                color: history !== null ? 'var(--accent-ink)' : 'var(--ink)',
              }}
              title="AI 改过的文件可以从这里退回去"
            >
              历史
            </button>
            <button
              onClick={() => {
                setMode('view');
                setDraft('');
              }}
              className="text-[11px] px-2 py-0.5 rounded"
              style={{
                background: mode === 'view' ? 'var(--accent)' : 'var(--paper-2)',
                color: mode === 'view' ? 'var(--accent-ink)' : 'var(--ink)',
              }}
            >
              预览
            </button>
            <button
              onClick={() => { setDraft(doc?.content || ''); setMode('edit'); }}
              className="text-[11px] px-2 py-0.5 rounded"
              style={{
                background: mode === 'edit' ? 'var(--accent)' : 'var(--paper-2)',
                color: mode === 'edit' ? 'var(--accent-ink)' : 'var(--ink)',
              }}
            >
              编辑
            </button>
            {mode === 'edit' && (
              <button
                onClick={doSave}
                disabled={saving}
                className="text-[11px] px-2 py-0.5 rounded disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                title="Ctrl+S"
              >
                {saving ? '…' : '保存'}
              </button>
            )}
          </div>
        </div>
      )}

      {/*
        历史版本面板（2026-10-18）。
        ⚠ 这三行状态都在切换文件时清空（见上面的 useEffect）——
          不清的话，切到 A 文件还挂着 B 文件的时间戳，点"恢复"就恢复错了对象。
      */}
      {history !== null && (
        <div
          className="shrink-0 px-3 py-2 border-t max-h-[160px] overflow-y-auto"
          style={{ background: 'var(--paper-2)', borderColor: 'var(--line)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              历史版本 · 每次被覆盖前自动留一份，最多留 3 份
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setHistory(null)}
              className="text-[11px] px-1 rounded"
              style={{ color: 'var(--ink-soft)' }}
            >
              收起
            </button>
          </div>
          {!history.length ? (
            <div className="text-[11px] py-1" style={{ color: 'var(--ink-soft)' }}>
              还没有历史版本 —— 这个文件没被覆盖过，或者已经超过 3 次了。
            </div>
          ) : history.map((h) => (
            <div key={h.name} className="flex items-center gap-2 py-0.5">
              <span className="text-[11px]" style={{ color: 'var(--ink)' }}>{fmtStamp(h.stamp)}</span>
              <span className="text-[10px]" style={{ color: 'var(--ink-soft)' }}>
                {Math.max(1, Math.round((h.size || 0) / 102.4)) / 10} KB
              </span>
              <div className="flex-1" />
              <button
                onClick={() => doRestore(h)}
                disabled={historyBusy}
                className="text-[11px] px-2 py-0.5 rounded disabled:opacity-40"
                style={{ background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)' }}
              >
                恢复这一版
              </button>
            </div>
          ))}
        </div>
      )}

      {restoreMsg && (
        <div className="shrink-0 px-3 pb-1 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
          {restoreMsg}
        </div>
      )}

      {/* 内容 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {error ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--danger)' }}>{error}</div>
        ) : loading ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--ink-soft)' }}>载入中…</div>
        ) : !doc ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--ink-soft)' }}>没有选中的文件</div>
        ) : mode === 'edit' ? (
          <div className="flex flex-col h-full">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 w-full p-3 outline-none resize-none text-[13px] leading-[1.9]"
              style={{
                background: 'var(--paper)',
                color: 'var(--ink)',
                fontFamily: 'ui-monospace, Consolas, monospace',
              }}
            />
            {dirty && (
              <div
                className="shrink-0 px-3 py-1 text-[11px] border-t"
                style={{ background: 'var(--paper-2)', borderColor: 'var(--line)', color: 'var(--ink-soft)' }}
              >
                有未保存改动 · Ctrl+S 保存
              </div>
            )}
            {/* 编辑时也显示渲染效果——纯文本看不到排版对不对 */}
            <div
              className="shrink-0 border-t overflow-y-auto"
              style={{ borderColor: 'var(--line)', maxHeight: '40%', background: 'var(--paper)' }}
            >
              <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--ink-soft)' }}>实时预览</div>
              <div className="px-3 pb-3 md-body">
                <DocBody blocks={doc.blocks || []} fontSize={fontSize} />
              </div>
            </div>
          </div>
        ) : (
          <div className="px-3 py-2 md-body">
            {savedAt && (
              <div className="text-[11px] mb-2" style={{ color: 'var(--ok)' }}>已保存</div>
            )}
            <DocBody blocks={doc.blocks || []} fontSize={fontSize} />
          </div>
        )}
      </div>
    </div>
  );
}
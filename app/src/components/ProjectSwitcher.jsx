import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 切换小说项目（弹窗）。
 *
 * ## 为什么顶栏那个 select 被删了
 *
 * 原先顶栏是「项目 select + ＋ 新建项目」两个控件。现在第 4 栏
 * 第二行也显示项目名、也能切换，同一件事有了两个入口——
 * 而两个入口的行为还不一样（顶栏那个只有切换，新建要另外点 ＋）。
 *
 * 更要紧的是：**回收站是每个项目自己的**。用户在顶栏切了项目，
 * 却看不到回收站里原来那个项目的东西，于是以为回收站空了、
 * 或者以为删错的东西找不回来了。这个割裂必须消掉。
 *
 * 所以合并成一个弹窗：新建、导入/导出、切换、重命名、删除、
 * 回收站入口全在这里，且它总是带着「当前是哪个项目」的上下文。
 */

/**
 * 删除项目的确认。
 *
 * ⚠ 为什么要单独一个界面而不是 window.confirm：
 *   删除会同时干掉数据库记录**和**项目文件夹，文件夹里是用户
 *   攒了几个月的资料。而 window.confirm 只能显示纯文本，
 *   用户没法在这里看到「会删掉哪些文件」。
 *   所以这个确认框把清单列出来，并且默认勾选的是**保留文件夹**——
 *   让用户先看到能安全操作的那条路。
 */
function ConfirmDelete({ project, files, onKeepFiles, busy, onCancel, onConfirm }) {
  const [keepFiles, setKeepFiles] = useState(true);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rounded-xl p-5 shadow-2xl"
        style={{
          background: 'var(--paper)',
          width: 460,
          maxWidth: '92vw',
          border: '1px solid var(--line)',
        }}
      >
        <div className="text-[14px] font-semibold mb-1" style={{ color: 'var(--danger)' }}>
          删除项目「{project.name}」？
        </div>
        <div className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--ink-soft)' }}>
          这个项目里的对话、章节、设定、伏笔都会一起消失。
        </div>

        {files && files.length > 0 && (
          <div
            className="rounded px-3 py-2 mb-3 text-[11.5px] leading-relaxed max-h-32 overflow-y-auto"
            style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
          >
            <b style={{ color: 'var(--ink)' }}>项目文件夹里有这些文件：</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {files.map((f) => (
                <li key={f.path} style={{ wordBreak: 'break-all' }}>{f.path}</li>
              ))}
            </ul>
          </div>
        )}

        <label className="flex items-start gap-2 text-[12px] cursor-pointer mb-1">
          <input
            type="checkbox"
            checked={keepFiles}
            onChange={(e) => { setKeepFiles(e.target.checked); onKeepFiles?.(e.target.checked); }}
            style={{ marginTop: 2 }}
          />
          <span>
            <b>保留硬盘上的文件夹</b>
            <span style={{ color: 'var(--ink-soft)' }}>（推荐）</span>
            <br />
            <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              项目会从软件里消失，但 {files && files.length ? files.length : ''} 个文件
              仍留在原来的位置，你可以在软件外自己删。
            </span>
          </span>
        </label>
        {!keepFiles && (
          <div className="text-[11.5px] mb-2" style={{ color: 'var(--danger)' }}>
            连文件夹一起删。<b>这一步不可撤销。</b>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded text-[12.5px]"
            style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3.5 py-1.5 rounded text-[12.5px] disabled:opacity-40"
            style={{ background: 'var(--danger)', color: 'var(--accent-ink)' }}
          >
            {busy ? '删除中…' : (keepFiles ? '从软件里删除' : '彻底删除')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 改名的小输入框，内联在那一行里 */
function RenameRow({ project, onDone, onCancel }) {
  const [v, setV] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const ref = useCallback((el) => { if (el) { el.focus(); el.select(); } }, []);

  const submit = async () => {
    const name = v.trim();
    if (!name || name === project.name) { onCancel(); return; }
    setBusy(true);
    try {
      await onDone(name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--accent-soft)' }}>
      <span className="text-[13px] shrink-0">✏️</span>
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        className="flex-1 px-2 py-1 rounded text-[13px] outline-none"
        style={{ background: 'var(--paper)', color: 'var(--ink)' }}
      />
      <button
        onClick={submit}
        disabled={busy || !v.trim()}
        className="px-2.5 py-1 rounded text-[12px] disabled:opacity-40"
        style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
      >
        {busy ? '…' : '保存'}
      </button>
      <button
        onClick={onCancel}
        className="px-2.5 py-1 rounded text-[12px]"
        style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
      >
        取消
      </button>
    </div>
  );
}

export default function ProjectSwitcher({
  projects, currentId, trashCount,
  /**
   * 打开时是否**直接展开「＋ 新建」输入框**。
   *
   * ⚠ 零项目时必须传 true。用户此刻唯一能做的事就是建项目，
   *   而第 1 栏那个按钮已经改成了「＋ 新建项目」——
   *   点进来还得再找一次「＋ 新建」，等于把同一个动作拆成两步。
   */
  startCreating = false,
  onPick, onCreate, onRename, onDelete, onExport, onOpenTrash,
  /** 导入已有文件夹：打开系统选择框 → 主进程绑定 → 返回统计 */
  onImport, onImportDone,
  onClose, onToast,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState([]);
  const [keepFiles, setKeepFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(!!startCreating);
  const [newName, setNewName] = useState('');
  const newRef = useRef(null);

  useEffect(() => {
    if (creating && newRef.current) newRef.current.focus();
  }, [creating]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (creating) { setCreating(false); return; }
      if (renamingId) { setRenamingId(null); return; }
      if (deleting) { setDeleting(null); return; }
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating, renamingId, deleting, onClose]);

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await onCreate(name);
      setCreating(false);
      setNewName('');
    } catch (e) {
      onToast?.(`新建失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const doRename = async (id, name) => {
    try {
      await onRename(id, name);
      setRenamingId(null);
    } catch (e) {
      onToast?.(`改名失败：${e.message}`);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      const r = await onDelete(deleting.id, keepFiles);
      if (r && r.ok === false) {
        onToast?.(r.error || '删除失败');
        return;
      }
      setDeleting(null);
      setDeleteFiles([]);
    } catch (e) {
      onToast?.(`删除失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导入已有文件夹。
   *
   * ⚠ 导入是**原地指过去**，不是复制。这意味着：
   *   - 软件里改文件 = 直接改你原来的文件，没有副本；
   *   - 你在别的编辑器里改，软件这边刷新也看得见。
   * 这是用户要的（复制一份必然分叉），但**必须先说清楚**——
   * 否则他以为是"导入一份副本"，回头发现原稿被改了，
   * 会以为软件动了他的东西。
   */
  const [importExplain, setImportExplain] = useState(false);
  const doImport = () => setImportExplain(true);

  const doImportReal = async () => {
    setBusy(true);
    try {
      const r = await onImport();
      if (r && r.canceled) { setImportExplain(false); return; }
      setImportExplain(false);
      onImportDone?.(r);
      onClose?.();
    } catch (e) {
      onToast?.(`导入失败：${e.message}`);
      setImportExplain(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {importExplain && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.42)' }}
          role="dialog"
          aria-modal="true"
          aria-label="导入文件夹"
        >
          <div
            className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
            style={{
              background: 'var(--paper)', width: 460, maxWidth: '92vw',
              border: '1px solid var(--line)',
            }}
          >
            <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b"
                 style={{ borderColor: 'var(--line)' }}>
              <span className="text-[14px] font-semibold">导入已有的小说文件夹</span>
            </div>
            <div className="px-5 py-4 text-[12.5px] leading-relaxed"
                 style={{ color: 'var(--ink-soft)' }}>
              <p>下一步会弹出系统窗口让你选一个文件夹，然后</p>
              <p className="mt-2 font-medium" style={{ color: 'var(--ink)' }}>
                直接把软件接在那个文件夹上——不复制、不新建副本。
              </p>
              <ul className="mt-3 space-y-1.5">
                <li>· 你在软件里改的文件，就是原文件夹里的文件</li>
                <li>· 你用别的工具改的，软件刷新后也看得见</li>
                <li>· 从项目里删掉这个项目时，**不会**删掉那个文件夹</li>
              </ul>
              <p className="mt-3">这样你那套已经用顺手的整理脚本仍然照常能用，两边不会分叉。</p>
            </div>
            <div className="shrink-0 flex gap-2 px-5 py-3.5 border-t"
                 style={{ borderColor: 'var(--line)' }}>
              <button onClick={() => setImportExplain(false)} disabled={busy}
                      className="flex-1 py-2 rounded-lg text-[13px] disabled:opacity-40"
                      style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
                取消
              </button>
              <button onClick={doImportReal} disabled={busy} data-testid="btn-import-confirm"
                      className="flex-1 py-2 rounded-lg text-[13px] disabled:opacity-40"
                      style={{ background: 'var(--accent)', color: '#fff' }}>
                {busy ? '导入中…' : '选择文件夹'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.32)' }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
        role="dialog"
        aria-modal="true"
        aria-label="切换小说项目"
      >
        <div
          className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
          style={{
            background: 'var(--paper)',
            width: 560,
            maxWidth: '92vw',
            border: '1px solid var(--line)',
          }}
        >
          {/* 标题 */}
          <div
            className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b"
            style={{ borderColor: 'var(--line)' }}
          >
            <span className="text-[15px]">⇄</span>
            <span className="text-[14px] font-semibold">切换小说项目</span>
            <span className="flex-1" />
            <button
              onClick={onClose}
              className="text-[15px] w-7 h-7 rounded"
              style={{ background: 'transparent', color: 'var(--ink-soft)' }}
              title="关闭（Esc）"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>

          {/* 三个动作 */}
          <div className="shrink-0 flex gap-2 px-5 py-3.5 border-b" style={{ borderColor: 'var(--line)' }}>
            <button
              onClick={() => { setCreating(true); setNewName(''); }}
              data-testid="btn-new-project"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px]"
              style={{
                background: 'var(--paper-2)',
                color: 'var(--accent)',
                border: '1px solid var(--line)',
              }}
              title="新建一个小说项目"
            >
              ＋ 新建
            </button>
            <button
              onClick={doImport}
              disabled={busy}
              data-testid="btn-import-folder"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] disabled:opacity-40"
              style={{
                background: 'var(--paper-2)',
                color: 'var(--accent)',
                border: '1px solid var(--line)',
              }}
              title="把一个已有的 novels 文件夹原地接进来，不复制、不改动它"
            >
              ↓ 导入文件夹
            </button>
            <button
              onClick={async () => {
                if (!currentId) { onToast?.('先选一个项目'); return; }
                setBusy(true);
                try {
                  const r = await onExport(currentId);
                  if (r && r.canceled) return;
                  onToast?.(r ? `已导出 ${r.files} 个文件到 ${r.dest}` : '已导出');
                } catch (e) {
                  onToast?.(`导出失败：${e.message}`);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={!currentId || busy}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px] disabled:opacity-40"
              style={{
                background: 'var(--paper-2)',
                color: 'var(--accent)',
                border: '1px solid var(--line)',
              }}
              title="把当前项目的整个文件夹复制一份到别处"
            >
              ↑ 导出
            </button>
          </div>

          {/* 新建输入框 */}
          {creating && (
            <div
              className="shrink-0 flex items-center gap-2 px-5 py-3 border-b"
              style={{ borderColor: 'var(--line)', background: 'var(--accent-soft)' }}
            >
              <input
                ref={newRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doCreate();
                  if (e.key === 'Escape') setCreating(false);
                }}
                placeholder="给新小说起个名字"
                className="flex-1 px-2.5 py-1.5 rounded text-[13px] outline-none"
                style={{ background: 'var(--paper)', color: 'var(--ink)' }}
              />
              <button
                onClick={doCreate}
                disabled={busy || !newName.trim()}
                className="px-3 py-1.5 rounded text-[12.5px] disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                {busy ? '…' : '创建'}
              </button>
            </div>
          )}

          {/* 项目列表 */}
          <div className="flex-1 overflow-y-auto min-h-0 py-2">
            {projects.length === 0 ? (
              <div
                className="px-6 py-12 text-[12.5px] text-center leading-relaxed"
                style={{ color: 'var(--ink-soft)' }}
              >
                还没有项目。
                <br />
                <span className="text-[11.5px]">点上面「＋ 新建」，会自动建好资料文件夹与模板。</span>
              </div>
            ) : (
              projects.map((p) => {
                const isCur = p.id === currentId;
                if (renamingId === p.id) {
                  return (
                    <RenameRow
                      key={p.id}
                      project={p}
                      onDone={(n) => doRename(p.id, n)}
                      onCancel={() => setRenamingId(null)}
                    />
                  );
                }
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-2.5 px-5 py-2.5 group"
                    style={{
                      background: isCur ? 'var(--accent-soft)' : undefined,
                      border: isCur ? '1px solid var(--line)' : '1px solid transparent',
                      borderRadius: 6,
                      margin: '0 12px',
                    }}
                  >
                    <button
                      onClick={() => { onPick(p.id); onClose?.(); }}
                      className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                      title={isCur ? '当前项目' : `切换到「${p.name}」`}
                    >
                      <span className="text-[14px] shrink-0">{isCur ? '✔' : '📕'}</span>
                      <span
                        className="text-[13.5px] truncate"
                        style={{ color: 'var(--ink)', fontWeight: isCur ? 600 : 400 }}
                      >
                        {p.name}
                      </span>
                      {isCur && (
                        <span
                          className="text-[10.5px] px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                        >
                          当前
                        </span>
                      )}
                    </button>

                    <button
                      onClick={() => setRenamingId(p.id)}
                      className="w-7 h-7 rounded text-[12px] opacity-0 group-hover:opacity-100"
                      style={{ background: 'transparent', color: 'var(--ink-soft)' }}
                      title="改项目名"
                      aria-label={`重命名 ${p.name}`}
                    >
                      ✏️
                    </button>
                    <button
                      onClick={async () => {
                        setDeleting(p);
                        setKeepFiles(true);
                        setDeleteFiles([]);
                        // 列出文件夹里有什么，让用户看到会删掉什么
                        try {
                          const t = await window.api.fs.tree({ id: undefined, projectId: p.id });
                          setDeleteFiles(collectFiles(t).slice(0, 20));
                        } catch (_) { /* 列不出来就只显示提示 */ }
                      }}
                      className="w-7 h-7 rounded text-[12px] opacity-0 group-hover:opacity-100"
                      style={{ background: 'transparent', color: 'var(--danger)' }}
                      title="删除项目"
                      aria-label={`删除 ${p.name}`}
                    >
                      🗑
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* 底部：回收站 */}
          <div
            className="shrink-0 px-5 py-3 border-t flex items-center"
            style={{ borderColor: 'var(--line)' }}
          >
            <button
              onClick={onOpenTrash}
              className="flex items-center gap-2 text-[12.5px] px-3 py-1.5 rounded"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
              title="回收站里的东西按项目分；这里看到的是当前项目的"
            >
              🗑 回收站
              {trashCount > 0 && (
                <span className="tabular-nums" style={{ color: 'var(--danger)' }}>
                  {trashCount}
                </span>
              )}
            </button>
            <span className="flex-1" />
            <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              回收站跟着项目走
            </span>
          </div>
        </div>
      </div>

      {deleting && (
        <ConfirmDelete
          project={deleting}
          files={deleteFiles}
          onKeepFiles={setKeepFiles}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={doDelete}
        />
      )}
    </>
  );
}

/** 把树摊平成文件路径列表（给删除确认框显示"会删掉什么"） */
function collectFiles(node, acc = []) {
  for (const c of node?.children || []) {
    if (c.type === 'file') acc.push(c.path);
    else collectFiles(c, acc);
  }
  return acc;
}

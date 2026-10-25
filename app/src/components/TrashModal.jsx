import { useCallback, useEffect, useState } from 'react';

/**
 * 回收站：**居中弹窗**。
 *
 * ## 为什么必须是弹窗而不是第 4 栏的一个页面
 *
 * 第一版把它做成了「替换第 4 栏的内容」。用户点进去之后：
 *   - 文件树整个消失，看不到自己删了什么、在哪一层
 *   - 「关闭」按钮在右栏最上面，窄栏里容易被忽略
 *   - 忘了它可以返回，整个第4 栏就像坏了
 *
 * 实测反馈是"单击了之后都返回不了了"——不是技术上关不掉，
 * 而是**关掉的入口不在用户看得到的地方**。
 *
 * 改成覆盖整个窗口的模态弹窗：点遮罩、按 Esc、点 × 都能关，
 * 且底层四栏仍然可见（半透明遮罩能透出来，用户知道自己还在哪）。
 */

const KIND = { file: '文件', dir: '文件夹' };

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 原路径被占时给个建议：放到同级的「回收还原」目录下 */
function suggestAltPath(origPath) {
  const i = origPath.lastIndexOf('/');
  const dir = i >= 0 ? origPath.slice(0, i) : '';
  const base = i >= 0 ? origPath.slice(i + 1) : origPath;
  return dir ? `${dir}/回收还原/${base}` : `回收还原/${base}`;
}

export default function TrashModal({ projectId, projectName, onClose, onChanged, onToast }) {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [renaming, setRenaming] = useState(null);   // {item, toPath}

  const load = useCallback(async () => {
    if (!projectId) { setItems([]); return; }
    setLoading(true);
    try {
      const r = await window.api.trash.list({ projectId });
      setItems(r.items || []);
      setStats(r.stats || { count: 0, bytes: 0 });
    } catch (e) {
      onToast?.(`读取回收站失败：${e.message}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, onToast]);

  useEffect(() => { load(); }, [load]);

  // Esc 关闭。放在这里而不是父级，是因为这个弹窗的开关
  // 由父级管，但"Esc 该关谁"是弹窗自己的语义——
  // 父级同时还管着设置页，两个都监听 Esc 会打架。
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doRestore = async (item, toPath) => {
    setBusyId(item.id);
    try {
      await window.api.trash.restore({ projectId, id: item.id, toPath });
      onToast?.(`已还原「${item.name}」`);
      setRenaming(null);
      await load();
      await onChanged?.();
    } catch (e) {
      // 原位置被占是常见情况：直接给"换个位置还原"的输入框，
      // 而不是弹一句"操作失败"就没下文
      if (/已有同名/.test(e.message)) {
        setRenaming({ item, toPath: suggestAltPath(item.origPath) });
      } else {
        onToast?.(`还原失败：${e.message}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const doPurge = async (item) => {
    // 已在回收站内、信息完全可见，所以确认框只问一句
    if (!window.confirm(
      `永久删除「${item.name}」？\n\n` +
      `原位置：${item.origPath}\n` +
      `删除于：${fmtTime(item.deletedAt)}\n\n` +
      `这一步不可撤销，也不再进任何回收站。`
    )) return;
    setBusyId(item.id);
    try {
      await window.api.trash.purge({ projectId, id: item.id });
      onToast?.(`已粉碎「${item.name}」`);
      await load();
    } catch (e) {
      onToast?.(`粉碎失败：${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const doEmpty = async () => {
    if (!items.length) return;
    if (!window.confirm(
      `清空回收站？\n\n` +
      `共 ${stats.count} 项、${fmtSize(stats.bytes)}。\n` +
      `清空后无法还原，也无法粉碎找回。`
    )) return;
    setBusyId('__all__');
    try {
      const r = await window.api.trash.empty({ projectId });
      onToast?.(`已清空 ${r.purged} 项`);
      await load();
      await onChanged?.();
    } catch (e) {
      onToast?.(`清空失败：${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      // 点遮罩关闭。指针按下时判断是否落在遮罩本身——
      // 直接用 onClick 的话，在弹窗内按下、弹窗外松开也会触发关闭
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      role="dialog"
      aria-modal="true"
      aria-label="回收站"
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          background: 'var(--paper)',
          width: 660,
          maxWidth: '92vw',
          height: 560,
          maxHeight: '86vh',
          border: '1px solid var(--line)',
        }}
      >
        {/* 标题栏 */}
        <div
          className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="text-[15px]">🗑</span>
          <span className="text-[14px] font-semibold">回收站</span>
          {projectName && (
            <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              属于「{projectName}」
            </span>
          )}
          <span className="flex-1" />
          <button
            onClick={doEmpty}
            disabled={!items.length || busyId === '__all__'}
            className="text-[12px] px-2.5 py-1 rounded disabled:opacity-35"
            style={{ background: 'transparent', color: 'var(--danger)' }}
            title="永久删除全部，不可还原"
          >
            {busyId === '__all__' ? '处理中…' : '清空'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-[13px] w-7 h-7 rounded disabled:opacity-40"
            style={{ background: 'transparent', color: 'var(--ink-soft)' }}
            title="刷新列表"
            aria-label="刷新"
          >
            {loading ? '…' : '⟳'}
          </button>
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

        {/* 概要 */}
        <div
          className="shrink-0 px-5 py-2 text-[11.5px] border-b"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}
        >
          {stats.count > 0
            ? `${stats.count} 项 · ${fmtSize(stats.bytes)}　—　「还原」放回原处，「粉碎」是永久删除`
            : '这里没有东西'}
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {items.length === 0 ? (
            <div
              className="px-6 py-14 text-[12.5px] text-center leading-relaxed"
              style={{ color: 'var(--ink-soft)' }}
            >
              回收站是空的。
              <br />
              <span className="text-[11.5px]">
                在文件上右键选「放入回收站」，删错的东西会落在这里，可以还原。
              </span>
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="flex items-center gap-3 px-5 py-2.5 border-b"
                style={{
                  borderColor: 'var(--line)',
                  opacity: busyId === it.id ? 0.45 : 1,
                }}
              >
                <span
                  className="w-8 h-8 shrink-0 rounded flex items-center justify-center text-[14px]"
                  style={{
                    background: it.type === 'dir' ? 'var(--warn-soft, var(--accent-soft))' : 'var(--accent-soft)',
                  }}
                >
                  {it.type === 'dir' ? '📁' : '📄'}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13.5px] font-medium truncate" title={it.name}>
                      {it.name}
                    </span>
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--ink-soft)' }}>
                      {it.type === 'dir' ? KIND.dir : fmtSize(it.size)}
                    </span>
                  </div>
                  <div className="text-[11px] truncate" style={{ color: 'var(--ink-soft)' }}>
                    {fmtTime(it.deletedAt)} 删除 · 原位置：{it.origPath}
                  </div>
                </div>

                {renaming && renaming.item.id === it.id ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      value={renaming.toPath}
                      onChange={(e) => setRenaming({ ...renaming, toPath: e.target.value })}
                      className="px-2 py-1 rounded text-[11.5px] outline-none"
                      style={{ background: 'var(--paper-2)', color: 'var(--ink)', width: 200 }}
                      placeholder="换个位置"
                    />
                    <button
                      onClick={() => doRestore(it, renaming.toPath)}
                      disabled={!renaming.toPath.trim()}
                      className="px-2.5 py-1 rounded text-[11.5px] disabled:opacity-40"
                      style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                    >
                      还原到这里
                    </button>
                    <button
                      onClick={() => setRenaming(null)}
                      className="px-2.5 py-1 rounded text-[11.5px]"
                      style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => doRestore(it)}
                      disabled={busyId === it.id}
                      className="w-8 h-8 rounded disabled:opacity-40"
                      style={{ background: 'transparent', color: 'var(--accent)' }}
                      title="还原到原位置"
                      aria-label={`还原 ${it.name}`}
                    >
                      ↺
                    </button>
                    <button
                      onClick={() => doPurge(it)}
                      disabled={busyId === it.id}
                      className="w-8 h-8 rounded disabled:opacity-40"
                      style={{ background: 'transparent', color: 'var(--danger)' }}
                      title="粉碎（永久删除，不可撤销）"
                      aria-label={`粉碎 ${it.name}`}
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div
          className="shrink-0 px-5 py-2.5 text-[11px] border-t"
          style={{ borderColor: 'var(--line)', color: 'var(--ink-soft)' }}
        >
          回收站跟着项目走——每个项目有自己的一份。点遮罩、按 Esc 或右上角 ✕ 都能关闭。
        </div>
      </div>
    </div>
  );
}

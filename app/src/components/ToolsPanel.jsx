import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * 快捷工具面板。
 *
 * ## 2026-11-03：这里只剩备忘录了
 *
 * 羽毛菌：「起名，脑洞，灵感碎片都应该做单独的交互而不是和备忘录一样」。
 *
 * 原来四个工具共用同一个"打开 md 随便写"的模板。对**备忘录**是对的 ——
 * 它就是随手记，给个空文件最省事。但对另外三个是错的：
 * 用户要的是"我说要求、模型给初稿"，而不是"给我一个空文件自己编"。
 *
 * 所以 name / brain / idea 三个已经搬到独立弹窗（`ToolModal.jsx`），
 * 各自有表单和 AI 动作，产物仍然落回同样的 md 文件
 * （起名备忘.md / 脑洞.md / 灵感碎片.md），旧内容一个字都没丢。
 *
 * ⚠ 别把这个面板删掉：备忘录仍然需要它，而且它演示了"最轻的写法"——
 *   不是每个工具都值得配一套表单。
 */

const TOOLS = [
  {
    key: 'memo',
    label: '备忘录',
    icon: '📌',
    hint: '随手记待办、灵感、要做的事',
    file: '备忘录.md',
    template: () => `# 备忘录\n\n> 待办与提醒。\n\n- [ ] \n`,
  },
];

/** 工具 + 已开文件映射 */
const TOOL_FILE = Object.fromEntries(TOOLS.map((t) => [t.key, t.file]));

/**
 * 顶栏按钮点进来时只展开**那一个**工具。
 *
 * @param {string} key 工具 key。空/undefined → 全部展开（默认面板）
 */
export default function ToolsPanel({
  projectId, readFile, writeFile, exists,
  onToast, onOpenPreview,
  activeKey, onPickTool,
}) {
  const [drafts, setDrafts] = useState({});     // {file: content}
  const [loaded, setLoaded] = useState({});    // {file: bool}
  const [busy, setBusy] = useState(null);

  // 切项目时清空：上一个项目的内容绝不能出现在下一个项目里。
  // 这是会写错文件的 bug，不是显示问题。
  useEffect(() => {
    setDrafts({});
    setLoaded({});
  }, [projectId]);

  const load = useCallback(async (file) => {
    if (!projectId) return;
    setBusy(file);
    try {
      const has = await exists(projectId, file);
      if (!has) {
        const tpl = TOOLS.find((t) => t.file === file)?.template();
        setDrafts((d) => ({ ...d, [file]: tpl || '' }));
        setLoaded((l) => ({ ...l, [file]: false }));
      } else {
        const doc = await readFile(projectId, file);
        setDrafts((d) => ({ ...d, [file]: doc.content }));
        setLoaded((l) => ({ ...l, [file]: true }));
      }
    } catch (e) {
      onToast?.(`读取失败：${e.message}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, readFile, exists, onToast]);

  const save = useCallback(async (file) => {
    if (!projectId) return;
    setBusy(file);
    try {
      await writeFile(projectId, file, drafts[file] || '');
      setLoaded((l) => ({ ...l, [file]: true }));
      onToast?.(`已保存到 ${file}`);
    } catch (e) {
      onToast?.(`保存失败：${e.message}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, drafts, writeFile, onToast]);

  if (!projectId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 min-h-0">
        <div className="text-[12px] text-center leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          先在顶部选一个项目。
          <br />
          这些工具的内容都存在项目文件夹里。
        </div>
      </div>
    );
  }

  /**
   * 顶栏点了哪个就展开哪个；没指定就全展开（原来的行为）。
   *
   * ⚠ 用 useMemo 算 visible 而不是直接 filter：
   *   每次渲染新建数组会让下面 TOOLS.map 的 key 虽然稳定、
   *   但 textarea 的 value 仍是 state 里的（不会丢）——
   *   真正的风险是父组件重渲染时把用户正在输入的内容闪一下。
   *   这里存的是 loaded/drafts 的 key，不涉及内容，安全。
   */
  const visibleTools = useMemo(
    () => (activeKey ? TOOLS.filter((t) => t.key === activeKey) : TOOLS),
    [activeKey],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-2 border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="text-[13px] font-semibold">
          {activeKey
            ? (TOOLS.find((t) => t.key === activeKey) || {}).label
            : '快捷工具'}
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
          内容直接落在项目文件夹的 md 里，随时能在第 3 栏预览。
        </div>
        {activeKey && (
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {TOOLS.map((t) => (
              <button
                key={t.key}
                onClick={() => onPickTool?.(t.key)}
                className="px-1.5 py-0.5 rounded text-[11px]"
                style={{
                  background: t.key === activeKey ? 'var(--accent)' : 'var(--paper-2)',
                  color: t.key === activeKey ? 'var(--accent-ink)' : 'var(--ink-soft)',
                }}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {visibleTools.map((t) => {
          const content = drafts[t.file];
          const isNew = loaded[t.file] === false;
          return (
            <div key={t.key} className="px-3 py-2.5 border-b" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[14px]">{t.icon}</span>
                <span className="text-[12px] font-semibold flex-1">{t.label}</span>
                {isNew && (
                  <span
                    className="text-[10px] px-1 rounded"
                    style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}
                  >
                    尚未创建
                  </span>
                )}
              </div>
              <div className="text-[11px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>{t.hint}</div>

              {content === undefined ? (
                <button
                  onClick={() => load(t.file)}
                  disabled={busy === t.file}
                  className="w-full py-1.5 rounded text-[12px] disabled:opacity-40"
                  style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                >
                  {busy === t.file ? '载入中…' : `打开 ${t.file}`}
                </button>
              ) : (
                <>
                  <textarea
                    value={content}
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.file]: e.target.value }))}
                    spellCheck={false}
                    rows={Math.min(14, Math.max(4, content.split('\n').length + 1))}
                    className="w-full p-2 rounded text-[12px] leading-[1.8] outline-none resize-y"
                    style={{
                      background: 'var(--paper-2)',
                      color: 'var(--ink)',
                      fontFamily: 'ui-monospace, Consolas, monospace',
                    }}
                  />
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      onClick={() => save(t.file)}
                      disabled={busy === t.file}
                      className="flex-1 py-1 rounded text-[12px] disabled:opacity-40"
                      style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                    >
                      {busy === t.file ? '保存中…' : '保存'}
                    </button>
                    <button
                      onClick={() => onOpenPreview?.(t.file)}
                      className="px-2.5 py-1 rounded text-[12px]"
                      style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                    >
                      预览
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { TOOLS, TOOL_FILE };
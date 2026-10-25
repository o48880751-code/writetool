import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * 快捷工具面板。
 *
 * ## 设计取舍：为什么不每个工具都做成一个完整功能
 *
 * 起名这类工具真做深了要接模型、要维护词库、要处理"重名检查"，
 * 但在"先看有没有用"这个阶段，投入产出不划算。
 *
 * 所以这一版的定位是：**给想法一个落脚点**。
 * 备忘录、起名、脑洞都是"往项目文件里追加一段 md"，
 * 三者共用同一个写入通道，只在默认模板与提示词上不同。
 * 这样它们：
 *   - 立刻能用（不需要等模型、不需要网络）
 *   - 成果留在项目文件夹里，能被检索、预览、编辑
 *   - 之后想加深（比如起名接模型生成候选），是在这个基础上加，
 *     不是推倒重来
 *
 * ## 为什么是四个工具，脑洞和灵感碎片要分开（2026-10-13）
 *
 * 羽毛菌：「灵感碎片没有在脑洞后面那里」——
 * 他要的是**顶栏上有一个独立的「灵感碎片」按钮**，
 * 位置在「脑洞」后面。
 *
 * 上一版我把灵感碎片当成「脑洞」工具的文件（TOOLS[2].file），
 * 于是在顶栏只给了三个按钮，「灵感碎片」只是个文件名——
 * **用户找的是按钮，不是文件**。把他熟悉的东西藏在另一个工具里，
 * 等于没给入口。
 *
 * 两者的区别也说得清：
 *   脑洞      = 成型的剧情设计：走向、反转、人物关系图（→ 脑洞.md）
 *   灵感碎片  = 没成型的随手记：一句台词、一个画面、一个念头（→ 灵感碎片.md）
 * 合并成一个工具时，用户想记个碎片得点进"脑洞"再找——
 *   而"想到就记"这件事多一步就等于不做。
 *
 * ⚠ 模板不再建灵感碎片.md（见 project-fs 的 TEMPLATE_FILES）：
 *   它由**第一次点开这个工具时**创建，文件树里那份一定写过东西。
 *
 * ## 为什么写入走 fs:write 而不是建表
 *
 * 这些内容本质是人的草稿，md 文件能用任何编辑器打开、能被全文检索、
 * 能随手拖进备份工具。塞进 SQLite 反而绑死在应用里。
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
  {
    key: 'name',
    label: '起名',
    icon: '✒️',
    hint: '人物名、地名、功法名的候选与取舍',
    file: '起名备忘.md',
    template: () => `# 起名备忘\n\n> 想到的名字先扔这里，定稿再写进设定/人物库.md。\n\n## 人物\n- \n\n## 地点\n- \n\n## 功法\n- \n`,
  },
  {
    key: 'brain',
    label: '脑洞',
    icon: '💡',
    // ⚠ file 与 label 同名：用户点「脑洞」，就该看到 脑洞.md。
    //   原来这个工具叫「脑洞」却写 灵感碎片.md，
    //   结果顶栏找不到"灵感碎片"、文件树里冒出一个对不上号的文件。
    hint: '剧情走向、反转设计与人物关系——想清楚了再往卷纲里写',
    file: '脑洞.md',
    template: () => `# 脑洞\n\n> 成型的剧情设计。定稿后誊进 卷纲/ 与 章节摘要.md。\n\n## 这条线的走向\n- \n\n## 反转与伏笔\n- \n`,
  },
  {
    key: 'idea',
    label: '灵感碎片',
    icon: '🗒️',
    hint: '没成型的随手记：一句台词、一个画面、一个念头',
    file: '灵感碎片.md',
    template: () => `# 灵感碎片\n\n> 不成型的想法都放这儿，别怕乱。\n\n- \n`,
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
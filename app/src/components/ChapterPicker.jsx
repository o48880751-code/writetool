import React, { useMemo, useState } from 'react';

/**
 * 章节勾选面板（2026-10-28，拆书用）。
 *
 * ## 为什么需要它
 *
 * 拆书的第一约束是**输入体积**：一整本网文几十万字，塞不进上下文。
 * 原来的做法是"取前 2 万字"，但那会把书砍在剧情中间——
 * 切出来的东西读者看着断头，模型分析起来也不知道边界在哪。
 *
 * 分好章让用户自己勾，逻辑单元才是完整的：选 3 章就是完整的 3 章。
 *
 * ## 为什么默认勾前三章
 *
 * 拆书最常问的是"它怎么抓住人的"——那看开头就够了。
 * 默认全空会让用户每次都要点三下，默认全选又必然超字数。
 */

/** 一次能发给模型的上限。约 3 万 token，多数窗口装得下。 */
const MAX_CHARS = 30000;

function fmtChars(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
  return `${n} 字`;
}

function ChapterPicker({ book, onCancel, onConfirm }) {
  const chapters = book?.chapters || [];

  /**
   * 默认勾选：前三章。但如果前三章加起来就超上限（有些书单章一万多字），
   * 那就只勾能装下的部分 —— 默认状态**一定合法**，不让用户一进来就看到红字。
   */
  const [picked, setPicked] = useState(() => {
    if (!chapters.length) return [];
    const out = [];
    let total = 0;
    for (const c of chapters.slice(0, 3)) {
      if (total + c.chars > MAX_CHARS) break;
      out.push(c.index);
      total += c.chars;
    }
    return out.length ? out : [chapters[0].index];
  });

  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const total = useMemo(
    () => chapters.filter((c) => pickedSet.has(c.index)).reduce((s, c) => s + c.chars, 0),
    [chapters, pickedSet]
  );
  const overLimit = total > MAX_CHARS;

  const toggle = (idx) => {
    setPicked((prev) => (prev.includes(idx) ? prev.filter((x) => x !== idx) : [...prev, idx]));
  };

  /** 全选 / 全不选 —— 大书几百章，手动点不现实 */
  const selectAll = () => setPicked(chapters.map((c) => c.index));
  const selectNone = () => setPicked([]);

  /** 按"能不能装下"自动选：从第一章往后连续选，直到超上限 */
  const selectFitting = () => {
    const out = [];
    let sum = 0;
    for (const c of chapters) {
      if (sum + c.chars > MAX_CHARS) break;
      out.push(c.index);
      sum += c.chars;
    }
    setPicked(out);
  };

  /**
   * @param {'analyze'|'extract'} mode
   *   analyze = 结构分析（它为什么留人）
   *   extract = 素材提取（人物/物品/势力/境界/大纲，能贴进自己设定库）
   *
   * ⚠ 两种产出差别很大，所以做成两个按钮而不是一个下拉：
   *   用户在点的那一刻就知道自己要哪一种，不需要先选再点。
   */
  const confirm = (mode) => {
    if (!picked.length || overLimit) return;
    // 按章节原顺序拼，不按勾选顺序 —— 故事要按时间线给模型
    const chosen = chapters.filter((c) => pickedSet.has(c.index));
    const body = chosen.map((c) => book.text.slice(c.start, c.end)).join('\n\n');
    onConfirm({
      name: book.name,
      title: chosen[0]?.title || '',
      count: chosen.length,
      totalChars: total,
      body,
      mode,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,.45)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-xl overflow-hidden flex flex-col"
        style={{
          width: 680, maxWidth: '94vw', height: '80vh',
          background: 'var(--paper)', border: '1px solid var(--line)',
          boxShadow: '0 12px 40px -8px rgba(0,0,0,.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- 头部 ---- */}
        <div
          className="px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              {book?.name || '未命名'}
              <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--ink-soft)' }}>
                共 {chapters.length} 章 · {fmtChars(book?.chars || 0)}
              </span>
            </div>
            <button
              onClick={onCancel}
              className="text-[16px] leading-none px-1"
              style={{ color: 'var(--ink-soft)' }}
              title="取消"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={selectFitting}
              className="px-2 py-1 rounded text-[11px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
              title={`从第一章开始，选到接近 ${fmtChars(MAX_CHARS)} 为止`}
            >
              选能装下的
            </button>
            <button
              onClick={selectAll}
              className="px-2 py-1 rounded text-[11px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
            >
              全选
            </button>
            <button
              onClick={selectNone}
              className="px-2 py-1 rounded text-[11px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
            >
              清空
            </button>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--ink-soft)' }}>
              已选 {picked.length} 章 · {fmtChars(total)}
            </span>
          </div>
        </div>

        {/* ---- 章节列表 ---- */}
        <div className="overflow-y-auto flex-1 px-3 py-2">
          {book?.hasPreamble && (
            <div
              className="text-[11px] rounded p-2 mb-2"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
            >
              第一个章节标题之前还有一段内容（书名页或卷首语），本次不会带上。
            </div>
          )}
          {chapters.map((c) => {
            const on = pickedSet.has(c.index);
            return (
              <label
                key={c.index}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
                style={{ background: on ? 'var(--paper-2)' : 'transparent' }}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(c.index)} />
                <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--ink)' }}>
                  {/* ⚠ 带序号：有些书上架时章节号没改，会出现两个「第1章」，
                      不带序号用户分不清哪个是哪个（2026-10-28 实测遇到过） */}
                  <span style={{ color: 'var(--ink-soft)' }}>{c.index + 1}. </span>
                  {c.title}
                </span>
                <span className="text-[11px] shrink-0" style={{ color: 'var(--ink-soft)' }}>
                  {fmtChars(c.chars)}
                </span>
              </label>
            );
          })}
        </div>

        {/* ---- 底部 ---- */}
        <div
          className="px-4 py-2.5 flex items-center gap-2 shrink-0"
          style={{ borderTop: '1px solid var(--line)' }}
        >
          {overLimit ? (
            <span className="text-[11px]" style={{ color: '#c0392b' }}>
              超了：{fmtChars(total)} / 上限 {fmtChars(MAX_CHARS)}。少选几章。
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              上限 {fmtChars(MAX_CHARS)}，够模型一次读完
            </span>
          )}
          <button
            onClick={onCancel}
            className="ml-auto px-3 py-1.5 rounded text-[12px]"
            style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
          >
            取消
          </button>
          <button
            onClick={() => confirm('analyze')}
            disabled={!picked.length || overLimit}
            className="px-3 py-1.5 rounded text-[12px]"
            style={{
              background: (!picked.length || overLimit) ? 'var(--paper-2)' : 'var(--paper-2)',
              color: (!picked.length || overLimit) ? 'var(--ink-soft)' : 'var(--ink)',
              cursor: (!picked.length || overLimit) ? 'default' : 'pointer',
              border: '1px solid var(--line)',
            }}
            title="它为什么留人：钩子、爽点、骨架、伏笔"
          >
            分析结构
          </button>
          <button
            onClick={() => confirm('extract')}
            disabled={!picked.length || overLimit}
            className="px-3 py-1.5 rounded text-[12px]"
            style={{
              background: (!picked.length || overLimit) ? 'var(--paper-2)' : 'var(--accent)',
              color: (!picked.length || overLimit) ? 'var(--ink-soft)' : 'var(--accent-ink)',
              cursor: (!picked.length || overLimit) ? 'default' : 'pointer',
            }}
            title="提取人物、物品、势力、境界体系、章节大纲"
          >
            提取素材
          </button>
          <button
            onClick={() => confirm('borrow')}
            disabled={!picked.length || overLimit}
            className="px-3 py-1.5 rounded text-[12px]"
            style={{
              background: 'var(--paper-2)',
              color: (!picked.length || overLimit) ? 'var(--ink-soft)' : 'var(--ink)',
              cursor: (!picked.length || overLimit) ? 'default' : 'pointer',
              border: '1px solid var(--line)',
            }}
            title="这本书用了哪些能搬到别处的手法"
          >
            借鉴清单
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChapterPicker;

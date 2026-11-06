import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 拆书窗口（2026-10-28）。
 *
 * ## 为什么是独立窗口，不是发进对话
 *
 * 拆书产出几万字。如果它进了对话历史，**后面每一轮都要重新带上**，
 * 而拆的结果用户只需要看一眼、存成文件 —— 不需要模型记住。
 * 羽毛菌原话：「拆书又不需要模型记住，本质只是对文档的解析。
 * 解析后放文件夹里，有需要的时候再读取。」
 *
 * ## 为什么没有逐字输出
 *
 * 走的是 `askOnce`（一次性调用），不是流式生成。
 * 好处是不必碰对话那套 convId / 工具调用 / 落库逻辑；
 * 代价是看不到字一个个出来，只能看计时器。
 *
 * ⚠ 所以这里**必须**显示"已等 N 秒"——用户盯着一个转圈等三分钟，
 *   会以为卡死了。看到秒数在涨，才知道它还活着。
 */

const MODE_LABEL = {
  analyze: '结构分析',
  extract: '素材提取',
  borrow: '借鉴清单',
};

const MODE_PROMPT = {
  analyze: [
    '拆这五层：章节钩子（每章结尾留了什么悬念）、爽点密度（几章一个、最长空窗多少章）、',
    '结构骨架（每卷的命题是什么）、人物功能（谁删掉故事会缺什么）、伏笔（埋在哪、收在哪）。',
    '每层先给结论，再给具体章号作证据。不要写成书评。',
  ].join(''),
  extract: [
    '把这几章里的素材抽出来，分成五类：人物、物品或法宝、势力或组织、境界或力量体系、章节大纲。\n',
    '每一条都要带「第几章」和一句原文（30 字以内，能回去核对）。\n',
    '从情节推出来的内容必须标「推测」。找不到原句的不要写，宁可少列。\n',
    '如果境界层级之间的差距前后不一致，单独指出来。',
  ].join(''),
  borrow: [
    '从这几章里挑出能搬到别处用的手法，最多 6 条。宁少勿滥。\n',
    '每条必须回答三件事：① 它解决了什么具体问题 ② 机制是什么（为什么这么写就有效）',
    '③ 换一本书还能不能用。\n',
    '格式：给它起个名字 / 用在哪一章哪一句原文 / 为什么有效 / 怎么搬到自己的书上 / 什么情况下会失效。\n',
    '不要写「文笔好」「节奏紧凑」这类评价 —— 那不是手法，拆不出能用的东西。',
  ].join(''),
};

function fmtSec(n) {
  if (n < 60) return `${n} 秒`;
  return `${Math.floor(n / 60)} 分 ${n % 60} 秒`;
}

function BookAnalyzer({ name, body, count, firstTitle, mode, skillText, projectId, onClose, onToast }) {
  const [phase, setPhase] = useState('running');   // running | done | error
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const startedRef = useRef(false);

  /**
   * ⚠ 正文由调用方切好传进来（ChapterPicker 已经切过），这里不再切第二遍 ——
   *   一本书几万字，重复 slice + join 是纯粹的浪费。
   *   技能正文（如果读到了）放在最前面：方法论应该在正文之前被读到。
   */
  const payload = useMemo(() => {
    const brief = `《${name}》，${count} 章，共 ${body.length} 字，从「${firstTitle}」开始。`;
    const ask = `【${MODE_LABEL[mode]}】\n${brief}\n\n${MODE_PROMPT[mode]}\n\n---\n${body}`;
    return { prompt: skillText ? `${skillText}\n\n=====\n\n${ask}` : ask };
  }, [name, body, count, firstTitle, mode, skillText]);

  /** 计时器：让用户知道请求还活着 */
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  /** 进来就跑。⚠ startedRef 防 React 严格模式下的二次调用（那会重复烧一次 token） */
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let alive = true;
    window.api.analyze.run({ prompt: payload.prompt })
      .then((r) => {
        if (!alive) return;
        if (r && r.ok) { setMarkdown(r.markdown || ''); setPhase('done'); }
        else { setError((r && r.error) || '分析失败'); setPhase('error'); }
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || '分析失败');
        setPhase('error');
      });

    return () => { alive = false; };
  }, [payload.prompt]);

  const save = async () => {
    if (saving || !markdown) return;
    setSaving(true);
    try {
      const r = await window.api.analyze.save({
        name: `${name}-${MODE_LABEL[mode]}`, markdown, projectId,
      });
      if (r && r.ok) {
        onToast?.(`已保存：${r.path}`);
      } else if (r && !r.canceled) {
        onToast?.('保存失败');
      }
    } catch (e) {
      onToast?.(`保存失败：${e?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      onToast?.('已复制');
    } catch (e) {
      onToast?.(`复制失败：${e?.message || '未知错误'}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.45)' }}>
      <div
        className="rounded-xl overflow-hidden flex flex-col"
        style={{
          width: 860, maxWidth: '94vw', height: '86vh',
          background: 'var(--paper)', border: '1px solid var(--line)',
          boxShadow: '0 12px 40px -8px rgba(0,0,0,.35)',
        }}
      >
        {/* ---- 头部 ---- */}
        <div className="px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              {MODE_LABEL[mode]} · {name}
              <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--ink-soft)' }}>
                {count} 章
              </span>
            </div>
            <button
              onClick={onClose}
              className="text-[16px] leading-none px-1"
              style={{ color: 'var(--ink-soft)' }}
              title="关闭"
            >
              ×
            </button>
          </div>
        </div>

        {/* ---- 内容 ---- */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {phase === 'running' && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-[13px]" style={{ color: 'var(--ink)' }}>正在分析…</div>
              <div className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                已等 {fmtSec(elapsed)}
              </div>
              <div className="text-[11px] text-center max-w-[420px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                一次性请求，没有逐字输出。几万字的产出通常要 1~3 分钟。
                <br />
                跑完之前关掉这个窗口，结果会丢。
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="text-[12px] leading-relaxed" style={{ color: '#c0392b' }}>
              {error}
              <div className="mt-3 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                常见原因：选中的章节太多（超过模型窗口）、模型不支持这么长的输出、网络中断。
                <br />
                可以关掉窗口少选几章重试。
              </div>
            </div>
          )}

          {phase === 'done' && (
            <pre className="text-[12.5px] whitespace-pre-wrap" style={{ color: 'var(--ink)', lineHeight: 1.75 }}>
              {markdown}
            </pre>
          )}
        </div>

        {/* ---- 底部 ---- */}
        <div className="px-4 py-2.5 flex items-center gap-2 shrink-0" style={{ borderTop: '1px solid var(--line)' }}>
          <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
            {phase === 'done' ? `${markdown.length} 字` : phase === 'running' ? '分析中' : '失败'}
          </span>
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded text-[12px]"
            style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
          >
            关闭
          </button>
          <button
            onClick={copy}
            disabled={phase !== 'done'}
            className="px-3 py-1.5 rounded text-[12px]"
            style={{
              background: 'var(--paper-2)',
              color: phase === 'done' ? 'var(--ink)' : 'var(--ink-soft)',
              border: '1px solid var(--line)',
              cursor: phase === 'done' ? 'pointer' : 'default',
            }}
          >
            复制
          </button>
          <button
            onClick={save}
            disabled={phase !== 'done' || saving}
            className="px-3 py-1.5 rounded text-[12px]"
            style={{
              background: phase === 'done' ? 'var(--accent)' : 'var(--paper-2)',
              color: phase === 'done' ? 'var(--accent-ink)' : 'var(--ink-soft)',
              cursor: phase === 'done' ? 'pointer' : 'default',
            }}
          >
            {saving ? '保存中…' : '保存到项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BookAnalyzer;

/**
 * 简介生成器（快捷工具）。
 *
 * ## 它与其他快捷工具的区别
 *
 * 备忘录 / 起名 / 脑洞 / 灵感碎片都是**往 md 文件里追加一段**，
 * 不调模型，纯记事本。
 * 简介生成不一样：它**要读书稿、要调模型**、产出的是一段成稿。
 * 所以它是独立面板，不是 ToolsPanel 里的一项 ——
 * 否则「进度 / 选了哪些资料 / 生成到哪一步」全挤在一个追加框里。
 *
 * ⚠ 生成走 `window.api.text.ask`，**不进对话历史、不触发工具循环**
 *   （conv:send 会落库、可能调 write_note，对这个小活儿全是多余副作用）。
 */
import React, { useState, useMemo } from 'react';

const AUDIENCE = [
  { key: 'auto', label: '自动' },
  { key: 'male', label: '男频' },
  { key: 'female', label: '女频' },
];

const AUD_HINT = {
  auto: '让 AI 从书稿里自己判断面向谁',
  male: '节奏快、爽点密、目标明确',
  female: '情绪细腻、人物关系与内心戏为主',
};

function flatFiles(tree, prefix = '', out = []) {
  for (const n of (tree && tree.children) || []) {
    if (n.type === 'file') out.push({ path: prefix + n.name, name: n.name });
    else if (n.children) flatFiles(n, prefix + n.name + '/', out);
  }
  return out;
}

export default function IntroGen({ projectId, tree, onClose, onToast, onSaveToFile }) {
  const [aud, setAud] = useState('auto');
  const [picked, setPicked] = useState([]);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [history, setHistory] = useState([]);

  const files = useMemo(() => flatFiles(tree), [tree]);
  const toggle = (p) => setPicked((v) => (v.includes(p) ? v.filter((x) => x !== p) : [...v, p]));

  const run = async () => {
    setErr('');
    setOut('');
    if (!picked.length) { setErr('先选一份书籍资料，让 AI 知道这本书讲什么。'); return; }
    setBusy(true);
    try {
      const parts = [];
      for (const p of picked) {
        const r = await window.api.fs.read({ projectId, path: p });
        if (r && r.content) parts.push(`《${p}》\n${r.content.slice(0, 12000)}`);
      }
      const bookTitle = picked[0].split('/').pop().replace(/\.md$/, '');
      const prompt = [
        `你是网文书城的资深编辑。下面是《${bookTitle}》的部分书稿，请为它写一段**作品简介**。`,
        '',
        `面向读者：${AUDIENCE.find((a) => a.key === aud).label}`,
        `　　（${AUD_HINT[aud]}）`,
        '',
        '要求：',
        '1. 150 到 250 字，分 2 到 3 段；',
        '2. 先给一句能钩住人的**核心看点**，再讲主要人物与冲突，最后留一个悬念；',
        '3. **不要**出现"本书""作者"这类出戏的词，也不要写"精彩""震撼"这种空话；',
        '4. 不要剧透关键反转，不要写"欲知后事如何请看下回"；',
        '5. 用中文，只输出简介正文，不要标题、不要小标题、不要解释。',
        extra ? `\n补充要求（优先照做）：${extra}\n` : '',
        '书稿节选：',
        '```',
        parts.join('\n\n'),
        '```',
      ].join('\n');

      const r = await window.api.text.ask({ prompt, timeoutMs: 180000 });
      if (!r || !r.ok) { setErr((r && r.error) || '生成失败。'); setBusy(false); return; }
      if (!r.text) { setErr('模型没有返回内容，换个模型试试。'); setBusy(false); return; }
      setOut(r.text);
      setHistory((h) => [{ text: r.text, at: new Date().toLocaleTimeString() }, ...h]);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(out); onToast && onToast('已复制简介'); }
    catch (_) { onToast && onToast('复制失败'); }
  };

  const save = async () => {
    if (!out) return;
    if (onSaveToFile) {
      onSaveToFile(out);
      onClose();
      return;
    }
    onToast && onToast('已生成，可复制到剪贴板');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
         style={{ background: 'rgba(0,0,0,.3)' }} onClick={onClose}>
      <div className="rounded-lg w-full max-w-xl my-4"
           style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
           onClick={(e) => e.stopPropagation()}>

        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-2.5"
             style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>简介生成器</span>
          <button onClick={onClose} className="text-[12px] px-2 py-1 rounded"
                  style={{ color: 'var(--ink-soft)' }}>关闭</button>
        </div>

        {/* 页签 */}
        <div className="flex items-center gap-1 px-4 pt-3">
          <span className="px-2.5 py-1 rounded text-[12.5px] font-semibold"
                style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>✨ 生成</span>
          <span className="px-2.5 py-1 text-[12.5px]" style={{ color: 'var(--ink-soft)' }}>
            历史（{history.length}）
          </span>
        </div>

        <div className="px-4 py-3 space-y-4" style={{ maxHeight: '68vh', overflowY: 'auto' }}>

          {/* 频段
              ⚠⚠ 这里原来打的是「**疯**段」，而下面三个选项是 男频 / 女频 ——
              2026-10-16 羽毛菌：「是频段」（一个字之差，同音不同字）。
              ⚠ 同一个错在注释里也有一份，一并改掉 —— 注释里的错字最容易漏，
              而且下一个人照着注释找会一起错。*/}
          <div>
            <div className="text-[12px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>频段</div>
            <div className="flex items-center gap-1.5">
              {AUDIENCE.map((a) => (
                <button key={a.key} onClick={() => setAud(a.key)}
                        className="px-3 py-1 rounded text-[12.5px]"
                        style={{
                          background: aud === a.key ? 'var(--accent)' : 'var(--paper-2)',
                          color: aud === a.key ? 'var(--accent-ink)' : 'var(--ink-soft)',
                          border: `1px solid ${aud === a.key ? 'var(--accent)' : 'var(--line)'}`,
                        }}>{a.label}</button>
              ))}
            </div>
          </div>

          {/* 书籍资料 */}
          <div>
            <div className="text-[12px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>
              书籍资料（选 md 文件供 AI 理解书稿）
            </div>
            <div className="rounded p-2 max-h-[150px] overflow-y-auto"
                 style={{ border: '1px solid var(--line)', background: 'var(--paper-2)' }}>
              {files.length === 0
                ? <div className="text-[12px] px-1 py-1" style={{ color: 'var(--ink-soft)' }}>
                    项目里还没有文件。
                  </div>
                : files.map((f) => (
                  <label key={f.path} className="flex items-center gap-2 py-0.5 cursor-pointer text-[12.5px]"
                         style={{ color: 'var(--ink)' }}>
                    <input type="checkbox" checked={picked.includes(f.path)}
                           onChange={() => toggle(f.path)} />
                    <span className="truncate">{f.path}</span>
                  </label>
                ))}
            </div>
          </div>

          {/* 补充要求 */}
          <div>
            <div className="text-[12px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>
              补充要求（书名 / 风格 / 想强调的点，自由填写）
            </div>
            <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={3}
                      placeholder="例如：书名《签到都市》、轻松搞笑、突出金手指的特殊规则…"
                      className="w-full px-2.5 py-1.5 rounded text-[12.5px] outline-none resize-y leading-relaxed"
                      style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }} />
          </div>

          {err && (
            <div className="text-[12px] px-2.5 py-2 rounded"
                 style={{ background: 'rgba(180,35,24,.08)', color: 'var(--danger)' }}>{err}</div>
          )}

          <button onClick={run} disabled={busy}
                  className="w-full py-2 rounded text-[13px] font-medium disabled:opacity-50"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
            {busy ? '正在读稿并生成…（可能要一两分钟）' : '✨ 生成简介'}
          </button>

          {out && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                  生成结果（{out.length} 字）
                </span>
                <span className="flex items-center gap-2">
                  <button onClick={copy} className="text-[12px] px-2 py-0.5 rounded border"
                          style={{ color: 'var(--ink-soft)', borderColor: 'var(--line)' }}>复制</button>
                  <button onClick={save} className="text-[12px] px-2 py-0.5 rounded border"
                          style={{ color: 'var(--accent)', borderColor: 'var(--line)' }}>存成文件</button>
                </span>
              </div>
              <pre className="text-[12.5px] leading-relaxed p-2.5 rounded whitespace-pre-wrap"
                   style={{ background: 'var(--paper-2)', color: 'var(--ink)',
                            border: '1px solid var(--line)' }}>{out}</pre>
            </div>
          )}

          {history.length > 1 && (
            <div className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
              历史：{history.length} 条（在面板里逐条生成，最近的在最上面）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
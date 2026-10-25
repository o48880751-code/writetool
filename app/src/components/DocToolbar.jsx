/**
 * 文档工具栏：书名 + 五个编辑功能。
 *
 * ## 为什么要有这排东西
 *
 * 2026-10-15 羽毛菌要的（照他的原话）：
 *   「我也要加一个书名栏，右边放搜索功能（查找某个词在该文件的位置并跳转），
 *     替换标点功能，单击后弹出该界面」「一键排版功能（去空格、压缩空行、首行缩进）」
 *   「还一个复制全文功能」
 *
 * 之前这个位置只有文件小标签，正文一长就没法在文件里找东西、也没法批量修标点 ——
 * 而中文小说的标点全角/半角混用几乎是必然的，靠手改很累。
 *
 * ## ⚠ 为什么这些能力放在渲染进程，不放主进程
 *
 * 五个功能里有四个是**纯文本变换**（替换标点 / 排版 / 复制 / 查找位置），
 * 不碰文件系统、不需要密钥、不跨进程。
 * 放渲染进程的好处是**同步、即时、可撤销**（改完还是草稿，用户能点保存或丢弃）。
 * 唯一碰盘的是 onSave —— 那仍然走主进程。
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';

/** 半角 → 全角。⚠ 引号必须**成对交替**，单条规则做不到。 */
const DEFAULT_PUNCT_RULES = [
  { from: '"', to: '“' },   // 左双引号
  { from: '"', to: '”' },   // 右双引号（与上一条交替）
  { from: "'", to: '‘' },
  { from: "'", to: '’' },
  { from: ',', to: '，' },
  { from: ';', to: '；' },
  { from: '!', to: '！' },
  { from: '?', to: '？' },
  { from: ':', to: '：' },
];

/**
 * 统计每条规则会命中多少处（**不修改**）。
 * ⚠ 引号那两条按"第 1、3、5… 个 → 左；第 2、4、6… 个 → 右"处理，
 *   所以要按出现顺序遍历，不能各自 count。
 */
/**
 * 同一个字符对应多条规则时，该用哪一条。
 *
 * ⚠ 引号是唯一的场景：`"` 既可能是左引号也可能是右引号，
 *   按出现顺序交替 —— 第 1、3、5… 个用第一条（“），第 2、4、6… 个用最后一条（”）。
 *   其余字符（`,` `!` …）只有一条规则，直接用它。
 *
 * ⚠⚠ 序号要 **从 0 开始算**：第 1 次出现必须落在**第一条**规则上。
 *   写成 `seen % n === 0` 的话第 1 次是 `1 % 2 === 1` → 落到最后一条，
 *   于是全文引号方向**全部反过来**（”甲“ 而不是 “甲”）。
 */
function pickRule(rules, ch, seen) {
  const idxs = [];
  for (let k = 0; k < rules.length; k++) if (rules[k].from === ch) idxs.push(k);
  if (!idxs.length) return -1;
  if (idxs.length === 1) return idxs[0];
  return (seen - 1) % 2 === 0 ? idxs[0] : idxs[idxs.length - 1];
}

export function countPunct(text, rules) {
  const counts = rules.map(() => 0);
  const seen = {};
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const pick = pickRule(rules, ch, seen[ch] = (seen[ch] || 0) + 1);
    if (pick >= 0) counts[pick]++;
  }
  return counts;
}

export function applyPunct(text, rules) {
  const out = [];
  const seen = {};
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const pick = pickRule(rules, ch, seen[ch] = (seen[ch] || 0) + 1);
    out.push(pick >= 0 ? rules[pick].to : ch);
  }
  return out.join('');
}

/**
 * 一键排版：去空格 → 压缩空行 → 首行缩进。
 *
 * ⚠ 顺序不能换：先去空格（否则行尾空格又变成新空行），
 *   再压缩空行，最后缩进（缩进后的全角空格不会被当成"多余空格"删掉）。
 */
/**
 * 一键排版：去空格 → 压缩空行 → 给**正文段落**加首行缩进。
 *
 * ⚠⚠⚠ 上一版是**破坏 Markdown 结构**的（2026-10-15 用户现场）：
 *   它给每一行都加了「　　」，于是
 *     # 人物库   → 　　# 人物库
 *     - 姓名：…   → 　　- 姓名：…
 *   结果预览里正文**整片消失**，而用户点了一键排版、
 *   又点了保存 —— 稿子被改坏并存盘了。
 *
 *   ⚠ 而且它**根本没处理代码块** —— 围栏里的代码同样会被去空格、加缩进。
 *   「批量改用户稿子」最不能碰的就是代码块。
 *
 * 现在的规矩：
 *   1. **代码围栏（``` 或 ~~~）整段原样保留**，一个字符都不动
 *   2. 只给**真正的正文段落**加缩进；下面这些一律不加：
 *      `#`标题 / `-` `*` `+` 列表 / `1.` 有序列表 / `>` 引用 / `|` 表格 /
 *      已是缩进的行 / 空的行
 *   3. 去空格只针对「汉字之间」与「标点之前」，不碰行首的 Markdown 符号
 */
export function typeset(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  /** 当前是否在代码围栏内 */
  let inFence = false;
  let fenceMark = '';

  for (let line of lines) {
    const t = line.trim();

    // ---- 代码围栏：进出都原样保留 ----
    const fence = t.match(/^(```|~~~)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1]; }
      else if (fence[1] === fenceMark) { inFence = false; fenceMark = ''; }
      out.push(line);          // ⚠ 围栏行自己不动
      continue;
    }
    if (inFence) { out.push(line); continue; }   // ⚠ 围栏内整段不动

    // ---- ① 去空格 ----
    let s = line
      // 汉字/中文标点之间的半角空格
      .replace(/([一-鿿　-〿＀-￯]) +(?=[一-鿿　-〿＀-￯])/g, '$1')
      // 中文标点前的空格
      .replace(/ +([，。、；：！？）】》」』])/g, '$1')
      // 中文标点后的空格
      .replace(/([（【《「『]) +/g, '$1')
      // 行尾空白
      .replace(/[ \t]+$/, '');

    // ⚠ 行首的缩进**保留** —— 嵌套列表靠它，删了就散架
    const indent = (s.match(/^[ \t]*/) || [''])[0];
    let body = s.slice(indent.length);

    if (!body) { out.push(''); continue; }

    // ---- ② ③ 缩进：只给正文段落 ----
    const isStructure = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(body);
    const alreadyIndented = /^[　\s]/.test(body);
    // ⚠ 列表的**子项**（缩进后是 - 或数字）也算结构
    const isSubItem = /^([-*+]\s|\d+\.\s)/.test(body);

    if (!isStructure && !alreadyIndented && !isSubItem && body.trim()) {
      body = `　　${body}`;
    }
    out.push(indent + body);
  }

  // ⚠⚠ 压缩空行**也必须跳过围栏内** ——
  //   否则代码里的空行照样被压掉。上一版把压缩放在最后一步
  //   （整串 .replace(/\n{3,}/g)），于是它**穿过了代码块**，
  //   判据「代码围栏内一个字符都不许动」当场变红。
  //   → 压缩与加缩进一样，按行走一遍。
  const squeezed = [];
  let fenceDepth = 0;
  for (const line of out) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) fenceDepth = fenceDepth ? 0 : 1;
    if (fenceDepth) { squeezed.push(line); continue; }
    if (line === '' && squeezed.length >= 2 && squeezed[squeezed.length - 1] === ''
      && squeezed[squeezed.length - 2] === '') {
      continue;                                   // 丢掉多余的空行
    }
    squeezed.push(line);
  }
  return squeezed.join('\n');
}

/** 查找：返回所有命中位置（字符下标），供上/下一个跳转用。 */
export function findAll(text, needle, caseSensitive = false) {
  if (!needle) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const pat = caseSensitive ? needle : needle.toLowerCase();
  const out = [];
  let i = hay.indexOf(pat);
  while (i >= 0) { out.push(i); i = hay.indexOf(pat, i + Math.max(1, pat.length)); }
  return out;
}

/* ============================================================ */

/** 工具栏图标。⚠ 全部内联 SVG，不用 emoji。
 *  理由与消息操作条一样：emoji 在 Windows 上是**彩色字形**、宽度还不定，
 *  钉在一排图标里会显得参差，而且颜色不受主题控制。 */
const TIcon = ({ d, size = 14, fill }) => (
  <svg
    width={size} height={size} viewBox="0 0 16 16"
    fill={fill || 'none'} stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);

// 查找：放大镜
const I_SEARCH = 'M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4zM11 11l3.4 3.4';
// 排版：左对齐的三行（第一行粗一点）
const I_TYPESET = ['M2.5 3.5h11M2.5 6.8h8M2.5 10.1h11M2.5 13.4h6'];
// 替换标点：引号
const I_PUNCT = ['M6 3.2c-1.2 0-2 1-2 2.4 0 .9.5 1.6 1.2 1.6.6 0 1-.4 1-1', 'M13 3.2c-1.2 0-2 1-2 2.4 0 .9.5 1.6 1.2 1.6.6 0 1-.4 1-1', 'M2.5 12h11'];
// 复制：两个方框
const I_COPY = ['M5.6 5.6V3.4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2.2', 'M10.4 6.6h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1z'];
// 撤销：逆时针弧形箭头
const I_UNDO = ['M2.8 8.2a5.2 5.2 0 1 1 1.7 3.7', 'M2.6 4.4v3.9h3.9'];

export default function DocToolbar({
  bookTitle, text, onChange,
}) {
  const [showSearch, setShowSearch] = useState(false);
  const [needle, setNeedle] = useState('');
  const [hits, setHits] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [showPunct, setShowPunct] = useState(false);
  const [rules, setRules] = useState(DEFAULT_PUNCT_RULES);
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [toast, setToast] = useState('');
  /**
   * 撤销栈。
   *
   * ⚠ 原来只有**一个** prevText，所以：排版 → 撤销（回到原样）→ 再排版
   *   就再也撤不回去了；而且用户要是排版之后又手动改了，
   *   `prevText.current !== text` 仍然成立，撤销会把**他自己刚写的字**一起抹掉。
   * ⚠ 栈 + 「只在值真的变了才入栈」两个约束一起才成立。
   */
  const undoStack = useRef([]);
  const pushUndo = (v) => {
    const st = undoStack.current;
    if (st.length && st[st.length - 1] === v) return;   // 同一份不重复入栈
    st.push(v);
    if (st.length > 20) st.shift();                      // 别无限涨
  };

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 1800); return () => clearTimeout(t); }, [toast]);

  useEffect(() => {
    setHits(findAll(text || '', needle));
    setCursor(0);
  }, [needle, text]);

  const say = (m) => setToast(m);

  /** 在预览区里把命中处滚到视野中 */
  const jumpTo = (idx) => {
    if (!hits.length) return;
    const el = document.querySelector('[data-doc-body]');
    if (!el) { say(`找到 ${hits.length} 处（预览模式下不能定位）`); return; }
    // ⚠ 按字符下标换算成节点位置：找到包含它的文本节点
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let acc = 0; let node = walker.nextNode(); let target = null;
    while (node) {
      const len = node.nodeValue.length;
      if (idx < acc + len) { target = node; break; }
      acc += len; node = walker.nextNode();
    }
    if (!target) return;
    const range = document.createRange();
    range.setStart(target, idx - acc);
    range.setEnd(target, Math.min(target.nodeValue.length, idx - acc + (needle.length || 1)));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // 滚到视野中间
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollTop += (r.top - box.top) - box.height / 3;
  };

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      say(`已复制全文（${(text || '').length} 字）`);
    } catch (_) { say('复制失败：浏览器不让访问剪贴板'); }
  };

  const doTypeset = () => {
    pushUndo(text || '');
    onChange(typeset(text || ''));
    say('已排版（去空格 / 压缩空行 / 首行缩进）· 记得保存');
  };

  const counts = useMemo(() => countPunct(text || '', rules), [text, rules]);
  const total = counts.reduce((a, b) => a + b, 0);

  const doReplace = () => {
    if (!total) { say('没有可替换的标点'); return; }
    pushUndo(text || '');
    onChange(applyPunct(text || '', rules));
    setShowPunct(false);
    say(`已替换 ${total} 处 · 记得保存`);
  };

  const addRule = () => {
    if (!newFrom || !newTo) { say('从与到都要填'); return; }
    setRules((r) => [...r, { from: newFrom, to: newTo }]);
    setNewFrom(''); setNewTo('');
  };

  const undo = () => {
    const st = undoStack.current;
    if (!st.length) { say('没有可撤销的操作'); return; }
    const prev = st.pop();
    onChange(prev);
    say('已撤销');
  };

  const Btn = ({ onClick, title, children, disabled }) => (
    <button
      onClick={onClick} title={title} disabled={disabled}
      className="px-1.5 py-1 rounded text-[12px] disabled:opacity-30"
      style={{ color: 'var(--ink-soft)' }}
    >{children}</button>
  );

  return (
    <div className="shrink-0 border-b" style={{ borderColor: 'var(--line)' }}>
      {/* ---------- 书名栏 ---------- */}
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ background: 'var(--paper-2)' }}
      >
        <span className="text-[14px]" aria-hidden="true">📖</span>
        <span className="font-semibold text-[14px] truncate"
              style={{ color: 'var(--ink)' }} title={bookTitle}>
          {bookTitle || '未命名'}
        </span>
        <div className="flex-1" />
        <span className="text-[11px] truncate" style={{ color: 'var(--ink-soft)' }}>{toast}</span>
        <Btn onClick={() => setShowSearch((v) => !v)} title="在本文档里查找并跳转"><TIcon d={I_SEARCH} /></Btn>
        <Btn onClick={doTypeset} title="一键排版（去空格、压缩空行、首行缩进）"><TIcon d={I_TYPESET} /></Btn>
        <Btn onClick={() => setShowPunct(true)} title="替换标点"><TIcon d={I_PUNCT} /></Btn>
        <Btn onClick={doCopy} title="复制全文"><TIcon d={I_COPY} /></Btn>
        <Btn onClick={undo} title="撤销上一次批量修改"><TIcon d={I_UNDO} /></Btn>
      </div>

      {/* ---------- 搜索条 ---------- */}
      {showSearch && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-t"
          style={{ borderColor: 'var(--line)' }}
        >
          <input
            autoFocus
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="查找本文档…"
            className="flex-1 px-2 py-1 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setCursor((c) => (hits.length ? (c + 1) % hits.length : 0)); if (hits.length) jumpTo(hits[(cursor + 1) % hits.length]); }
              if (e.key === 'Escape') setShowSearch(false);
            }}
          />
          <span className="text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
            {needle ? (hits.length ? `${cursor + 1} / ${hits.length}` : '无结果') : ''}
          </span>
          <Btn onClick={() => { if (hits.length) { setCursor((cursor - 1 + hits.length) % hits.length); jumpTo(hits[(cursor - 1 + hits.length) % hits.length]); } }}
              disabled={!hits.length} title="上一个">↑</Btn>
          <Btn onClick={() => { if (hits.length) { setCursor((cursor + 1) % hits.length); jumpTo(hits[(cursor + 1) % hits.length]); } }}
              disabled={!hits.length} title="下一个">↓</Btn>
        </div>
      )}

      {/* ---------- 替换标点 ---------- */}
      {showPunct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,.3)' }}
          onClick={() => setShowPunct(false)}
        >
          <div
            className="rounded-lg w-full max-w-md p-5"
            style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold mb-2" style={{ color: 'var(--ink)' }}>
              替换标点规则
            </div>
            <div className="text-[13px] mb-4" style={{ color: 'var(--accent)' }}>
              将替换 {total} 处
            </div>

            <div className="text-[12px] mb-2" style={{ color: 'var(--ink-soft)' }}>默认规则</div>
            <div className="space-y-1.5 mb-4 max-h-[240px] overflow-y-auto">
              {rules.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px]">
                  <span className="flex-1 px-2 py-1 rounded text-center"
                        style={{ background: 'var(--paper-2)', color: 'var(--ink)', border: '1px solid var(--line)' }}>
                    {r.from}
                  </span>
                  <span style={{ color: 'var(--ink-soft)' }}>→</span>
                  <span className="flex-1 px-2 py-1 rounded text-center"
                        style={{ background: 'var(--paper-2)', color: 'var(--ink)', border: '1px solid var(--line)' }}>
                    {r.to}
                  </span>
                  <span className="text-[11.5px] w-10 text-right" style={{ color: counts[i] ? 'var(--ink-soft)' : 'var(--line)' }}>
                    {counts[i]} 处
                  </span>
                </div>
              ))}
            </div>

            <div className="text-[12px] mb-2" style={{ color: 'var(--ink-soft)' }}>添加规则</div>
            <div className="flex items-center gap-2 mb-5">
              <input value={newFrom} onChange={(e) => setNewFrom(e.target.value)}
                     placeholder="从"
                     className="w-20 px-2 py-1 rounded text-[13px] outline-none"
                     style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }} />
              <span style={{ color: 'var(--ink-soft)' }}>→</span>
              <input value={newTo} onChange={(e) => setNewTo(e.target.value)}
                     placeholder="到"
                     className="w-20 px-2 py-1 rounded text-[13px] outline-none"
                     style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }} />
              <button onClick={addRule} className="w-7 h-7 rounded-full text-[15px] text-white"
                      style={{ background: 'var(--accent)' }} title="添加">+</button>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button onClick={() => setShowPunct(false)} className="px-3 py-1.5 text-[13px]"
                      style={{ color: 'var(--accent)' }}>取消</button>
              <button onClick={doReplace} disabled={!total} className="px-4 py-1.5 rounded-full text-[13px] disabled:opacity-40"
                      style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>替换</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
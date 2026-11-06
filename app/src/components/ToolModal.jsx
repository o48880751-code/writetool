import { useState } from 'react';

/**
 * 快捷工具的弹窗（起名 / 脑洞 / 灵感碎片，2026-11-03）。
 *
 * ## 为什么三个工具共用一个组件
 *
 * 羽毛菌的原话：「起名，脑洞，灵感碎片都应该做单独的交互而不是和备忘录一样」。
 * 他说的是**不要那个"打开一个 md 文件随便写"的通用模板**，
 * 而不是"三个界面必须长得不一样"。
 *
 * 看一眼三者其实同构：
 *   填几个字段 → 点按钮 → 模型给一段结果 → 改一改 → 存进项目文件。
 * 差别只在**字段表**和**动作**（灵感碎片有两个动作）。
 * 所以做成"一份骨架 + 三套配置"，改一处布局三个都受益；
 * 分成三个组件的话，同样的 bug 要修三遍。
 *
 * ## 与备忘录的区别
 *
 * 备忘录是**纯手写**（一个 textarea，存了就行）。
 * 这三个是**人给方向、模型出初稿**——所以必须先有表单，
 * 让用户把"要什么"说清楚，否则生成的东西跟他想的没关系。
 */

const KINDS = [
  { id: 'person', label: '人物' },
  { id: 'place', label: '地名' },
  { id: 'skill', label: '功法' },
  { id: 'sect', label: '门派' },
  { id: 'item', label: '法宝' },
];

const MODES = {
  name: {
    title: '起名',
    sub: '给人物、地点、功法起名。填得越具体，名字越贴。',
    file: '起名备忘.md',
    maxW: 720,
    fields: [
      { key: 'kind', type: 'chips', label: '要起什么名', options: KINDS, def: 'person' },
      { key: 'count', type: 'num', label: '要几个', def: 8, min: 1, max: 20 },
      { key: 'seed', type: 'text', label: '基础灵感（选填）', ph: '比如：姓沈、带雪、气质偏冷' },
      { key: 'must', type: 'text', label: '额外要求（选填）', ph: '比如：避开「云、天、龙」，不要叠字' },
    ],
    actions: [{ key: 'gen', label: '生成候选', primary: true }],
    resultPh: '生成的名字会出现在这里，可以直接改、删掉不喜欢的',
    saveLabel: '存进起名备忘',
  },
  brain: {
    title: '脑洞',
    sub: '一句话想法，展开成能往下写的剧情设计（走向 / 反转 / 伏笔 / 风险）。',
    file: '脑洞.md',
    maxW: 780,
    fields: [
      { key: 'idea', type: 'area', label: '我的想法', ph: '一句话就行，比如：主角重生回高三，带着满级记忆', rows: 3, required: true },
      { key: 'direction', type: 'text', label: '想往哪走（选填）', ph: '比如：爽感、悬疑、抒情' },
      { key: 'avoid', type: 'text', label: '不要碰（选填）', ph: '比如：不要后宫、不要无敌流' },
    ],
    actions: [{ key: 'gen', label: '帮我展开', primary: true }],
    resultPh: '展开的剧情设计会出现在这里，可以直接改',
    saveLabel: '存进脑洞.md',
  },
  idea: {
    title: '灵感碎片',
    sub: '随手写一句，别怕乱。可以让它整理清楚，也可以让它扩散成几个方向。',
    file: '灵感碎片.md',
    maxW: 720,
    fields: [
      { key: 'text', type: 'area', label: '灵感', ph: '一句台词、一个画面、一个念头都行', rows: 4, required: true },
    ],
    /**
     * ⚠ 两个动作**不是主次关系**：
     *   整理是"把我说的话理清楚"（不该创作），
     *   扩散是"从这条灵感长出去"（必须创作）。
     *   所以两个都给主按钮样式，但左边那个更常用 →
     *   视觉上主色只给「AI 整理」，扩散用次级样式（见渲染处的 ghost）。
     */
    actions: [
      { key: 'tidy', label: 'AI 整理', primary: true },
      { key: 'expand', label: '扩散成方向', ghost: true },
    ],
    resultPh: '整理 / 扩散的结果会出现在这里，可以直接改',
    saveLabel: '存进灵感碎片',
  },
};

const inputStyle = () => ({
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
  outline: 'none',
});

function defaults(cfg) {
  const o = {};
  for (const f of cfg.fields) o[f.key] = f.def != null ? f.def : '';
  return o;
}

export default function ToolModal({ mode, projectId, genre, onClose, onToast, onSaved }) {
  const cfg = MODES[mode] || MODES.name;
  const [form, setForm] = useState(() => defaults(cfg));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const requiredOk = cfg.fields.every((f) => !f.required || String(form[f.key] || '').trim());

  const run = async (action) => {
    setBusy(action);
    setErr('');
    try {
      const r = await window.api.tool.gen({
        mode,
        action,
        /**
         * ⚠ genre 是**当前项目题材**，从外面传进来而不是让用户再选一次：
         *   同一本书里起名、想脑洞，题材是已知事实，再问一遍是浪费。
         */
        fields: { ...form, genre },
      });
      setResult(r && r.text ? r.text : '');
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    const text = result.trim();
    if (!text) { setErr('结果还是空的，先生成或自己写点东西'); return; }
    setBusy('save');
    setErr('');
    try {
      const path = cfg.file;
      let prev = '';
      /**
       * ⚠ 没有 `fs.exists` 这个通道 —— 主进程只提供 read/write。
       *   用"读得到就是存在"来判断，和 App 里 `fileExists` 是同一套语义。
       *   （写 `window.api.fs.exists(...)` 会直接是 undefined 调用 → 保存时炸。）
       */
      let has = false;
      try {
        const doc = await window.api.fs.read({ projectId, path });
        prev = String((doc && doc.content) || '');
        has = true;
      } catch (_) {
        has = false;
      }
      if (!has) {
        prev = `# ${cfg.title}\n\n> 由「${cfg.title}」工具生成，可按需删改。\n`;
      }
      /**
       * ⚠ **追加**而不是覆盖：同一个工具会被用很多次，
       *   每次覆盖等于把上一次的想法删掉。中间插一条分隔线 + 时间，
       *   翻回去能看出"哪批是哪个时候想的"。
       */
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
      const next = `${prev.replace(/\s+$/, '')}\n\n---\n\n### ${stamp}\n\n${text}\n`;
      await window.api.fs.write({ projectId, path, content: next });
      onToast?.(`已追加到 ${path}`);
      onSaved?.();
    } catch (e) {
      setErr(`保存失败：${e.message}`);
    } finally {
      setBusy('');
    }
  };

  return (
    /**
     * ⚠ 遮罩**不绑 onClick**：CoverModal 那次栽过 ——
     *   点输入框外一点点就把整页关了，刚填的东西全没。
     *   唯一的出口是左上角「返回」。
     */
    <div
      className="modal-mask fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.42)' }}
      data-testid="tool-modal"
      data-mode={mode}
    >
      <div
        className="modal-card rounded-2xl flex flex-col"
        style={{
          width: cfg.maxW,
          maxWidth: '92vw',
          maxHeight: '88vh',
          background: 'var(--paper)',
          border: '1px solid color-mix(in srgb, var(--ink) 8%, transparent)',
          boxShadow: '0 24px 64px -12px rgba(0,0,0,.28)',
        }}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="tool-modal-back"
            className="shrink-0 flex items-center justify-center rounded-lg"
            style={{
              width: 30, height: 30, background: 'var(--paper-2)',
              color: 'var(--ink-soft)', border: 'none', cursor: 'pointer', fontSize: 14,
            }}
            title="返回"
          >
            ←
          </button>
          <div className="min-w-0">
            <div className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>{cfg.title}</div>
            <div className="text-[11.5px] mt-0.5 leading-snug" style={{ color: 'var(--ink-soft)' }}>
              {cfg.sub}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-5">
          {/* 字段 */}
          <div className="flex flex-col gap-3.5 mt-2">
            {cfg.fields.map((f) => (
              <div key={f.key}>
                <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'var(--ink-soft)' }}>
                  {f.label}
                  {f.required && <span style={{ color: 'var(--accent)' }}> *</span>}
                </div>
                {f.type === 'chips' ? (
                  <div className="flex flex-wrap gap-1.5">
                    {(f.options || []).map((o) => {
                      const on = form[f.key] === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          data-testid={`tool-${f.key}-${o.id}`}
                          onClick={() => setField(f.key, o.id)}
                          className="px-3 py-1.5 rounded-full text-[12px]"
                          style={{
                            background: on ? 'var(--ink)' : 'var(--paper-2)',
                            color: on ? 'var(--paper)' : 'var(--ink-soft)',
                            border: `1px solid ${on ? 'transparent' : 'var(--line)'}`,
                            cursor: 'pointer',
                          }}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                ) : f.type === 'num' ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      data-testid={`tool-${f.key}`}
                      min={f.min}
                      max={f.max}
                      value={form[f.key]}
                      onChange={(e) => setField(f.key, e.target.value)}
                      style={{ ...inputStyle(), width: 88 }}
                    />
                    <span className="text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>个</span>
                  </div>
                ) : f.type === 'area' ? (
                  <textarea
                    data-testid={`tool-${f.key}`}
                    rows={f.rows || 3}
                    value={form[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={f.ph}
                    spellCheck={false}
                    style={{ ...inputStyle(), resize: 'vertical', lineHeight: 1.7 }}
                  />
                ) : (
                  <input
                    data-testid={`tool-${f.key}`}
                    value={form[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={f.ph}
                    spellCheck={false}
                    style={inputStyle()}
                  />
                )}
              </div>
            ))}
          </div>

          {/* 动作 */}
          <div className="flex items-center gap-2 mt-4">
            {cfg.actions.map((a) => (
              <button
                key={a.key}
                type="button"
                data-testid={`tool-run-${a.key}`}
                onClick={() => run(a.key)}
                disabled={!!busy || !requiredOk}
                className="px-4 py-2 rounded-full text-[12.5px] font-medium disabled:opacity-40"
                style={a.ghost ? {
                  background: 'var(--paper-2)', color: 'var(--ink)',
                  border: '1px solid var(--line)', cursor: busy ? 'default' : 'pointer',
                } : {
                  background: 'var(--ink)', color: 'var(--paper)',
                  border: 'none', cursor: busy ? 'default' : 'pointer',
                }}
              >
                {busy === a.key ? '正在想…' : a.label}
              </button>
            ))}
            {!requiredOk && (
              <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                先填带 * 的那一项
              </span>
            )}
            {err && (
              <span className="text-[11.5px] leading-snug" style={{ color: 'var(--danger)' }}>{err}</span>
            )}
          </div>

          {/* 结果 */}
          <div className="mt-4">
            <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'var(--ink-soft)' }}>
              结果（可以直接改）
            </div>
            <textarea
              data-testid="tool-result"
              value={result}
              onChange={(e) => setResult(e.target.value)}
              placeholder={cfg.resultPh}
              spellCheck={false}
              rows={10}
              style={{ ...inputStyle(), resize: 'vertical', lineHeight: 1.75, minHeight: 180 }}
            />
          </div>
        </div>

        {/* 底部：保存 */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-6 py-3.5"
          style={{ borderTop: '1px solid var(--line)' }}
        >
          <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
            会追加到 <code style={{ fontFamily: 'ui-monospace, monospace' }}>{cfg.file}</code>，不会覆盖之前的内容
          </span>
          <button
            type="button"
            data-testid="tool-save"
            onClick={save}
            disabled={!!busy || !result.trim()}
            className="px-4 py-2 rounded-full text-[12.5px] disabled:opacity-40"
            /**
             * ⚠ 和「生成」一样用近黑，不用强调色。
             *   2026-11-03 已经把书架的主按钮从 accent 蓝改成 ink ——
             *   再在这里留一个蓝色主按钮，就变成同一套界面里两种"主色"。
             *   强调色现在只用于选中态和进度（信息性），不再用于操作。
             */
            style={{ background: 'var(--ink)', color: 'var(--paper)', border: 'none', cursor: 'pointer' }}
          >
            {busy === 'save' ? '保存中…' : cfg.saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

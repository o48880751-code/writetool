import { useEffect, useState } from 'react';

/** 右栏：设置。分「运行」与「外观」两块——模型相关的一切都在运行块。 */
export default function SettingsPanel({ config, onConfigChange, ollama, projectId }) {
  const [local, setLocal] = useState(config || {});
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLocal(config || {}); }, [config]);

  const save = async (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    const saved = await window.api.config.set(patch);
    onConfigChange?.(saved);
    if (patch.model || patch.ollamaBase || patch.numCtx) check();
  };

  const check = async () => {
    setBusy(true);
    setStatus(await window.api.ollama.check());
    setBusy(false);
  };

  useEffect(() => { check(); /* eslint-disable-next-line */ }, []);

  const ok = status && status.ok;

  return (
    <aside className="h-full overflow-y-auto border-l"
           style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--line)' }}>
        <h2 className="text-[13px] font-semibold">设置</h2>
      </div>

      {/* ---- 运行 ---- */}
      <Section title="运行">
        <Row label="Ollama">
          <div className="flex items-center gap-2">
            <span className="text-[12px] flex-1"
                  style={{ color: ok ? 'var(--ok)' : 'var(--danger)' }}>
              {busy ? '检测中…'
                : ok ? `已连接 v${status.version}（${status.models.length} 个模型）`
                : status?.error || '未连接'}
            </span>
            <MiniBtn onClick={check}>重测</MiniBtn>
          </div>
        </Row>

        <Row label="服务地址">
          <Input
            value={local.ollamaBase || ''}
            onChange={(v) => save({ ollamaBase: v })}
            placeholder="http://127.0.0.1:11434"
          />
        </Row>

        <Row label="模型">
          <select
            value={local.model || ''}
            onChange={(e) => save({ model: e.target.value })}
            className="w-full px-2 py-1 rounded text-[12px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          >
            {(status?.models || [local.model].filter(Boolean)).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Row>

        <Row label="上下文窗口">
          <div className="flex items-center gap-2">
            <input
              type="range" min="2048" max="32768" step="1024"
              value={local.numCtx || 8192}
              onChange={(e) => save({ numCtx: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[11px] tabular-nums w-12 text-right">
              {local.numCtx}
            </span>
          </div>
          <Hint text="超出会被上下文治理自动压缩。低于 4096 容易生成失败。" />
        </Row>

        <Row label="创造性">
          <div className="flex items-center gap-2">
            <input
              type="range" min="0" max="1" step="0.05"
              value={local.temperature ?? 0.3}
              onChange={(e) => save({ temperature: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[11px] tabular-nums w-8 text-right">
              {(local.temperature ?? 0.3).toFixed(2)}
            </span>
          </div>
          <Hint text="续写建议 0.2~0.4；越高越有创意但越容易跑偏设定。" />
        </Row>
      </Section>

      {/* ---- 外观 ---- */}
      <Section title="外观">
        <Row label="字号">
          <div className="flex items-center gap-2">
            <input
              type="range" min="12" max="24" step="1"
              value={local.fontSize || 16}
              onChange={(e) => save({ fontSize: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[11px] tabular-nums w-8 text-right">{local.fontSize}</span>
          </div>
        </Row>
        <Row label="主题">
          <div className="flex gap-1.5">
            {['light', 'dark'].map((t) => (
              <button
                key={t}
                onClick={() => save({ theme: t })}
                className="flex-1 py-1.5 rounded text-[12px]"
                style={{
                  background: local.theme === t ? 'var(--accent)' : 'var(--accent-soft)',
                  color: local.theme === t ? '#fff' : 'var(--ink)',
                }}
              >
                {t === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </Row>
        <Row label="完成提示">
          <select
            value={local.notify || 'window'}
            onChange={(e) => save({ notify: e.target.value })}
            className="w-full px-2 py-1 rounded text-[12px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          >
            <option value="window">仅窗口</option>
            <option value="sound">仅提示音</option>
            <option value="both">窗口+提示音</option>
            <option value="none">不提示</option>
          </select>
        </Row>
      </Section>

      {/* ---- 设定库 ---- */}
      <Section title="设定库">
        <Row label="导入">
          <button
            onClick={async () => {
              const r = await window.api.settings.importBible({ projectId });
              if (!r.canceled) window.location.reload();
            }}
            disabled={!projectId}
            className="w-full py-1.5 rounded text-[12px] disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            从 JSON 导入
          </button>
          <Hint text="格式：{ entries: [{ project, type, name, note, aliases }] }" />
        </Row>
      </Section>

      {/* ---- 诊断 ---- */}
      <Section title="诊断">
        <AppInfo />
      </Section>
    </aside>
  );
}

function AppInfo() {
  const [info, setInfo] = useState(null);
  useEffect(() => { window.api.app.info().then(setInfo); }, []);
  if (!info) return <Hint text="读取中…" />;
  return (
    <div className="text-[11px] space-y-1" style={{ color: 'var(--ink-soft)' }}>
      <div>Electron {info.electron} · Node {info.node}</div>
      <div className="break-all">数据：{info.dbPath}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-b" style={{ borderColor: 'var(--line)' }}>
      <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide"
           style={{ color: 'var(--ink-soft)' }}>
        {title}
      </div>
      <div className="px-4 pb-3 space-y-3">{children}</div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div>
      <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>{label}</div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-2 py-1 rounded text-[12px] outline-none"
      style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
    />
  );
}

function MiniBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded text-[11px]"
      style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
    >
      {children}
    </button>
  );
}

function Hint({ text }) {
  return (
    <div className="text-[10px] mt-1 leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
      {text}
    </div>
  );
}
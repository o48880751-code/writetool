/**
 * 风格面板 —— 第 3 步的去 AI 味引擎。
 *
 * ## 它显示什么
 *
 * 不是「AI 味打分」，是「**这段与你自己的历史正文差在哪**」。
 * 每一项都给三列：实测值 / 你的基准 / 修改建议。
 *
 * ## 为什么不给分数
 *
 * 「AI 味 72 分」对人没有任何行动价值——用户不知道该改什么。
 * 而「你的对话占比 12%，你平时是 31%」直接可用。
 *
 * ## 数据从哪来
 *
 * 全部来自用户自己已保存的章节正文（`style:profile`）。
 * **不含任何内置禁用词表**——开发时验证过：
 * 我记忆里的「著名 AI 腔套语」（眼中闪过 / 嘴角勾起 / 不由得 / 仿佛…一般）
 * 在 42 章真实模型输出里出现次数**全是 0**。靠列举套语找 AI 味行不通。
 */

const SEVERITY_COLOR = {
  high: 'var(--danger)',
  medium: 'var(--accent)',
  low: 'var(--ink-soft)',
};

const SEVERITY_LABEL = { high: '明显', medium: '略偏', low: '轻微' };

export default function StylePanel({ projectId, profile, result, onRefresh, onCheckCurrent, busy }) {
  if (!projectId) {
    return <Empty text="先选一个项目" />;
  }

  // 画像不可用 —— 这是正常状态，不是错误。用户还没保存过章节而已。
  if (!profile || profile.available === false) {
    return (
      <div>
        <Head />
        <Empty text={profile && profile.reason ? profile.reason : '还没有已保存的章节，风格基准只能来自你自己的历史正文'} />
        <div className="px-3 pb-3">
          <button
            onClick={onRefresh}
            className="w-full py-1.5 rounded text-[12px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          >
            重新检查
          </button>
        </div>
      </div>
    );
  }

  const confLabel = { high: '样本充足', medium: '样本偏少', low: '仅 1 篇' }[profile.confidence];
  const confColor = profile.confidence === 'high' ? 'var(--ink-soft)' : 'var(--accent)';

  return (
    <div>
      <Head
        right={
          <button onClick={onRefresh} disabled={busy} className="text-[11px] disabled:opacity-40"
                  style={{ color: 'var(--ink-soft)' }}>
            刷新
          </button>
        }
      />

      {/* 基准信息 */}
      <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
        基准取自你已保存的 <b style={{ color: 'var(--ink)' }}>{profile.sampleCount}</b> 章
        （{profile.totalChars} 字）·{' '}
        <span style={{ color: confColor }}>{confLabel}</span>
      </div>

      {/* 上次检测结果 */}
      {result && result.ok === false && (
        <Note>{result.error}</Note>
      )}

      {result && result.ok !== false && (
        <div className="px-3 pb-3">
          <div className="text-[11px] mb-2" style={{ color: 'var(--ink-soft)' }}>
            {result.summary}
          </div>

          {result.deviations.length === 0 && !result.tics.length && (
            <div className="text-[12px] py-3 text-center rounded"
                 style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
              未发现偏离
            </div>
          )}

          {result.deviations.map((d) => (
            <DeviationRow key={d.metric} d={d} />
          ))}

          {result.tics && result.tics.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>套语提示</div>
              <div className="flex flex-wrap gap-1">
                {result.tics.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded text-[11px]"
                        style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {result.skipped && result.skipped.length > 0 && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
              <div className="mb-1">未判定（样本不足，不报警）</div>
              {result.skipped.map((s) => (
                <div key={s.metric} className="truncate" title={s.reason}>
                  · {s.label} —— {s.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!result && (
        <div className="px-3 pb-3">
          <div className="text-[11px] mb-2" style={{ color: 'var(--ink-soft)' }}>
            生成结束后会自动检测。也可以手动检查当前章节。
          </div>
        </div>
      )}

      <div className="px-3 pb-3">
        <button
          onClick={onCheckCurrent}
          disabled={busy}
          className="w-full py-1.5 rounded text-[12px] disabled:opacity-40"
          style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
        >
          检查当前章节
        </button>
      </div>

      {/* 注入给模型的指令，让人知道它到底被告知了什么 */}
      {profile.directive && (
        <div className="px-3 pb-4">
          <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>
            已注入给模型的文风要求
          </div>
          <pre className="text-[11px] leading-relaxed whitespace-pre-wrap p-2 rounded"
               style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
            {profile.directive}
          </pre>
        </div>
      )}
    </div>
  );
}

function DeviationRow({ d }) {
  return (
    <div className="mb-2 p-2 rounded" style={{ background: 'var(--accent-soft)' }}>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[12px]" style={{ color: 'var(--ink)' }}>{d.label}</span>
        <span className="text-[11px]"
              style={{ color: SEVERITY_COLOR[d.severity] }}>
          {SEVERITY_LABEL[d.severity]}{d.direction === 'high' ? '偏高' : '偏低'}
        </span>
      </div>
      <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>
        实测 <b style={{ color: 'var(--ink)' }}>{d.value}</b>
        <span style={{ color: 'var(--ink-soft)' }}>{d.unit}</span>
        {' 你的基准 '}
        <b style={{ color: 'var(--ink)' }}>{d.baseline}</b>
        <span style={{ color: 'var(--ink-soft)' }}>{d.unit}</span>
      </div>
      <div className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>{d.advice}</div>
    </div>
  );
}

function Head({ children, right }) {
  return (
    <div className="flex items-center px-3 h-8 shrink-0"
         style={{ color: 'var(--ink)' }}>
      <span className="text-[12px] font-medium">文风</span>
      {children}
      <div className="flex-1" />
      {right}
    </div>
  );
}

function Note({ children }) {
  return (
    <div className="px-3 pb-3 text-[11px]"
         style={{ color: 'var(--ink-soft)' }}>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return (
    <div className="px-3 pb-3">
      <div className="text-[11px] leading-relaxed rounded p-2"
           style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
        {text}
        <div className="mt-1">
          风格基准全部来自你自己写过的正文——不内置禁用词表，
          因为那套词在实测里对模型输出几乎无效。
        </div>
      </div>
    </div>
  );
}
/**
 * 设置页的 UI 原语。
 *
 * ## 为什么要单独一个文件
 *
 * 2026-10-12 把「AI 提供商」与「Skill」两个类目拆成了独立组件文件，
 * 但它们都要用同一套 Group / Field / Hint。
 *
 * 当时的选择有两个：
 *   a) 把这几个复制到两个新文件里——三份，改一处漏两处
 *   b) 留一个 settings-ui.jsx 出来让两边 import
 *
 * 选 b。这类组件加起来不到 50 行，重复三份的成本是
 * 「改了一次主题间距，界面上三个地方长得不一样」。
 *
 * ⚠ 它们用 CSS 变量（var(--ink) 等），所以跟随主题自动变，
 *   不需要额外传 theme。
 */

export function H1({ children }) {
  return <h1 className="text-[17px] font-semibold mb-4">{children}</h1>;
}

export function Group({ title, children }) {
  return (
    <section className="mb-6">
      <div className="text-[11px] font-semibold mb-2.5" style={{ color: 'var(--ink-soft)' }}>
        {title}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Field({ label, children }) {
  return (
    <div>
      <div className="text-[12.5px] mb-1.5">{label}</div>
      {children}
    </div>
  );
}

export function Hint({ children, warn }) {
  return (
    <div
      className="text-[11.5px] leading-relaxed mt-1.5"
      style={{ color: warn ? 'var(--danger)' : 'var(--ink-soft)' }}
    >
      {children}
    </div>
  );
}

/**
 * 连接状态点。
 *
 * ⚠ 三态而不是两态：
 *   ok    绿 —— 刚测过，能连上
 *   bad   红 —— 测过，连不上
 *   空     灰 —— **还没测过**
 *
 * 只做两态的话，"还没测"和"连不上"会显示成同一个红点，
 * 用户刚打开设置就看到一片红，会以为全坏了。
 */
export function StatusDot({ ok, busy, idle }) {
  const color = busy ? 'var(--ink-soft)' : ok ? 'var(--ok)' : idle ? 'var(--ink-soft)' : 'var(--danger)';
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{
        background: color,
        animation: busy ? 'pulse 1s ease-in-out infinite' : 'none',
      }}
    />
  );
}
import { useState, useEffect, useRef } from 'react';

/**
 * 《用户协议》确认弹窗。
 *
 * ## 它出现的时机
 *
 * 范围守卫第一次拦到"涉及法律 / 道德伦理的具体做法"时，主进程会把这次拦截连同一个
 * **一次性令牌**一起返回（`blocked:'warn'` + `needAgreement:true` + `agreementToken`）。
 * 用户勾选同意 → 界面带着令牌把**同一条**重发一次 → 主进程放行（且不再重复记警告）。
 * 不勾选 / 取消 → 这条内容不会被发送。
 *
 * ⚠⚠ 这里**不做任何判定**：能不能放行由主进程说了算，界面只是把协议摆出来、
 *   收集一个勾选。判定写在渲染层等于没写（羽毛菌：防止提示词破解软件）。
 *
 * ⚠ 弹窗必须能被"看不见/被裁掉"的判据量到，所以每个关键节点都留了 data-testid。
 *
 * `readOnly` = 只是"查看全文"（设置页里那个按钮用），没有勾选框，主按钮是「关闭」。
 * ⚠ 两种模式共用一个组件，是为了让**协议正文只存在一处**——
 *   复制一份到别处，两边迟早不一致，而用户看到的协议必须是真在约束他的那一份。
 */
export default function AgreementModal({ open, version, text, reason, busy, readOnly, onAgree, onCancel }) {
  const [checked, setChecked] = useState(false);
  const boxRef = useRef(null);
  const scrollerRef = useRef(null);

  // ⚠ 每次打开都要复位：上一次勾过，这次进来还是勾上的话，
  //   「勾选才能继续」就等于没有。
  useEffect(() => {
    if (open) {
      setChecked(false);
      const t = setTimeout(() => {
        if (boxRef.current) boxRef.current.focus();
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
      }, 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.42)' }}
      // ⚠ 点遮罩 = 取消（等同于"不勾选就不发"），但**不能**当"同意"
      onClick={onCancel}
      data-testid="agreement-modal"
    >
      <div
        className="max-w-2xl w-full rounded-lg p-5 flex flex-col gap-3"
        style={{
          // ⚠ 浮层用 --float：开了自定义背景时它是**完全不透明**的原纸色，
          //   用 --paper 会变成半透明，背后的大字透上来根本读不成协议。
          background: 'var(--float)',
          border: '1px solid var(--line)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px]">📕</span>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
          {readOnly ? '《用户协议》全文' : '请先阅读并同意《用户协议》'}
        </div>
        </div>

        {reason && (
          <div
            className="text-[12px] leading-relaxed rounded px-2.5 py-2"
            style={{ background: 'var(--accent-soft)', color: 'var(--danger)' }}
            data-testid="agreement-reason"
          >
            {reason}
          </div>
        )}

        {/* 协议正文：可滚动。⚠ 必须自己管高度，别让长文把按钮顶出屏幕。 */}
        <div
          ref={scrollerRef}
          className="text-[12px] leading-[1.75] rounded px-3 py-2 overflow-y-auto"
          style={{
            background: 'var(--paper-2)',
            border: '1px solid var(--line)',
            color: 'var(--ink-soft)',
            maxHeight: '46vh',
            whiteSpace: 'pre-wrap',
          }}
          data-testid="agreement-text"
        >
          {text || '（协议内容没取到）'}
        </div>

        {!readOnly && (
          <label
            className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none"
            style={{ color: 'var(--ink)' }}
          >
            <input
              ref={boxRef}
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              style={{ marginTop: 2 }}
              data-testid="agreement-checkbox"
            />
            <span>我已完整读过上面这份协议，同意遵守其中的约定（版本 {version || '—'}）。</span>
          </label>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded text-[12.5px]"
            style={{ border: '1px solid var(--line)', color: 'var(--ink-soft)' }}
            onClick={onCancel}
            data-testid="btn-agree-cancel"
          >
            {readOnly ? '关闭' : '取消（这条不发送）'}
          </button>
          {!readOnly && (
            <button
              className="px-3 py-1.5 rounded text-[12.5px]"
              style={{
                background: checked ? 'var(--accent)' : 'var(--paper-2)',
                color: checked ? 'var(--accent-ink)' : 'var(--ink-soft)',
                border: '1px solid var(--line)',
                cursor: checked && !busy ? 'pointer' : 'not-allowed',
              }}
              // ⚠⚠ 没勾选就不给点：这是"要求其遵守用户协议，并勾选同意确认"的字面意思。
              //   只在文案里写一句"请遵守"、按钮却照常能点，等于没要求。
              disabled={!checked || busy}
              onClick={() => { if (checked && !busy) onAgree(); }}
              data-testid="btn-agree"
            >
              {busy ? '发送中…' : '同意并继续'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
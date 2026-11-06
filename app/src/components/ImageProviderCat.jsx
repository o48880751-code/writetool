import { useState, useEffect } from 'react';
import { Group, Field, Hint } from './settings-ui.jsx';

/**
 * 「封面生图」配置块（2026-11-02）。
 *
 * 挂在「AI 提供商」页的**下面**，和上面的文本连接是**两套东西**：
 * 上面那张表决定"谁来写字"，这一块决定"谁来画图"。
 * 合在一起会让用户以为选了 qwen-image 就能聊天 —— 那是必 400 的。
 *
 * ## 为什么只有一个「试一下」，没有「检查连接」
 *
 * 生图没有统一的 `/models` 端点（百炼和方舟都不是 OpenAI 那套）。
 * ping 通不代表模型名对、尺寸那家认。所以验证方式只有一个：
 * **真的画一张**。成了就是成了，出图直接显示出来给他看。
 *
 * ⚠ 这一个动作会把「地址 / 模型 / 尺寸 / 密钥」一起验证掉。
 */
export default function ImageProviderCat({ onToast }) {
  const [presets, setPresets] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [tried, setTried] = useState(null);
  const [err, setErr] = useState('');

  const reload = async () => {
    const [ps, c] = await Promise.all([
      window.api.image.presets(),
      window.api.image.get(),
    ]);
    setPresets(ps || []);
    setCfg(c);
  };

  useEffect(() => { reload().catch((e) => setErr(e.message || String(e))); }, []);

  if (err && !cfg) {
    return (
      <>
        <div className="mt-8 pt-5" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="text-[17px] font-semibold mb-2">封面生图</div>
          <div className="text-[12px]" style={{ color: 'var(--danger)' }}>读不到配置：{err}</div>
        </div>
      </>
    );
  }
  if (!cfg) return null;

  const preset = presets.find((p) => p.key === cfg.providerKey) || presets[0] || {};
  const isCustom = preset.key === 'custom';

  const pick = async (k) => {
    setBusy('preset');
    try {
      await window.api.image.save({ providerKey: k });
      setTried(null);
      await reload();
    } catch (e) {
      onToast && onToast(`切换失败：${e.message || e}`);
    } finally { setBusy(''); }
  };

  /** 先把界面上改的东西存下去（换服务商会把 base/model/size 清回默认，所以顺序要对） */
  const saveAll = async () => {
    await window.api.image.save({
      base: cfg.base,
      model: cfg.model,
      size: cfg.size,
    });
    if (key.trim()) {
      await window.api.image.setKey({ key: key.trim() });
      setKey('');
    }
    await reload();
  };

  const doSave = async () => {
    setBusy('save');
    setErr('');
    try {
      await saveAll();
      onToast && onToast('生图配置已保存');
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(''); }
  };

  const doTry = async () => {
    setBusy('try');
    setErr('');
    setTried(null);
    try {
      await saveAll();
      const r = await window.api.image.tryOne({});
      setTried(r);
      onToast && onToast(`画好了：${r.model} · ${(r.ms / 1000).toFixed(1)} 秒`);
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(''); }
  };

  const inputStyle = {
    background: 'var(--paper-2)',
    border: '1px solid color-mix(in srgb, var(--ink) 12%, transparent)',
    color: 'var(--ink)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12.5,
    width: '100%',
    outline: 'none',
  };

  return (
    <div className="mt-9 pt-6" style={{ borderTop: '1px solid var(--line)' }}>
      <div className="text-[17px] font-semibold mb-1">封面生图</div>
      <div className="text-[11.5px] mb-4 leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
        只用来画**小说封面**。它和上面的文本连接互不影响 ——
        这里选的模型不会出现在对话的模型列表里。
        <br />
        这里只负责**配好并验证**；真正生成封面在
        <b style={{ color: 'var(--ink)' }}> 主界面的快捷工具栏 → 封面</b>。
      </div>

      {/* ---------- 服务商 ---------- */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {presets.map((p) => {
          const on = p.key === preset.key;
          return (
            <button
              key={p.key}
              type="button"
              data-testid={`img-preset-${p.key}`}
              disabled={busy === 'preset'}
              onClick={() => pick(p.key)}
              title={p.help || p.name}
              className="px-3 py-1.5 rounded-lg text-[12px]"
              style={{
                background: on ? 'var(--accent)' : 'var(--paper-2)',
                color: on ? 'var(--accent-ink)' : 'var(--ink-soft)',
                fontWeight: on ? 600 : 400,
                border: '1px solid transparent',
                cursor: 'pointer',
              }}
            >
              {p.name}
            </button>
          );
        })}
      </div>

      <Group title="连接">
        <Field label="接口地址">
          <input
            data-testid="img-base"
            value={cfg.base}
            onChange={(e) => setCfg({ ...cfg, base: e.target.value })}
            placeholder={preset.base || 'https://…/v1'}
            style={inputStyle}
            spellCheck={false}
          />
          {/**
            * ⚠ 显示**最终会请求的地址**（2026-11-02）。
            *   那天报 500 就是因为看不到它：完整端点被粘进上面那格，
            *   程序又拼了一次 /images/generations，实际打到了
            *   .../images/generations/images/generations。服务端只回一句
            *   「500 InternalServiceError」，没人能从中看出是地址重复。
            *   现在重复一眼可见 —— 这比任何错误提示都直接。
            */}
          {cfg.endpoint && (
            <div className="text-[10.5px] mt-1.5 leading-snug break-all"
                 data-testid="img-endpoint"
                 style={{ color: 'var(--ink-soft)', opacity: 0.8 }}>
              实际请求：{cfg.endpoint}
            </div>
          )}
        </Field>

        <Field label="模型">
          <div className="flex gap-2">
            <input
              data-testid="img-model"
              value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              placeholder={preset.defaultModel || '填模型名'}
              style={inputStyle}
              spellCheck={false}
            />
            {(preset.models || []).length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setCfg({ ...cfg, model: e.target.value }); }}
                className="shrink-0 px-2 rounded-lg text-[12px]"
                style={{
                  background: 'var(--paper-2)', color: 'var(--ink-soft)',
                  border: '1px solid color-mix(in srgb, var(--ink) 12%, transparent)',
                  maxWidth: 220,
                }}
                title="从常见模型里挑一个"
              >
                <option value="">常见模型…</option>
                {(preset.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </div>
        </Field>

        <Field label="API 密钥">
          <input
            data-testid="img-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={cfg.hasKey ? '已保存（留空就不改）' : '粘贴密钥'}
            style={inputStyle}
            spellCheck={false}
          />
        </Field>

        <Field label="尺寸（宽x高）">
          <input
            data-testid="img-size"
            value={cfg.size}
            onChange={(e) => setCfg({ ...cfg, size: e.target.value })}
            placeholder={preset.defaultSize}
            style={{ ...inputStyle, width: 180 }}
            spellCheck={false}
          />
        </Field>
      </Group>

      {/* 预付表里那家的说明 —— 都是"不知道就会踩"的具体坑 */}
      {preset.help && (
        <div className="mb-4">
          <Hint warn>{preset.help}</Hint>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          data-testid="img-save"
          onClick={doSave}
          disabled={!!busy}
          className="px-4 py-2 rounded-lg text-[12.5px] font-medium"
          style={{
            background: 'var(--paper-2)', color: 'var(--ink)',
            border: '1px solid color-mix(in srgb, var(--ink) 12%, transparent)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy === 'save' ? '保存中…' : '保存'}
        </button>

        <button
          type="button"
          data-testid="img-try"
          onClick={doTry}
          disabled={!!busy}
          className="px-4 py-2 rounded-lg text-[12.5px] font-medium"
          style={{
            background: 'var(--accent)', color: 'var(--accent-ink)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy === 'try' ? '正在测试…（可能要半分钟）' : '保存并测试'}
        </button>

        {isCustom && !cfg.base && (
          <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
            自定义服务得先把地址填上
          </span>
        )}
      </div>

      {err && (
        <div className="text-[11.5px] mb-3 px-3 py-2 rounded-lg leading-relaxed"
             style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)' }}>
          {err}
        </div>
      )}

      {/**
       * 测试结果只做**一行交代**，不做大图预览（2026-11-02 羽毛菌：
       * 「你画啥啊，画出来用处呢」）。这张图除了证明通道通，没有任何用处，
       * 让它占半个屏幕反而像"这就是产品"。
       */}
      {tried && (
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
             style={{ background: 'color-mix(in srgb, var(--ok, #2e7d32) 8%, transparent)' }}>
          <img
            src={tried.url}
            alt="测试图"
            data-testid="img-tried"
            style={{
              width: 44, height: 44, borderRadius: 8, objectFit: 'cover',
              border: '1px solid var(--line)', background: 'var(--paper-2)',
            }}
          />
          <div className="text-[11.5px] leading-snug" style={{ color: 'var(--ink)' }}>
            <div style={{ color: 'var(--ok, #2e7d32)', fontWeight: 600 }}>配通了</div>
            <div style={{ color: 'var(--ink-soft)' }}>
              {tried.model} · {(tried.ms / 1000).toFixed(1)} 秒 · 左上角那张只是测试图
            </div>
            <div style={{ color: 'var(--ink-soft)' }}>
              回主界面，快捷工具栏点「🖼️ 封面」就能给这本书生成封面。
            </div>
            {/* 尺寸被自动放大时必须说出来，不能悄悄改用户的设置 */}
            {tried.sizeNote && (
              <div style={{ color: 'var(--ink-soft)', opacity: 0.9 }}>
                {tried.sizeNote}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

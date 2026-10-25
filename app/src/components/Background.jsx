/**
 * 自定义背景：上传一张图片，替代整窗的白色底。
 *
 * ## 为什么单独一层而不是改 CSS 变量
 *
 * 图必须真的在所有面板**背后** —— 改颜色变量做不到这件事
 * （那只会让面板变半透明，背后还是空的）。
 *
 * ## 踩过的坑
 *
 * 1. **z-index 必须是最底层**，放进正常文档流会被主区盖住，表现为「设了没反应」。
 * 2. **图走 appbg 自定义协议，不转 dataURL** —— 好几 MB 的图 base64 之后常驻
 *    渲染进程内存，而它只需要被 CSS 引用一次。
 * 3. **协议必须 bypassCSP**，否则 CSP 的 img-src 会把它拦掉，
 *    表现是「图设了但完全不显示」，而设置页还显示已保存。
 * 4. ⚠⚠ `protocol.handle('appbg')` 必须写在 app ready **之后**（同 appfont），
 *    写在模块顶层会让整个 main.js 的加载中断、后面所有 handler 都不注册。
 *
 * ## 关于「改了设置立刻生效」
 *
 * `BackgroundLayer` 挂在 App 根部，它读的是 `useBackground()` 的 state，
 * 而那份 state 只在启动时从 `bg:get` 取一次。
 * ⚠ 光在设置页改配置是不够的 —— 必须广播 `BG_CHANGED` 让它重读，
 * 否则表现是「设置页显示已生效，整窗背景要重启才变」。
 */
import React, { useState, useEffect } from 'react';

const DEFAULTS = { enabled: false, url: '' };

/** 设置页改完背景后广播这个事件，让整窗的背景层重读配置。 */
export const BG_CHANGED = 'writetool:bg-changed';

export function useBackground() {
  const [bg, setBg] = useState(DEFAULTS);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await window.api.bg.get();
        if (alive && r) setBg({ ...DEFAULTS, ...r });
      } catch (_) { /* 拿不到就保持默认值，功能不该因此不可用 */ }
    };
    load();
    window.addEventListener(BG_CHANGED, load);
    return () => { alive = false; window.removeEventListener(BG_CHANGED, load); };
  }, []);

  /**
   * 把「有没有背景图」这件事挂到 `<body>` 的 class 上。
   *
   * ⚠⚠ 光铺一层图是**不够**的 —— 面板是不透明的 `--paper`，
   *   图只从"恰好没有背景色"的顶栏缝里露出来。
   *   真正让图透出来的是 CSS 里 `body.bg-photo { --paper: …66% }`
   *   （见 index.css 那一节），这里只负责开这个开关。
   *
   * ⚠ 放在这个 hook 里而不是 App 里：状态本来就在这儿，
   *   分两处迟早会出现"配置改了、class 没跟上"。
   */
  useEffect(() => {
    const on = !!(bg.enabled && bg.url);
    document.body.classList.toggle('bg-photo', on);
  }, [bg.enabled, bg.url]);

  return { bg, apply: setBg, setBg };
}

export function BackgroundLayer({ bg }) {
  if (!bg.enabled || !bg.url) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="bg-layer"
      style={{
        position: 'fixed',
        inset: 0,
        // ⚠⚠ 必须是 **-1**，不能是 0。
        //   定位元素（z-index:0 / auto）在绘制顺序里排在**普通流内容之后**，
        //   写 0 的话这张图会盖在所有面板上面 —— 界面看着像"整窗糊了一张图"。
        //   负 z-index 排在父级背景之后、所有普通流内容之前，才是"背景"。
        zIndex: -1,
        pointerEvents: 'none',
        backgroundImage: `url("${bg.url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}

/**
 * 设置页里的那一栏：勾选 + 选图 + 缩略预览 + 清除。
 *
 * ⚠ 没有模糊/通透/遮罩滑杆（2026-10-16 羽毛菌明确要求去掉）：
 *   这功能的定义就是「上传一张图替代白色底」，多一个滑杆就多一处要解释的地方。
 *   面板的透光度是 CSS 里固定的（`body.bg-photo` 里 66% / 60%），
 *   保证任何图铺上去字都还读得清。
 */
export function BackgroundSection({ bg, apply, onToast }) {
  const on = !!bg.enabled && !!bg.url;

  const save = (patch) => {
    const next = { ...bg, ...patch };
    apply(next);
    // ⚠ 落盘是异步的，等一拍再让整窗重读，否则会读到旧配置
    setTimeout(() => window.dispatchEvent(new Event(BG_CHANGED)), 60);
  };

  return (
    <div
      className="rounded-lg p-4"
      style={{
        border: '1px solid var(--line)',
        background: 'var(--paper-2)',
      }}
    >
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!bg.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
          style={{ width: 15, height: 15, accentColor: 'var(--accent)' }}
        />
        <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>
          自定义背景图片
        </span>
      </label>

      <div className="text-[12px] mt-1.5" style={{ color: 'var(--ink-soft)' }}>
        选一张图片铺满整个窗口，替代默认的纯色底。面板会保持半透明，字照常可读。
      </div>

      {bg.url && (
        <div
          className="mt-2.5 rounded overflow-hidden"
          style={{
            height: 84,
            border: '1px solid var(--line)',
            backgroundImage: `url("${bg.url}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: on ? 1 : 0.45,
          }}
        />
      )}

      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        <button
          onClick={async () => {
            try {
              const r = await window.api.bg.pick();
              if (!r || !r.ok) {
                if (r && r.canceled) return;
                onToast && onToast((r && r.error) || '没选中图片');
                return;
              }
              save({ url: r.url, enabled: true });   // 选了图就自动打开
              onToast && onToast('背景图已设置');
            } catch (e) {
              onToast && onToast('选择失败：' + e.message);
            }
          }}
          className="text-[12px] px-2.5 py-1 rounded-full"
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            border: '1px solid var(--line)',
          }}
        >
          {bg.url ? '换一张' : '选择图片'}
        </button>
        {bg.url && (
          <button
            onClick={() => save({ url: '', enabled: false })}
            className="text-[12px] px-2.5 py-1 rounded-full"
            style={{
              background: 'var(--paper)',
              color: 'var(--ink-soft)',
              border: '1px solid var(--line)',
            }}
          >
            清除
          </button>
        )}
      </div>
    </div>
  );
}

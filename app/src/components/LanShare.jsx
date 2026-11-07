import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';

/**
 * 局域网传文件面板（2026-11-06）。
 *
 * ## 它解决什么
 *
 * 羽毛菌的原话：「局域网共享就是互相传输文件啊，又不能操控」。
 * 所以这里不是"用平板远程操作电脑"，而是两台设备之间**传文件**：
 *   · 手机 / 平板扫码 → 浏览器打开 → 能下载项目里的 md
 *   · 手机上的文件 → 传进项目的「收件箱」
 * 手机端不装任何软件，这是这个方案最值钱的地方。
 *
 * ## 几个必须守住的点
 *
 * ⚠ **服务随面板启停**。打开才起服务，关掉立刻停 ——
 *   一个开机就监听端口的 HTTP 服务，用户根本不知道它在跑。
 * ⚠ 卸载时一定要 stop()：面板是被条件渲染的，用户点 ×、
 *   点遮罩、按 Esc 都会卸载，漏一处就变成"关了还在传"。
 * ⚠ 二维码内容里带 token，token 换了二维码必须跟着换（不是缓存一次就完）。
 */

/** 把一串文本画成 SVG 二维码。返回 svg 字符串（自己生成的，无外部输入） */
function makeQr(text) {
  try {
    // 0 = 自动选版本；M = 15% 容错，手机斜着扫也能过
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    // scalable：输出 viewBox 而不是固定像素，外面用 CSS 控制大小
    return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  } catch (_) {
    return '';
  }
}

export default function LanShare({ projectName, onClose, onReceived }) {
  const [state, setState] = useState({ phase: 'starting' });
  const [copied, setCopied] = useState(false);
  const [got, setGot] = useState([]);

  /**
   * ⚠ 用 ref 记住"这次挂载是否已经停过"，避免 StrictMode / 快速开关时
   *   stop 跑两遍（服务端 stop 是幂等的，但重复调用会多等 1 秒）。
   */
  const stopped = useRef(false);

  const boot = useCallback(async () => {
    setState({ phase: 'starting' });
    try {
      /**
       * ⚠⚠ 这里拿到的是**已经拆过外层信封的 data**，没有 `.ok`。
       *   preload 的 call() 在 handler 返 { ok:false } 时会直接 throw，
       *   所以失败走 catch，不需要在这里判 ok ——
       *   第一版写成 `if (!r.ok)`，结果永远判成失败，面板一直停在"启动失败"。
       */
      const d = await window.api.lan.start();
      if (!d || !d.token) throw new Error('服务没起来');
      setState({ phase: 'on', ...d, qr: d.url ? makeQr(d.url) : '' });
    } catch (e) {
      setState({ phase: 'error', error: e.message || String(e) });
    }
  }, []);

  useEffect(() => {
    stopped.current = false;
    boot();
    /** 手机传上来文件时，主进程推一条事件过来 */
    const off = window.api.lan.onEvent((e) => {
      if (!e) return;
      if (e.type === 'received') {
        setGot((prev) => [{ name: e.name, size: e.size, at: Date.now() }, ...prev].slice(0, 20));
        // 让外面的文件树刷新一下，「收件箱」里立刻能看到
        if (onReceived) onReceived(e);
      }
    });
    return () => {
      off();
      if (!stopped.current) {
        stopped.current = true;
        // ⚠ 不 await：卸载时不能再 setState，也不该让关闭动作等一秒
        window.api.lan.stop();
      }
    };
  }, [boot, onReceived]);

  const shut = async () => {
    stopped.current = true;
    await window.api.lan.stop();
    onClose();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.url || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_) { /* 剪贴板被拒就让用户自己选中复制 */ }
  };

  return (
    /**
     * ⚠⚠ `.modal-mask` **只是个入场动画**，不带定位。
     *   第一版只写了 modal-mask，结果弹窗跑到左上角、占满全宽、没有遮罩
     *   （截图里就是一块贴在顶栏下面的白板）。
     *   定位要么用 Tailwind 的 fixed inset-0 flex，要么像 .guide-mask 那样自带。
     */
    <div
      className="modal-mask fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(0,0,0,.42)' }}
      onClick={shut}
      data-testid="lan-mask"
    >
      <div
        className="modal-card lan-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="局域网传文件"
      >
        <div className="lan-head">
          <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>局域网传文件</span>
          <button type="button" className="lan-x" onClick={shut} aria-label="关闭">✕</button>
        </div>

        {state.phase === 'starting' && (
          <div className="lan-body">
            <div className="lan-note">正在启动…</div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="lan-body">
            <div className="lan-note" style={{ color: 'var(--danger)' }}>{state.error}</div>
            <button type="button" className="lan-btn" onClick={boot}>重试</button>
          </div>
        )}

        {state.phase === 'on' && (
          <div className="lan-body">
            {state.hasLan === false ? (
              <div className="lan-note" style={{ color: 'var(--danger)' }}>
                这台电脑现在没有局域网地址（没连 WiFi 或网线）。
                连上之后点「重试」。
              </div>
            ) : (
              <>
                <div
                  className="lan-qr"
                  data-testid="lan-qr"
                  /* eslint-disable-next-line react/no-danger */
                  dangerouslySetInnerHTML={{ __html: state.qr }}
                />
                <div className="lan-tip">手机相机或浏览器扫码打开</div>

                <div className="lan-url">
                  <code data-testid="lan-url">{state.url}</code>
                  <button type="button" className="lan-copy" onClick={copy}>
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>

                <div className="lan-note">
                  手机和电脑要在<b>同一个 WiFi</b> 下。链接只能打开一次会话，
                  关掉这个面板就失效。
                </div>
              </>
            )}

            <div className="lan-got">
              <div className="lan-got-head">
                <b>收到的文件</b>
                <span>{got.length ? got.length + ' 个' : '还没有'}</span>
              </div>
              {got.length === 0 ? (
                <div className="lan-empty">
                  手机上传的文件会落在项目的<b>「收件箱」</b>里，不会覆盖任何已有文件。
                </div>
              ) : (
                <ul className="lan-list">
                  {got.map((f) => (
                    <li key={f.at + f.name}>
                      <span className="lan-fname">{f.name}</span>
                      <span className="lan-fsize">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="lan-foot">
          <span className="lan-stamp">
            只共享当前这本文档 · {projectName || '当前项目'}
          </span>
          <button type="button" className="lan-btn" onClick={shut}>停止共享</button>
        </div>
      </div>
    </div>
  );
}

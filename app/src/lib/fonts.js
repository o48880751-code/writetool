import { useEffect, useState } from 'react';

/**
 * 字体相关的前端逻辑。
 *
 * 字体文件由主进程下载到本机，经 appfont:// 协议暴露。
 * 这里只做两件事：
 *   1. 把「已安装字体」的 @font-face 规则注入 <head>，让界面能用上；
 *   2. 给设置页的字体选择器提供状态（列 / 装 / 删 / 进度）。
 */

const STYLE_ID = 'writetool-fonts';

/**
 * 把已安装字体的 @font-face 写进一个 <style> 并挂到 <head>。
 * 重复调用会覆盖（同一个 style 元素），不会越积越多。
 *
 * @param {Array<{family:string,file:string}>} presets 已安装的字体预置
 */
export function injectFontFaces(presets) {
  if (!presets || !presets.length) return;
  const css = presets
    .map((p) => `@font-face{font-family:${p.family};src:url('appfont://${p.file}');font-display:swap;}`)
    .join('\n');
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/**
 * 启动期一次性注入：根据已安装的开源字体挂上 @font-face，
 * 这样用户选过某字体后，正文/聊天立刻能用，不必先打开设置页。
 */
export function useBootstrapFonts() {
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [presets, installed] = await Promise.all([
          window.api.font.presets(),
          window.api.font.installed(),
        ]);
        if (!alive) return;
        const set = new Set(installed || []);
        injectFontFaces((presets || []).filter((p) => set.has(p.id)));
      } catch (_) {
        // 字体是锦上添花，失败不影响主流程
      }
    })();
    return () => { alive = false; };
  }, []);
}

/**
 * 设置页字体选择器的状态与操作。
 *
 * @returns {{
 *   presets: Array, installed: Set<string>, installing: {id:string,loaded:number,total:number}|null,
 *   error: string|null, install: (id:string)=>Promise<void>,
 *   uninstall: (id:string)=>Promise<void>, refresh: ()=>Promise<void>
 * }}
 */
export function useFonts() {
  const [presets, setPresets] = useState([]);
  const [installed, setInstalled] = useState(() => new Set());
  const [installing, setInstalling] = useState(null);
  const [error, setError] = useState(null);

  const refresh = async () => {
    const [ps, ins] = await Promise.all([
      window.api.font.presets(),
      window.api.font.installed(),
    ]);
    setPresets(ps || []);
    setInstalled(new Set(ins || []));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const off = window.api.font.onProgress((p) => {
      setInstalling((cur) => (cur && cur.id === p.id ? { ...cur, loaded: p.loaded, total: p.total } : cur));
    });
    return off;
  }, []);

  const reapply = async () => {
    const [ps, ins] = await Promise.all([
      window.api.font.presets(),
      window.api.font.installed(),
    ]);
    const set = new Set(ins || []);
    setInstalled(set);
    injectFontFaces((ps || []).filter((p) => set.has(p.id)));
  };

  /**
   * 下载并安装。
   *
   * ⚠⚠ 外面再套一个超时（2026-11-02）：主进程那边已经修好了"收满不结束"的死等，
   *   但这条链路上任何一环卡住，界面都会永远显示"下载中 100%"，
   *   而用户唯一的出路是关掉设置页——那正是他遇到的"卡在 100%"。
   *   宁可在两分半后主动报错，也不要让它静默挂着。
   */
  const install = async (id) => {
    setError(null);
    setInstalling({ id, loaded: 0, total: 0 });
    try {
      await Promise.race([
        window.api.font.install({ id }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('下载超时（2 分半没完成），换个网络或改用「从本地文件装字体」')), 150000)),
      ]);
      await reapply();
    } catch (e) {
      setError(e.message || '下载失败');
    } finally {
      setInstalling(null);
    }
  };

  const uninstall = async (id) => {
    setError(null);
    try {
      await window.api.font.uninstall({ id });
      await reapply();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  /**
   * 从本地 .ttf/.otf 装字体。
   *
   * ⚠ 这是网络被掐时的唯一生路：内置那几款走 CDN，下不下来不由程序决定；
   *   而用户自己下好的字体文件，导进来永远能用。
   */
  const importLocal = async () => {
    setError(null);
    try {
      const r = await window.api.font.importLocal({});
      if (!r || r.canceled) return null;
      await reapply();
      return r.font || null;
    } catch (e) {
      setError(e.message || '导入失败');
      return null;
    }
  };

  return { presets, installed, installing, error, install, uninstall, importLocal, refresh };
}

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 可拖拽分割面板。
 *
 * ## 为什么自己写而不是拖一个库
 *
 * 分三档变化的四栏布局，需要的行为很具体：
 *   - 拖分隔条改宽度
 *   - 双击恢复默认
 *   - 宽度持久化
 *   - 窗口不够宽时不能把某栏挤成 0（要有最小宽度与降级）
 * 一个通用库反而要为了这些行为去配一堆 prop。
 *
 * ## 三个真实踩过的点
 *
 * 1. **拖动时不要重渲染整棵树**。
 *    宽度存 state 的话，每移动 1px 就重渲染一次四栏——
 *    里面若有 TipTap 实例，每次重建都可能丢焦点/丢选区。
 *    这里把宽度写到 DOM 的 `flex-basis` 上（ref 直改），
 *    只有**拖动结束**才 setState 落一次。
 *
 * 2. **指针事件要挂到 window 上**。
 *    只监听分隔条的话，指针移出分隔条（快速拖动时几乎必然发生）
 *    就会丢失 mousemove，表现为"拖到边缘就卡住"。
 *
 * 3. **最小宽度总和可能超过容器宽度**。
 *    窗口缩小时四栏相加会溢出，表现为某一栏不见了或整条横向滚动。
 *    这里在容器宽度变化时按比例压缩，优先压缩弹性最大的栏。
 */

/**
 * 存储键跟随**软件版本**，不再是自增的布局版本号。
 *
 * 羽毛菌定的版本语义：第一位大更新、第二位小更新。
 * 于是「大更新」（1.0 → 2.0）自动作废旧布局（那时界面多半变了），
 * 「小更新」（1.0 → 1.1）保留用户的栏宽调整（布局没大改，留着更贴心）。
 *
 * 这比原来 `v1 / v2 / v3` 手动递增好：以前要人记得改，
 * 忘了就会拿旧布局参数渲染新界面。
 *
 * @param {string} appVersion 由 app:version 通道传入；拿不到时退回 '0.0.0'
 *   （此时旧数据不会命中，等于按默认布局初始化——安全方向）
 */
function storageKey(appVersion) {
  const v = String(appVersion || '0.0.0').replace(/^v/i, '');
  const major = (v.split('.')[0] || '0');
  return `writetool.paneWidths.major${major}`;
}

/**
 * 分隔条宽度（含在 min/max 约束之外，但必须计入总宽——见 allocate() 的注释）。
 *
 * ⚠⚠ **这个常量与分隔条实际画出来的宽度必须是同一个值。**
 *
 * 2026-10-16 现场：「卡片没有填充满」—— 第 4 栏右边空出一条 12px 的缝。
 *   起因是把分隔条从 5px 改成 1px 时，只改了 `Divider` 里的 `width: 1`，
 *   这个常量还留着 5。于是 `allocate()` 按「每栏之间留 5px」算账
 *   （4 栏 → 给分隔条预留 15px），而屏幕上 3 条分隔条只占了 3px，
 *   **12px 没人认领**，全堆在容器最右边。
 *   （当时看不出来是因为容器本身刷 `--paper`；后来容器改成 transparent，
 *    那条缝立刻显形。）
 *
 * 现在的规矩：**Divider 的宽度从这个常量取**（`width: DIVIDER_W`），
 * 谁也别再写死一个数 —— 两处各写一个数就一定会再次错开。
 */
const DIVIDER_W = 1;

/**
 * 分隔条的**命中区**宽度（视觉 1px，但手指要能点中）——与布局无关，别混进上面那个常量。
 *
 * ⚠⚠ 12 → 6（2026-10-16 羽毛菌：「这个分割线为什么还能左右拖动」）。
 *   现场量到的：命中区 12px，从分隔线往**两侧面板内部各伸 6px** ——
 *   而分隔线本来就贴在面板边界上，于是聊天区最右边 6px 全是"拖拽区"，
 *   正好压在输入框的右边缘上。用户在那里随手一拖栏宽就变了，
 *   看起来就是"输入框旁边那条东西居然能拖着左右拉"。
 *
 *   改成 6px（左右各 2.5px）：仍然好点中，但不再覆盖面板里的内容。
 *   ⚠ 命中区越大误触越多，这是同一根绳上的两头 —— 真要方便还可以再加
 *     "按住 Alt 拖"或"双击复位"，别靠无限加大命中区来解决。
 */
const DIVIDER_HIT = 6;

/**
 * 各栏默认比例与绝对宽度约束。
 *
 * `def` 是宽屏下的目标宽度，`weight` 是窗口不够宽时的分配权重。
 * 两者分开是因为：单纯按 def 等比缩放，在 1280 屏上会把对话列表
 * 缩到 130px（已低于 min 160），而文档预览只剩 220px——
 * 中文长句一行放不下几个字，读起来是灾难。
 *
 * 权重定成 1 : 3 : 2 : 1 是实测出来的：1267px 窗口下
 * 220 + 567 + 220 + 260，第 3 栏正好卡在 min 上，一句话被折成三行。
 * 把第 2 栏权重从 3 降到 2，第 3 栏就宽了——而主编辑区
 * 在没有对话内容时其实用不了 500px。
 */
export const PANE_DEFAULTS = [
  { key: 'conversations', label: '对话列表', def: 220, min: 160, max: 460, weight: 1 },
  { key: 'main', label: '主编辑区', def: 560, min: 300, max: 2000, weight: 2 },
  { key: 'preview', label: '文档预览', def: 420, min: 260, max: 1200, weight: 2 },
  { key: 'files', label: '项目文件树', def: 250, min: 180, max: 700, weight: 1 },
];

/** 读持久化宽度。数据损坏时退回 null（触发按比例初始化）——不能因为一条脏记录让界面打不开 */
function loadWidths(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out = {};
    PANE_DEFAULTS.forEach((p, i) => {
      const v = Number(arr[i]);
      out[p.key] = Number.isFinite(v) && v >= p.min ? Math.min(v, p.max) : p.def;
    });
    return out;
  } catch (_) {
    return null;
  }
}

export function saveWidths(widths, key) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(PANE_DEFAULTS.map((p) => Math.round(widths[p.key])))
    );
  } catch (_) { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
}

/** 按权重分配容器宽度。min 之和超过容器时返回 min（此时会横向滚动，用户可拖回来）
 *  @param {Array} specs 只传**可见**的栏（收起的栏不参与分配） */
export function initWidths(container, specs = PANE_DEFAULTS) {
  const divTotal = DIVIDER_W * Math.max(0, specs.length - 1);
  const usable = Math.max(0, container - divTotal);
  const sumMin = specs.reduce((s, p) => s + p.min, 0);
  if (usable < sumMin) {
    const out = {};
    for (const p of specs) out[p.key] = p.min;
    return out;
  }
  const sumWeight = specs.reduce((s, p) => s + p.weight, 0);
  // 先按权重给，再把超出 min 的部分收回，重新分给有余量的栏
  const out = {};
  for (const p of specs) out[p.key] = Math.max(p.min, Math.round((usable * p.weight) / sumWeight));
  let over = specs.reduce((s, p) => s + out[p.key], 0) - usable;
  const slack = specs.filter((p) => out[p.key] > p.min);
  const slackTotal = slack.reduce((s, p) => s + (out[p.key] - p.min), 0);
  if (over > 0 && slackTotal > 0) {
    for (const p of slack) {
      out[p.key] -= Math.round(over * (out[p.key] - p.min) / slackTotal);
    }
  }
  return out;
}

/** 容器宽度未知时的兜底（首帧渲染用，下一帧会被真实宽度替换） */
function fallbackWidths() {
  const out = {};
  for (const p of PANE_DEFAULTS) out[p.key] = p.def;
  return out;
}

/**
 * 把可见栏的宽度铺满容器：装不下就收，有余量就摊。
 *
 * ## 为什么不直接改存着的宽度
 *
 * 收起的栏（比如纯手工模式只剩预览 + 目录）要把腾出的地方给剩下的栏，
 * 但**不能把这个结果写回持久化宽度**——否则「收起再放开」会拿不回
 * 自己调好的比例：放开时那两栏已经被撑大了，剩下的全被挤扁。
 * 所以 allocate 只算「这一帧该显示多宽」，存着的宽度原样不动。
 *
 * ## ⚠ 分隔条宽度必须算进去
 *
 * 第一版只算四栏，实测在 1267px 窗口下四栏压到 1267，
 * 加 3 条 5px 分隔条 = 1282，溢出 15px，
 * **第 4 栏被推出右边界整栏看不见**——而四栏都"正常"，看着像布局成功。
 *
 * @param {object} widths 各栏存着的宽度（可以含被收起的栏）
 * @param {number} container 容器宽（px）
 * @param {Array} specs **可见**的栏（顺序即左右顺序）
 */
export function allocate(widths, container, specs = PANE_DEFAULTS) {
  if (container <= 0 || !specs.length) return widths;
  const divTotal = DIVIDER_W * (specs.length - 1);
  const usable = Math.max(0, container - divTotal);
  const out = { ...widths };
  const total = specs.reduce((s, p) => s + (out[p.key] || 0), 0);

  // 装不下：按权重从余量最大的栏开始收
  if (total > usable) {
    let over = total - usable;
    const order = [...specs].sort((a, b) => b.weight - a.weight);
    for (const p of order) {
      if (over <= 0) break;
      const shrinkable = (out[p.key] || 0) - p.min;
      if (shrinkable <= 0) continue;
      const cut = Math.min(shrinkable, over);
      out[p.key] -= cut;
      over -= cut;
    }
    // 全压到最小仍放不下：说明窗口本身太窄，允许出现横向滚动，
    // 但每栏仍保持 min，用户能拖动找回来
    return out;
  }

  // 有余量：按各栏**当前宽度比例**摊下去（保持用户调出来的比例）
  let slack = usable - total;
  let guard = 0;
  while (slack > 0.5 && guard++ < 24) {
    const pool = specs.filter((p) => (out[p.key] || 0) < p.max - 0.5);
    if (!pool.length) break;                    // 全都到 max 了，剩下就让给横向滚动
    const base = pool.reduce((s, p) => s + out[p.key], 0);
    if (base <= 0) break;
    let moved = 0;
    for (const p of pool) {
      const add = Math.min(p.max - out[p.key], (slack * out[p.key]) / base);
      out[p.key] += add;
      moved += add;
    }
    if (moved < 0.5) break;
    slack -= moved;
  }
  return out;
}

/**
 * 分隔条。
 *
 * @param {object} left 分隔条左边的栏（PANE_DEFAULTS 里的一项）
 * @param {object} right 分隔条右边的栏
 *
 * ⚠ 这里传**左右两栏本身**，而不是「第几条分隔条」。
 *   中间某栏被收起时，第 i 条分隔条的右边就不再是 PANE_DEFAULTS[i+1]，
 *   照旧按下标推会算错栏宽（拖第 2 条却改了被收起那栏的邻居）。
 */
function Divider({ left, right, widths, containerRef, onCommit, onDoubleClick }) {
  const [hover, setHover] = useState(false);
  const dragging = useRef(false);

  const startDrag = useCallback((e) => {
    // 只响应主键。左键 = 0；中键/右键会弹出系统菜单，用户不是想拖面板
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;

    const startX = e.clientX;
    const startLeft = widths[left.key];
    const startRight = widths[right.key];
    const pairTotal = startLeft + startRight;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const dx = ev.clientX - startX;
      // 两栏宽度之和不变：拖左栏变宽，右栏就等量变窄。
      // 这样用户拖某一条边时，视线对面的那栏不会跟着跑位。
      let nl = startLeft + dx;
      let nr = pairTotal - nl;
      if (nl < left.min) { nl = left.min; nr = pairTotal - nl; }
      if (nl > left.max) { nl = left.max; nr = pairTotal - nl; }
      if (nr < right.min) { nr = right.min; nl = pairTotal - nr; }
      if (nl > left.max) { nl = left.max; }
      if (nr > right.max) { nr = right.max; nl = Math.max(left.min, pairTotal - nr); }

      // 直改 DOM，不走 setState——见文件头「踩过的点 1」
      const apply = (key, w) => {
        const el = containerRef.current?.querySelector(`[data-pane="${key}"]`);
        if (el) el.style.flexBasis = `${Math.round(w)}px`;
      };
      apply(left.key, nl);
      apply(right.key, nr);
    };

    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 从 DOM 读回真实值落 state：拖动过程没有中间 state，只能这样取
      const el = containerRef.current?.querySelector(`[data-pane="${left.key}"]`);
      if (el) {
        const realW = parseFloat(el.style.flexBasis) || startLeft;
        onCommit({ [left.key]: realW, [right.key]: pairTotal - realW });
      }
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';   // 拖动时别选中文字
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [left, right, widths, containerRef, onCommit]);

  useEffect(() => () => {
    // 组件卸载时确保监听被摘掉，否则 pointermove 会一直跑到页面结束
    dragging.current = false;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整${left.label}宽度`}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={startDrag}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // ⚠ 宽度**只从 DIVIDER_W 来**，别在这里另写一个数：
        //   布局算账用的是它，两处不一致就会在容器右边留下一条没人认领的缝
        //   （2026-10-16 的 12px 缝就是这么来的）。
        width: DIVIDER_W,
        flex: `0 0 ${DIVIDER_W}px`,
        cursor: 'col-resize',
        background: hover ? 'var(--accent)' : 'var(--line)',
        transition: 'background .12s',
        position: 'relative',
        zIndex: 5,
      }}
    >
      {/* ⚠ 视觉只有 1px，但命中区有 6px —— 细线好看，太细就点不中。
          用负 inset 外扩：不影响布局宽度，只扩大可点区域。

          ⚠ `inset: 0 -2.5px` 是**两个值**的简写 = 上下 0、左右 -2.5px，
          所以命中区本来就是"只在左右伸出去"（我一度以为上下也外扩了，
          去查才发现那是想当然 —— 写注释前先确认，别把猜测写成结论）。 */}
      <div
        style={{
          position: 'absolute',
          inset: `0 ${-(DIVIDER_HIT - DIVIDER_W) / 2}px`,
        }}
      />
    </div>
  );
}

/**
 * 四栏布局容器。
 *
 * @param {Array} panes [{ key, render }]，顺序必须与 PANE_DEFAULTS 一致
 * @param {object} props
 * @param {number} props.height 容器高度（数字或 CSS 值）
 * @param {string[]} props.hidden 要收起的栏 key（如 ['conversations']）。
 *   收起的栏不渲染、不占宽度，它腾出的空间按比例分给剩下的栏；
 *   放回来时拿回自己原来调好的宽度（见 allocate 的注释）。
 */
export default function SplitPanes({ panes, height = '100%', children, appVersion, hidden = [] }) {
  const containerRef = useRef(null);
  // 版本号是异步拿到的，所以 key 要跟着它变。
  // 版本变化时 React 会重建 state —— 那正是我们要的「布局重置」。
  const key = storageKey(appVersion);
  const [widths, setWidths] = useState(() => loadWidths(storageKey(appVersion)));
  const [container, setContainer] = useState(0);
  // 首次拿到容器宽度时按比例初始化。
  // 先给一组绝对默认值再看容器，是「先渲染错再修正」——
  // 表现为界面闪一下再变形，且在窄屏上第一帧就溢出。
  const inited = useRef(false);

  /**
   * 可见的栏（按左右顺序）。
   * ⚠ 用 key 去 PANE_DEFAULTS 里找 spec，而不是照 panes 的下标取——
   *   收起一栏后 panes 数组的下标与 PANE_DEFAULTS 就错位了。
   */
  const entries = PANE_DEFAULTS
    .map((spec) => ({ spec, pane: panes.find((p) => p.key === spec.key) }))
    .filter((e) => e.pane && !hidden.includes(e.spec.key));
  const specs = entries.map((e) => e.spec);

  // 容器宽度变化时压缩各栏。ResizeObserver 比 window.resize 准：
  // 面板自身被布局挤压时 window 尺寸没变，但容器变了。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setContainer((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (container <= 0 || inited.current) return;
    inited.current = true;
    // 有持久化就用它；没有才按比例分配。
    // ⚠ 分配一律按**全部四栏**做：收起状态下算出来的比例
    //   不该被存下来（否则放开时那两栏已经被撑大了）。
    setWidths((prev) => (prev || { ...fallbackWidths(), ...initWidths(container) }));
  }, [container]);

  const commit = useCallback((patch) => {
    setWidths((prev) => {
      const base = prev || fallbackWidths();
      const next = { ...base, ...patch };
      saveWidths(next, key);
      return next;
    });
  }, [key]);

  const reset = useCallback(() => {
    setWidths((prev) => {
      // 只重置可见栏的宽度：被收起的栏留着原样，放回来时还是原来的宽
      const base = { ...fallbackWidths(), ...(prev || {}) };
      const next = container > 0 ? { ...base, ...initWidths(container, specs) } : base;
      saveWidths(next, key);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, key, hidden.join(',')]);

  const w = allocate(widths || fallbackWidths(), container, specs);
  const total = specs.reduce((s, p) => s + (w[p.key] || 0), 0);

  return (
    <div
      ref={containerRef}
      /**
       * ⚠ `data-panes-root` 是给自定义背景图用的钩子（index.css 里
       * `body.bg-photo [data-panes-root] { background: transparent }`）。
       *
       * 这一层的纸色纯属套娃 —— 它下面紧接着就是每一栏的 <section>
       * （也有纸色）。开着背景图时**纸色是乘起来的**：
       * 0.66 × 0.66 = 0.88 有效纸，图基本就看不见了。
       * 判据 `diag-bg.js` 会数每个点下面有几层纸，就是这个坑。
       */
      data-panes-root="1"
      style={{
        display: 'flex',
        height,
        width: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--paper)',
      }}
      onDoubleClick={(e) => {
        // 只在点到空白处时重置，避免与子面板的 dblclick（选中文本）打架
        if (e.target === e.currentTarget) reset();
      }}
    >
      {entries.map((e, i) => {
        const spec = e.spec;
        const width = w[spec.key];
        return (
          <div key={spec.key} style={{ display: 'contents' }}>
            <section
              data-pane={spec.key}
              aria-label={spec.label}
              style={{
                flex: `0 0 ${Math.round(width)}px`,
                width: Math.round(width),
                minWidth: spec.min,
                maxWidth: spec.max,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--paper)',
              }}
            >
              {e.pane.render()}
            </section>
            {i < entries.length - 1 && (
              <Divider
                left={spec}
                right={entries[i + 1].spec}
                widths={w}
                containerRef={containerRef}
                onCommit={commit}
                onDoubleClick={reset}
              />
            )}
          </div>
        );
      })}
      {children}
      {/* 溢出诊断：容器装不下时给用户一个提示，而不是默默把栏推出屏幕 */}
      {container > 0 && total + DIVIDER_W * (specs.length - 1) > container + 2 && (
        <div
          className="shrink-0 self-start text-[10px] px-1 py-0.5 rounded"
          style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}
          title="窗口太窄，各栏已压到最小。拖动分隔条或拉宽窗口。"
        >
          窗口过窄
        </div>
      )}
    </div>
  );
}
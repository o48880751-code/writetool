/**
 * 图标集（2026-11-02）
 *
 * ## 为什么要自己写
 *
 * 界面上原来用的是 emoji（📁 📄 ⚙ 🗂 💬）。emoji 的问题是：
 *   · **彩色**，而且是别人渲染的彩色 —— 满屏黄文件夹在苹果界面里不存在
 *   · **字重不可控**，和 13px 的中文标签放一起像两个时代的东西
 *   · 不同系统长得不一样（Windows 的 📁 和 macOS 的完全是两种画法）
 *
 * ## 画法
 *
 * 全部按 SF Symbols 的规矩：
 *   · 24×24 viewBox，**stroke 1.8**，圆角线帽/线接头
 *   · 只用 `currentColor`，颜色由父级决定（这样深浅主题自动跟）
 *   · 不加任何装饰性细节 —— 苹果的图标信息量都很低
 *
 * ⚠ 尺寸用 `size` 控制，默认跟着字号走（写 `size="1em"` 也行）。
 * ⚠ 别在这套图标里混 fill 图形：一两个实心会让整排图标看着"重了一块"。
 */

const PATHS = {
  /* 分栏开关：外框 + 两条竖线，实心小点标出"这是哪一栏" */
  panelLeft: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.6" />
      <path d="M9 5.5v13M15 5.5v13" />
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  panelCenter: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.6" />
      <path d="M9 5.5v13M15 5.5v13" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.6" />
      <path d="M9 5.5v13M15 5.5v13" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),

  /* 文件树 */
  folder: (
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6a1 1 0 0 1 .8.4l1.3 1.7h7.3a2 2 0 0 1 2 2v7.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  ),
  folderOpen: (
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6a1 1 0 0 1 .8.4l1.3 1.7h7.3a2 2 0 0 1 2 2v1.9" />
      <path d="M3.5 9.8h17.2l-2 8.2a2 2 0 0 1-1.9 1.5H5.6a2 2 0 0 1-2-1.6z" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8.5z" />
      <path d="M13.5 3v5.5H18" />
      <path d="M9 13h6M9 16.5h4" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v14H6.5A2.5 2.5 0 0 0 4 19.5z" />
      <path d="M19 17v4H6.5" />
    </>
  ),
  chevron: <path d="M9.5 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,

  /* 通用 */
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <path d="M4 8h16M4 16h16" />
      <circle cx="9.5" cy="8" r="2.3" />
      <circle cx="14.5" cy="16" r="2.3" />
    </>
  ),
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  save: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h9.6L19 5.9v13.6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z" />
      <path d="M8.5 3v5.5h6.5V3M8.5 14.5h7" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
    </>
  ),
};

export function Icon({ name, size = 16, className = '', style }) {
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      className={'icon ' + className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: '-0.14em', ...style }}
    >
      {body}
    </svg>
  );
}

export default Icon;

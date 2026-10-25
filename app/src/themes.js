/**
 * 主题清单。
 *
 * 与 index.css 里的 `[data-theme='xxx']` 是一一对应关系——
 * **加主题必须两处都加**，少一处切过去就会回退到 :root 的默认值。
 * memory/theme-integrity.test.js 会静态校验这一点。
 *
 * 每套主题的差异不是"好看不好看"，而是**使用场景**：
 *   日间冷光（ink / slate）→ 屏幕很亮时降低对比疲劳
 *   日间暖光（ochre / moss）→ 纸质偏好
 *   夜间（night-*）→ 暗环境
 *   高对比（contrast）→ 视力不佳
 */
export const THEMES = [
  { id: 'gold',       name: '墨金',  desc: '宣纸底，默认',     dark: false, swatch: ['#faf9f7', '#8b6f47', '#1f2328'] },
  { id: 'ochre',      name: '赭石',  desc: '土色纸感',       dark: false, swatch: ['#faf6ee', '#9a6b3f', '#2b2318'] },
  { id: 'moss',       name: '松绿',  desc: '暖调护眼',       dark: false, swatch: ['#f7f9f5', '#4a6b48', '#1d241d'] },
  { id: 'ink',        name: '黛蓝',  desc: '冷调，亮屏用',   dark: false, swatch: ['#f7f8fa', '#3d5a80', '#1a2233'] },
  { id: 'slate',      name: '石青',  desc: '清冷高对比',     dark: false, swatch: ['#f5f6f7', '#455a64', '#15181c'] },
  { id: 'plum',       name: '绛紫',  desc: '浓郁配色',       dark: false, swatch: ['#f9f7fa', '#6b4a72', '#241d2b'] },
  { id: 'night',      name: '夜墨',  desc: '深色暖调',       dark: true,  swatch: ['#16181c', '#c9a86a', '#e8e6e1'] },
  { id: 'night-ink',  name: '夜黛',  desc: '深色冷调',       dark: true,  swatch: ['#14171c', '#7fa8d4', '#e2e6ec'] },
  { id: 'night-moss', name: '深夜松', desc: '深色护眼',       dark: true,  swatch: ['#151815', '#8fbd7a', '#e4e8e0'] },
  { id: 'contrast',   name: '高对比', desc: '纯黑白，视力不佳', dark: false, swatch: ['#ffffff', '#0000cc', '#000000'] },
];

export const DEFAULT_THEME = 'gold';

export function isValidTheme(id) {
  return THEMES.some((t) => t.id === id);
}

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/**
 * 应用主题：写 html 的 data-theme 属性。
 *
 * 不用 class 切换——CSS 变量挂在属性选择器上，改一个属性即可，
 * 不用让任何组件重渲染。
 *
 * ⚠ 同时写 `data-dark="1"`：`dark` 这个标记以前只在 JS 里，
 *   CSS 拿不到，于是"深色主题下某块固定浅色"的问题没法用选择器表达。
 *   2026-10-16 聊天区那次就是这么卡住的（见 index.css 的 chat-surface 一节）。
 *   ⚠ 以后加主题只要在 THEMES 里写对 dark，CSS 自动跟上 ——
 *   千万别在 CSS 里手抄主题 id 列表（抄漏一个就是"某个深色主题下还是白的"）。
 */
export function applyTheme(id) {
  const valid = isValidTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', valid);
  const t = getTheme(valid);
  if (t.dark) document.documentElement.setAttribute('data-dark', '1');
  else document.documentElement.removeAttribute('data-dark');
  return valid;
}
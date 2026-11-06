/**
 * 主题系统（2026-11-01 重构，照 ChatGPT 的 Appearance 页）。
 *
 * ## 为什么推翻重做
 *
 * 旧版是 12 套平铺主题（墨金 / 赭石 / 松绿 / 黛蓝 …），羽毛菌的原话：
 *   「不要这种固定选择主题，而是和 ChatGPT 一样只能选择深色、浅色，
 *     然后可以改底色、字体颜色这种。」
 *
 * 所以现在只有两层：
 *   ① **mode** —— light / dark / system（跟随系统）
 *   ② **自定义色** —— 背景 / 文字 / 强调，按明暗各存一份
 *
 * ⚠ `index.css` 里那 12 套 `[data-theme='xxx']` **保留着没删**：
 *   删了要动 400 行 CSS，而多留几套死变量不影响任何东西。
 *   哪天想恢复"更多配色"只要把配色下拉加回来。
 */

/** 明暗档位。**只有这三档**，对应 ChatGPT 的三个 Mode 缩略图。 */
export const MODES = [
  { id: 'light', name: '浅色', hint: '白底深字，日间用' },
  { id: 'dark', name: '深色', hint: '深灰底浅字，暗环境用' },
  { id: 'system', name: '跟随系统', hint: '跟着 Windows 的深浅设置走' },
];

export const DEFAULT_MODE = 'light';

/**
 * 明暗两档各用哪套 CSS 主题。
 *
 * ⚠ 抽成常量是为了让 `memory/theme-integrity.test.js` 能静态读到 ——
 *   以前测试是从 `THEMES` 数组里正则抽 id，现在数组没了，
 *   测试只能靠这个对象知道"实际要校验哪两个 [data-theme]"。
 *   改这里的值，测试会自动校验新的一对。
 */
export const ACTIVE_THEMES = { light: 'gpt', dark: 'gpt-dark' };

/**
 * 每一档的默认三色。
 *
 * ⚠ 取值来自 ChatGPT Appearance：
 *   浅 Background #FFFFFF / Foreground #1A1C1F
 *   深 Background #212121 / Foreground #ECECEC
 *   ⚠ 强调色没用它的 #2D8AE1 原色 —— 那个配白字只有 3.6:1，
 *     我们的按钮字 12.5px，过不了 4.5:1 的可读线（theme-integrity.test.js 会查）。
 */
export const MODE_DEFAULTS = {
  light: { bg: '#ffffff', fg: '#1a1c1f', accent: '#1a73c9' },
  dark: { bg: '#212121', fg: '#ececec', accent: '#3f9ceb' },
};

export function isValidMode(id) {
  return MODES.some((m) => m.id === id);
}

/** 系统当前是不是深色。⚠ 老环境 / 无 matchMedia 时按浅色算。 */
export function systemPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (_) {
    return false;
  }
}

/** 三档 mode 解析成"到底是不是深色" */
export function resolveDark(mode) {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemPrefersDark();
}

/** 当前档位对应的默认三色 */
export function modeDefaults(mode) {
  return MODE_DEFAULTS[resolveDark(mode) ? 'dark' : 'light'];
}

/** `#abc` → `#aabbcc`；不合法返回 ''（调用方用默认值兜底） */
export function normalizeHex(v) {
  if (!v || typeof v !== 'string') return '';
  let s = v.trim().toLowerCase();
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return /^#[0-9a-f]{6}$/.test(s) ? s : '';
}

/**
 * 取出当前生效的三色。
 *
 * ⚠ 自定义色**按明暗分别存**（`customColors.light` / `customColors.dark`）：
 *   只存一份的话，用户在浅色下把背景改成米黄，切到深色还是米黄 ——
 *   深色模式配浅底，等于没切。
 */
export function effectiveColors(mode, customColors) {
  const key = resolveDark(mode) ? 'dark' : 'light';
  const slot = (customColors && customColors[key]) || {};
  const def = MODE_DEFAULTS[key];
  const bg = normalizeHex(slot.bg) || def.bg;
  const fg = normalizeHex(slot.fg) || def.fg;
  const accent = normalizeHex(slot.accent) || def.accent;
  return {
    bg,
    fg,
    accent,
    // 有没有任何一项被用户动过 —— 决定要不要整套覆盖
    dirty: !!(
      (normalizeHex(slot.bg) && normalizeHex(slot.bg) !== def.bg)
      || (normalizeHex(slot.fg) && normalizeHex(slot.fg) !== def.fg)
      || (normalizeHex(slot.accent) && normalizeHex(slot.accent) !== def.accent)
    ),
  };
}

/** 相对亮度（WCAG 公式）。用来决定强调色上该配白字还是黑字。 */
function luminance(hex) {
  const h = normalizeHex(hex) || '#000000';
  const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 强调色上的文字色：亮底配深字，暗底配白字 */
function inkOn(color) {
  return luminance(color) > 0.45 ? '#0d0f12' : '#ffffff';
}

/**
 * 把主题写到 DOM 上。
 *
 * @param {string} mode  light / dark / system
 * @param {object} [customColors] { light:{bg,fg,accent}, dark:{bg,fg,accent} }
 *
 * ⚠ 覆盖走**内联 style** 而不是再加一套 `[data-theme]`：
 *   内联优先级高于任何选择器，一定能盖住预设主题；
 *   用户把颜色改回默认时 `removeProperty` 就干净还原。
 *
 * ⚠ 一旦动过任意一项就**整套覆盖**（bg / paper-2 / ink / line / accent / accent-soft …）。
 *   只改 --paper 不改 --line，边框会留在原来的灰上，整块界面看着"没对齐"。
 */
export function applyTheme(mode, customColors) {
  const m = isValidMode(mode) ? mode : DEFAULT_MODE;
  const dark = resolveDark(m);
  const root = document.documentElement;

  root.setAttribute('data-theme', dark ? ACTIVE_THEMES.dark : ACTIVE_THEMES.light);
  if (dark) root.setAttribute('data-dark', '1');
  else root.removeAttribute('data-dark');

  const OVERRIDES = [
    '--paper', '--paper-2', '--ink', '--ink-soft', '--line',
    '--accent', '--accent-ink', '--accent-soft',
    '--bubble-user', '--bubble-user-ink',
  ];
  // 先全清 —— 否则切回默认后旧的自定义值还挂在 html 上
  OVERRIDES.forEach((k) => root.style.removeProperty(k));

  const c = effectiveColors(m, customColors);
  if (!c.dirty) return { dark, ...c };

  const set = (k, v) => root.style.setProperty(k, v);
  set('--paper', c.bg);
  // 侧栏降一档：分栏之间已经没有分割线，全靠背景明度分层
  set('--paper-2', `color-mix(in srgb, ${c.bg} 92%, ${c.fg} 8%)`);
  set('--ink', c.fg);
  set('--ink-soft', `color-mix(in srgb, ${c.fg} 62%, ${c.bg} 38%)`);
  set('--line', `color-mix(in srgb, ${c.fg} 14%, ${c.bg} 86%)`);
  set('--accent', c.accent);
  set('--accent-ink', inkOn(c.accent));
  set('--accent-soft', `color-mix(in srgb, ${c.accent} 12%, ${c.bg} 88%)`);
  set('--bubble-user', c.accent);
  set('--bubble-user-ink', inkOn(c.accent));

  return { dark, ...c };
}

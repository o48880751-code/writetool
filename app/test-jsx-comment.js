/**
 * 检查「源码注释被当成正文渲染进界面」。
 *
 * ## 起因
 *
 * 2026-10-14 羽毛菌装上 1.0.2，聊天框上方直接顶着一整段源码注释：
 *
 *   /*** ⚠⚠ 这里必须是 relative + z-20（2026-10-14 修）。** 思考菜单浮在**…
 *
 * 三处 JSX 里的注释写成了裸的块注释，React 就把它当普通文本节点渲染了。
 * **编译不报错、运行不报错、单元测试全绿** —— 唯一症状是用户看见源码。
 *
 * ## 为什么主要判据是「查 dist」
 *
 * 我先写了个纯静态判据（扫 .jsx 找裸块注释），连着错三版：
 *   第 1 版按缩进筛 → 3 处真错里混进 3 处误报
 *   第 2 版按 return ( 的括号配平 → 把函数文档注释全判成错（8 处）
 *   第 3 版按「注释后那一行是什么」筛 → 还剩 8 处，全是
 *     `(async () => {` / `useEffect(() => {` / `if (x) {` /
 *     函数解构参数 `onOpenSettings,` 这类**完全合法**的 JS
 *
 * 每修一版都要数一遍误报。而误报会让人养成「忽略这条测试」的习惯 ——
 * 那比没有判据更糟。
 *
 * **改成只查构建产物**：那几个短语只可能来自源码注释，
 * 一旦出现在 .js 里，就说明某处漏了花括号。
 * 这条判据**零误报**，而且直接对应用户的实际症状。
 *
 * ⚠ 代价：必须先 npm run build。提交前跑一次构建本来也是该做的。
 *
 * ## 附带的静态扫描（只提示，不判失败）
 *
 * 保留是因为它能给**具体行号**，排查时省事；
 * 但误报率高，所以不当断言 —— 打完标记让人自己核对。
 *
 * ## JSX 注释的两条语法规则（都踩过）
 *
 *   1. JSX 里的注释必须用花括号包住，否则被当文本渲染。
 *   2. **属性之间**连花括号也不行 —— 花括号注释只能当**子节点**。
 *      写在属性之间会构建失败：「Expected `...` but found `}`」。
 *      正确做法：属性之间的注释放到 return ( 之前（JS 区，那里注释合法）。
 *
 * 运行：node test-jsx-comment.js（需先 npm run build）
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = __dirname;
let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};

console.log('一、构建产物里有无「只可能来自注释」的字符串');

/**
 * 这些短语全部只出现在源码注释里。
 * 界面上看到它们 = 某段注释被编译进产物 = 会被当正文渲染。
 *
 * ⚠ 挑这几个时必须同时满足：
 *   1. 源码注释里出现过
 *   2. **正常代码里绝不会出现**（不能是变量名、字符串字面量）
 */
const PROBES = [
  'relative + z-20',
  '文件=浅绿底',
  '没有项目时，这个按钮',
  '这段必须用「花括号 + 块注释」',
  '必须放在标签',
  // ⚠ 2026-10-15 补：文风蒸馏面板又犯了一次，界面上顶着
  //   「羽毛菌指定要放的一句（2026-10-15）」。当时 PROBES 里没有它，
  //   于是这条判据**全绿放过了** —— 探针不覆盖新代码，等于没有。
  '羽毛菌指定要放的一句',
  '放标题正下方而不是设置页',
];

check('dist/assets/*.js 里没有注释文本', () => {
  const dir = path.join(APP, 'dist', 'assets');
  if (!fs.existsSync(dir)) throw new Error('dist/assets 不存在 —— 先 npm run build');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  if (!files.length) throw new Error('dist/assets 里没有 .js —— 先 npm run build');
  const hit = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const p of PROBES) if (s.includes(p)) hit.push(f + ' 含「' + p + '」');
  }
  if (hit.length) {
    throw new Error('\n      ' + hit.join('\n      ')
      + '\n      → 这些字符串只可能来自源码注释。说明 JSX 里的注释漏了花括号，'
      + '\n        界面上会把它当正文渲染出来。');
  }
});

console.log('\n二、附带扫描：属性之间的裸注释（仅提示，不判失败）');

/**
 * ⚠ 误报率高，**故意不当断言**。
 *   它问的是「注释结束后那一行是什么」，而 useEffect(() => {、
 *   if (x) {、函数解构参数这些合法 JS 都长得像"后面不是函数定义"。
 *
 * 打出来只为给行号，方便人工核对。真的问题由第一条兜住。
 */
function scanAttrComments(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  const endOf = (i) => lines[i].includes('*/');
  for (let i = 0; i < lines.length; i++) {
    if (inBlock) { if (endOf(i)) inBlock = false; continue; }
    const t = lines[i].trim();
    if (!t.startsWith('/*')) continue;
    let j = i; let g = 0;
    while (j < lines.length && g++ < 80 && !endOf(j)) j++;
    const after = (lines[j + 1] || '').trim();
    const ok = !after
      || /^(function|const|let|var|export|class|return)\b/.test(after)
      || /^(useEffect|useMemo|useCallback|useRef|useState)\s*\(/.test(after)
      || /^\(?async\b/.test(after)
      || /^(if|for|while|switch|try)\s*\(/.test(after)
      || after.startsWith('//') || after.startsWith('/*')
      || after === ');' || after === ')' || after === '};' || after === '}';
    if (!ok) out.push({ line: i + 1, after: after.slice(0, 40) });
    if (!endOf(i)) inBlock = true;
  }
  return out;
}

const JSX_FILES = [
  'src/App.jsx',
  'src/components/ChatPanel.jsx',
  'src/components/SettingsPage.jsx',
  'src/components/ConversationList.jsx',
  'src/components/FileTree.jsx',
  'src/components/DocPreview.jsx',
  'src/components/EditorSurface.jsx',
  'src/components/ToolCards.jsx',
  'src/components/ToolsPanel.jsx',
  'src/components/SkillCat.jsx',
  'src/components/ProviderCat.jsx',
  'src/components/StylePanel.jsx',
  'src/components/SplitPanes.jsx',
  'src/components/ProjectSwitcher.jsx',
  'src/components/MainWorkspace.jsx',
  'src/components/FileBox.jsx',
  'src/components/SettingsPanel.jsx',
  'src/components/TrashModal.jsx',
  'src/components/settings-ui.jsx',
  // ⚠ 2026-10-15 新增的两个（DistillPanel 已删，从列表里去掉）
  'src/components/StyleDistill.jsx',
  'src/components/ParamGuide.jsx',
];

let hintTotal = 0;
for (const rel of JSX_FILES) {
  const f = path.join(APP, rel);
  if (!fs.existsSync(f)) continue;
  const hits = scanAttrComments(fs.readFileSync(f, 'utf8'));
  if (hits.length) {
    hintTotal += hits.length;
    console.log('  · ' + rel + '：' + hits.length + ' 处需人工确认');
    for (const h of hits) console.log('      ' + h.line + ' 行 → 之后是「' + h.after + '」');
  }
}
if (!hintTotal) console.log('  （没有需要人工确认的地方）');
console.log('  说明：这些多半是合法 JS 注释。真出问题的话，第一条判据会红。');

console.log('\n三、属性位置上的花括号注释（这条是**硬断言**）');

/**
 * ⚠⚠ 2026-10-16 我自己又踩了一次：
 *
 *     <button
 *       onClick={() => { … }}
 *       {/* 两个 testid 二选一 *\/}      ← 属性位置
 *       {...(hasProject ? … : …)}
 *     >
 *
 * 构建直接失败：`Expected `...` but found `}``。
 * ⚠ 而**上面第二节那条"仅提示"的扫描完全没报它** —— 它找的是
 *   "以 `/*` 开头的行"，而这条注释前面有 6 个空格 + `{`，形状不一样。
 *   「提示型扫描不覆盖新写法」= 等于没有。
 *
 * 所以补这条：在 JSX **开标签内部**出现 `{/*` 一律判失败。
 * 它零误报 —— 属性位置上放花括号注释**必然**是语法错误，没有例外。
 *
 * ⚠ 实现取向：宁可漏报不可误报，但**别把该抓的也放过去**。
 *   第一版写的是"遇到 `>` 就离开标签" —— 于是 `onClick={() => {…}}` 里
 *   箭头那个 `>` 提前把状态关掉了，紧跟其后的属性位置注释**一个都没抓到**
 *   （变异验证当场证明：注入错误后判据照样全绿）。
 *   正解：进标签后跟**花括号深度**，只有深度为 0 的 `>` 才算标签结束。
 *   ⚠ 同时只报**深度 0** 的 `{/*`：写在属性表达式**里面**的
 *     `onClick={() => {/* 合法 *\/}}` 是正常 JS 注释，不能误伤。
 */
function scanBraceInTag(src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  let inTag = false;
  let depth = 0;          // 标签内的花括号深度
  let tagLine = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (!inTag) {
        // 开标签：`<` 后面直接跟字母（`</div>` 的小写斜杠不算）
        if (ch === '<' && /[A-Za-z]/.test(line[ci + 1] || '')) { inTag = true; tagLine = li + 1; depth = 0; }
        continue;
      }
      // 属性值里的字符串：整段跳过去，里面的 `>` `{` 都不算数
      if (ch === '"' || ch === "'") {
        const end = line.indexOf(ch, ci + 1);
        ci = end === -1 ? line.length : end;
        continue;
      }
      if (ch === '{') {
        if (depth === 0 && line.startsWith('{/*', ci)) out.push({ line: li + 1, tagLine });
        depth++;
        continue;
      }
      if (ch === '}') { if (depth > 0) depth--; continue; }
      if (ch === '>' && depth === 0) inTag = false;
    }
  }
  return out;
}

check('源码里没有「属性之间的花括号注释」', () => {
  const hits = [];
  for (const rel of JSX_FILES) {
    const f = path.join(APP, rel);
    if (!fs.existsSync(f)) continue;
    for (const h of scanBraceInTag(fs.readFileSync(f, 'utf8'))) {
      hits.push(`${rel}:${h.line}（第 ${h.tagLine} 行那个标签的属性之间）`);
    }
  }
  if (hits.length) {
    throw new Error('\n      ' + hits.join('\n      ')
      + '\n      → 属性位置上只能写属性或 `{...spread}`，花括号注释写在属性之间会让构建直接失败。'
      + '\n        把这段注释挪到 return ( 之前的 JS 区，或放进元素的子节点里。');
  }
});

console.log('\n' + (failed ? '✗' : '✓') + ' ' + passed + ' 通过'
  + (failed ? '，' + failed + ' 失败' : ''));
process.exit(failed ? 1 : 0);

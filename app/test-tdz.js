/**
 * React 组件的 TDZ（暂时性死区）检查。
 *
 * ## 为什么要有这个
 *
 * 今天连踩两次同一个错误：
 *   ① `renderMainTab` 里用了 `showToast`（声明在后面）
 *   ② `SplitPanes` 的 prop 用了 `appVersion`（state 被误删）
 *
 * 两次的表现完全一样：
 *   - 整个 React 树挂不上，`#root` 的 children 为 0
 *   - 界面全白
 *   - **控制台没有任何报错**
 *
 * 我是临时往 main.jsx 里塞了个 ErrorBoundary 才抓到的，
 * 报错原文是 `Cannot access 'x' before initialization`。
 *
 * 为什么难发现：
 *   - `useCallback(() => {...}, [])` 里引用后声明的变量**语法完全合法**，
 *     只有在渲染真正执行到那一行时才抛
 *   - 而渲染执行到那一行之前，界面已经是空的了
 *   - 于是"点了没反应"和"功能坏了"看起来一模一样
 *
 * ## 这个检查做什么
 *
 * 静态扫描：找出**渲染期就会执行**的函数体，
 * 看它们引用的本地绑定有没有在函数声明之前定义。
 *
 * 运行：node app/test-tdz.js
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 递归列出源码文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(p);
  }
  return out;
}

/** 剥注释与字符串字面量，避免把注释里的名字当代码 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const files = walk(SRC);

/**
 * 判断某个函数是不是「渲染期执行」。
 *
 * 判据：它的返回值被用在 JSX 里（`<Foo ...`）或者被 return。
 * 更简单的代理判据：它不是被包进 useCallback/useMemo 的，
 * 且它的名字出现在 `render` 相关的位置。
 *
 * 这里用**保守近似**：凡是
 *   - 顶层 `const X = (args) => {`（不是 useCallback 包着的）
 *   - 且函数体里直接 return JSX 或引用了别的组件
 * 就当作渲染期函数。
 */
function findRenderPhaseFns(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2}const (\w+) = (?!\(useCallback|useMemo|useState|useRef|useEffect)/);
    if (!m) continue;
    const rest = lines[i].slice(m[0].length);
    // ⚠ 原来这里写的是 `/^\(?/` —— `?` 让括号成了可选项，等于没检查。
    //   后果：`const all = caps.providers || []` 这类**纯值**声明也被当成
    //   函数起点，body 从那一行一直划到下一个 JSX 结束，于是把它后面
    //   声明的 customs / locals / clouds 全算成"引用了后声明的绑定"（假红）。
    //   要的是"等号右边真的是一对参数括号"。
    if (!/^(?:async\s+)?\(|^function\b/.test(rest)) continue;
    // 不是 hook，也不是 useCallback 的函数体参数形式
    if (/^use[A-Z]/.test(rest.trim())) continue;

    // 函数体范围：从起点到**下一个 2 空格缩进的顶层声明**之前。
    //
    // ⚠ 原来是用花括号配对算的（数 { 与 }），实测会算歪：
    //   报错指向的行能跑到文件后部去（SkillCat 的 renderRow 被算到 551 行），
    //   于是把别的组件里的声明也当成"它引用的后声明绑定"。
    //   JSX 里花括号样式太多，纯计数靠不住。
    //   组件体里的顶层声明一律 2 空格缩进，用这个当边界稳得多。
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s{2}(?:const|let|var|function)\s/.test(lines[j])) { end = j - 1; break; }
    }
    if (end <= i) continue;
    const body = lines.slice(i, end + 1).join('\n');
    // 渲染期的特征：body 里有 JSX（尖括号大写组件）或 return (
    if (/<\/?[A-Z]\w*/.test(body) || /return\s*\(\s*</.test(body)) {
      out.push({ name: m[1], start: i + 1, end: end + 1, body });
    }
  }
  return out;
}

console.log('一、渲染期函数不引用后声明的绑定');

for (const f of files) {
  const rel = path.relative(path.join(__dirname, '..'), f);
  const raw = fs.readFileSync(f, 'utf8');
  const src = strip(raw);
  const lines = src.split('\n');

  // 本文件的顶层绑定声明位置。
  //
  // ⚠ 缩进限制是 0~2 空格：模块级 0、组件体内 2。
  //   原来写的是 0~4，把函数**内部的局部变量**（4 空格）也收了进来，
  //   于是 renderRow 引用自己的 on / isEditing 也被判成"引用了后声明的绑定"。
  const decls = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,2}const (\w+) = /);
    if (m && !decls[m[1]]) decls[m[1]] = i + 1;
  }

  const renderFns = findRenderPhaseFns(lines);
  for (const fn of renderFns) {
    check(`${rel} 的 ${fn.name}（第 ${fn.start} 行）无 TDZ 引用`, () => {
      const ids = new Set((fn.body.match(/\b([A-Za-z_$][\w$]*)\b/g) || []));
      const bad = [];
      for (const [name, line] of Object.entries(decls)) {
        if (line <= fn.start) continue;
        // 「被当成值用」的形态：当参数传、赋值、return、进数组/对象。
        //
        // ⚠ 这条正则原来写的是 `name\s*[(\\}/,]` ——
        //   字符类里**漏了 `)`**（也不含 `;`、`]`），于是
        //   `renderEditor(sk, lateThing)` 这种"名字在参数末位"的写法
        //   判据看不见。实测过：往 renderRow 里埋一个引用后声明绑定的
        //   调用，判据毫无反应。而参数末位恰恰是**最常见**的位置。
        //
        // ⚠ 也别把空白（`\s`）或行尾放进字符类 —— 试过一次，
        //   函数**自己的局部变量**（`on ?`、`isEditing &&`）全被判成
        //   "引用了后声明的绑定"，一次报出 7 个假红。
        //   `decls` 只记行号、不区分作用域，所以判据必须窄：
        //   只认"像标识符被当值用"的那几种后缀。
        const used = new RegExp('(?<![.\\w$])' + name + '\\s*[()\\}\\/,;\\]]').test(fn.body)
          || new RegExp(`=\\s*${name}\\s*$`, 'm').test(fn.body);
        if (used) bad.push(`${name}（声明在第 ${line} 行）`);
      }
      assert(bad.length === 0,
        `${fn.name} 引用了后声明的绑定：${bad.join('、')}\n` +
        `    运行时表现：Cannot access ... before initialization\n` +
        `    界面全白且**不报任何错**`);
    });
  }
}

console.log('\n二、关键绑定的声明位置');

const appPath = path.join(SRC, 'App.jsx');
const appSrc = strip(fs.readFileSync(appPath, 'utf8'));
const appLines = appSrc.split('\n');

check('renderMainTab / fileBoxPanel 排在所有 useCallback 之后', () => {
  const at = (name) => appLines.findIndex((l) => l.includes(`const ${name} =`)) + 1;
  const lastHook = Math.max(
    ...appLines
      .map((l, i) => (/\bconst \w+ = use(Callback|State|Ref|Effect|Memo)\b/.test(l) ? i + 1 : 0))
  );
  for (const name of ['renderMainTab', 'fileBoxPanel']) {
    const line = at(name);
    assert(line > 0, `找不到 ${name}`);
    assert(line > lastHook,
      `${name} 在第 ${line} 行，但它引用的绑定可能声明在第 ${lastHook} 行之前——\n` +
      `    它是渲染期执行的，必须排在所有 hook 之后`);
  }
});

check('showToast 声明在 renderMainTab 之前', () => {
  const at = (name) => appLines.findIndex((l) => l.includes(`const ${name} =`)) + 1;
  assert(at('showToast') > 0 && at('showToast') < at('renderMainTab'),
    `showToast 在第 ${at('showToast')} 行，renderMainTab 在第 ${at('renderMainTab')} 行——顺序反了`);
});

check('appVersion 有声明（曾经被 Python 替换误删过）', () => {
  const has = appLines.some((l) => /const \[appVersion,\s*setAppVersion\]\s*=/.test(l));
  assert(has,
    'App.jsx 里没有 appVersion 的 state 声明——\n' +
    '    但 <SplitPanes appVersion={appVersion} /> 用了它。\n' +
    '    运行时：ReferenceError: appVersion is not defined → 界面全白');
});

check('versionInfo 与 appVersion 同时存在且都从 app:version 设置', () => {
  const hasV = appLines.some((l) => /const \[versionInfo,\s*setVersionInfo\]\s*=/.test(l));
  assert(hasV, '缺 versionInfo');
  const uses = appLines.filter((l) => l.includes('setAppVersion(v.full'));
  assert(uses.length >= 1, 'appVersion 没有被赋值 —— 它会永远是空串，面板宽度键跟着退化');
});

// ===========================================================
console.log('\n三、拖拽相关的绑定位置');

// 2026-10-12 加的拖拽。这一批全是新写的 useCallback，
// 而 drop 会用到 drag 的信息——它必须靠 dragRef（同步的），
// 不能靠 drag state（异步的），理由见 FileTree 里的注释。
// APP 是本文件所在目录（app/），项目根是它的上一级。
const APP = __dirname;
const ft = fs.readFileSync(path.join(APP, 'src', 'components', 'FileTree.jsx'), 'utf8');

check('★ drop 用的是同步的 dragRef，不是 drag state', () => {
  assert(ft.includes('dragRef.current'),
    'FileTree 没有 dragRef：drop 时读 drag state 会拿到空值（setState 还没提交）');
  const dropFn = ft.match(/const onDropOn = useCallback\(([\s\S]{0,700}?)\}, \[/);
  assert(dropFn, '找不到 onDropOn');
  assert(!/\bcur\.targetPath\b/.test(dropFn[1]),
    'onDropOn 里读 drag state 的 targetPath——setState 未提交时是空');
  assert(/resolveDrop/.test(dropFn[1]),
    'onDropOn 应自己算落点（resolveDrop），不依赖 state');
});

check('resolveDrop 声明在 onDropOn 之前', () => {
  const iResolve = ft.indexOf('const resolveDrop = useCallback');
  const iDrop = ft.indexOf('const onDropOn = useCallback');
  assert(iResolve > 0 && iDrop > 0, '两个函数都要存在');
  assert(iResolve < iDrop,
    `resolveDrop 在第 ${iResolve + 1} 行、onDropOn 在第 ${iDrop + 1} 行——反过来就是 TDZ`);
});

check('拖拽相关的 ref 都已声明（nodeEl / dragRef）', () => {
  for (const name of ['dragRef', 'nodeEl']) {
    assert(new RegExp(`const ${name} = useRef\\(`).test(ft),
      `${name} 没有声明（曾经被 Python 替换误删过）`);
  }
});

console.log('\n四、弹窗的关闭途径');

check('★ 回收站与项目切换都是弹窗，不是替换第 4 栏', () => {
  const appSrc = fs.readFileSync(path.join(APP, 'src', 'App.jsx'), 'utf8');
  assert(!/trashOpen\s*\?\s*\(/.test(appSrc),
    '回收站又变回「替换第 4 栏」了——用户反馈过「点了返回不了」');
  assert(!/TrashPanel/.test(appSrc), '还在用旧的 TrashPanel（替换式面板），应换成 TrashModal');
  assert(/TrashModal/.test(appSrc), 'App 没引用 TrashModal');
  assert(/ProjectSwitcher/.test(appSrc), 'App 没引用 ProjectSwitcher');
});

check('★ 顶栏不该再有项目 select 与新建按钮', () => {
  const appSrc = fs.readFileSync(path.join(APP, 'src', 'App.jsx'), 'utf8');
  const header = appSrc.slice(appSrc.indexOf('<header'), appSrc.indexOf('</header>'));
  assert(!/<select/.test(header), '顶栏仍有 select——它与第 4 栏第二行的项目切换重复');
  assert(!/新建项目/.test(header), '顶栏仍有「新建项目」按钮——需求要求整合进切换弹窗');
});

check('两个弹窗都提供了三种关闭方式（遮罩 / Esc / ×）', () => {
  for (const f of ['TrashModal.jsx', 'ProjectSwitcher.jsx']) {
    const src = fs.readFileSync(
      path.join(APP, 'src', 'components', f), 'utf8');
    assert(src.includes('role="dialog"'), `${f} 缺 role="dialog"（无障碍 + 便于测试定位）`);
    assert(/e\.key === 'Escape'/.test(src), `${f} 缺 Esc 关闭`);
    assert(/e\.target === e\.currentTarget/.test(src),
      `${f} 缺「点遮罩关闭」——只留一个 × 按钮正是用户反馈「返回不了」的根因`);
  }
});

console.log('\n五、错误可见性');

check('初始化失败会显示原因而不是白屏', () => {
  const hasInitErr = appLines.some((l) => /const \[initError,\s*setInitError\]\s*=/.test(l));
  assert(hasInitErr,
    'App 没有 initError 状态——初始化抛错时界面会永远停在「加载中…」，用户不知道出了什么事');
  const hasTry = appLines.some((l) => /catch \(e\) \{\s*$/.test(l.trim()));
  assert(hasTry, '初始化 effect 里没有 catch');
});

check('有 ErrorBoundary 或至少能暴露渲染失败', () => {
  // 不是强制要求 ErrorBoundary，但 main.jsx 或 App 里应该有兜底
  const main = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const hasBoundary = /ErrorBoundary|getDerivedStateFromError|componentDidCatch/.test(main + app);
  assert(hasBoundary,
    '没有错误边界：任何渲染异常都会表现为「白屏且无报错」，'
    + '排障时只能靠猜');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`TDZ 检查：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
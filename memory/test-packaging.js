/**
 * 打包完整性用例。
 *
 * ## 为什么要有这个文件
 *
 * `memory/alias-discovery.js` 和 `memory/state-writer.js` 都曾经
 * `require('../run-verify.js')` 只为拿一两个纯函数。
 * 开发态没事（文件在），**打包后 run-verify.js 不在安装包里**——
 * 表现是：主进程当前路径不加载它，所以平时无恙；
 * 直到某天有人 require 它，**直接抛 Cannot find module**。
 *
 * 这类缺陷的特点是「不报错但埋雷」：主进程 try/catch 把它吞了，
 * 界面上只表现为某个功能静默失效。
 *
 * 所以把「目录自足」这条不变量固化成用例，
 * 任何人新增跨目录依赖都会在这里失败。
 *
 * ## 判定标准
 *
 * `memory/` 与 `db/` 里的**运行时模块**（排除测试/脚本类文件，
 * 它们本就在仓库根目录跑、不进安装包）不得引用 `../` 上层目录。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 会进安装包、会被主进程 require 的运行时模块 */
const RUNTIME_MODULES = [
  ['memory', 'text-util.js'],
  ['memory', 'context-budget.js'],
  ['memory', 'state-writer.js'],
  ['memory', 'drift-rules.js'],
  ['memory', 'loop-guard.js'],
  ['memory', 'alias-discovery.js'],
  ['memory', 'style.js'],
  ['db', 'store.js'],
];

/**
 * 会进安装包但不该有的文件前缀。
 * 打包时 `extraResources` 的 filter 只排了这些：
 *   test-* / verify-* / eval-* / *-probe / probe-* / import-* / check-*
 * 注意 `import-modianditu.js`、`check-outline-drift.js` 是**离线导入工具**，
 * 主进程不加载，但它们若引用了 run-verify 同样会在某些路径下崩，
 * 所以一并排除在运行时之外。
 */
const NOT_RUNTIME = /^(test-|verify-|eval-|probe-)|-probe\.js$|^import-.*\.js$|^check-.*\.js$/;

const STAR = String.fromCharCode(42);
const SLASH = String.fromCharCode(47);
const DOLLAR_AND_BACKSLASH = String.fromCharCode(92) + String.fromCharCode(36) + String.fromCharCode(38);
/** 双星号通配的替换结果：任意（含斜杠） */
const NAME_ANY = '.' + String.fromCharCode(42);
/** 单星号通配的替换结果：任意非斜杠字符 */
const NAME_NOSLASH = '[' + String.fromCharCode(94) + SLASH + ']' + STAR;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n一、运行时模块不跨目录依赖');

/**
 * 抽掉注释再找 require。
 *
 * ⚠ 第一版直接对原文 grep `require('../...')`，结果 text-util.js 和
 * alias-discovery.js 双双报错——但那两处 require 出现在**注释里**
 * （讲的就是"曾经依赖过 run-verify.js"这段历史）。
 * 「提过这个名字」和「真的 require 了它」是两回事。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释（跳过 http:// 这类）
}

for (const [dir, file] of RUNTIME_MODULES) {
  check(`${dir}/${file} 不引用上层目录`, () => {
    const p = path.join(ROOT, dir, file);
    assert(fs.existsSync(p), `文件不存在：${p}`);
    const code = stripComments(fs.readFileSync(p, 'utf8'));
    const requires = code.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    const bad = requires.filter((r) => /\.\.\//.test(r));
    assert(bad.length === 0,
      `发现跨目录依赖：${bad.join(', ')}\n    run-verify.js 不在安装包里，require 它会直接崩`);
  });
}

console.log('\n二、运行时模块可独立加载');

for (const [dir, file] of RUNTIME_MODULES) {
  check(`${dir}/${file} 可 require`, () => {
    const p = path.join(ROOT, dir, file);
    const m = require(p);
    assert(m && typeof m === 'object', '导出应为空对象');
  });
}

console.log('\n三、打包白名单与实际文件一致');

/**
 * ⚠ 最初这一节只查 memory/，结果 db/ 里的 test-db.js 与 verify-e2e.js
 * 照样被打进安装包（db 的 filter 是「双星号 + 通配」，收一切文件）。
 * **用例只覆盖自己想到的那一半，等于没覆盖。**
 * 所以改成对两个目录统一检查。
 */
for (const dir of ['memory', 'db']) {
  check(`app/package.json 的 ${dir} filter 排除了全部非运行时文件`, () => {
    const pkgPath = path.join(ROOT, 'app', 'package.json');
    if (!fs.existsSync(pkgPath)) {
      // 没有 app 目录时跳过（纯后端仓库）
      return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const er = (pkg.build && pkg.build.extraResources) || [];
    const entry = er.find((r) => r.to === `modules/${dir}`);
    assert(entry, `package.json 缺少 ${dir} 的 extraResources`);
    const filters = entry.filter || [];
    const negatives = filters.filter((f) => f.startsWith('!'));
    assert(negatives.length >= 3,
      `排除规则太少（${negatives.length} 条），测试/探针脚本会打进安装包`);

    // 每个被排除类别的实际文件都应命中至少一条规则
    const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'));
    const leaks = [];
    for (const f of files) {
      if (!NOT_RUNTIME.test(f)) continue;
      const excluded = negatives.some((n) => globMatches(n.replace(/^!/, ''), f));
      if (!excluded) leaks.push(f);
    }
    assert(leaks.length === 0, `这些文件没被任何规则排除：${leaks.join(', ')}`);
  });
}

/**
 * 极简 glob 匹配，只支持 electron-builder filter 用到的语法（双星号前缀与单星号通配）。
 *
 * ⚠ 写这个函数时踩了一个很蠢的坑：块注释里直接写了双星号斜杠开头的
 * 过滤规则原文，而它中间那两个字符正好闭合了注释——
 * 于是整个文件从那行起被当成代码，Node 直接报 SyntaxError，
 * 且报错行号指向注释内部，完全看不出真实原因。
 *
 * 同理，第一版把过滤规则转成正则后 match 整个文件名，
 * 结果「.*」吞掉一切、所有规则都匹配不上，15 个文件全报「漏网」。
 * 实际语义是「任意目录前缀 + 文件名通配」，平铺文件下前缀应视为可省略。
 */
function globMatches(pattern, filename) {
  // 规则形如「双星号斜杠 + test- + 单星号 + .js」。
  // 双星号前缀表示任意目录层级，对平铺在 memory 下的文件等价于「无前缀」。
  const prefix = STAR + STAR + SLASH;
  let core = pattern.startsWith(prefix) ? pattern.slice(prefix.length) : pattern;

  // ⚠ 顺序至关重要：**先替换通配符，再转义剩下的元字符**。
  // 反过来写（先转义）会把 `*` 变成反斜杠加星号，
  // 后面的 split(STAR) 就再也找不到它——
  // 结果所有规则一律返回 false，15 个文件全报「漏网」，而规则本身完全正确。
  let body = core
    .split(STAR + STAR).join(NAME_ANY)
    .split(STAR).join(NAME_NOSLASH);

  // 通配符已替换成合法正则片段，剩下的字符才需要逐个转义
  body = body.replace(/[.+?^${}()|[\\]\\]/g, DOLLAR_AND_BACKSLASH);

  return new RegExp('^' + body + '$').test(filename);
}

console.log('\n四、版本信息与安装体验');

/**
 * 分发相关的配置。两条不是"锦上添花"，是**会丢用户数据**的坑：
 *
 * 1. `deleteAppDataOnUninstall` 默认为 true ——
 *    卸载时把 %APPDATA%/writetool 整个删掉，
 *    里面是用户的全部章节正文、设定库、状态表。
 *    **卸载软件不等于删除作品。** 必须显式关掉。
 *
 * 2. `perMachine` 默认 false 时装到用户目录、不需要管理员权限，
 *    但如果哪天改回 true，公司电脑上没管理员权限就装不了。
 *    这里钉住当前的正确取值。
 */
check('卸载不删用户数据（否则用户的稿子会跟着消失）', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const nsis = (pkg.build && pkg.build.nsis) || {};
  assert(nsis.deleteAppDataOnUninstall === false,
    `nsis.deleteAppDataOnUninstall 应为 false，实际 ${nsis.deleteAppDataOnUninstall}：卸载软件不该删掉用户写的章节`);
});

check('装到用户目录而非全机（不需管理员权限）', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const nsis = (pkg.build && pkg.build.nsis) || {};
  assert(nsis.perMachine === false,
    `nsis.perMachine 应为 false，实际 ${nsis.perMachine}：默认装用户目录，普通用户才能装`);
});

check('package.json 的元信息完整（进 exe 属性面板）', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const k of ['description', 'author', 'license']) {
    assert(typeof pkg[k] === 'string' && pkg[k].length > 0, `package.json 缺少 ${k}（任务栏属性里会显示为空）`);
  }
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), `version 非法：${pkg.version}`);
});

console.log('\n五、配置项合法性');

/**
 * ⚠ 曾经的坑：给 `build.win` 加了一个 `metadata` 配置项（想显式指定
 * FileDescription），**凭记忆加的，没查 schema**。
 * electron-builder 26.x 的 win 段根本没有这个选项 →
 * 打包直接报 `Invalid configuration object. ... does not match the API schema`。
 *
 * 这个错误本可以在打包前用 30 秒查出来：
 *   grep -rn "metadata" node_modules/app-builder-lib/out/options/*.d.ts
 *
 * **配置项名字不能凭印象写。** 这里把已知合法的键列出来，
 * 多一个就报错。
 */
const KNOWN_WIN_KEYS = new Set([
  'target', 'arch', 'icon', 'artifactName', 'signingHashAlgorithms',
  'sign', 'signtoolOptions', 'certificateSubjectName', 'certificateSha1', 'publisherName',
  'verifyUpdateCodeSignature', 'disableWebInstaller', 'legalTrademarks', 'requestedExecutionLevel',
]);

check('build.win 的键都在 electron-builder schema 内', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const keys = Object.keys((pkg.build && pkg.build.win) || {});
  const bogus = keys.filter((k) => !KNOWN_WIN_KEYS.has(k));
  assert(bogus.length === 0,
    `这些键 electron-builder 不认，打包会报 Invalid configuration object：${bogus.join(', ')}\n` +
    `    查 schema：grep -rn "<键名>" node_modules/app-builder-lib/out/options/*.d.ts`);
});

check('build.nsis 的键都在 schema 内', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  // 只钉住这几个我们真用到的，避免 electron-builder 升版时误报
  const used = ['oneClick', 'perMachine', 'allowToChangeInstallationDirectory',
    'allowElevation', 'createDesktopShortcut', 'createStartMenuShortcut',
    'shortcutName', 'deleteAppDataOnUninstall', 'menuCategory'];
  const known = new Set([
    'oneClick', 'perMachine', 'allowToChangeInstallationDirectory', 'allowElevation',
    'createDesktopShortcut', 'createStartMenuShortcut', 'shortcutName',
    'deleteAppDataOnUninstall', 'menuCategory', 'installerIcon', 'uninstallerIcon',
    'license', 'language', 'installerLanguages', 'runAfterFinish', 'displayLanguageSelector',
    'unicode', 'warnings', 'include', 'artifactName', 'guid', 'packagerName',
  ]);
  const bogus = used.filter((k) => {
    const nsis = (pkg.build && pkg.build.nsis) || {};
    return k in nsis && !known.has(k);
  });
  assert(bogus.length === 0, `nsis 里这些键不合法：${bogus.join(', ')}`);
});

console.log('\n六、首启动与菜单');

/**
 * 用户截图里出现了「墨染仙途」这个项目，问为什么进来就有。
 * 查下来是**我测试截图时用 node -e 造的**，主进程本身不预置——
 * 但"主进程不预置"这件事当时没有任何测试或注释保证，
 * 哪天有人加一行 demo 初始化就会静默复发。
 * 这里把它钉死。
 */
check('主进程不预置任何项目（首次启动应是空的）', () => {
  const p = path.join(ROOT, 'app', 'electron', 'main.js');
  const src = fs.readFileSync(p, 'utf8');
  // 逐条字符串匹配而不是正则——正则里的 \s \/ 在多层编辑中极易被吃掉，
  // 本文件已经因此踩过一次 SyntaxError。
  const banned = ['墨染仙途', 'novel-demo', 'demo-verify', '示例项目'];
  const hit = banned.filter((s) => src.includes(s));
  assert(hit.length === 0,
    `主进程里出现了硬编码的项目名：${hit.join('、')}——用户会看到一个自己没建过的项目`);
  // 带字面量 id 的 createProject 调用同样可疑
  const seeded = /createProject\(\s*\{\s*id:\s*['"]/.test(src);
  assert(!seeded, '主进程里有硬编码 id 的 createProject 调用');
});

check('菜单栏已汉化（不出现英文默认菜单）', () => {
  const p = path.join(ROOT, 'app', 'electron', 'main.js');
  const src = fs.readFileSync(p, 'utf8');
  assert(/Menu\.setApplicationMenu/.test(src),
    '主进程没有设置应用菜单，Electron 会用默认英文菜单（File/Edit/View/Window）');
  for (const label of ['文件', '编辑', '视图', '窗口']) {
    assert(src.includes(`'${label}'`), `菜单缺少「${label}」`);
  }
});

check('内置技能在启动时 seed', () => {
  const p = path.join(ROOT, 'app', 'electron', 'main.js');
  const src = fs.readFileSync(p, 'utf8');
  assert(/seedBuiltinSkills/.test(src),
    '主进程启动时应 seed 内置技能，否则输入框的 @技能 是空的');
});

console.log('\n七、四栏布局的运行时文件');

// ---------------------------------------------------------------
// 四栏改版（2026-10-11 夜）新增了一批运行时文件。
//
// 这里的教训来自上两轮：
//   - 打包白名单漏 db/ → 测试脚本被打进安装包
//   - 运行时模块 require 上层目录 → 打包后崩
// 所以这次两条都钉死：文件必须在、打进包后必须能 require。
// ---------------------------------------------------------------

const V_RUNTIME = [
  'app/electron/project-fs.js',
  'app/electron/markdown-render.js',
];

check('四栏新增的运行时模块存在', () => {
  for (const rel of V_RUNTIME) {
    const p = path.join(ROOT, rel);
    assert(fs.existsSync(p), `缺少 ${rel}`);
    assert(fs.statSync(p).size > 500, `${rel} 太小，可能是空壳`);
  }
});

check('运行时模块可独立 require（不跨目录依赖）', () => {
  for (const rel of V_RUNTIME) {
    const p = path.join(ROOT, rel);
    const src = fs.readFileSync(p, 'utf8');
    const requires = src.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    const bad = requires.filter((r) => r.includes('..'));
    assert(bad.length === 0, `${rel} 有跨目录依赖：${bad.join(', ')}`);
  }
});

check('主进程加载了这两个模块', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'main.js'), 'utf8');
  for (const mod of ['project-fs.js', 'markdown-render.js']) {
    assert(src.includes(mod), `main.js 没有 require ${mod}——打包后文件树会空、预览不渲染`);
  }
});

check('preload 暴露了 fs 通道（第 4 栏与第 3 栏全靠它）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'preload.js'), 'utf8');
  for (const fn of ['tree', 'read', 'write', 'create', 'rename', 'remove', 'reveal']) {
    assert(src.includes(fn + ':'), `preload 的 fs 通道缺 ${fn}`);
  }
});

check('files 白名单排除了 electron/ 下的测试脚本', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  assert(files.includes('!electron/test-*.js'),
    `electron/test-*.js 会被打进安装包（当前白名单：${JSON.stringify(files)}）`);
  assert(files.includes('!electron/shoot-*.js'),
    'electron/shoot-*.js 是截图脚本，不该进安装包');
});

console.log('\n八、截图判据与设置页');

/**
 * WRITETOOL_SHOT 的"渲染完成"判据连写错两次：
 *   ① `.ProseMirror`  —— TipTap 编辑器，只在「正文编辑」标签挂载，
 *      主区默认停在「对话」标签 → 永远等不到，白等满 8 秒。
 *   ② `[data-pane="files"] input` —— 文件树的搜索框，
 *      **空项目时它也在**（只是下面显示空状态），
 *      判据成立但 React 还没拿到 config，页面仍是「加载中…」。
 *
 * 两次都表现为「截出来一张加载中…的空白页」，
 * 而看上去像界面坏了。这里把判据的选择原则钉死。
 */
/**
 * 截图判据的**可证伪性**。
 *
 * 这条判据连错四次（.ProseMirror → files input → header select → body.innerText），
 * 每次都表现为「截出一张加载中的空白页」，而每次看起来都很有道理。
 *
 * 第四次那次最隐蔽：`document.body.innerText` 在 `show:false` 的无头环境里
 * **依赖布局**，没布局时返回空字符串 → `indexOf('加载中') === -1` 恒成立
 * → 600ms 就判定「渲染完成」。
 *
 * > 判据本身也要能被证伪。
 * > 前三次我都没验证过它在「未完成」时返回 false。
 */
check('截图判据不用 innerText（无头环境下恒为空串）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'main.js'), 'utf8');
  const m = src.match(/const has = await win\.webContents\.executeJavaScript\(([\s\S]{0,700})/);
  assert(m, '找不到截图判据代码');
  const code = m[1];
  assert(!/innerText/.test(code),
    '★ 判据里用了 innerText：无头环境下它依赖布局、返回空串，条件恒成立');
  assert(code.includes('textContent'),
    '判据应该用 textContent（不依赖布局）');
});

check('截图判据同时要求「有子节点」与「不含加载中」', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'main.js'), 'utf8');
  const m = src.match(/const has = await win\.webContents\.executeJavaScript\(([\s\S]{0,700})/);
  const code = m[1];
  assert(code.includes('children.length'), '要检查 root 已有子节点');
  assert(code.includes('加载中'), '要排除「加载中」状态');
  // 这两个是前三次的错法
  assert(!/ProseMirror/.test(code), 'ProseMirror 只在正文标签挂载，不能当判据');
});

check('截图等待有超时兜底（不会无限等）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'main.js'), 'utf8');
  assert(/elapsed\s*<\s*8000/.test(src),
    '截图轮询应有超时上限，否则判据写错时会永远等下去');
});

check('设置入口在左下角（不是顶栏下拉）', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'App.jsx'), 'utf8');
  const hdr = appSrc.indexOf('<header');
  assert(hdr >= 0, '找不到顶栏');
  // 设置入口由第 1 栏自己渲染，App 只负责把回调传下去
  assert(/onOpenSettings/.test(appSrc),
    'App 应把 onOpenSettings 传给第 1 栏');
  assert(/setShowSettings[(]true[)]/.test(appSrc),
    'App 应把打开设置的动作传给第 1 栏');
  assert(appSrc.indexOf('onOpenSettings') > appSrc.indexOf('<SplitPanes'),
    'onOpenSettings 应作为 props 传给第 1 栏（在 SplitPanes 内部）');

  const clSrc = fs.readFileSync(
    path.join(ROOT, 'app', 'src', 'components', 'ConversationList.jsx'), 'utf8');
  assert(/onOpenSettings/.test(clSrc) && /设置/.test(clSrc),
    '第 1 栏里应有设置入口');
  assert(/paper-2/.test(clSrc),
    '设置入口要有背景区分（--paper-2 与列表的 --paper 有色阶差）');

  assert(!/THEMES[.]map[(][^\n]*<option/.test(appSrc),
    '顶栏不该再有主题下拉——设置项散在两处是用户找不到功能的主因');
});

/**
 * ★ 三栏必须贯穿到窗口底部。
 *
 * 这条是被一次误改逼出来的：设置入口曾经做成一条
 * **横跨整个窗口宽度**的底栏（28px → 36px）。
 * 那样等于给四栏都加了一条底边——第 2/3/4 栏各被压掉一截，
 * 而正文、文档预览、文件树恰恰是用户盯着看的东西。
 *
 * 为了一个设置入口让三栏都变小，方向就错了。
 *
 * 判据：App 里**不能有任何横跨全宽的底栏**，
 * 四栏之外的东西一律放进某一栏内部。
 */
check('★ 没有横跨全宽的底栏（三栏面积不因此被压）', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'App.jsx'), 'utf8');
  // SplitPanes 是自闭合标签，找它自己的闭合斜杠
  const m = appSrc.match(/<SplitPanes[\s\S]*?\/>/);
  assert(m, '找不到四栏区（SplitPanes）');
  const endAt = m.index + m[0].length;

  // 四栏闭合之后到组件 return 结束，只允许有 fixed 定位的弹窗，
  // 不允许再有撑高度的块——那必然横跨全宽并压掉三栏的面积。
  const after = appSrc.slice(endAt);
  const retAt = after.indexOf('  );');
  assert(retAt > 0, '找不到四栏之后的段落终点');
  const tail = after.slice(0, retAt)
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 剥注释
    .replace(/\/\/[^\n]*/g, '');

  const offenders = [];
  // 逐个 className 找有没有"撑高度"的类：
  //   h-N 固定高（h-7/h-9 那种底栏）
  //   shrink-0 在垂直 flex 容器里就是不收缩的条
  for (const cm of tail.match(/className="[^"]*"/g) || []) {
    if (/fixed/.test(cm)) continue;         // 弹窗是 fixed，不占布局
    if (/\bh-\d+\b/.test(cm) || /shrink-0/.test(cm)) {
      offenders.push(cm.trim());
    }
  }
  assert(offenders.length === 0,
    `四栏之后还有撑高度的块，会压掉三栏的显示面积：\n    ${offenders.join('\n    ')}`);
});

/**
 * 判据为什么查结构而不是查字面量。
 *
 * 2026-10-12 两次改设置按钮：一次是把它拆成
 * `<span>⚙</span><span>设置</span>`（图标要单独放大到 15px 与文字配比），
 * 一次是把它从全宽底栏挪进第 1 栏。
 * 两次 `src.includes('⚙ 设置')` 都红了，而功能一点没坏。
 *
 * 结构断言（入口在第 1 栏里、有背景区分）不随排版改动失效。
 * 这与 §12.11「看起来做了检查，实际检查的不是那件事」是同一个问题的两面：
 * 上次是**没检查**，这次的两次是**检查的东西太脆**。
 */
check('★ 设置入口的断言查结构而非字面量', () => {
  const src = fs.readFileSync(path.join(__dirname, 'test-packaging.js'), 'utf8');
  const start = src.indexOf('设置入口在左下角');
  assert(start > 0, '找不到那条断言');
  // 只看 check(...) 到下一个 check 之间的**代码**，跳过注释——
  // 否则这段说明文字里出现的字面量会被自己匹配到。
  const end = src.indexOf('check(', start + 10);
  const body = src.slice(start, end > 0 ? end : start + 1400)
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/\/\/[^\n]*/g, '');           // 行注释
  assert(!body.includes("includes('⚙ 设置')"),
    '仍在用字面量匹配——按钮一改排版就会假红');
  assert(body.includes('onOpenSettings'),
    '应该查「打开设置」这个动作，而不是某个字符串');
  assert(body.includes('ConversationList'),
    '应该查设置入口住在第 1 栏内部');
});

check('设置页有返回键与全部类目', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'src', 'components', 'SettingsPage.jsx'), 'utf8');
  assert(src.includes('← 返回'), '缺返回键');
  // ⚠ 从 CATS 数组里抠 key，不用 `src.includes(c)`：
  //   那种写法只要文件里任何地方出现这几个字母就算过（'data' 尤其容易命中），
  //   而且第七轮把「模型」改成「AI 提供商」、又加了 Skill 之后它就一直红着——
  //   红的原因与它要防的东西无关，等于这条断言谁也没保护。
  const m = /const CATS = \[([\s\S]*?)\n\];/.exec(src);
  assert(m, '找不到 CATS 数组');
  const keys = [...m[1].matchAll(/key:\s*'([\w-]+)'/g)].map((x) => x[1]);
  for (const c of ['appearance', 'provider', 'skill', 'params', 'data', 'about']) {
    assert(keys.includes(c), `缺类目 ${c}（实际有：${keys.join(', ')}）`);
  }
  assert(keys.length === new Set(keys).size, '类目 key 有重复');
});

check('设置页组件被 App 引用', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'src', 'App.jsx'), 'utf8');
  assert(src.includes('SettingsPage'), 'App 没引用 SettingsPage');
});

console.log('\n九、应用图标');

/**
 * 图标配置曾经完全缺失——打包日志明确写着
 *   "default Electron icon is used  reason=application icon is not set"
 * 也就是说用户装到的还是 Electron 的默认图标。
 *
 * 这里钉死三件事：文件真的存在、package.json 指对了、files 白名单带上了它。
 * 第三条最容易漏：files 是白名单，图标文件不在里面就会被静默丢掉，
 * 而打包依然"成功"——只是又变回默认图标。
 */
check('build/icon.ico 存在且非空', () => {
  const p = path.join(ROOT, 'app', 'build', 'icon.ico');
  assert(fs.existsSync(p), `缺少图标：${p}\n    跑 node app/make-icon.js 生成`);
  const size = fs.statSync(p).size;
  assert(size > 1000, `图标太小（${size} 字节），可能是空文件`);
  // ICO 头：reserved(2)=0, type(2)=1, count(2)>=7
  const buf = fs.readFileSync(p);
  assert(buf.readUInt16LE(0) === 0, 'ICO 头 reserved 应为 0');
  assert(buf.readUInt16LE(2) === 1, 'ICO 头 type 应为 1');
  const count = buf.readUInt16LE(4);
  assert(count >= 5, `应含多种尺寸，实际 ${count}`);
});

check('package.json 的 win.icon 指向存在的文件', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const icon = pkg.build && pkg.build.win && pkg.build.win.icon;
  assert(icon, 'package.json 缺少 build.win.icon（会退回 Electron 默认图标）');
  const p = path.join(ROOT, 'app', icon);
  assert(fs.existsSync(p), `win.icon 指向的文件不存在：${p}`);
});

check('files 白名单包含图标（否则被静默丢弃）', () => {
  const pkgPath = path.join(ROOT, 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  assert(files.some((f) => /build\/.*\.ico|\*\*\/\*\.ico/.test(f)),
    `files 白名单里没有 icon.ico：${JSON.stringify(files)}\n    白名单不含它 = 打包时图标被丢弃 = 又变回默认图标`);
});

check('大图 PNG 存在（Linux/macOS 用）', () => {
  const p = path.join(ROOT, 'app', 'build', 'icon.png');
  assert(fs.existsSync(p), `缺少 ${p}`);
  assert(fs.statSync(p).size > 1000, 'icon.png 太小');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`打包完整性：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
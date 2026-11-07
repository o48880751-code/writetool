/**
 * 打包后处理：补全 exe 的 Windows 版本资源。
 *
 * ## 为什么需要它
 *
 * electron-builder 的字段映射（实测验证）：
 *   package.json 的 productName  → ProductName / InternalName / **FileDescription**
 *   package.json 的 version      → FileVersion / ProductVersion
 *   package.json 的 copyright    → LegalCopyright
 *
 * **`description` 不会进 FileDescription**——实测传中文 description 后，
 * exe 里的 FileDescription 仍然只是 productName 的值 "WriteTool"。
 * 任务栏属性面板是给用户看的，只显示产品名不够用。
 *
 * electron-builder 内部用 resedit 改 exe 版本信息，resedit 就在 node_modules 里，
 * 所以这里直接复用它做后处理，不引入新依赖。
 *
 * ## 为什么照抄 electron-builder 的调用方式
 *
 * 第一版按印象写成了 `NtExecutable.fromFile(path)` 与
 * `exe.getResourceDirectoryEntries()`，两个都不存在。
 * 正确用法读自 `node_modules/app-builder-lib/out/util/resEdit.js`：
 *
 *   NtExecutable.from(buffer)            ← 传**字节**，传路径报 DataView must be an ArrayBuffer
 *   NtExecutableResource.from(executable) ← 资源入口在 Resource 上，不在 NtExecutable 上
 *   Resource.VersionInfo.fromEntries(res.entries)
 *   vi.outputToResourceEntries(res.entries)
 *   res.outputResource(executable)
 *   Buffer.from(executable.generate())
 *
 * **API 名不能凭印象写。** 遇到 `is not a function` 就去读调用方的实现。
 *
 * 用法：node post-build-metadata.js [产物目录]
 *   默认 app/release/win-unpacked
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, 'release', 'win-unpacked');

/** 拿到 resedit。正常在 node_modules 顶层；找不到再试 electron-builder 的依赖路径。 */
function loadResedit() {
  const candidates = [
    () => require('resedit'),
    () => require(path.join(__dirname, 'node_modules', 'resedit')),
  ];
  for (const c of candidates) {
    try { return c(); } catch (_) { /* 试下一个 */ }
  }
  throw new Error(
    '找不到 resedit。它是 electron-builder 的传递依赖，' +
    '若 node_modules 结构变了，先跑 npm install 重建。'
  );
}

/**
 * 用户看到的名字（2026-11-03 加）。
 *
 * ## 2026-11-07 改名后这里必须跟着变
 *
 * 原来 productName 是 WriteTool，所以 exe 就叫 WriteTool.exe，
 * 下面两处直接写死也没事。
 *
 * 现在 productName 改成了 InkScroll（品牌统一），exe 变成 **InkScroll.exe** ——
 * 写死的那个名字会让打包在第三步直接报「找不到 WriteTool.exe」，
 * 而前两步明明都成功了，看起来像"打包坏了"。
 *
 * 当时不敢改 productName 的理由是「它决定 userData 目录名」，
 * 那个问题现在用另一条路解决了：main.js 里把 userData **显式钉回**
 * `%APPDATA%\writetool`（见那里的注释）。所以这里可以放心跟着 productName 走。
 *
 * 两个名字的分工没变：
 *   · productName → 目录 / exe 文件名 / 内部标识
 *   · displayName → 文件属性、任务管理器、控制面板里显示的名字（「长卷」）
 */
function displayNameOf(pkg) {
  // ⚠ 优先 shortcutName（"长卷"）：build.productName 现在是 InkScroll，
  //   直接用它会让任务管理器里显示英文名，和启动页对不上。
  return pkg.displayName
    || (pkg.build && pkg.build.nsis && pkg.build.nsis.shortcutName)
    || pkg.build?.productName
    || pkg.productName
    || 'InkScroll';
}

/** exe 的文件名（不含扩展名），由 productName 决定 —— 只在这里算一次 */
function exeBaseOf(pkg) {
  return pkg.build?.productName || pkg.productName || 'InkScroll';
}

/**
 * 补全指定目录里 WriteTool.exe 的版本资源。
 * @param {string} dir 产物目录（含 WriteTool.exe）
 * @returns {{ok:boolean, exePath?:string, error?:string}}
 */
function patchExe(dir, pkgHint) {
  const pkg0 = pkgHint || JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const exePath = path.join(dir, exeBaseOf(pkg0) + '.exe');
  if (!fs.existsSync(exePath)) {
    return { ok: false, error: `找不到 ${exePath}（先跑 npm run package）` };
  }

  let resedit;
  try {
    resedit = loadResedit();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const product = exeBaseOf(pkg);
  const display = displayNameOf(pkg);
  const desc = pkg.description || '本地长篇小说写作工具';
  const author = pkg.author || 'InkScroll';
  const copyright = pkg.copyright || `Copyright © ${new Date().getFullYear()} ${author}`;
  const version = pkg.version || '0.1.0';

  // electron-builder 默认 lang/codepage（en-US / UTF-16）
  const lang = { lang: 0x0409, codepage: 1200 };

  const values = {
    FileDescription: `${display} — ${desc}`,
    ProductName: display,
    CompanyName: author,
    LegalCopyright: copyright,
    // ⚠ 这两个必须还是真实文件名，改了会让某些校验工具认为 exe 被替换过
    InternalName: product,
    OriginalFilename: product + '.exe',
  };

  try {
    const buffer = fs.readFileSync(exePath);
    const executable = resedit.NtExecutable.from(buffer);
    const res = resedit.NtExecutableResource.from(executable);

    const list = resedit.Resource.VersionInfo.fromEntries(res.entries);
    const vi = list.length > 0 ? list[0] : resedit.Resource.VersionInfo.createEmpty();

    vi.setStringValues(lang, values);
    vi.setFileVersion(version);
    vi.setProductVersion(version);
    // resedit 会把版本号归一成四段数字（0.1.0 → 0.1.0.0），
    // 这里再写一次字符串值把原样保住
    vi.setStringValues(lang, { FileVersion: version });

    vi.outputToResourceEntries(res.entries);
    res.outputResource(executable);
    fs.writeFileSync(exePath, Buffer.from(executable.generate()));
    return { ok: true, exePath };
  } catch (e) {
    return { ok: false, error: `写版本资源失败：${e.message}` };
  }
}

/** 读回 exe 里的版本字符串，验证写进去了 */
function verifyExe(exePath) {
  const buf = fs.readFileSync(exePath);
  const has = (s) => buf.includes(Buffer.from(s, 'utf16le'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const display = displayNameOf(pkg);
  return [
    { label: '产品名', hit: has(display) },
    { label: '中文描述', hit: has('本地长篇小说写作工具') },
    { label: '版本号', hit: has(pkg.version || '0.1.0') },
    { label: '版权', hit: has(display) && has('Copyright') },
  ];
}

function main() {
  const dir = process.argv[2] || DEFAULT_DIR;
  if (!fs.existsSync(dir)) {
    console.error(`✗ 目录不存在：${dir}`);
    process.exit(1);
  }

  const r = patchExe(dir);
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }

  console.log(`✓ 版本资源已补全：${r.exePath}`);
  const checks = verifyExe(r.exePath);
  let bad = 0;
  for (const c of checks) {
    if (!c.hit) bad++;
    console.log(`  ${c.hit ? '✓' : '✗'} ${c.label}`);
  }
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { patchExe, verifyExe };
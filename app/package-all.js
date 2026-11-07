/**
 * 打包主流程（替代 package.json 里那条 `a && b && c && d`）。
 *
 * ## 为什么需要这个文件
 *
 * 原来的 `"package"` 是一串 `&&`：
 *
 *   npm run build && npm run package:dir && npm run package:meta && npm run package:installer
 *
 * 它**随机失败**，而且失败信息只有一段 `Packager.doBuild` 的堆栈，
 * 看不出是哪一步、为什么（2026-10-20 和 10-21 各撞了一次）。
 *
 * 分步手动跑就都过 —— 说明不是某一步本身有问题，而是**步与步之间没有间隔**：
 * `package:dir` 最后一步是 signtool 给 `WriteTool.exe` 签名，
 * 签完句柄还没完全释放，下一行 `post-build-metadata.js` 立刻去改这个 exe 的
 * 版本资源，就被拒绝。`&&` 不会等，于是失败。
 *
 * 这个脚本做两件事：
 *   ① 每一步之间**显式等待**（默认 2.5 秒，可调）
 *   ② 打印每一步的耗时和结果，失败时能一眼看出卡在哪
 *
 * 用法：`npm run package`
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 算出生成的安装包真实路径。
 *
 * ⚠ 为什么不在结束时写死文件名：2026-11-07 打包是**成功**的，
 *   但 `打包.bat` 末尾硬编码了 `release\WriteTool-0.1.0-setup.exe`
 *   （品牌改名前 + 版本号还是占位值），羽毛菌按那句提示去 release 里找，
 *   发现没有 → 以为打包失败，白等一轮。
 *   以后改 artifactName 或升版本，这里会自动跟着变。
 */
function installerPath() {
  const pkg = require(path.join(__dirname, 'package.json'));
  const tpl = (pkg.build && pkg.build.win && pkg.build.win.artifactName)
    || '${name}-${version}-setup.${ext}';
  const file = tpl
    .replace(/\$\{name\}/g, pkg.name || 'app')
    .replace(/\$\{version\}/g, pkg.version || '0.0.0')
    .replace(/\$\{ext\}/g, 'exe');
  return { file, abs: path.join(__dirname, 'release', file), version: pkg.version };
}

/**
 * 同步睡眠。
 * ⚠ 不能用 setTimeout —— 它是异步的，主线程会立刻继续往下走，
 *   等于没等。`Atomics.wait` 是少数能在主线程同步阻塞的写法。
 */
function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const STEPS = [
  { cmd: 'npm run build', label: '编译渲染层', waitBefore: 0 },
  { cmd: 'npm run package:dir', label: '打包应用目录', waitBefore: 0 },
  // ⚠ 2.5 秒：等 signtool 对 WriteTool.exe 的句柄释放
  { cmd: 'npm run package:meta', label: '写入版本资源', waitBefore: 2500 },
  // ⚠ 1.5 秒：等元数据写完后句柄再释放一次
  { cmd: 'npm run package:installer', label: '生成安装包', waitBefore: 1500 },
];

console.log('\n=== 打包 ===\n');

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i];
  if (s.waitBefore) {
    process.stdout.write(`  （等待 ${s.waitBefore / 1000}s 让文件句柄释放）\n`);
    sleep(s.waitBefore);
  }
  console.log(`  [${i + 1}/${STEPS.length}] ${s.label}...`);
  const t0 = Date.now();
  try {
    execSync(s.cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(`\n  [失败] ${s.label} —— 命令：${s.cmd}`);
    console.error('  上面最后几行是真实原因；如果是 EBUSY/EPERM/占用，关掉 WriteTool 再试。\n');
    process.exit(1);
  }
  console.log(`  [OK] ${s.label}（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
}

/**
 * ⚠ 不要只打一句"打包完成"就结束。
 *   打包失败和"你找错地方了"在用户眼里长得一模一样 ——
 *   必须把**真实存在的路径 + 体积 + 生成时间**摆出来，
 *   他双击就能装，不用再去翻目录。
 */
const out = installerPath();
if (fs.existsSync(out.abs)) {
  const st = fs.statSync(out.abs);
  const mb = (st.size / 1048576).toFixed(1);
  const at = new Date(st.mtimeMs);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  console.log('=== 打包完成 ===\n');
  console.log(`  版本    v${out.version}`);
  console.log(`  安装包  ${out.abs}`);
  console.log(`  体积    ${mb} MB（生成于 ${hhmm}）`);
  console.log('\n  ⚠ 装之前先把正在运行的 InkScroll / WriteTool 全部退出，');
  console.log('    旧进程会占着同一个数据库，覆盖安装后可能起不来。\n');
} else {
  console.log('=== 打包结束，但没找到安装包 ===\n');
  console.log(`  期望路径：${out.abs}`);
  console.log('  说明 artifactName 与实际产物不一致，去 release/ 目录看一眼真实文件名。\n');
  process.exit(1);
}

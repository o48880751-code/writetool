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

console.log('=== 打包完成 ===\n');

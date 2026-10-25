/**
 * 打包产物冒烟：**直接跑 asar 里的 main.js**，验"装出来的那份能不能用"。
 *
 * ## 为什么必须有它
 *
 * 打包会引入一整类**源码态永远测不出来**的问题：
 *   · 跨目录 require：`path.join(__dirname,'..','..',…)` 开发态总能中，
 *     打包态落在 `resources/` 而模块实际在 `resources/modules/` → 必挂
 *     （今天的规矩是走 ROOT，但"规矩"得有判据守着）
 *   · 内置技能在 `resources/modules/builtin-skills/`，不在 asar 里 ——
 *     路径写错就是"技能一个都种不进去"，而开发态永远全绿
 *   · asar 内的 __dirname / fs 读取行为与磁盘不同
 *   · dist（渲染层）没被打进去 → 白屏
 *
 * ## 做法
 *
 * 用自带的 electron 跑 **asar 里的 main.js**（不是源码那份），
 * userData 指向临时目录，然后按真启动的方式验结果状态：
 *   窗口起没起 / 渲染层渲没渲 / 版本号 / 读目录 / 内置技能种没种进去。
 *
 * ⚠ 为什么不去启动 `win-unpacked/WriteTool.exe` 本体：
 *   沙箱里 GUI 产物起不来（`bad option: --user-data-dir=…`），
 *   而 exe 那层是 electron-builder 的标准输出；真正会出错的是 asar 里的代码。
 *
 * 运行：.\electron-run.cmd test-pkg-smoke.js [产物目录]
 *   产物目录默认 release-111/win-unpacked
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const UNPACKED = path.resolve(APPDIR, process.argv[2] || 'release-111/win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

if (!fs.existsSync(ASAR)) {
  console.error(`找不到产物：${ASAR}\n先打包：npm run package:dir（或 npx electron-builder --win --dir）`);
  process.exit(2);
}

/**
 * ⚠⚠ userData 必须在 require main.js **之前**改掉，
 *   否则会写到用户真实的 %APPDATA%\writetool，把对话和密钥弄脏。
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pkg-'));
app.setPath('userData', TMP);

let passed = 0; const failures = []; const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

console.log(`产物：${UNPACKED}`);
console.log(`版本文件：package.json = ${JSON.parse(fs.readFileSync(path.join(ASAR, 'package.json'), 'utf8')).version}`);

/**
 * ⚠ require 必须在 whenReady **之外**：main.js 里有
 *   `protocol.registerSchemesAsPrivileged`，它要求 app ready 之前调用。
 */
require(path.join(ASAR, 'electron', 'main.js'));

app.whenReady().then(async () => {
  console.log('\n一、主进程真跑起来了（顶层没崩、窗口建出来了）');
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  check('★ 窗口建出来了（顶层模块加载没中断）', () => {
    assert(win, '没有窗口 —— main.js 顶层大概率抛了');
  });
  if (!win) { await Promise.all(pending); app.exit(1); return; }
  win.showInactive();
  await new Promise((r) => setTimeout(r, 2500));
  const j = (code) => win.webContents.executeJavaScript(code);

  console.log('\n二、渲染层（dist 有没有被打进 asar）');
  const rendered = await j(`!!document.getElementById('root')?.children.length`).catch(() => false);
  check('★★ 界面渲染出来了（白屏 = dist 没进包 / 路径不对）', () => {
    assert(rendered, '#root 是空的');
  });
  const built = await j(`[...document.querySelectorAll('script')].map(s=>s.src).join(',')`).catch(() => '');
  check('★ 脚本来自 app:// 协议（不是 file:// 直读磁盘）', () => {
    assert(/app:\/\//.test(built), `脚本地址不对：${built.slice(0, 120)}`);
  });

  console.log('\n三、跨目录 / 内置资源（打包期最容易断的地方）');
  const info = await j(`window.api.app.info()`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★★ app:info 有版本号，且就是这次发版的号', () => {
    assert(info && !info.err, `app:info 失败：${info && info.err}`);
    const pkgVer = JSON.parse(fs.readFileSync(path.join(ASAR, 'package.json'), 'utf8')).version;
    assert(info.version === pkgVer, `界面报 ${info.version}，包里是 ${pkgVer}`);
  });

  const projects = await j(`(async () => {
    let l = await window.api.project.list();
    if (!l || !l.length) { await window.api.project.create({ id: 'pkg', name: '打包冒烟' }); l = await window.api.project.list(); }
    return l;
  })()`).then((r) => r).catch((e) => ({ err: String(e) }));
  const pid = Array.isArray(projects) && projects.length ? projects[0].id : null;
  check('★★ 建项目 + 读目录都通（ROOT 跨目录 require 没断）', async () => {
    assert(!(projects && projects.err), `project:list 报错：${projects && projects.err}`);
    assert(pid, '没有项目');
    const tree = await j(`window.api.fs.tree({ projectId: ${JSON.stringify(pid)} })`).catch((e) => ({ err: String(e) }));
    assert(!tree.err, `fs:tree 报错：${tree.err}`);
    const dirs = (tree.children || []).filter((k) => k.type === 'dir').map((k) => k.name);
    assert(dirs.join('/') === '设定/卷纲/章节', `默认目录不对：${dirs.join('/')}`);
  });

  const skills = await j(`window.api.skill.index({ projectId: null })`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★★ 内置技能真的种进去了（它们在 resources/modules/builtin-skills/，不在 asar 里）', () => {
    assert(Array.isArray(skills), `skill:index 返回异常：${JSON.stringify(skills).slice(0, 160)}`);
    assert(skills.length >= 5, `索引里只有 ${skills.length} 条 —— 内置技能没种进去`);
    for (const s of skills) assert(s.description && s.description.length > 10,
      `${s.id} 的 description 太短（模型看不见它）`);
    console.log('      ' + skills.map((s) => s.id).join(', '));
  });

  const conns = await j(`window.api.provider.listConnections()`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★ 服务商图标资源能读（resources/ 里的静态资源没丢）', () => {
    assert(Array.isArray(conns), `listConnections 返回异常：${JSON.stringify(conns).slice(0, 160)}`);
  });

  console.log('\n四、写盘链路（项目文件夹落在临时 userData 里）');
  const wrote = await j(`window.api.fs.write({ projectId: ${JSON.stringify(pid)}, path: '章节/第一章.md', content: '# 第一章\\n打包冒烟' })`)
    .then(() => true).catch((e) => String(e));
  const fp = path.join(TMP, 'projects', pid, '章节', '第一章.md');
  check('★★ 写文件真的落到磁盘上', () => {
    assert(wrote === true, `fs:write 报错：${wrote}`);
    assert(fs.existsSync(fp), `文件不在：${fp}`);
    assert(/打包冒烟/.test(fs.readFileSync(fp, 'utf8')), '内容不对');
  });

  await Promise.all(pending);
  console.log('\n----------------------------------------------------');
  console.log(failures.length
    ? `产物冒烟：${passed} 通过 / ${failures.length} 失败`
    : `产物冒烟：${passed} 通过`);
  console.log(`userData（临时）：${TMP}`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('脚本崩了：', e && e.message);
  setTimeout(() => app.exit(1), 300);
});

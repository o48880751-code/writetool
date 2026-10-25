/**
 * 验 write_note 在**真实主进程**里能不能落地。
 *
 * ## 为什么单独一个文件
 *
 * `runWriteNote` 的单测用的是自己造的 ctx（fileExists/readFile/writeFile），
 * 绿了不代表**真能用** —— 中间还隔着主进程那段注入：
 *   `pfs.resolveIn(projectId, rel)` 的用法对不对、
 *   `toolMod.backupFile` 有没有真的被调到、
 *   `pfs.write` 会不会因为目录不存在而失败。
 *
 * 这几件事只有真起 Electron、真建项目、真写一次磁盘才知道。
 *
 * ⚠ 不走模型：8B 模型不一定会主动调工具，这里要验的是**管道**，
 *   不是模型聪不聪明。模型那一环由 e2e-real-chat.js 负责。
 *
 * 运行：.\electron-run.cmd test-write-note-live.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

const APPDIR = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-note-live-'));
const USER_DIR = path.join(TMP, 'userData');
fs.mkdirSync(USER_DIR, { recursive: true });
app.setPath('userData', USER_DIR);

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const tools = require(path.join(APPDIR, 'electron', 'tools.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const pfs = new ProjectFs(path.join(USER_DIR, 'projects'));

/**
 * ⚠⚠ main.js 必须在 **app ready 之前** require。
 *   它顶层会调 `protocol.registerSchemesAsPrivileged`，ready 之后调会抛
 *   「should be called before app is ready」。
 *   ——这个坑我踩了两次（e2e-real-chat.js 也栽过一次），记下来。
 */
require(path.join(APPDIR, 'electron', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('❌ 没起窗口'); app.exit(1); return; }
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }

  const j = (code) => win.webContents.executeJavaScript(code);
  const pid = 'note-' + Date.now().toString(36);
  await j(`window.api.project.create({ id: '${pid}', name: '写文件测试' })`);
  const root = pfs.projectDir(pid);
  console.log('项目目录：' + root + '\n');

  /**
   * ⚠ 这里**照抄主进程 conv:send 里那段注入**，不是重新实现一遍。
   *   抄错了就是"判据验的不是产品那段代码"。
   */
  const ctx = {
    userText: '把设定整理进 设定/世界观.md',
    fileExists: (rel) => { try { return fs.existsSync(pfs.resolveIn(pid, rel)); } catch (_) { return false; } },
    readFile: (rel) => { try { return fs.readFileSync(pfs.resolveIn(pid, rel), 'utf8'); } catch (_) { return ''; } },
    writeFile: (rel, content, opts = {}) => {
      const abs = pfs.resolveIn(pid, rel);
      const backup = opts.backup && fs.existsSync(abs) ? tools.backupFile(abs, () => abs) : null;
      if (opts.append) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, content, 'utf8');
      } else {
        pfs.write(pid, rel, content);
      }
      return { backup };
    },
    approve: async () => { throw new Error('这个用例不该走到审批'); },
  };

console.log('\n一、覆盖项目模板自带的文件');
  // ⚠ 第一版这里假设"文件不存在、目录也不存在"，结果第一步就显示
  //   「原内容已备份为 …（覆盖前共 48 字）」—— 因为 **project:create
  //   会写初始模板**，世界观.md / 人物库.md 一直都在。
  //   这不是 bug，但有个真实后果值得钉住：**模型第一次"写设定"就是在覆盖模板**，
  //   所以备份与审批都会触发 —— 这正是想要的。
  const r1 = await tools.runWriteNote(
    { path: '设定/世界观.md', content: '# 世界观\n\n大雍王朝。\n', reason: '整理设定' }, ctx);
  console.log('   ', JSON.stringify(r1.output));
  check('★ 覆盖成功，模板原内容备份下来了', () => {
    assert(r1.ok, r1.output);
    assert(/大雍王朝。/.test(fs.readFileSync(pfs.resolveIn(pid, '设定/世界观.md'), 'utf8')), '内容不对');
    const baks = fs.readdirSync(path.dirname(pfs.resolveIn(pid, '设定/世界观.md')))
      .filter((f) => f.includes('.bak-'));
    assert(baks.length === 1, `模板原内容没被备份`);
  });

  console.log('\n二、再覆盖一次（仍不该弹审批：用户点名了这个文件）');
  const r2 = await tools.runWriteNote(
    { path: '设定/世界观.md', content: '# 世界观\n\n大雍王朝，皇权渐衰。\n' }, ctx);
  console.log('   ', JSON.stringify(r2.output));
  check('★ 覆盖成功', () => {
    assert(r2.ok, r2.output);
    assert(/皇权渐衰/.test(fs.readFileSync(pfs.resolveIn(pid, '设定/世界观.md'), 'utf8')));
  });

  console.log('\n三、没点名文件 → 也不该弹审批（写文件是底层能力）');
  // ⚠ 这一节原来钉的是「模型自选的文件要弹审批」，
  //   已按羽毛菌的要求换掉：「这个是最基础最默认的功能，
  //   就跟你能改文件一样，不要随便一下都拿来问」。
  // ⚠ 路径仍要选**模板里没有的**——第一版选了 设定/人物库.md，
  //   它本来就在模板里，于是"否决后文件还在"看着像审批被绕过。
  const NEW_FILE = '卷纲/总纲.md';
  const asked = [];
  const r3 = await tools.runWriteNote(
    { path: NEW_FILE, content: '第一卷 春闱舞弊案\n' },
    { ...ctx, userText: '帮我整理一下', approve: async (req) => { asked.push(req); return false; } });
  check('★ 没弹审批，直接写进去了', () => {
    assert(asked.length === 0, `弹了 ${asked.length} 次审批 —— 写文件是底层能力，不该问`);
    assert(r3.ok, r3.output);
    assert(/春闱舞弊案/.test(fs.readFileSync(pfs.resolveIn(pid, NEW_FILE), 'utf8')),
      '批准与否都该写进去（没人被问）');
  });

  console.log('\n四、再写一个新文件（也不该有人被问）');
  const asked2 = [];
  const r5 = await tools.runWriteNote(
    { path: NEW_FILE, content: '第一卷 春闱舞弊案\n' },
    { ...ctx, userText: '帮我整理一下', approve: async (req) => { asked2.push(req); return true; } });
  check('★ 文件真的出现，且内容对', () => {
    assert(asked2.length === 0, `又弹了 ${asked2.length} 次审批`);
    assert(r5.ok, r5.output);
    assert(/春闱舞弊案/.test(fs.readFileSync(pfs.resolveIn(pid, NEW_FILE), 'utf8')),
      '批准了却没写进去');
  });

  console.log('\n五、追加（不该产生备份）');
  // ⚠ 两次都是 append。第一版第一次忘了给 mode（默认 replace），
  //   把内容换成了 '第一行'，然后判据说"原内容被弄丢"—— 那不是 bug。
  const baksBefore = fs.readdirSync(path.dirname(pfs.resolveIn(pid, '设定/世界观.md')))
    .filter((f) => f.includes('.bak-')).length;
  const r4a = await tools.runWriteNote(
    { path: '设定/世界观.md', content: '第一行\n', mode: 'append' }, ctx);
  const r4b = await tools.runWriteNote(
    { path: '设定/世界观.md', content: '第二行\n', mode: 'append' }, ctx);
  const baksAfter = fs.readdirSync(path.dirname(pfs.resolveIn(pid, '设定/世界观.md')))
    .filter((f) => f.includes('.bak-')).length;
  check('★ 追加保留原内容，且不多出备份文件', () => {
    assert(r4a.ok && r4b.ok, r4b.output);
    const txt = fs.readFileSync(pfs.resolveIn(pid, '设定/世界观.md'), 'utf8');
    assert(/皇权渐衰/.test(txt), '追加把原内容弄丢了');
    assert(txt.includes('第一行') && txt.includes('第二行'), '追加内容不对');
    assert(baksAfter === baksBefore, `追加不该产生备份（.bak ${baksBefore} → ${baksAfter}）`);
  });
  console.log('\n项目目录最终内容：');
  for (const f of fs.readdirSync(path.join(root, '设定'))) console.log('   设定/' + f);

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `真机写文件：${passed} 通过 / ${failures.length} 失败` : `真机写文件：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });
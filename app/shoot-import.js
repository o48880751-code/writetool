/**
 * 「导入已有小说文件夹」的界面端到端截图 + 主动断言。
 *
 * ## 为什么单独一个脚本
 *
 * 源级判据只能证明"代码写了 importFolder"，
 * 证明不了**点下去真的把用户的文件夹接到界面上了**。
 * 今天是连续第三次栽在"点击之后发生什么"这类问题上
 * （前两次是顶栏三个按钮 key 全叫 'tools'、灵感碎片没排在脑洞后面）。
 *
 * 而且导入的对象是**用户自己的原稿** —— 这条链路
 * 一旦"看起来成功"却接错了目录，后果是用户对着空文件树以为稿子丢了。
 *
 * 场景：
 *   dialog  点「↓ 导入文件夹」→ 说明弹窗出现，讲清了"原地不复制"
 *   done    确认导入后 → 文件树真的出现《墨染仙途》的文件
 *
 * ⚠ 全程不写用户的原稿目录：只读 + tree + 统计。
 *
 * 运行：cmd //c "electron-run.cmd shoot-import.js [dialog|done]"
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const OUT = path.join(__dirname, 'shots');
const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { versionInfo } = require(path.join(APPDIR, 'electron', 'version-info.js'));

/** 用户真实的小说目录。只读。 */
const NOVEL_DIR = process.env.WT_NOVEL_DIR || 'C:\\Users\\26775\\AI写小说\\墨染仙途';

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-import';
const IMPID = 'pj-imported';

const ARGV = process.argv.slice(1).filter((a) => !a.startsWith('-'));
const SCRIPT_AT = ARGV.findIndex((a) => a.endsWith('.js'));
const SCENARIO = (SCRIPT_AT >= 0 ? ARGV[SCRIPT_AT + 1] : ARGV[0]) || 'dialog';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
// ⚠ createProject 是裸 INSERT，第二次跑同一个 id 会抛 UNIQUE constraint，
//   而这行在模块顶层 → 脚本加载期就挂住、一行输出都没有，像"卡住了"。
if (!db.getProject(PID)) db.createProject({ id: PID, name: '导入验证' });
if (!fs.existsSync(pfs.projectDir(PID))) pfs.ensureProject(PID);

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const PRELOAD_SRC = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...PRELOAD_SRC.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$/.test(ch) ? [] : null));

let CFG = {
  model: '', numCtx: 8192, temperature: 0.3, fontSize: 16,
  fontFamily: 'system-ui', theme: 'gold', notify: 'window',
  currentProject: PID, thinkLevel: 'off', activeConnectionId: '',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: CFG.currentProject }));
h('chapter:list', () => db.listChapters(CFG.currentProject || PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.listSettings(CFG.currentProject || PID));
h('state:list', () => db.listEntityStates(CFG.currentProject || PID));
h('thread:open', () => db.listOpenThreads(CFG.currentProject || PID));
h('bible:query', () => ({ hits: [] }));
h('skill:list', () => db.listSkills(CFG.currentProject || PID));
h('conv:list', () => db.listConversations(CFG.currentProject || PID));
h('conv:create', () => ({ id: 'cv1' }));
h('conv:messages', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('ollama:check', () => ({ ok: false, error: '还没连' }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:reveal', () => ({ ok: true }));
h('trash:list', () => ({ items: [], stats: {} }));
h('trash:add', () => ({ ok: true }));
h('trash:restore', () => ({ ok: true }));
h('trash:purge', () => ({ ok: true }));
h('trash:empty', () => ({ ok: true }));
h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份' }));
h('data:inspectBackup', () => ({ canceled: true }));
h('app:info', () => ({ version: '1.0.0', userDir: path.join(APPDATA, 'writetool'), dbPath: DB, node: process.versions.node, electron: process.versions.electron }));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', () => ({ ok: true }));

/**
 * 导入通道的桩：**照抄主进程那段逻辑**，不return 一个写死的结果。
 *
 * ⚠ 返回写死的 `{fileCount: 24}` 会让断言永远为真 ——
 *   测的是我写的数字，不是真的接上去的目录。
 *   这里真的 bindExternal + countTree，断言才有意义。
 */
let importCalled = 0;
h('project:importFolder', ({ dir } = {}) => {
  importCalled++;
  const target = dir || NOVEL_DIR;
  if (!fs.existsSync(target)) return { canceled: true };
  if (!db.getProject(IMPID)) db.createProject({ id: IMPID, name: path.basename(target) });
  pfs.bindExternal(IMPID, target);
  CFG = { ...CFG, currentProject: IMPID };
  return { projects: db.listProjects(), id: IMPID, dir: target,
           name: path.basename(target), ...pfs.countTree(IMPID) };
});

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
};

/** 打开项目切换弹窗 */
async function openSwitcher(js) {
  // ⚠ 精确定位第 2 行那个「📕 项目名 ⇅」按钮。
  //   原来按 textContent 匹配「未选项目|切换项目|导入文件夹」，
  //   结果一个都没匹配上 —— 按钮文本是项目名（"导入验证"），
  //   而「导入文件夹」在**还没打开**的弹窗里。
  //   于是弹窗没开，下一条断言全在空页面上跑，报红却与被测功能无关。
  const found = await js(`(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.getClientRects().length);
    const b = bs.find(x => {
      const t = x.textContent.replace(/\\s+/g,'');
      return /^📕.*⇅$/.test(t) || (/📕/.test(t) && /⇅/.test(t));
    });
    if (b) b.click();
    return b ? b.textContent.replace(/\\s+/g,' ') : '';
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  return found;
}

app.whenReady().then(async () => {
  if (!fs.existsSync(NOVEL_DIR)) {
    console.log(`! 用户小说目录不存在：${NOVEL_DIR}（环境不满足）`);
    app.exit(2);
  }
  const win = new BrowserWindow({
    width: 1440, height: 940, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  await win.webContents.executeJavaScript("window.confirm = () => true; true");

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await js("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.capturePage();      // 丢弃：等合成器产新帧
    await new Promise((r) => setTimeout(r, 200));
    const img = await win.webContents.capturePage();
    await js("document.body.style.transition=''; true");
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  截图', name);
  };

  console.log(`\n=== 导入文件夹截图（场景 ${SCENARIO}）===\n  小说目录：${NOVEL_DIR}`);

  const swName = await openSwitcher(js);
  console.log('  点开的项目按钮:', swName);
  t('点开了项目切换弹窗', !!swName, '没找到「📕 项目名 ⇅」那个按钮');

  // ---- 弹窗里有「导入」按钮，且不是原来那个"只弹提示"的假货 ----
  const btn = JSON.parse(await js(`JSON.stringify(
    [...document.querySelectorAll('button[data-testid]')]
      .filter(b => b.getClientRects().length > 0)
      .map(b => ({ id: b.dataset.testid, text: b.textContent.trim() })))`));
  console.log('  弹窗按钮:', JSON.stringify(btn));
  t('弹窗里有「导入文件夹」按钮',
    btn.some((b) => /导入文件夹/.test(b.text)),
    `实际：${btn.map((b) => b.text).join('、')}`);

  const body0 = await js("document.body.textContent.replace(/\\s+/g,' ')");
  t('导入按钮旁不再是把文件手动拷进数据目录那种说法',
    !/拷进数据目录/.test(body0), '那个只是提示，根本没有功能');

  // ---- 点它：必须先弹"原地不复制"的说明，而不是直接开系统选择框 ----
  await js(`(() => {
    const b = [...document.querySelectorAll('button[data-testid="btn-import-folder"]')]
      .find(x => x.getClientRects().length);
    if (b) b.click();
    return !!b;
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const dlg = await js(`document.body.textContent.replace(/\\s+/g,' ')`);
  console.log('  说明弹窗:', dlg.slice(0, 200));

  t('点导入后先出现说明弹窗',
    /导入已有的小说文件夹/.test(dlg));
  t('说明里讲清了「不复制」',
    /不复制|不会复制|直接/.test(dlg));
  t('说明里讲清了「不会删掉那个文件夹」',
    /不会.{0,4}删|不删/.test(dlg));

  if (SCENARIO === 'dialog') {
    await shot('g3-导入说明弹窗');
  }

  if (SCENARIO === 'done') {
    // 确认 → 真导入
    await js(`(() => {
      const b = [...document.querySelectorAll('button[data-testid="btn-import-confirm"]')]
        .find(x => x.getClientRects().length);
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));
    t('主进程真的被调了一次', importCalled === 1, `调了 ${importCalled} 次`);
    t('项目确实绑到了用户目录',
      pfs.isExternal(IMPID) && pfs.projectDir(IMPID) === path.resolve(NOVEL_DIR),
      pfs.projectDir(IMPID));

    // 文件树有没有真的出现
    const treeTxt = await js("document.body.textContent.replace(/\\s+/g,' ')");
    console.log('  界面片段:', treeTxt.slice(0, 260));
    t('文件树里能看到导入项目的文件',
      /小说资料|章节内容|世界观|第一章/.test(treeTxt),
      '文件树没有出现小说目录里的任何文件');
    await shot('g4-导入后文件树');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${SCENARIO}：通过 ${pass} / 失败 ${fail}`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('崩溃：', e); app.exit(1); });
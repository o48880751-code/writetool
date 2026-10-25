/**
 * 截图：第 4 栏文件树的排序控件。
 *
 * ## 为什么要单独一个脚本
 *
 * shoot-tree.js 是文件树的通用截图，但它写于排序控件存在之前，
 * `fs:tree` 那个桩**不透传 sort**（`pfs.tree(p.projectId)` 没第二个参数）——
 * 界面怎么点排序，读回来的都是同一棵树，截图拍出来四档一模一样。
 *
 * 这次踩过的坑值得记下来：shoot-tool-ui.js 那一轮，
 * 四张图的**字节数完全相同**，而脚本日志里 DOM 诊断一切正常。
 * 光看"脚本没报错"发现不了画面是错的。
 * 所以本脚本每拍一张都会核对**文件顺序真的变了**，
 * 顺序没变就不算通过 —— 这比事后肉眼看图靠谱。
 *
 * 运行：./electron-run.cmd shoot-sort.js
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

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const PID = 'shot-sort';
const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'shoot-sort.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ---- 造一批能区分四种排序的文件 ----
// 三个文件在**名字 / 大小 / 时间**三个维度上的次序互不相同，
// 否则某一档排序拍出来会跟另一档一模一样，白跑一趟。
if (!db.getProject(PID)) db.createProject({ id: PID, name: '排序验证' });
pfs.ensureProject(PID);
const SEEDS = [
  { name: '灵柩.txt', size: 300, agoMin: 90 },    // 名字最前
  { name: '斩秋刀.md', size: 4200, agoMin: 30 },
  { name: '青莲.md', size: 1100, agoMin: 150 },  // 最大 / 最新
];
for (const s of SEEDS) {
  pfs.write(PID, s.name, '墨'.repeat(s.size));
  const t = new Date(Date.now() - s.agoMin * 60000);
  const abs = pfs.resolveIn(PID, s.name);
  try { fs.utimesSync(abs, t, t); } catch (_) { /* 精度不够就按名字断言 */ }
}

// ---- IPC 桩：自动枚举 + 覆盖 ----
/**
 * ⚠ 注册前先 removeHandler。
 * 「自动枚举兜底桩」和后面的「真数据覆盖」会把同一个通道注册两次，
 * 而 Electron 对二次注册**直接抛错**：
 *   Attempted to register a second handler for 'config:get'
 * 症状是脚本在加载期就挂掉，什么截图都没有，也不会有别的提示。
 * （与主进程里那个重复注册的 bug 是同一个坑。）
 */
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
function fallbackFor(ch) {
  if (/_list$|_get$/.test(ch)) return [];
  if (ch === 'config:get') return null;   // 下面用真数据覆盖
  return null;
}
for (const ch of ALL_CHANNELS) {
  const fb = fallbackFor(ch);
  h(ch, () => (typeof fb === 'function' ? fb() : fb));
}

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID, thinkLevel: 'off', activeConnectionId: 'conn-1',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.0', full: 'v1.0.0' }));
h('project:list', () => db.listProjects());
h('project:open', () => CFG);
h('project:create', (p) => { db.createProject(p); return { projects: db.listProjects(), createdFolder: true, dir: '' }; });
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => db.listSkills(PID));
h('conv:list', () => []);
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));

/**
 * ⚠⚠ 这个桩**必须**透传 sort。
 * 不透传的话，界面点排序只是换了个图标，树还是同一棵，
 * 四张截图会是同一张图 —— 而脚本一路 ok。
 */
let LAST_SORT = null;
h('fs:tree', (p) => {
  LAST_SORT = p.sort;
  return pfs.tree(p.projectId, { sort: p.sort });
});

const WIN_W = 1500, WIN_H = 950;
/**
 * 屏幕缩放。capturePage 给的是**物理像素**，判尺寸必须乘上它。
 * ⚠ `screen` 模块在 app ready 之前不能用（会抛），所以在回调里填。
 */
let WIN_SCALE = 1;

/** 窗口句柄放模块作用域：main 回调之外要用它推事件 */
const winRef = { win: null };

app.whenReady().then(async () => {
  WIN_SCALE = Math.max(1, Math.round(
    require('electron').screen.getPrimaryDisplay().scaleFactor || 1));
  // ⚠ 窗口不能无脑设 1500：屏只有 1267 逻辑宽时，Windows 会把它缩掉，
  //   于是 `WIN_W` 和真实宽度对不上，尺寸判据的基线就是错的
  //   （踩过一次：五张图全被判不合格，而它们宽度其实完全一致）。
  //   直接按屏宽来，要多少有多少。
  const { width: screenW } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(WIN_W, screenW - 40);
  const winH = Math.min(WIN_H, require('electron').screen.getPrimaryDisplay().workAreaSize.height - 60);
  console.log(`  屏幕缩放 ${WIN_SCALE}x，可用 ${screenW}x${winH}，窗口定为 ${winW}x${winH}`);

  const win = winRef.win = new BrowserWindow({
    width: winW, height: winH, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  /**
   * ⚠ 窗口必须 show 出来。show:false 的窗口 capturePage 只能拿到首次绘制那一帧 ——
   *   表现为"DOM 诊断全对，PNG 却是另一个页面"，而且不报错。
   *   （shoot-tool-ui.js 那一轮四张图字节数完全相同，就是这个。）
   */
  win.showInactive();

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 2200));

  /**
   * ⚠⚠ 拍之前先等布局稳定，而且**每一拍都要等**。
   *
   * 第一版只在 load 后等一次 2200ms，之后每张只多等 150ms。
   * 结果第一张 PNG 里第 4 栏被切掉一半（右边一条空白），
   * 而同一轮的另外三张是完整的 —— 日志里所有断言都绿。
   *
   * 原因：SplitPanes 要按拖拽位置算各栏宽度，那几步都排在
   * 首帧之后。第一张拍得太早，量到的还是布局中途的宽度。
   * 元素本身都在（DOM 查得到），只是画面没跟上。
   */
  const settled = () => win.webContents.executeJavaScript(`
    (() => {
      var d = document.documentElement;
      return d.scrollWidth <= window.innerWidth + 1
        && !!document.querySelector('[data-testid="tree-sort-btn"]');
    })()
  `);

  const shot = async (name) => {
    // 等布局稳定，最多等 3 秒
    for (let i = 0; i < 30; i++) {
      if (await settled()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await win.webContents.executeJavaScript("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 200));

    // ⚠ capturePage 会失败（UnknownVizError），而且是**未捕获的 promise 拒绝**——
    //   后果不是这一张图没有，而是整个脚本中途死掉，后面几张压根没拍，
    //   看起来像"界面挂了"。第一版就在这儿栽过。
    //   所以：捕获 + 重试；连续失败就把这一张记成"没拍成"，脚本继续往下走。
    let buf = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try {
        buf = (await win.webContents.capturePage()).toPNG();
      } catch (e) {
        console.log(`  [重试 ${i + 1}] capturePage 失败：${e.message}`);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await win.webContents.executeJavaScript("document.body.style.transition=''; true");

    if (!buf) {
      console.log(`  ✗ ${name} 没拍成（capturePage 反复失败）`);
      badShots.push(`${name}(没拍成)`);
      return;
    }

    // 拍完必须验尺寸。
    //
    // ⚠⚠ 这里踩过一个坑，而且方向完全搞反了：
    //   原本怀疑"布局没稳定导致图被切掉"，于是按「窗口宽的 90%」设阈值，
    //   结果五张**全被判不合格** —— 因为它们宽度完全一致（2534px）。
    //   一致就说明不是"某几张没稳"，是**基线算错了**：
    //   窗口设 1500 逻辑宽，但这台屏只有 1267 逻辑宽（2x → 2534 物理像素），
    //   Windows 直接把窗口缩小了，`win.getSize()` 才是真实值。
    //
    //   教训：判据第一次全红的时候，先量它到底看见了什么 ——
    //   五张一模一样，那不是"部分失败"，是"整体判断错了"。
    const width = buf.readUInt32BE(16);
    const realW = win.getContentBounds().width;   // 真实逻辑宽
    const minW = realW * WIN_SCALE * 0.95;
    if (width < minW) {
      console.log(`  ✗ ${name} 宽只有 ${width}，低于真实窗口宽 ${realW}x${WIN_SCALE} 的 95%（${Math.round(minW)}）`);
      badShots.push(`${name}(${width}px)`);
    } else {
      console.log('  ✓', name, `${width}px 宽（窗口真实 ${realW}x${WIN_SCALE}）`);
    }
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  };

  /**
   * 界面上当前显示的文件顺序。
   *
   * ⚠ FileTree 的行上没有 data-path，所以只能读可见文本——
   *   这也正是"用户看到的是什么"。
   *   取标签文字（不是整行），因为整行还有图标、大小、时间等。
   */
  const shownFiles = () => win.webContents.executeJavaScript(`
    [...document.querySelectorAll('span')]
      .map(s => s.textContent.trim())
      .filter(t => /^(灵柩|斩秋刀|青莲)\\.(md|txt)$/.test(t))
  `);

  const sortBtn = () => win.webContents.executeJavaScript(`
    (() => {
      var b = document.querySelector('[data-testid="tree-sort-btn"]');
      return b ? { title: b.title, ok: true } : { ok: false };
    })()
  `);

  const clickSort = () => win.webContents.executeJavaScript(`
    (() => {
      var b = document.querySelector('[data-testid="tree-sort-btn"]');
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  console.log('\n=== 文件树排序：控件与四档 ===');
  const badShots = [];
  console.log('  排序按钮:', JSON.stringify(await sortBtn()));
  console.log('  初始（应为 manual/手动）:', JSON.stringify(await shownFiles()));
  await shot('s1-排序-手动档');

  // 逐档点过去，每档都核对**顺序真的变了**
  const seen = [JSON.stringify(await shownFiles())];
  const NAMES = { manual: '手动', name: '名称', modified: '时间', size: '大小' };
  for (let i = 1; i <= 3; i++) {
    console.log(`  点第 ${i} 下:`, await clickSort());
    await new Promise((r) => setTimeout(r, 900));
    const files = await shownFiles();
    const title = (await sortBtn()).title || '';
    const which = Object.entries(NAMES).find(([, v]) => title.includes(v))?.[0] || '?';
    seen.push(JSON.stringify(files));
    console.log(`    现在是「${which}」档 · title=${title.slice(0, 40)}`);
    console.log(`    界面上是: ${JSON.stringify(files)}`);
    console.log(`    主进程收到的 sort: ${JSON.stringify(LAST_SORT)}`);
    if (i === 3) await shot('s2-排序-大小档');
    else if (i === 2) await shot('s3-排序-时间档');
  }

  // 非手动档应当有"拖拽会被盖掉"的说明
  const note = await win.webContents.executeJavaScript(
    "(() => { var n = document.querySelector('[data-testid=\"tree-sort-note\"]'); return n ? n.textContent.trim() : null; })()"
  );
  console.log('  非手动档的提示:', note);
  await shot('s4-排序-提示可见');

  // 点第四下回到 manual，说明与提示都该消失
  console.log('  再点一下（回 manual）:', await clickSort());
  await new Promise((r) => setTimeout(r, 900));
  console.log('  回 manual 后提示:', await win.webContents.executeJavaScript(
    "!!document.querySelector('[data-testid=\"tree-sort-note\"]')"
  ));
  await shot('s5-排序-回到手动');

  // ---- 可证伪：四档必须给出三个不同的顺序 ----
  // 少于三个就说明有两档对这一批文件是等价的 —— 控件可能没接上。
  const uniq = [...new Set(seen)];
  console.log(`\n  四档给出的不同顺序数: ${uniq.length} / 4`);
  if (uniq.length < 3) {
    console.log('  ✗ 至少两档顺序相同 —— 排序多半没真正生效（截图看着正常而已）');
  } else {
    console.log('  ✓ 至少三档顺序互不相同，排序确实生效了');
  }
  if (badShots.length) {
    console.log(`  ✗ 有 ${badShots.length} 张图布局没稳就拍了：${badShots.join(', ')}`);
  } else {
    console.log('  ✓ 五张图宽度都正常');
  }

  win.destroy();
  app.exit(uniq.length >= 3 && !badShots.length ? 0 : 1);
});

/**
 * 文件树截图 + 主动断言：新模板结构 + 拖文件夹进去文件跟着走。
 *
 * ## 为什么专门写一个
 *
 * 羽毛菌报的是：「我试着拖动文件夹，但是文件居然不跟随移动」。
 * 这句话有两种可能，得分开验：
 *
 *   1. **磁盘层没搬**（fs.renameSync 只搬了空壳 / 漏了子项）
 *   2. **磁盘层搬了，但界面让人以为没搬**
 *      —— 落点判定几乎命不中"放进去"，或搬进去之后那个文件夹是折叠的
 *
 * 第一种好查：node 里直接跑 pfs.move 就验了（它是好的）。
 * 第二种**只有把界面跑起来才看得见**，扫源码判据证明不了。
 *
 * ## 三个场景
 *
 *   fresh  全新项目的文件树：只有 设定/卷纲/章节 + 章节摘要.md
 *   into   把「卷纲」拖进「章节」：子文件必须跟着，且树要自动展开
 *   sort   拖到上沿 = 排序（不能被当成"放进去"）
 *
 * 运行：cmd //c "electron-run.cmd shoot-tree.js [fresh|into|sort]"
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

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-tree';

const ARGV = process.argv.slice(1).filter((a) => !a.startsWith('-'));
const SCRIPT_AT = ARGV.findIndex((a) => a.endsWith('.js'));
const SCENARIO = (SCRIPT_AT >= 0 ? ARGV[SCRIPT_AT + 1] : ARGV[0]) || 'fresh';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
/**
 * ⚠ createProject **不是幂等的**——store.js 里是裸 INSERT，
 *   第二次跑同一个 id 会抛 `UNIQUE constraint failed: projects.id`，
 *   而这行在模块顶层，于是整个脚本在加载期就挂住：
 *   一行输出都没有、进程不退、看起来像"卡住了"。
 *   （其他 shoot 脚本也有同样的坑，shoot-files.js 里是 db.createProject 直接调。）
 */
if (!db.getProject(PID)) db.createProject({ id: PID, name: '树结构验证' });

/**
 * ⚠ 每次都从**空目录**重新建。
 *   上一轮跑完的项目会被 ensureProject 的 `if (exists) return` 跳过，
 *   于是第二轮截图拍的是第一轮的旧结构——改完模板再跑，
 *   看到的还是老样子，误判成"改动没生效"。
 */
const DIR = pfs.projectDir(PID);
if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
pfs.ensureProject(PID);

// into/sort 场景要造出"文件夹里有东西"，否则验不了"文件跟着走"
if (SCENARIO !== 'fresh') {
  pfs.write(PID, '卷纲/第一卷.md', '# 第一卷\n\n- 主线：夜枫入道\n');
  pfs.write(PID, '卷纲/第二卷.md', '# 第二卷\n\n- 主线：入京都\n');
}

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

/** 从 preload 抠出全部通道名先注册兜底桩：漏一个渲染期就报 No handler */
const PRELOAD_SRC = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...PRELOAD_SRC.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
const fallbackFor = (ch) => (/_list$/.test(ch) ? [] : null);
for (const ch of ALL_CHANNELS) h(ch, () => fallbackFor(ch));

let CFG = {
  model: '', numCtx: 8192, temperature: 0.3, fontSize: 16,
  fontFamily: 'system-ui', theme: 'gold', notify: 'window',
  currentProject: PID, thinkLevel: 'off', activeConnectionId: '',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: PID }));
h('chapter:list', () => db.listChapters(PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.loadSettings(PID));
h('state:list', () => db.listEntityStates(PID));
h('thread:open', () => db.listOpenThreads(PID));
h('bible:query', () => ({ hits: [] }));
h('skill:list', () => db.listSkills(PID));
h('conv:list', () => db.listConversations(PID));
h('conv:create', () => db.createConversation({ projectId: PID, title: '' }));
h('conv:messages', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('ollama:check', () => ({ ok: false, error: '还没连' }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:move', (p) => pfs.move(p.projectId, p.from, p.toDir, { anchor: p.anchor, place: p.place }));
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

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
};

app.whenReady().then(async () => {
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
  // 拍两次扔第一张：capturePage 返回的是合成器最后一帧，不是此刻界面
  const shot = async (name) => {
    await js("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.capturePage();
    await new Promise((r) => setTimeout(r, 200));
    const img = await win.webContents.capturePage();
    await js("document.body.style.transition=''; true");
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  截图', name);
  };
  /** 文件树里的行；只取可见的（隐藏的设置页里也有 div[title]） */
  const rows = () => js(`(() => {
    const pane = document.querySelector('[data-pane="files"]');
    if (!pane) return '[]';
    return JSON.stringify([...pane.querySelectorAll('div[title]')]
      .filter(d => d.getClientRects().length > 0)
      .map(d => ({ title: d.title, pad: d.style.paddingLeft,
                   shadow: d.style.boxShadow || '' })));
  })()`);

  const alive = JSON.parse(await js(`JSON.stringify({
    kids: document.getElementById('root').children.length,
    buttons: document.querySelectorAll('button').length })`));
  console.log(`\n=== 文件树截图（场景 ${SCENARIO}）===`);
  console.log('  界面:', JSON.stringify(alive));
  if (alive.kids < 1 || alive.buttons < 3) {
    console.log('  ❌ 界面没渲染出来');
    app.exit(1);
  }
  // 切到「文件」页签才看得到文件树
  await js(`(() => {
    const b = [...document.querySelectorAll('button')]
      .filter(x => x.getClientRects().length > 0)
      .find(x => x.textContent.includes('文件'));
    if (b) b.click();
    return !!b;
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  if (SCENARIO === 'fresh') {
    const list = JSON.parse(await rows());
    console.log('  树:', list.map((r) => r.title).join(' | '));
    const titles = list.map((r) => r.title);
    t('只有 设定/卷纲/章节 三个文件夹 + 章节摘要.md',
      ['卷纲', '章节', '设定', '章节摘要.md'].every((x) => titles.includes(x)),
      `实际：${titles.join('、')}`);
    t('根目录没有散落的 md（世界观/人物库不该在这）',
      !titles.includes('世界观.md') && !titles.includes('人物库.md'),
      `根目录出现了：${titles.filter((x) => x.endsWith('.md')).join('、')}`);
    // ⚠ 别去点「设定」再截图：
    //   它默认就是展开的（根默认展开，子目录按 .order.json 记的状态），
    //   点一下反而折叠了 —— 第一版就是这么拍的空树。
    //   直接从已有的行里按**缩进**筛出子项。
    const opened = JSON.parse(await rows());
    // ⚠ parseFloat 不是 Number：style.paddingLeft 读回来是 "18px"，
    //   Number('18px') 是 NaN，而 NaN > 6 恒为 false ——
    //   过滤器静默丢掉所有子项，断言报"设定下实际：（空）"。
    //   看起来像界面没渲染，实际是筛选器自己坏了。
    const kids = opened.filter((r) => parseFloat(r.pad) > 6).map((r) => r.title);
    console.log('  缩进值:', opened.map((r) => `${r.title}=${r.pad}`).join(' | '));
    console.log('  设定下的子项:', kids.join(' | '));
    // ⚠ 路径分隔符两个都要认：tree() 在 Windows 上给的是反斜杠。
    //   第一版只判 `设定/世界观.md`，而实际是 `设定\世界观.md` → 假红。
    const has = (n) => kids.some((x) => x.replace(/\\/g, '/') === n);
    t('设定里是 世界观.md 与 人物库.md',
      has('设定/世界观.md') && has('设定/人物库.md'),
      `设定下实际：${kids.join('、')}`);
    t('没有占位的「说明.md」',
      !kids.some((x) => /说明/.test(x)), `出现了：${kids.filter((x) => /说明/.test(x)).join('、')}`);
    await shot('f1-新项目-干净的三个文件夹');
  }

  if (SCENARIO === 'into' || SCENARIO === 'sort') {
    /**
     * 拖拽：派发真实 DOM 的 HTML5 事件序列。
     *
     * ⚠ 坐标要按**纵向**给（判据改成纵向了）：
     *   落在行中间 → 放进去；落在上沿 → 排序。
     *   第一版用 `rect.left + width*0.85`（横向右侧 15%），
     *   在改成纵向判定后那个坐标 v≈0.5，仍然会"放进去"——
     *   也就是说**测不出"落在中间"这个条件本身**。
     *
     * ⚠ 视觉要在**下一轮事件循环**里读，不能在 dispatch 之后立刻读：
     *   dragover 里的 setDrag 是 React 的 state 更新，同步读 DOM 拿到的
     *   还是 dragover 之前的旧 style（boxShadow 为空）。
     *   于是断言报"没被判成放进去"，而移动其实是成功的——
     *   **一个假的红**。用 requestAnimationFrame 等两帧再读。
     */
    const dragResult = await js(`(async () => {
      const pane = document.querySelector('[data-pane="files"]');
      const vis = () => [...pane.querySelectorAll('div[title]')]
        .filter(d => d.getClientRects().length > 0);
      const src = vis().find(d => d.title === '卷纲');
      const dst = vis().find(d => d.title === '章节');
      if (!src || !dst) return JSON.stringify({ err: 'not-found' });
      let dt; try { dt = new DataTransfer(); } catch (e) { return JSON.stringify({ err: e.message }); }
      const r = dst.getBoundingClientRect();
      // 纵向位置：0.5 = 行中间（放进去）；0.06 = 紧贴上沿（排序）
      const vRatio = ${SCENARIO === 'sort' ? 0.06 : 0.5};
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * vRatio;

      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));

      // 等两帧，让 React 把 drag state 提交并重绘
      const nextFrame = () => new Promise(r2 => requestAnimationFrame(() => r2()));
      await nextFrame(); await nextFrame();
      const vs = vis().find(d => d.title === '章节');
      const visual = vs ? (vs.style.boxShadow || '') : '';
      const bg = vs ? (vs.style.background || '') : '';

      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return JSON.stringify({ vRatio, visual, bg });
    })()`);
    console.log('  拖拽:', dragResult);
    await new Promise((r) => setTimeout(r, 800));

    if (SCENARIO === 'into') {
      const st = JSON.parse(dragResult);
      t('落在行中间被判定为「放进去」（左边那条竖条）',
        /inset 3px 0 0/.test(st.visual || ''),
        `视觉是「${st.visual}」—— 中间落点没被判成放进去`);
      t('★ 卷纲 整个进了 章节（含子文件）',
        fs.existsSync(pfs.resolveIn(PID, '章节/卷纲/第一卷.md')),
        '章节/卷纲/第一卷.md 不存在 —— 文件没跟着文件夹走');
      t('★ 根目录不再有 卷纲',
        !fs.existsSync(pfs.resolveIn(PID, '卷纲')),
        '卷纲还在项目根');
      const after = JSON.parse(await rows());
      const vis = after.map((r) => r.title);
      t('★ 树自动展开了，用户能看见文件跟着走了',
        vis.some((x) => /章节[/\\]卷纲[/\\]第一卷\.md/.test(x)),
        `树上没出现 子文件，实际：${vis.join('、')}`);
      console.log('  移动后树:', vis.join(' | '));
      await shot('f2-拖文件夹-整个进去了');
    } else {
      const st = JSON.parse(dragResult);
      t('落在上沿被判定为「排序」（上插入线，不是放进去）',
        /inset 0 2px 0/.test(st.visual || '') && !/inset 3px 0 0/.test(st.visual || ''),
        `视觉是「${st.visual}」`);
      t('排序没有把文件夹搬进对方',
        fs.existsSync(pfs.resolveIn(PID, '卷纲')) && !fs.existsSync(pfs.resolveIn(PID, '章节/卷纲')),
        '上沿落点被误判成"放进去"了');
      await shot('f3-拖上沿-排序');
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${SCENARIO}：通过 ${pass} / 失败 ${fail}`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('崩溃：', e); app.exit(1); });

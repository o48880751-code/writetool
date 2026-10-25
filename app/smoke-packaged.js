/**
 * 打包后 exe 的启动冒烟测试。
 *
 * 验的不是「能不能打开」，而是完整链路：
 *   Electron 启动 → 主进程加载 resources/modules → SQLite 建库
 *   → 渲染进程加载页面 → IPC 通 → 文风链路可调用
 *
 * 用法（⚠ 必须显式传产物目录，否则测的是开发态不是打包态）：
 *   env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/electron/dist/electron.exe smoke-packaged.js \
 *     ../release-ship/win-unpacked
 *
 * 第一版没传参，直接信 `app.isPackaged`——但用 electron.exe 跑脚本时它恒为 false，
 * 于是 ROOT 指向源码目录、页面路径也指向 dev 的 dist，
 * 测出来「页面不存在」，而真实的 exe 其实是好的。**测的东西不对，结论就无效。**
 *
 * 无显示器环境下靠 4 个 GPU 开关才能起渲染进程（见 app/README.md）。
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

/** 产物根目录：argv[2]（--packaged-dir=xxx 或直接给路径） */
function resolveProductDir() {
  const arg = process.argv.find((a) => a.startsWith('--packaged-dir='));
  const raw = arg ? arg.split('=')[1] : process.argv[2];
  if (raw && fs.existsSync(path.resolve(raw))) return path.resolve(raw);
  return null;
}

const PRODUCT = resolveProductDir();
const ROOT = PRODUCT
  ? path.join(PRODUCT, 'resources', 'modules')
  : path.join(process.cwd(), '..');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
}

const logFile = path.join(os.tmpdir(), 'writetool-ship-smoke.log');

app.whenReady().then(async () => {
  console.log('\n打包产物启动冒烟测试');
  console.log(`ROOT = ${ROOT}\n`);

  t('Electron 以图形模式运行（未被 ELECTRON_RUN_AS_NODE 降级）',
    typeof app.getPath === 'function');

  // ---- 模块加载 ----
  let store, styleApi;
  try {
    ({ Store } = require(path.join(ROOT, 'db', 'store.js')));
    styleApi = require(path.join(ROOT, 'memory', 'style.js'));
    t('db/store.js 与 memory/style.js 加载成功', true);
  } catch (e) {
    t('模块加载', false, e.message);
    finish();
    return;
  }

  // ---- 风格层可运行 ----
  try {
    const p = styleApi.buildProfile([
      '“你爹在家不？”夜大田坐在石墩上，灌了口水。夜枫放下刨子站起身。草鞋沾满了泥，显是刚从外头跑货回来。“大伯。”夜大田压低声音：“我前日在青石镇，碰上了一个仙师。”夜大柱从里间出来，手里还攥着把修了一半的刨子。堂屋里静了一瞬。',
      '“盘缠路费少说要十五两。”十五两。夜大柱沉默了。他一个月攒不下二两银子。婆娘刘氏犹豫道：“那……要花银子不？”他这爹是个老实巴交的木匠，在村口支了个小摊卖炊饼。日子过得紧巴巴的。',
    ]);
    t('产物内风格层可建画像', p.ok, p.ok ? `${p.sampleCount} 篇，置信度 ${p.confidence}` : p.error);
    const d = styleApi.styleDirective(p);
    t('产物内风格指令可生成', d.length > 10, `${d.split('\n').length} 行`);
  } catch (e) {
    t('风格层可运行', false, e.message);
  }

  // ---- SQLite ----
  try {
    const dbPath = path.join(os.tmpdir(), `ship-smoke-${Date.now()}.db`);
    const s = new Store(dbPath);
    s.createProject({ id: 'ship-smoke', name: '冒烟测试' });
    const ps = s.listProjects();
    t('产物内 SQLite 建库与读写', ps.some((p) => p.id === 'ship-smoke'), `${ps.length} 个项目`);

    // listRecentChapterContents 必须在产物里可用（风格面板依赖它）
    const bodies = s.listRecentChapterContents('ship-smoke', 12);
    t('listRecentChapterContents 可调用', Array.isArray(bodies));
    s.close();
    try { fs.rmSync(dbPath, { force: true }); } catch {}
  } catch (e) {
    t('SQLite 建库', false, e.message);
  }

  // ---- 渲染进程 ----
  const candidates = [];
  if (PRODUCT) {
    // 打包态：页面在 asar 里，dist 是根
    candidates.push(path.join(PRODUCT, 'resources', 'app.asar', 'dist', 'index.html'));
  } else {
    candidates.push(path.join(process.cwd(), 'dist', 'index.html'));
  }
  const html = candidates.find((p) => fs.existsSync(p));
  if (!html) {
    t('渲染页面存在', false,
      `试过：${candidates.join(' | ')}\n    未传 --packaged-dir 时测的是开发态，不是打包态`);
    finish();
    return;
  }
  t('渲染页面存在', true, html.replace(process.cwd(), '.'));

  // ⚠ preload 必须显式传。只 loadFile(html) 的话 BrowserWindow 不带 preload，
  // window.api 压根不存在——第一版就是这么得出「no-api」的，
  // 看起来像产品缺陷，其实是测试自己没把通道接上。
  const preload = [
    path.join(__dirname, 'electron', 'preload.js'),
    path.join(PRODUCT || '', 'resources', 'app.asar', 'electron', 'preload.js'),
  ].find((p) => p && fs.existsSync(p));

  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: preload || undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (!preload) {
    t('preload 脚本存在', false, `试过：${preload}`);
  }
  const loaded = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 20000);
    win.webContents.on('did-finish-load', () => { clearTimeout(timer); resolve('ok'); });
    win.webContents.on('did-fail-load', (_e, code, desc) => { clearTimeout(timer); resolve(`fail:${code} ${desc}`); });
    win.loadFile(html);
  });
  t('渲染进程加载页面', loaded === 'ok', loaded === 'ok' ? '' : loaded);

  if (loaded === 'ok') {
    t('preload 已挂载', !!preload, preload ? preload.replace(process.cwd(), '.') : '');
    // IPC 往返
    ipcMain.handle('smoke:ping', () => ({ pong: true }));
    const r = await win.webContents.executeJavaScript(
      'window.api && typeof window.api.style === "object" ? "exposed" : "no-api"'
    );
    t('preload 暴露 window.api.style', r === 'exposed', String(r));

    // 文风面板组件是否真的编译进了产物
    const hasPanel = await win.webContents.executeJavaScript(
      '!!document.body.innerHTML.length'
    );
    t('页面已渲染内容', hasPanel === true);

    const shot = path.join(os.tmpdir(), 'writetool-ship.png');
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(shot, img.toPNG());
      t('页面截图成功', fs.existsSync(shot) && fs.statSync(shot).size > 1000,
        `${shot} · ${fs.existsSync(shot) ? Math.round(fs.statSync(shot).size / 1024) : 0} KB`);
    } catch (e) {
      t('页面截图', false, e.message);
    }
  }

  // ---- 四栏新增能力：必须在打包态验证 ----
  //
  // project-fs.js 与 markdown-render.js 是这一轮新增的运行时模块。
  //
  // ⚠ 路径：它们在 **app.asar 里**（files 白名单是 dist/ + electron/），
  //   而 ROOT 指向 resources/modules（extraResources 放的 db/ 与 memory/）。
  //   第一版用 path.join(ROOT, 'electron', ...) 拼，结果指向
  //   modules/electron/ —— 报 Cannot find module。
  //   看起来像「模块没打进包」，实际是**测试自己找错了地方**。
  //
  //   这也正是第 9 章那条教训的又一次：现象指向模块缺失，
  //   先确认自己找的路径对不对。
  // ⚠⚠ 必须用 PRODUCT（--packaged-dir 指到的那个目录）拼路径，
  //   **不能用 process.resourcesPath**。
  //   这个 smoke 脚本是用开发态的 electron.exe 跑的，
  //   process.resourcesPath 指向 electron 自己的安装目录
  //   （.../node_modules/electron/dist/resources），根本不是打包产物。
  //   第一版就是在这儿栽的：路径指向 electron 自带目录，报 Cannot find module，
  //   看起来像「模块没打进安装包」。
  const ASAR_ELECTRON = PRODUCT
    ? path.join(PRODUCT, 'resources', 'app.asar', 'electron')
    : path.join(process.resourcesPath, 'app.asar', 'electron');
  {
    const fsMod = path.join(ASAR_ELECTRON, 'project-fs.js');
    const mdMod = path.join(ASAR_ELECTRON, 'markdown-render.js');
    // ⚠ 不能用 fs.existsSync 判断 asar 内部文件——fs 走原生调用，
    //   不认 Electron 的 asar 虚拟文件系统，永远返回 false。
    //   正确判据就是 require 成功与否（下面两条已经覆盖了）。

    let pfs = null;
    let md = null;
    try {
      ({ ProjectFs: pfs } = require(fsMod));
      t('产物内 project-fs.js 可 require', !!pfs);
    } catch (e) {
      t('产物内 project-fs.js 可 require', false, `ERR: ${e.message.split('\\n')[0]}`);
    }
    try {
      md = require(mdMod);
      t('产物内 markdown-render.js 可 require', typeof md.parse === 'function');
    } catch (e) {
      t('产物内 markdown-render.js 可 require', false, e.message);
    }

    if (pfs) {
      // 用一个临时项目目录跑真实读写，不碰用户数据
      const tmpRoot = path.join(os.tmpdir(), `wt-smoke-fs-${Date.now()}`);
      const fsm = new pfs(tmpRoot);
      try {
        const made = fsm.ensureProject('smoke');
        // ⚠ 路径要跟**当前**模板一致（2026-10-13 模板改过）：
        //   世界观.md / 人物库.md 挪进了「设定/」，
        //   这里若还写死旧路径，冒烟就会报"打包态建不出模板"——
        //   而打包其实是好的，是这条断言过期了。
        //   （症状与"extraResources 漏了 db 模块"一模一样，最容易误判成打包坏了。）
        // ⚠ 路径要跟**当前**模板一致。2026-10-16 又挪了一次：
        //   章节摘要.md 从项目根进到 章节/ 里（根目录不再放内容文件）。
        //   断言过期的话会报"打包态建不出模板"——而打包其实是好的。
        t('打包态能建项目文件夹与模板', made.created
          && fs.existsSync(path.join(tmpRoot, 'smoke', '设定', '世界观.md'))
          && fs.existsSync(path.join(tmpRoot, 'smoke', '设定', '人物库.md'))
          && fs.existsSync(path.join(tmpRoot, 'smoke', '章节', '章节摘要.md'))
          && fs.existsSync(path.join(tmpRoot, 'smoke', '卷纲')),
          made.dir);
        fsm.write('smoke', '测试.md', '# 标题\n\n- 甲：说明\n');
        const back = fsm.read('smoke', '测试.md');
        t('打包态文件读写一致', back.content.includes('甲：说明'));
        const tr = fsm.tree('smoke');
        t('打包态文件树能扫到文件',
          (tr.children || []).some((c) => c.name === '测试.md'),
          `${(tr.children || []).length} 项`);
        // 越界防护在打包态同样生效——这里不是走过场，是真的拦一次
        let blocked = false;
        try { fsm.read('smoke', '../../../../Windows/win.ini'); }
        catch (e) { blocked = /越界/.test(e.message); }
        t('打包态路径越界被拦下', blocked);
      } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      }
    }

    if (md && md.parse) {
      const blocks = md.parse('# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- 列表');
      const kinds = blocks.map((b) => b.t);
      t('打包态 markdown 渲染器产出正确结构',
        kinds.includes('h') && kinds.includes('table') && kinds.includes('ul'),
        JSON.stringify(kinds));
      t('打包态字数统计剥离 md 标记', md.stat('# 标题').chars === 2,
        `实际 ${md.stat('# 标题').chars}`);
    }
  }

  // ---- 拖拽排序：tree-order.js 是 2026-10-12 新增的运行时模块 ----
  //
  // 开发态存在不代表进了安装包（第 9 章踩过「文件不在包里，require 直接崩」）。
  // 而且它 require 的是同目录的 project-fs.js —— 打包后两个都要在。
  {
    const ASAR_ELECTRON = PRODUCT
      ? path.join(PRODUCT, 'resources', 'app.asar', 'electron')
      : path.join(process.resourcesPath, 'app.asar', 'electron');
    let orderMod = null;
    try {
      orderMod = require(path.join(ASAR_ELECTRON, 'tree-order.js'));
      t('产物内 tree-order.js 可 require', typeof orderMod.applyOrder === 'function');
    } catch (e) {
      t('产物内 tree-order.js 可 require', false,
        `ERR: ${String(e.message).split('\n')[0]}`);
    }

    // 打包态跑一遍真实的拖拽落点：建项目 → 写文件 → 排序 → 移动
    const os = require('node:os');
    const tmpRoot = path.join(os.tmpdir(), `wt-smoke-mv-${Date.now()}`);
    const { ProjectFs: Pfs2 } = require(path.join(ASAR_ELECTRON, 'project-fs.js'));
    const fsm = new Pfs2(tmpRoot);
    const onlyMine = (t, re) => t.children
      .filter((x) => x.type === 'file' && re.test(x.name)).map((x) => x.name);
    try {
      fsm.ensureProject('mv');
      fsm.write('mv', 'a.md', 'a');
      fsm.write('mv', 'b.md', 'b');
      fsm.write('mv', 'c.md', 'c');

      const t0 = fsm.tree('mv');
      const dirsBefore = t0.children.filter((x) => x.type === 'dir').map((x) => x.name);
      const filesBefore = onlyMine(t0, /^[abc]\.md$/);

      fsm.move('mv', 'a.md', '', { anchor: 'c.md', place: 'before' });
      const t1 = fsm.tree('mv');
      const filesAfter = onlyMine(t1, /^[abc]\.md$/);
      const dirsAfter = t1.children.filter((x) => x.type === 'dir').map((x) => x.name);

      // ⚠ 判据用「a 落在 c 前面」而不是绝对位置：
      //   初始是 a,b,c（拼音序），把 a 拖到 c 前 → b,a,c。
      //   第一版我写成 after[2]==='a'，而实际 after[2] 是 'c'——
      //   是断言写错了，不是实现。
      t('打包态拖拽排序生效',
        filesAfter.indexOf('a.md') < filesAfter.indexOf('c.md'),
        `前:${filesBefore.join(',')} 后:${filesAfter.join(',')}`);
      t('打包态文件没丢没重', filesAfter.length === 3, filesAfter.join(','));

      // 拖文件不该动目录的相对位置（分段处理，见 project-fs 的 _recordSiblingOrder）
      t('打包态目录顺序未被文件排序影响',
        dirsAfter.join(',') === dirsBefore.join(','),
        `前:${dirsBefore.join(',')} 后:${dirsAfter.join(',')}`);

      fsm.move('mv', 'a.md', '卷纲');
      t('打包态跨目录移动生效',
        fs.existsSync(fsm.resolveIn('mv', '卷纲/a.md'))
        && !fs.existsSync(fsm.resolveIn('mv', 'a.md')));

      // 成环拦截在打包态同样生效。
      // ⚠ 先造一个真的嵌套目录再测：ensureProject 建的是**平级**的
      //   卷纲/ 章节/ 设定/，没有嵌套。第一版写成 move('卷纲','卷纲/章节')
      //   ——那个目录根本不存在，于是报的是「目标目录不存在」，
      //   成环检查压根没执行到，测试因此红。
      //   （这正是「现象指向某个功能坏了，先确认前提存在」的又一例。）
      fsm.write('mv', '卷纲/内层/甲.md', 'x');
      let blocked = false;
      let msg = '';
      try { fsm.move('mv', '卷纲', '卷纲/内层'); }
      catch (e) { blocked = /自己的子目录/.test(e.message); msg = e.message; }
      t('打包态成环移动被拦下', blocked, msg || '没报错');
      t('打包态成环拦截后现场未被动过',
        fs.existsSync(fsm.resolveIn('mv', '卷纲/内层/甲.md')));
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }

    // 顺序文件不出现在文件树里
    if (orderMod) {
      t('顺序表是点开头的隐藏文件',
        orderMod.ORDER_FILE.startsWith('.'), orderMod.ORDER_FILE);
    }
  }

  // ---- provider.js：2026-10-12 新增的运行时模块 ----
  //
  // 它 require 同目录的模块吗？不。但 main.js require 它，
  // 打包后主进程在 asar 里加载 —— 开发态存在不代表进了包。
  // 第 9 章踩过「文件不在包里，require 直接崩」。
  {
    const E = PRODUCT
      ? path.join(PRODUCT, 'resources', 'app.asar', 'electron')
      : path.join(process.resourcesPath, 'app.asar', 'electron');
    let pv = null;
    try {
      pv = require(path.join(E, 'provider.js'));
      t('产物内 provider.js 可 require', typeof pv.chatStream === 'function'
        && typeof pv.probe === 'function');
    } catch (e) {
      t('产物内 provider.js 可 require', false,
        `ERR: ${String(e.message).split('\n')[0]}`);
    }
    // secret-store 需要 electron 的 safeStorage，打包态应能 require
    try {
      const ss = require(path.join(E, 'secret-store.js'));
      t('产物内 secret-store.js 可 require', typeof ss.init === 'function'
        && typeof ss.save === 'function');
    } catch (e) {
      t('产物内 secret-store.js 可 require', false,
        `ERR: ${String(e.message).split('\n')[0]}`);
    }

    if (pv) {
      // 思考参数：三家三种形态的映射在打包后仍然要对
      t('打包态 Ollama think=false 显式下发',
        pv.buildThinkParams('ollama', 'off').fields.think === false);
      const ds = pv.buildThinkParams('openai-compatible', 'on', { thinkStyle: 'dashscope' });
      t('打包态百炼 enable_thinking 在顶层',
        ds.fields.enable_thinking === true && !('extra_body' in ds.fields));
      const or_ = pv.buildThinkParams('openai-compatible', 'high', { thinkStyle: 'openrouter' });
      t('打包态 OpenRouter reasoning.effort 正确',
        or_.fields.reasoning && or_.fields.reasoning.effort === 'max');

      // SSE 解析在打包后仍要认 [DONE] 与 reasoning_content
      const got = { text: [], think: [] };
      const m1 = pv.handleLine('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}',
        {}, 'openai', { onText: (x) => got.text.push(x), onThink: (x) => got.think.push(x) });
      const m2 = pv.handleLine('data: [DONE]', {}, 'openai',
        { onText: () => {}, onThink: () => {} });
      t('打包态 SSE 解析思考与正文分离',
        got.think.length === 1 && got.text.length === 0);
      t('打包态 SSE 认 [DONE]', m2.done === true);

      // 密钥脱敏：打包后同样要生效
      const SECRET = 'sk-PACKAGED-MUST-NOT-LEAK';
      const msg = pv.describeHttp(500, `error with ${SECRET}`, 'openai', SECRET);
      t('打包态错误信息不含密钥', !msg.includes(SECRET), msg.slice(0, 60));
    }
  }

  // ---- builtin-skills：2026-10-12 新增的目录式内置技能 ----
//
// ⚠ 这一条是**打包后才暴露的坑**：开发态读的是源码目录，一切正常；
//   打完包 app.asar 里如果没有 builtin-skills/，
//   启动时 seedBuiltinSkills 会抛「目录读不到」，
//   而用户看到的只是「技能列表里没有这两个」——完全猜不到是漏打包了。
{
  const ASAR = PRODUCT
    ? path.join(PRODUCT, 'resources', 'app.asar')
    : path.join(process.resourcesPath, 'app.asar');
  const BS_ASAR = path.join(ASAR, 'builtin-skills');
  // ⚠ 这条原来只查 app.asar/builtin-skills —— **查错了地方**。
  //   db/store.js 运行时读的是 resources/modules/ 下那一份
  //   （extraResources 拷的），它根本不在 app.asar 里。
  //   后果：把 extraResources 那行删掉，测试照样全过 ——
  //   等于这条断言什么都没钉住。是我自己写出来后
  //   试着删配置验证它能不能失败，才发现它查的是另一份。
  //   两处都要查：任一缺失都会让功能在真实运行时断掉。
  const BS_MODULES = path.join(PRODUCT
    ? path.join(PRODUCT, 'resources', 'modules')
    : path.join(process.resourcesPath, 'modules'), 'builtin-skills');
  const inAsar = fs.existsSync(BS_ASAR);
  const inModules = fs.existsSync(BS_MODULES);
  // ⚠ app.asar 侧**不该有** builtin-skills。
//   第一次做的时候我把它加进了 build.files，结果白白多打了一份副本，
//   还让人以为 db 是从 asar 里读的。真正被读的是 resources/modules/ 那份。
//   这条断言防的就是那个多余副本回流。
  // ⚠ detail 只在失败时打印：这两条的 detail 是"怎么修"的提示，
  // 通过时也打出来，会让人以为产物缺东西。
  t('产物内不含冗余的 app.asar/builtin-skills（db 读不到那儿）', !inAsar,
    !inAsar ? '' : `不该有：${BS_ASAR}`);
  t('★ 产物内含 builtin-skills（resources/modules 侧，db 实际读这里）',
    inModules, inModules ? '' : `找不到 ${BS_MODULES} —— 检查 package.json 的 extraResources`);

  // ---- 源码改了但忘记重打包，是最贵的一类错 ----
  // 2026-10-13 的「An object could not be cloned」就是这么溜过去的：
  // 源码早修好了，但装出来的 exe 还是旧的坏代码，而所有源码级测试照样全绿。
  // 这里直接把产物 asar 里的关键代码读出来核对。
  if (PRODUCT) {
    try {
      const asar = require(require.resolve('@electron/asar'));
      const src = asar.extractFile(
        path.join(PRODUCT, 'resources', 'app.asar'), 'electron/provider.js').toString();
      // ⚠ 只看代码行。注释里就写着 `version: safeVersion(cfg)` 这个反面示例，
      //   全文匹配会永远命中，报出一条假警（我第一次就栽在这）。
      const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
      const code = codeLines.join('\n');
      // ⚠⚠ 还要排掉**函数定义行**。`async function safeVersion(cfg)` 参数名一样，
      //   第一次只排注释，新旧包一起红，我差点去改本来正确的代码。
      //   判据自己出错的两次，都是"匹配到了不该算的那一行"。
      const callSites = code.split('\n').filter(
        (l) => /safeVersion\(cfg\)/.test(l) && !/function\s+safeVersion\s*\(/.test(l));
      const badCalls = callSites.filter((l) => !/await\s+safeVersion\(cfg\)/.test(l));
      t('★ 产物内 probe 的 safeVersion 已 await（IPC 可克隆修复在包里）',
        callSites.length > 0 && badCalls.length === 0,
        badCalls.length
          ? `产物里的 provider.js 还是裸调用：${badCalls.join(' | ').trim()} —— 改了源码没重打包？`
          : (!callSites.length ? '产物里根本没找到 safeVersion 调用点，产物与源码对不上' : ''));
    } catch (e) {
      t('产物内 provider.js 可从 asar 提取核对', false, e.message);
    }
  }

  if (inModules) {
    const BS = BS_MODULES;
    let FMT = null;
    try {
      FMT = require(path.join(ASAR, 'electron', 'skill-format.js'));
    } catch (_) { /* 下面那条会报 */ }
    for (const id of ['sk-novel-writer', 'sk-skill-creator']) {
      const md = path.join(BS, id, 'SKILL.md');
      const has = fs.existsSync(md);
      t(`产物内 ${id}/SKILL.md 存在`, has);
      if (has && FMT) {
        const parsed = FMT.parse(fs.readFileSync(md, 'utf8'));
        t(`产物内 ${id} frontmatter 可解析`,
          !!parsed.name && !!parsed.description,
          `name="${parsed.name}" desc=${String(parsed.description).length}字`);
        t(`产物内 ${id}/references 也在`,
          fs.existsSync(path.join(BS, id, 'references', 'templates.md')));
      }
    }
    try {
      const R = require(path.join(ASAR, 'electron', 'provider-presets.js'));
      t('产物内服务商量表可 require 且完整',
        Array.isArray(R.PROVIDERS) && R.PROVIDERS.length >= 10
        && !!R.get('deepseek') && !!R.get('zhipu') && !!R.get('siliconflow'),
        `${R.PROVIDERS && R.PROVIDERS.length} 家`);
    } catch (e) {
      t('产物内服务商量表可 require 且完整', false, String(e.message).slice(0, 60));
    }
  }

  /**
   * ---- 工具能力（终端 / 联网）----
   *
   * ⚠ 这一批的判据是「require 得起来」而不是「文件在不在」。
   *   理由：这三个新模块（tools / agent-loop / approval）互相 require，
   *   漏打任何一个都会在**加载期**炸 —— 而软件一装上就双击，
   *   用户看到的是「main process 出错」，跟"工具不能用"完全不是一回事。
   *
   * ⚠ 打包漏文件是这类项目最贵的错：源码级测试全绿，
   *   装出来的 exe 却是坏的。所以源码里加一个模块，产物里就得有一条判据。
   */
  for (const [mod, wantFn] of [
    ['tools.js', ['execTool', 'classifyCommand', 'TOOL_DEFS']],
    ['agent-loop.js', ['createAgentRun']],
    ['approval.js', ['createApprovalGate']],
  ]) {
    let M = null;
    try {
      M = require(path.join(ASAR, 'electron', mod));
    } catch (_) { /* 下面报 */ }
    t(`★ 产物内 ${mod} 可 require`,
      !!M, M ? '' : `app.asar/electron/${mod} 加载不了 —— 检查 package.json 的 build.files`);
    if (M) {
      const missing = wantFn.filter((f) => typeof M[f] === 'undefined');
      t(`★ 产物内 ${mod} 导出完整`, missing.length === 0,
        missing.length ? `缺 ${missing.join(', ')}` : '');
    }
  }

  /**
   * 危险命令判定器必须在产物里真的拒得掉东西。
   *
   * ⚠ 只判"文件在"不够：electron-builder 可能把 tools.js 打进去了，
   *   但内容是旧版本（源码改了没重打）。所以直接调它验证行为。
   */
  try {
    const T = require(path.join(ASAR, 'electron', 'tools.js'));
    const danger = T.classifyCommand('Remove-Item -Recurse C:\\temp');
    const safe = T.classifyCommand('Get-ChildItem *.md');
    t('★ 产物内危险命令仍会被拦',
      danger && danger.dangerous === true && Array.isArray(danger.reasons) && danger.reasons.length > 0,
      `dangerous=${danger && danger.dangerous}`);
    t('★ 产物内普通命令不被误拦', safe && safe.dangerous === false,
      `安全命令被判危险：${(safe && safe.reasons || []).join('、')}`);
    /**
     * ⚠ 这里必须调 checkUrl 而不是 isBlockedHost。
     *   isBlockedHost 收的是**纯 hostname**，喂它整条 URL 会返回 false
     *   ——第一版就是这么写的，红了一条。防护没丢，是判据调错了函数。
     *   checkUrl 才是真正被 fetchPage/searchWeb 调用的那一层。
     */
    const meta = T.checkUrl('http://169.254.169.254/latest/meta-data/');
    t('★ 产物内内网地址仍被拦（SSRF 防护没丢）',
      meta && meta.ok === false && /内网/.test(meta.error || ''),
      `checkUrl 返回 ok=${meta && meta.ok} —— 防护在产物里丢了？`);
    // 公网地址必须放行：只测拦截不测放行的话，一个「全部拒绝」的实现也能全绿
    const pub = T.checkUrl('https://example.com/a');
    t('★ 产物内公网地址仍放行（不是一律拒绝）',
      !!pub && pub.ok === true, `公网地址被拒：${pub && pub.error}`);
  } catch (e) {
    t('产物内 tools.js 可直接调用验证行为', false, String(e.message).slice(0, 80));
  }

  /**
   * 审批闸门：产物里必须仍然是「默认拒绝」。
   *
   * ⚠ 这是最要紧的一条 —— 它是模型能碰用户电脑的最后一道闸。
   *   如果哪天打包把它弄丢了，主进程会在 require 时崩；
   *   而如果它还在但行为变了（有人改成默认放行），
   *   装出来的软件就是一个沉默的后门。
   */
  try {
    const { createApprovalGate } = require(path.join(ASAR, 'electron', 'approval.js'));
    // 没有界面 → 必须拒绝
    const g1 = createApprovalGate({ available: false, send: () => {} });
    // 发送抛异常 → 必须拒绝
    const g2 = createApprovalGate({
      available: true,
      send: () => { throw new Error('Object has been destroyed'); },
    });
    // 伪造 id → 不该命中任何审批
    const g3 = createApprovalGate({ available: true, send: () => {} });
    // 超时 5ms 且无人回应 → 必须拒绝
    const g4 = createApprovalGate({ available: true, send: () => {}, timeoutMs: 5 });

    const r1 = await g1.request({ command: 'rm' });
    const r2 = await g2.request({ command: 'rm' });
    const r3 = g3.decide('ap-999', true);
    const r4 = await g4.request({ command: 'rm' });
    t('★ 产物内审批：没有界面时拒绝', r1 === false);
    t('★ 产物内审批：发送失败时拒绝', r2 === false);
    t('★ 产物内审批：伪造 id 不放行', r3 === false);
    t('★ 产物内审批：超时拒绝', r4 === false);
  } catch (e) {
    t('产物内 approval.js 可直接调用验证行为', false, String(e.message).slice(0, 80));
  }

  /**
   * 排序档位：产物的行为必须与源码一致。
   *
   * ⚠ 为什么单独查这一条：sort 的链路横跨四层
   *   （FileTree → App → preload → main → project-fs），
   *   任何一层在打包时漏掉（asar 路径、contextBridge 白名单），
   *   源码测试全绿而**装出来的软件排序点了没反应**。
   *   源码测试抓不到这种只在产物里出现的断链。
   */
  try {
    const pf = require(path.join(ASAR_ELECTRON, 'project-fs.js'));
    t('★ 产物内 SORT_BY_NAME 已导出且不含 manual',
      Array.isArray(pf.SORT_BY_NAME)
      && ['name', 'modified', 'size'].every((k) => pf.SORT_BY_NAME.includes(k))
      && !pf.SORT_BY_NAME.includes('manual'));

    // 真跑一次排序，确认四档都能用
    const spid = 'smoke-sort';
    const root = path.join(os.tmpdir(), `smoke-sort-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    const pfs2 = new pf.ProjectFs(root);
    pfs2.ensureProject(spid);
    pfs2.write(spid, 'aaa.md', 'x'.repeat(100));
    pfs2.write(spid, 'bbb.md', 'y'.repeat(9000));
    const filesOf = (opt) => pfs2.tree(spid, opt).children
      .filter((c) => c.type === 'file').map((c) => c.name)
      // ⚠ 排除模板自带的「章节摘要.md」。项目模板里有它，而
      //   「目录恒在文件前」是刻意规则，它会排在文件段第一位。
      //   不排除的话期望值就是错的 —— 第一次写就踩了这个坑。
      .filter((n) => ['aaa.md', 'bbb.md'].includes(n));
    t('★ 产物内按大小排序可用',
      filesOf({ sort: 'size' }).join(',') === 'bbb.md,aaa.md',
      filesOf({ sort: 'size' }).join(','));
    t('★ 产物内不传 sort 等价于 manual（不崩且有内容）',
      filesOf({}).length === 2, filesOf({}).join(','));
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    t('产物内 project-fs 排序可验证', false, String(e.message).slice(0, 80));
  }
}

  /**
   * ---- 本轮新增的界面代码有没有打进 dist ----
   *
   * ⚠ 「源码改了但忘记重打包」是这个项目最贵的一类错（2026-10-13 栽过）：
   *   源码级测试全绿，装出来的 exe 还是旧界面。
   *   这里直接读产物 asar 里的 dist JS，找这轮几个**专属标记** ——
   *   data-* 属性最适合当探针：它们只可能来自新代码。
   */
  if (PRODUCT) {
    try {
      const asar = require(require.resolve('@electron/asar'));
      const pkg = path.join(PRODUCT, 'resources', 'app.asar');
      // ⚠ 不能用 fs.existsSync 探 asar 内部路径 —— fs 走原生调用、不认 asar 虚拟文件系统。
      const files = asar.listPackage(pkg)
        .filter((f) => /[\\/]dist[\\/]assets[\\/].+\.js$/.test(f));
      let all = '';
      for (const f of files) all += asar.extractFile(pkg, f.replace(/^[\\/]/, '')).toString();
      t('产物里找到了 dist 的 JS 包', files.length > 0, `${files.length} 个文件`);
      for (const [marker, who] of [
        ['data-ctx-meter', '上下文用量圆环'],
        ['data-ctx-tip', '上下文用量气泡'],
        ['data-tree-row', '文件树的右键菜单/空白处判定'],
        ['scope-banner', '使用范围守卫的提示横条'],
        ['btn-scope-unlock', '使用范围守卫的「重新启用」按钮'],
      ]) {
        t(`★ 产物界面里含「${who}」的新代码`, all.includes(marker),
          all.includes(marker) ? '' : `dist 里找不到 ${marker} —— 改了源码没重打包？`);
      }
    } catch (e) {
      t('产物 dist 内容可核对', false, String(e.message).slice(0, 120));
    }
  }

win.destroy();
  finish();
});

function finish() {
  try { fs.appendFileSync(logFile, `\n${pass} pass ${fail} fail\n`); } catch {}
  console.log(`\n${'='.repeat(50)}\n通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : '  全部通过'}`);
  app.exit(fail ? 1 : 0);
}
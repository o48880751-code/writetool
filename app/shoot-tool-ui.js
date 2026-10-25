/**
 * 工具能力的界面截图：设置页「工具」类目 + 审批弹窗 + 工具卡片。
 *
 * ## 为什么单独一个脚本
 *
 * shoot-settings.js 已经把设置页的六个类目都截了，但它是在
 * **工具功能还没做**的时候写的 —— 里面没有 tool:* 的 IPC，
 * 点进「工具」类目会直接报错。
 *
 * 复用它就得改它的 CFG 与桩，多一层的间接。
 * 而这里要验的三样东西（授权开关、审批弹窗、工具卡片）
 * 都需要**特定的前置状态**，拆开反而更清楚。
 *
 * 三个场景：
 *   --scenario=off   工具关着（默认状态，最该被看清）
 *   --scenario=on    工具开着、已填搜索 Key
 *   --scenario=noproject  开着但没有项目 —— 开关给了却跑不了
 *   --scenario=approve 审批弹窗盖在设置页之上
 *   --scenario=cards    消息流里的工具调用卡片
 *
 * 运行：./electron-run.cmd shoot-tool-ui.js --scenario=off
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
const PID = 'shot-tool-ui';

const SCENARIO = (process.argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || 'off';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '工具验证' });
pfs.ensureProject(PID);

/**
 * ⚠⚠ 窗口句柄必须挂在模块作用域。
 *
 * 原来 `const win = new BrowserWindow(...)` 写在 app.whenReady() 回调里，
 * 而 pushTool 定义在模块顶层去引用 `win` —— 那是**另一个作用域**，
 * 模块里根本没有叫 win 的绑定，一调用就 ReferenceError。
 *
 * 更坑的是：这个错被 SIGTERM 掩盖了，表现是「脚本一句话都不打印就死」，
 * 看起来像超时或环境问题，不像一行明显的拼写/作用域错。
 */
const winRef = { win: null };

const h = (ch, fn) => ipcMain.handle(ch, async (_e, payload) => {  try { return { ok: true, data: await fn(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/**
 * ⚠ 场景决定 config 的初始值。
 *   默认（off）必须与主进程 DEFAULT_CONFIG 一致 ——
 *   这里写成 true 的话，截图会显示成"默认就开着"，
 *   而实际装出来的软件是关着的，那张图就是骗人的。
 */
const TOOLS_ON = SCENARIO === 'on' || SCENARIO === 'noproject' || SCENARIO === 'approve';
const HAS_KEY = SCENARIO === 'on';

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: SCENARIO === 'noproject' ? null : PID,
  toolsEnabled: TOOLS_ON,
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
/**
 * ⚠ noproject 场景不能只把 config.currentProject 设成 null。
 *
 * App 初始化时（App.jsx:229-234）拿不到 currentProject 会**自动回落到
 * 第一个项目** —— 那是产品该有的行为，不是 bug。所以只置空 currentProject
 * 造出来的还是「有项目」，终端照样显示可用。
 * 要看到 ToolCat 里「需要先选项目」那条提示，得让项目列表真的为空。
 */
h('project:list', () => (SCENARIO === 'noproject' ? [] : db.listProjects()));
h('project:open', () => ({ currentProject: CFG.currentProject }));
h('chapter:list', () => db.listChapters(PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.loadSettings(PID));
h('state:list', () => db.listEntityStates(PID));
h('thread:open', () => db.listOpenThreads(PID));
h('thread:list', () => db.listOpenThreads(PID));
h('thread:create', () => ({ id: 'th-1' }));
h('thread:resolve', () => ({ ok: true }));

/**
 * ⚠ provider:* 这三个通道是后来才加的（多连接改造），
 *   老的截图脚本都没注册 → 渲染进程会刷一屏
 *   「No handler registered」。它不致命（React 会 catch），
 *   但会让界面停在半路：能力表没有 → 思考档位算不出来 →
 *   输入框那一行少一块控件。所以这里必须补上。
 */
h('provider:capabilities', () => {
  const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
  return {
    providers: presets.PROVIDERS,
    customs: presets.customs().map((c) => c.key),
  };
});
h('provider:listConnections', () => ([
  {
    id: 'conn-ollama', name: '本机 Ollama', protocol: 'ollama',
    providerKey: 'ollama', base: 'http://127.0.0.1:11434',
    model: 'qwen3:latest', needKey: false, isPreset: true, hasKey: false,
  },
]));
h('bible:query', () => ({ hits: [] }));
h('skill:list', () => db.listSkills(PID));
h('conv:list', () => ([
  { id: 'cv-tool', projectId: PID, title: '工具验证', updatedAt: Date.now() },
]));
h('conv:create', () => ({ id: 'cv-tool', projectId: PID, title: '工具验证' }));
h('conv:messages', () => ([
  { id: 'm1', role: 'user', content: '帮我数一下这个项目里有几个 md 文件，字数一共多少。' },
]));
h('conv:send', () => ({ started: true }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('ollama:check', () => ({ ok: true, version: '0.40.2', models: [{ name: 'qwen3:latest' }] }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:reveal', () => ({ ok: true }));

h('app:info', () => ({
  version: '0.1.0', userDir: path.join(APPDATA, 'writetool'), dbPath: DB,
  node: process.versions.node, electron: process.versions.electron,
}));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', (p) => ({ ok: true, url: p.url }));
h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份\\writetool-backup' }));
h('data:inspectBackup', () => ({ canceled: true }));

// ---- 回收站：走真实 Trash ----
const { Trash } = require(path.join(APPDIR, 'electron', 'trash.js'));
const trash = new Trash(pfs);
trash.empty(PID);
h('trash:list', (p) => ({ items: trash.list(p.projectId), stats: trash.stats(p.projectId) }));
h('trash:add', (p) => ({ ok: true, entry: trash.add(p.projectId, p.path) }));
h('trash:restore', (p) => trash.restore(p.projectId, p.id, { toPath: p.toPath }));
h('trash:purge', (p) => trash.purge(p.projectId, p.id));
h('trash:empty', (p) => trash.empty(p.projectId));
h('app:setDownloadUrl', (p) => ({ ok: true, downloadUrl: p.url }));

// ---- 工具 ----
let SEARCH_KEY = HAS_KEY ? 'fake-bing-key-1234' : '';
h('tool:searchKeyStatus', () => ({ has: !!SEARCH_KEY, encrypted: true }));
h('tool:setSearchKey', (p) => { SEARCH_KEY = String(p.apiKey || ''); return { ok: true, encrypted: true, has: !!SEARCH_KEY }; });
h('tool:decide', (p) => {
  console.log('  [桩] 收到审批决定', JSON.stringify(p));
  return { ok: true };
});

/** 手动往渲染进程推一条工具事件（真实环境是主进程发的） */
const pushTool = (ch, payload) => {
  if (!winRef.win) throw new Error('窗口还没建好，推不了事件');
  winRef.win.webContents.send(ch, payload);
};

/**
 * ⚠ 调试闸门：设 WTB_NO_PUSH=1 可跳过所有手动推送，
 *   用来二分「弹窗有问题」还是「pushTool 本身有问题」。
 */
const NO_PUSH = !!process.env.WTB_NO_PUSH;

app.whenReady().then(async () => {
  winRef.win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const win = winRef.win;   // 回调内仍用短名，读起来不变
  win.webContents.on('render-process-gone', (_e, d) => console.log('  渲染进程退出', JSON.stringify(d)));

  /**
   * ⚠⚠ 窗口必须 show 出来，否则 capturePage 拍到的是**首次绘制那一帧**。
   *
   * 症状极具误导性：脚本日志里 DOM 诊断明明白白写着
   *   标题「工具」、开关可见、开关文字「已关闭」，
   * 而拍出来的 PNG 是「外观 · 配色主题」，侧栏高亮也在外观上。
   * 更坏的是四个场景的 PNG **字节数完全相同**（101703）——
   * 那就是同一张图被存了四遍。
   *
   * 教训：DOM 断言通过 ≠ 画面正确。截图脚本必须让窗口真的显示出来，
   * 否则 capturePage 拿的是过期缓冲，而且不会报错。
   */
  win.showInactive();

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  const shot = async (name) => {
    await win.webContents.executeJavaScript("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 130));
    const img = await win.webContents.capturePage();
    await win.webContents.executeJavaScript("document.body.style.transition=''; true");
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  ✓', name);
  };

  const clickText = async (text) => win.webContents.executeJavaScript(`
    (() => {
      const bs = [...document.querySelectorAll('button')];
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || bs.find(x => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  const textOf = () => win.webContents.executeJavaScript(
    "document.getElementById('root').textContent.replace(/\\s+/g,' ').slice(0,120)");

  console.log(`\n=== 工具界面截图（场景 ${SCENARIO}）===`);

  // 打开设置
  // ⚠ 设置按钮只有「⚙」+「设置」两段文本，中间没有空格连在一起，
  //   而 includes('⚙ 设置') 匹配不到 —— 那是把 DOM 里分开的两个 span 当成一个字符串了。
  //   直接找 title 属性最稳。
  console.log('  点「⚙ 设置」:', await win.webContents.executeJavaScript(`
    (() => {
      var b = document.querySelector('button[title*="打开设置"]');
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `));
  await new Promise((r) => setTimeout(r, 700));

  /**
   * ⚠⚠ 必须限定在设置页侧栏里点「工具」。
   *
   * 上一版用 clickText('工具') 全局找，命中的是**主区那个「快捷工具」面板**
   * 里的东西 —— 结果侧栏停在「外观」，截图拍的是配色主题，
   * 而脚本却报告 "点「工具」类目: ok"。
   *
   * 教训与之前那次一样：clickText 返回 ok 只说明**某个**按钮被点了，
   * 不说明点了想要的那个。要么限定作用域，要么核对点了之后的画面。
   */
  const CAT = '⌘工具';
  console.log('  点侧栏「工具」类目:', await win.webContents.executeJavaScript(`
    (() => {
      var nav = document.querySelectorAll('nav');
      var target = null;
      for (var i = 0; i < nav.length; i++) {
        var b = [...nav[i].querySelectorAll('button')]
          .find(x => x.textContent.replace(/\\s+/g,'') === ${JSON.stringify(CAT)});
        if (b) { target = b; break; }
      }
      if (!target) {
        return 'not-found, 侧栏按钮有：' + [...nav].map(n =>
          [...n.querySelectorAll('button')].map(b=>b.textContent.trim()).join('/')).join(' | ');
      }
      target.click();
      return 'ok';
    })()
  `));
  await new Promise((r) => setTimeout(r, 600));

  // ⚠ 诊断：click() 返回 ok 只说明按钮被调了，不说明设置页真的切了类目。
  //   打印主区标题 + 开关所在容器，对照截图看。
  console.log('  [诊断] 设置页现状:', await win.webContents.executeJavaScript(`
    (() => {
      var heads = [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.trim());
      var sw = document.querySelector('[data-testid="tool-master-switch"]');
      return JSON.stringify({
        标题: heads.slice(0, 4),
        开关在不在: !!sw,
        开关文字: sw ? sw.textContent.trim().slice(0,20) : null,
        开关可见: sw ? (sw.offsetParent !== null) : null,
        nav个数: document.querySelectorAll('nav').length,
        匹配到的按钮: (() => {
          var out = [];
          document.querySelectorAll('nav').forEach((n,i) => {
            [...n.querySelectorAll('button')].forEach(b => {
              if (b.textContent.replace(/\\s+/g,'').includes('工具')) out.push(i+':'+b.textContent.trim());
            });
          });
          return out;
        })(),
      });
    })()
  `));

  const has = await win.webContents.executeJavaScript(`
    (() => {
      var sw = document.querySelector('[data-testid="tool-master-switch"]');
      return sw ? sw.textContent.trim() : 'no-switch';
    })()
  `);
  console.log('  开关当前显示:', has);

  await shot(`t-${SCENARIO}-设置-工具`);

  // ---- 审批弹窗：必须盖在设置页之上 ----
  if (SCENARIO === 'approve' && !NO_PUSH) {
    console.log('  推一条审批请求…');
    try {
      pushTool('tool:approve', {
        id: 'ap-1',
        command: 'Remove-Item -Recurse -Force C:\\Users\\羽毛菌\\Documents\\旧稿',
        reasons: ['删除类命令', '涉及项目文件夹以外的路径'],
        outside: true,
      });
      console.log('  [调试] send 已返回');
    } catch (e) {
      console.log('  [调试] send 抛异常:', e.message);
    }
    await new Promise((r) => setTimeout(r, 600));

    const shown = await win.webContents.executeJavaScript(`
      (() => {
        var m = document.querySelector('[data-testid="tool-approval"]');
        var c = document.querySelector('[data-testid="tool-approval-command"]');
        return JSON.stringify({
          modal: !!m,
          命令: c ? c.textContent.slice(0,40) : null,
          层级: m ? getComputedStyle(m).zIndex : null,
        });
      })()
    `);
    console.log('  弹窗状态:', shown);
    await shot('t-approve-审批弹窗盖在设置页上');

    // 点「不允许」，确认回传到了主进程（桩会打印）
    console.log('  点「不允许」:', await win.webContents.executeJavaScript(`
      (() => {
        var b = document.querySelector('[data-testid="tool-approval-deny"]');
        if (!b) return 'not-found';
        b.click();
        return 'ok';
      })()
    `));
    await new Promise((r) => setTimeout(r, 500));
    const gone = await win.webContents.executeJavaScript(
      "!document.querySelector('[data-testid=\"tool-approval\"]')");
    console.log('  点完是否已收起:', gone);
    await shot('t-approve-拒绝后');
  }

  // ---- 工具调用卡片 ----
  if (SCENARIO === 'cards') {
    console.log('  返回工作区:', await clickText('← 返回'));
    await new Promise((r) => setTimeout(r, 600));

    // ⚠⚠ 必须限定在**对话列表那一栏**里点，作用域是消息区左边的窄列。
    //
    // 第五次犯同一个错：上一版 clickText('工具验证') 全局找，
    // 命中的是顶部工具栏「📂 工具验证」——它会打开「切换小说项目」弹窗，
    // 于是三张卡片被整个遮住，脚本照样报 "选对话: ok"。
    //
    // 这类错**光看返回值永远发现不了**：点到的按钮确实存在、确实被点了。
    // 所以凡是「点了之后画面必须变成某个样子」的步骤，
    // 除了看返回值，还要看下一步的截图。
    console.log('  选对话:', await win.webContents.executeJavaScript(`
      (() => {
        var b = [...document.querySelectorAll('button')]
          .find(x => x.textContent.replace(/\\s+/g,'').replace(/^\\s*\\+\\s*/,'') === '工具验证'
                 && x.closest('nav,aside,section,div') !== null
                 && !x.closest('[role="dialog"]'));
        if (!b) return 'not-found';
        b.click();
        return 'ok';
      })()
    `));
    await new Promise((r) => setTimeout(r, 700));

    // 核对：项目切换弹窗不该在，对话该打开了
    console.log('  [诊断] 弹窗是否还在:', await win.webContents.executeJavaScript(
      `!!document.querySelector('[role="dialog"]')`
    ));

    console.log('  模拟生成中…');
    pushTool('tool:start', { id: 't1', name: 'terminal', brief: 'Get-ChildItem -Recurse *.md | Measure-Object' });
    await new Promise((r) => setTimeout(r, 200));
    pushTool('tool:start', { id: 't2', name: 'web_search', brief: '搜 修真小说 门派 设定' });
    await new Promise((r) => setTimeout(r, 200));
    pushTool('tool:start', { id: 't3', name: 'web_fetch', brief: 'https://example.com/novel-guide' });
    await new Promise((r) => setTimeout(r, 400));
    await shot('t-cards-工具执行中');

    pushTool('tool:end', {
      id: 't1', name: 'terminal', status: 'done',
      brief: 'Get-ChildItem -Recurse *.md | Measure-Object',
      output: 'Count : 24\n\nAverage : \nSum : 432118',
    });
    pushTool('tool:end', {
      id: 't2', name: 'web_search', status: 'failed',
      brief: '搜 修真小说 门派 设定',
      output: '搜索失败（401）。Key 可能无效或已过期 —— 去「设置 → 工具」换一个。',
    });
    pushTool('tool:end', {
      id: 't3', name: 'web_fetch', status: 'done',
      brief: 'https://example.com/novel-guide',
      output: '标题：网文设定指南\n来源：https://example.com/novel-guide\n\n……',
    });
    await new Promise((r) => setTimeout(r, 500));
    await shot('t-cards-工具执行完');

    // 展开一张卡片
    console.log('  展开第一张卡片:', await win.webContents.executeJavaScript(`
      (() => {
        var b = document.querySelector('[data-testid="tool-card-t1"]');
        if (!b) return 'not-found';
        b.click();
        return 'ok';
      })()
    `));
    await new Promise((r) => setTimeout(r, 400));
    await shot('t-cards-展开输出');
  }

  console.log('  根节点文本:', await textOf());
  win.destroy();
  app.exit(0);
});

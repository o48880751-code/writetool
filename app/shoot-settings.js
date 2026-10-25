/**
 * 设置页截图脚本。
 *
 * 与 shoot-v.js 同样的两个前提（踩过了）：
 *   1. 必须自己注册全部 IPC，否则 React 卡在「加载中…」
 *   2. 桩函数必须把 payload 透传给 fn
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
const PID = 'shot-settings';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

if (!db.getProject(PID)) db.createProject({ id: PID, name: '设置验证' });
pfs.ensureProject(PID);

// 各种检查结果都预置好，让截图覆盖到四种分支
const SCENARIO = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1] || 'update';

const h = (ch, fn) => ipcMain.handle(ch, async (_e, payload) => {
  try { return { ok: true, data: await fn(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// config:set 必须返回合并后的完整 config —— 真实主进程是这么做的，
// 渲染进程 rely on 回读结果来更新界面。返回残缺的 patch 会让
// 「主题切换没生效」这种假象出现。
let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID,
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
h('ollama:check', () => ({ ok: true, version: '0.40.2', models: [{ name: 'qwen3:latest' }, { name: 'gemma3:4b' }] }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:reveal', () => ({ ok: true }));

h('app:info', () => ({
  version: '0.1.0',
  userDir: path.join(APPDATA, 'writetool'),
  dbPath: DB,
  node: process.versions.node,
  electron: process.versions.electron,
}));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', (p) => ({ ok: true, url: p.url }));

h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份\\writetool-backup' }));
h('data:inspectBackup', () => ({ canceled: true }));

// ---- 回收站：走真实 Trash 模块（不是打桩） ----
const { Trash } = require(path.join(APPDIR, 'electron', 'trash.js'));
const trash = new Trash(pfs);
trash.empty(PID);
pfs.write(PID, '误删的卷纲.md', '# 第一卷\n\n这一卷本不该删。\n');
trash.add(PID, '误删的卷纲.md');
pfs.write(PID, '章节/草稿.md', '草稿内容');
trash.add(PID, '章节/草稿.md');
pfs.write(PID, '设定/旧人物.md', '一个已废弃的人物设定');
trash.add(PID, '设定');

h('trash:list', (p) => ({ items: trash.list(p.projectId), stats: trash.stats(p.projectId) }));
h('trash:add', (p) => ({ ok: true, entry: trash.add(p.projectId, p.path) }));
h('trash:restore', (p) => trash.restore(p.projectId, p.id, { toPath: p.toPath }));
h('trash:purge', (p) => trash.purge(p.projectId, p.id));
h('trash:empty', (p) => trash.empty(p.projectId));
h('app:setDownloadUrl', (p) => ({ ok: true, downloadUrl: p.url }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('  渲染进程退出', JSON.stringify(d)));

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const shot = async (name) => {
    // 截图前关掉 body 的 .18s 颜色过渡。
    // 原因：切主题后 capturePage 有时截到的是过渡起始帧——
    //   浅色文字 + 深色背景 = 文字"消失"。
    //   而 DOM 检查说 computed color 是对的、元素可见、尺寸正常，
    //   于是看起来像 CSS bug，其实是截图时机。
    //   （与 FileBox 那次「元素在、尺寸正常、截图里看不见」同一类）
    await win.webContents.executeJavaScript(
      "document.body.style.transition = 'none'; true"
    );
    await new Promise((r) => setTimeout(r, 120));
    const img = await win.webContents.capturePage();
    await win.webContents.executeJavaScript(
      "document.body.style.transition = ''; true"
    );
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  ✓', name);
  };
  /**
   * 按可见文字点按钮。
   *
   * ⚠ 类目按钮的文字是「🤖 模型」这种「emoji + 空格 + 文字」，
   *   既不等于 "模型" 也不以它开头（emoji 在前）。
   *   所以要用 includes 而不是 === / startsWith。
   *   第一版用 startsWith → 全部 not-found，
   *   而截图里类目明明都在——又是"测试找错了"而不是"界面坏了"。
   */
  const clickText = async (text) => win.webContents.executeJavaScript(`
    (() => {
      const bs = [...document.querySelectorAll('button')];
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || bs.find(x => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'not-found: ' + bs.map(x=>x.textContent.trim()).join('|').slice(0,150);
      b.click();
      return 'ok';
    })()
  `);

  console.log(`\n=== 设置页截图（场景 ${SCENARIO}）===`);
  await shot('s0-工作区-状态栏');

  // 诊断：DOM 里到底有什么
  console.log('  DOM:', await win.webContents.executeJavaScript(`
    (function(){
      var r = document.getElementById('root');
      return JSON.stringify({
        kids: r ? r.children.length : -1,
        txt: r ? (r.textContent||'').slice(0,60) : '',
        buttons: document.querySelectorAll('button').length,
        api: typeof window.api,
        apiKeys: (window.api ? Object.keys(window.api) : []).join(',').slice(0,80),
        cfgErr: (window.api && window.api.config)
          ? window.api.config.get().then(function(c){return 'ok '+(c&&c.theme)})
              .catch(function(e){return 'ERR '+e.message.slice(0,50)})
          : 'no-config'
      });
    })()
  `).then(async (x) => x));

  console.log('  点「⚙ 设置」:', await clickText('⚙ 设置'));
  await new Promise((r) => setTimeout(r, 700));
  await shot('s1-设置-外观');

  for (const [label, name] of [['模型', 's2-设置-模型'], ['参数', 's3-设置-参数'], ['数据', 's4-设置-数据']]) {
    console.log(`  点「${label}」:`, await clickText(label));
    await new Promise((r) => setTimeout(r, 500));
    await shot(name);
  }

  // 回收站：先关设置页——设置是整页覆盖，不关就看不到第 4 栏
  console.log('  点「← 返回」关设置:', await clickText('← 返回'));
  await new Promise((r) => setTimeout(r, 500));
  console.log('  点「🗑 回收站」:', await clickText('🗑 回收站'));
  await new Promise((r) => setTimeout(r, 800));
  await shot('s5b-回收站');
  console.log('  回收站条目数:', await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('[data-pane=\"files\"] div')].filter(d => /原位置：/.test(d.textContent||'')).length"
  ));

  // 关掉回收站 → 文件树按时间排序
  console.log('  关回收站:', await clickText('关闭'));
  await new Promise((r) => setTimeout(r, 500));
  console.log('  点「时间」排序:', await clickText('时间'));
  await new Promise((r) => setTimeout(r, 700));
  await shot('s5c-文件树-按时间排序');

  console.log('  重开设置:', await clickText('⚙ 设置'));
  await new Promise((r) => setTimeout(r, 600));
  console.log('  点「作者」:', await clickText('作者'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('s5d-设置-作者');

  console.log('  点「参数」:', await clickText('参数'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('s5e-设置-思考强度');

  console.log('  点「关于」:', await clickText('关于'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('s6-设置-关于');

  // 切个主题看是否即时生效。
  // ⚠ 必须先切回「外观」类目——「关于」类目里没有主题按钮，
  //   直接找必然 not-found。第一版就在这儿栽了。
  console.log('  切回「外观」:', await clickText('外观'));
  await new Promise((r) => setTimeout(r, 400));
  console.log('  点主题「夜黛」:', await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('夜黛'));
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `));
  await new Promise((r) => setTimeout(r, 1400));
  console.log('  当前 data-theme:', await win.webContents.executeJavaScript(
    "document.documentElement.getAttribute('data-theme')"
  ));
  await shot('s7-设置-换主题');

console.log('  点「← 返回」:', await clickText('← 返回'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('s8-返回工作区');

  console.log('\n完成');
  db.close();
  app.exit(0);
});
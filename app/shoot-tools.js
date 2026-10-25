/**
 * 顶栏快捷工具截图 + 主动断言。
 *
 * ## 为什么要有这个
 *
 * 羽毛菌：「灵感碎片没有在脑洞后面那里」——
 * 截图里顶栏只有 📌备忘录 / ✒️起名 / 💡脑洞 三个，
 * 而他的要求是**灵感碎片有自己的按钮，排在脑洞后面**。
 *
 * 这是 2026-10-13 连续第二次在"顶栏这一排"上翻车：
 * 前一次是三个按钮的 React key 全叫 'tools'（点哪个都一样）。
 * 而这类问题**扫源码判据只能证明"写了"，证明不了"点得动"**。
 *
 * 场景：
 *   bar     顶栏四个按钮在，顺序对，灵感碎片在脑洞后面
 *   click   点「灵感碎片」→ 面板标题变成"灵感碎片"，只展开它一个
 *
 * 运行：cmd //c "electron-run.cmd shoot-tools.js [bar|click]"
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
const PID = 'shot-tools';

const ARGV = process.argv.slice(1).filter((a) => !a.startsWith('-'));
const SCRIPT_AT = ARGV.findIndex((a) => a.endsWith('.js'));
const SCENARIO = (SCRIPT_AT >= 0 ? ARGV[SCRIPT_AT + 1] : ARGV[0]) || 'bar';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
// ⚠ createProject 不是幂等的（裸 INSERT），第二次跑会抛 UNIQUE constraint，
//   而这行在模块顶层 → 脚本加载期挂住、一行输出都没有。
if (!db.getProject(PID)) db.createProject({ id: PID, name: '工具栏验证' });
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
// ⚠ 没有 fs:exists 通道。App.jsx 的 fileExists 是**拿 fs.read 试**：
//   读得到就 true，读不到就 false。所以桩也必须这样——
//   给一个永远返回 true 的 fs:exists 反而是错的（那个通道根本不会被调用）。
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
  /** 顶栏快捷工具按钮（只取可见的） */
  const bars = () => js(`(() => {
    const bs = [...document.querySelectorAll('button[data-quick]')]
      .filter(b => b.getClientRects().length > 0);
    return JSON.stringify(bs.map(b => ({ key: b.dataset.quick, text: b.textContent.trim() })));
  })()`);

  const alive = JSON.parse(await js(`JSON.stringify({
    kids: document.getElementById('root').children.length,
    buttons: document.querySelectorAll('button').length })`));
  console.log(`\n=== 顶栏工具截图（场景 ${SCENARIO}）===`);
  console.log('  界面:', JSON.stringify(alive));
  if (alive.kids < 1 || alive.buttons < 3) { console.log('  ❌ 界面没渲染'); app.exit(1); }

  const bar = JSON.parse(await bars());
  console.log('  顶栏:', JSON.stringify(bar));
  t('顶栏有四个快捷工具按钮',
    bar.length === 4, `实际 ${bar.length} 个：${bar.map((b) => b.text).join('、')}`);
  t('含「灵感碎片」按钮',
    bar.some((b) => /灵感碎片/.test(b.text)),
    `实际：${bar.map((b) => b.text).join('、')}`);
  const bi = bar.findIndex((b) => /脑洞/.test(b.text));
  const ii = bar.findIndex((b) => /灵感碎片/.test(b.text));
  t('灵感碎片排在脑洞后面',
    bi >= 0 && ii > bi, `脑洞在第 ${bi + 1} 位，灵感碎片在第 ${ii + 1} 位`);
  t('四个按钮的 data-quick 各不相同',
    new Set(bar.map((b) => b.key)).size === bar.length,
    `key：${bar.map((b) => b.key).join('、')}`);

  if (SCENARIO === 'bar') {
    await shot('g1-顶栏四个工具');
  }

  if (SCENARIO === 'click') {
    // 点「灵感碎片」
    await js(`(() => {
      const b = [...document.querySelectorAll('button[data-quick]')]
        .find(x => /灵感碎片/.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const st = JSON.parse(await js(`(() => {
      const body = document.body.textContent.replace(/\\s+/g, ' ');
      return JSON.stringify({
        hasIdea: body.includes('灵感碎片'),
        hasBrainPanel: /脑洞[\\s\\S]{0,40}打开 脑洞\\.md/.test(body),
        openButtons: [...document.querySelectorAll('button')]
          .map(b => b.textContent.trim())
          .filter(x => /^打开 /.test(x)),
        textarea: document.querySelectorAll('textarea').length,
      });
    })()`));
    console.log('  点后:', JSON.stringify(st));
    t('点「灵感碎片」后能打开 灵感碎片.md',
      st.openButtons.some((x) => /灵感碎片\.md/.test(x)),
      `面板里的「打开」按钮：${st.openButtons.join('、') || '（无）'}`);
    t('只展开它一个（脑洞不跟着一起冒出来）',
      !st.openButtons.some((x) => /脑洞\.md/.test(x)),
      `不该出现的：${st.openButtons.filter((x) => /脑洞/.test(x)).join('、')}`);
    await shot('g2-点灵感碎片-只展开它');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${SCENARIO}：通过 ${pass} / 失败 ${fail}`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('崩溃：', e); app.exit(1); });

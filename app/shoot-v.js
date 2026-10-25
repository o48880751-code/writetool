/**
 * 四栏布局的截图脚本。
 *
 * 与上一版 shoot-ui2.js 同样的两个前提，踩过一次就够了：
 *   1. 必须自己注册全部 IPC —— 否则 React 卡在 `if (!config)`，
 *      界面停在「加载中…」，看起来像功能不存在。
 *   2. 桩函数必须把 payload 透传给 fn —— `async () => fn()`
 *      会让解构拿到 undefined，表现为「检索返回 0 条」。
 *
 * 这里的数据源是真实的项目文件夹（%APPDATA%/writetool/projects/），
 * 临时库是空的，截出来全是空状态，看不出真实效果。
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
const MODULES = path.resolve(__dirname, '..');   // 项目根（db/ memory/ 在那儿）
const APPDIR = __dirname;                                // app/ 目录（dist/ 与 electron/ 在这儿）
const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-4col';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ---- 准备数据：项目 + 资料文件（走真实模块，验证链路而不是打桩） ----
if (!db.getProject(PID)) db.createProject({ id: PID, name: '四栏验证' });
pfs.ensureProject(PID);
pfs.write(PID, '世界观.md', `# 世界观

## 地理
- **越国**：中原以南，昭华十七年冬，朝廷北伐失败后封锁边境
- **处州**：越国境内一州，城外有青石村

## 势力
- **赤霄宗**：越国第一剑宗，剑诀起手一划带三分回锋

## 力量体系
- **逆鳞诀**：赤霄宗不传之秘，需以血饲刃
`);
pfs.write(PID, '人物库.md', `# 人物库

## 主角
- **姓名**：夜枫
  - 身份：处州青石村少年，木匠之子
  - 目标：想知道城墙外头有什么
  - 弱点：见血即手抖

## 主要角色
- 夜大柱：夜枫之父，月入二两
`);
pfs.write(PID, '章节摘要.md', `# 章节摘要

| 章 | 标题 | 摘要 | 状态 |
|---|---|---|---|
| 1 | 处州少年 | 夜枫决定离村 | 已写 |
| 2 | 问道院 | 初到岚州 | 草稿 |
| 3 | 铁棺 | 乱葬岗拾棺 | 未写 |
`);
pfs.write(PID, '卷纲/第一卷.md', `# 第一卷 卷名未定

## 主线
夜枫离家 → 问道院求学 → 卷末得知父亲死亡的真相

## 分卷节奏
- 第一章起：确立离开的动机
- 中段：问道院的门派冲突
`);
db.upsertSetting({ id: `${PID}:character:夜枫`, projectId: PID, type: 'character', name: '夜枫', note: '处州青石村少年，木匠之子' });
db.upsertSetting({ id: `${PID}:location:处州`, projectId: PID, type: 'location', name: '处州', note: '越国境内一州' });

// ---- IPC 桩（payload 必须透传） ----
const h = (ch, fn) => ipcMain.handle(ch, async (_e, payload) => {
  try { return { ok: true, data: await fn(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

h('config:get', () => ({
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID,
}));
h('config:set', (p) => p);
h('project:list', () => db.listProjects());
h('project:open', (p) => ({ currentProject: p.id }));
h('project:create', (p) => { db.createProject(p); return { projects: db.listProjects() }; });
h('chapter:list', () => db.listChapters(PID));
h('chapter:get', (p) => db.getChapter(p.id));
h('chapter:create', (p) => db.createChapter({ ...p, projectId: PID }));
h('chapter:save', () => ({ ok: true }));
h('settings:list', () => db.loadSettings(PID));
h('settings:upsert', (p) => db.upsertSetting(p));
h('state:list', () => db.listEntityStates(PID));
h('state:set', (p) => db.setEntityState(p));
h('state:writeback', () => ({ ok: true }));
h('thread:open', () => db.listOpenThreads(PID));
h('thread:create', (p) => db.createThread({ ...p, projectId: PID }));
h('thread:resolve', () => ({ ok: true }));
h('bible:query', (p) => {
  const all = db.loadSettings(PID);
  const q = String(p.query || '').toLowerCase();
  const hits = all.filter((s) =>
    s.name.toLowerCase().includes(q) || String(s.note || '').toLowerCase().includes(q));
  return { hits };
});
h('skill:list', () => { db.seedBuiltinSkills(); return db.listSkills(PID); });
h('conv:list', () => db.listConversations(PID));
h('conv:create', (p) => db.createConversation({ projectId: PID, title: p.title }));
h('conv:messages', (p) => db.listMessages(p.conversationId));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节，风格基准只能来自你自己的历史正文' }));
h('style:check', () => ({ ok: true, deviations: [], summary: '未检测' }));
h('ollama:status', () => ({ ok: true, version: '0.40.2', models: [{ name: 'qwen3:latest' }] }));

// 文件树通道：全部走真实的 ProjectFs
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => {
  const r = pfs.read(p.projectId, p.path);
  return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) };
});
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:validateName', (p) => pfs.validateName(p.name));
h('fs:reveal', () => ({ ok: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680, height: 1000, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, d) => {
    const m = d && typeof d === 'object' ? d.message : String(d);
    if (m && !/gpu|GPU|Autofill|devtools/i.test(m)) console.log('  [renderer]', m);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('  渲染进程退出', JSON.stringify(d)));

  const html = path.join(APPDIR, 'dist', 'index.html');
  await win.loadFile(html);
  await new Promise((r) => setTimeout(r, 1400));

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  ✓', name);
  };
  /** 通过主标签栏的「+」菜单打开一个标签 */
  const openTab = async (label) => {
    const r = await win.webContents.executeJavaScript(`
      (() => {
        const plus = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '+');
        if (!plus) return 'no-plus';
        plus.click();
        return 'menu-opened';
      })()
    `);
    if (r !== 'menu-opened') return r;
    await new Promise((r2) => setTimeout(r2, 250));
    const r2 = await win.webContents.executeJavaScript(`
      (() => {
        const item = [...document.querySelectorAll('button')]
          .find(b => (b.textContent||'').includes(${JSON.stringify(label)}));
        if (!item) return 'not-in-menu';
        item.click();
        return 'ok';
      })()
    `);
    await new Promise((r3) => setTimeout(r3, 400));
    return r2;
  };

  const clickText = async (text) => win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || btns.find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  console.log('\n=== 尺寸诊断 ===');
  console.log('  ', await win.webContents.executeJavaScript(`
    (() => {
      const panes = [...document.querySelectorAll('[data-pane]')];
      const info = {
        win: window.innerWidth + 'x' + window.innerHeight,
        screen: screen.width + 'x' + screen.height,
        paneCount: panes.length,
      };
      info.panes = panes.map(e => ({
        key: e.dataset.pane,
        basis: e.style.flexBasis,
        w: Math.round(e.getBoundingClientRect().width),
        right: Math.round(e.getBoundingClientRect().right),
      }));
      const wrap = panes[0] && panes[0].parentElement;
      info.wrapperW = wrap ? Math.round(wrap.getBoundingClientRect().width) : null;
      info.wrapperScrollW = wrap ? wrap.scrollWidth : null;
      return JSON.stringify(info, null, 1);
    })()
  `));

  // 直接问渲染进程：它拿到树了吗
  console.log('  渲染进程里的树:', await win.webContents.executeJavaScript(`
    (() => {
      const ft = document.querySelector('[data-pane="files"]');
      return ft ? ft.textContent.replace(/\\s+/g,' ').trim().slice(0,80) : 'no-pane';
    })()
  `));
  // 直接调一次通道，看返回什么
  console.log('  直接调 fs.tree:', await win.webContents.executeJavaScript(`
    window.api.fs.tree({ projectId: ${JSON.stringify(PID)} })
      .then(t => 'ok children=' + (t.children||[]).length)
      .catch(e => 'ERR ' + e.message)
  `));
  console.log('  window.api 键:', await win.webContents.executeJavaScript(
    'Object.keys(window.api).join(",")'
  ));

  console.log('\n=== 截图 ===');
  await shot('v1-四栏-默认');

  console.log('  诊断节点结构:', await win.webContents.executeJavaScript(`
    (() => {
      const all = [...document.querySelectorAll('*')];
      const el = all.reverse().find(d => d.tagName === 'SPAN' && (d.textContent||'').trim() === '世界观.md');
      if (!el) return 'no-span';
      const chain = [];
      let t = el;
      for (let i = 0; i < 5 && t; i++) {
        chain.push(t.tagName + '.' + String(t.className||'').slice(0,20) +
          ' pad=' + (t.style.paddingLeft||'-') +
          ' title=' + (t.title||'-'));
        t = t.parentElement;
      }
      return JSON.stringify(chain, null, 1);
    })()
  `));

  // 点文件树里的「世界观.md」
  console.log('  点「世界观.md」:', await win.webContents.executeJavaScript(`
    (() => {
      // FileTree 的文件名是 span，onClick 挂在**它父级那个带 title 的 div** 上
      // （title 就是文件路径）。向上找带 title 的祖先，别数层数——
      // 数层数在结构一改就失效，而 title 是稳定标识。
      const all = [...document.querySelectorAll('*')];
      const span = all.reverse().find(d =>
        d.tagName === 'SPAN' && (d.textContent||'').trim() === '世界观.md');
      if (!span) return 'not-found:no-span';
      const target = span.closest('[title]');
      if (!target) return 'not-found:no-title-ancestor';
      target.click();
      return 'clicked ' + target.title;
    })()
  `));
  await new Promise((r) => setTimeout(r, 900));
  await shot('v2-预览-世界观');

  // 第二个文件（多标签）
  console.log('  点「章节摘要.md」:', await win.webContents.executeJavaScript(`
    (() => {
      // FileTree 的文件名是 span，onClick 挂在**它父级那个带 title 的 div** 上
      // （title 就是文件路径）。向上找带 title 的祖先，别数层数——
      // 数层数在结构一改就失效，而 title 是稳定标识。
      const all = [...document.querySelectorAll('*')];
      const span = all.reverse().find(d =>
        d.tagName === 'SPAN' && (d.textContent||'').trim() === '章节摘要.md');
      if (!span) return 'not-found:no-span';
      const target = span.closest('[title]');
      if (!target) return 'not-found:no-title-ancestor';
      target.click();
      return 'clicked ' + target.title;
    })()
  `));
  await new Promise((r) => setTimeout(r, 900));
  await shot('v3-预览-表格');

  // 切到编辑模式
  console.log('  点「编辑」:', await clickText('编辑'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('v4-编辑模式');

  // 主区标签
  console.log('  点主标签「学文风」:', await openTab('学文风'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('v5-标签-学文风');

  console.log('  点主标签「蒸馏」:', await openTab('蒸馏'));
  await new Promise((r) => setTimeout(r, 700));
  await shot('v6-标签-蒸馏');

  console.log('  点主标签「快捷工具」:', await openTab('快捷工具'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('v7-标签-快捷工具');

  console.log('  点主标签「章节」:', await openTab('章节'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('v8-标签-章节');

  // 顶栏快捷工具
  console.log('  点顶栏「起名」:', await clickText('起名'));
  await new Promise((r) => setTimeout(r, 600));
  await shot('v9-顶栏-起名');

  // 拖拽分隔条：把第 3 栏拉宽
  const before = await win.webContents.executeJavaScript(`
    JSON.stringify([...document.querySelectorAll('[data-pane]')].map(e => e.style.flexBasis))
  `);
  console.log('  拖拽前各栏:', before);
  const box = await win.webContents.executeJavaScript(`
    (() => {
      const ps = [...document.querySelectorAll('[data-pane]')];
      const preview = ps[2];
      const r = preview.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left - 2), y: Math.round(r.top + 200) });
    })()
  `);
  const { x, y } = JSON.parse(box);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await new Promise((r) => setTimeout(r, 120));
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x + i * 18, y });
    await new Promise((r) => setTimeout(r, 30));
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: x + 144, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const after = await win.webContents.executeJavaScript(`
    JSON.stringify([...document.querySelectorAll('[data-pane]')].map(e => e.style.flexBasis))
  `);
  console.log('  拖拽后各栏:', after);
  console.log('  各栏是否变化:', before !== after ? '是（拖拽生效）' : '否（没生效）');
  await shot('v10-拖拽分割');

  // 深色主题
  await win.webContents.executeJavaScript(`
    (() => {
      const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.textContent.includes('夜墨')));
      if (!s) return 'no-select';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(s, 'night');
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));
  await shot('v11-主题-夜墨');

  console.log('\n完成');
  db.close();
  app.exit(0);
});
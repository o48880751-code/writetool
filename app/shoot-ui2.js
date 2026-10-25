/**
 * 对话优先界面的截图验证。
 *
 * 需要完整注册 IPC 才能让 React 走完初始化——
 * App.jsx 开头是 `if (!config) return 加载中…`，`config:get` 没人应答就全是空白。
 * 「截图空白」和「界面不存在」是两回事，这里必须分清。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const OUT = path.join(__dirname, 'shots');
const PRODUCT = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];

const ROOT = PRODUCT ? path.join(PRODUCT, 'resources', 'modules') : path.resolve(__dirname, '..');
const { Store } = require(path.join(ROOT, 'db', 'store.js'));
const { summarizeBible } = require(path.join(ROOT, 'memory', 'context-budget.js'));

// 用独立的临时库，并塞入演示数据——空库截出来全是空状态，看不出布局对不对
const DB = path.join(require('node:os').tmpdir(), `shoot-${Date.now()}.db`);
const db = new Store(DB);
db.seedBuiltinSkills();
db.createProject({ id: 'demo', name: '示例项目' });
db.upsertSetting({ id: 'demo:character:夜枫', projectId: 'demo', type: 'character', name: '夜枫', note: '处州青石村少年，十五岁，木匠之子', aliases: ['小枫'] });
db.upsertSetting({ id: 'demo:location:青石村', projectId: 'demo', type: 'location', name: '青石村', note: '处州城外，村东头住着他大哥' });
db.upsertSetting({ id: 'demo:technique:逆鳞诀', projectId: 'demo', type: 'technique', name: '逆鳞诀', note: '赤霄宗剑诀，起手一划带三分回锋' });
db.setEntityState({ projectId: 'demo', entityName: '夜枫', state: { location: '青石村', 境界: '凡人' }, chapterId: null });
db.createThread({ id: 'pt1', projectId: 'demo', name: '铜镜裂纹', summary: '第一章提到镜上有裂纹，未解释来源', importance: 4 });
const ch1 = db.createChapter({ id: 'ch1', projectId: 'demo', title: '第一章 处州少年', origin: 'human' });
db.updateChapterContent('ch1', '“枫儿——”\n\n巷口传来一声喊。夜枫蹲在院门口，正给一块松木板去皮，抬头一看，他大伯夜大田正大步流星朝他走来，脚上一双草鞋沾满了泥。\n\n“大伯。”夜枫放下刨子，站起身。');
const c1 = db.createConversation({ projectId: 'demo', title: '第一章怎么开头' });
db.addMessage({ conversationId: c1.id, role: 'user', content: '第一章开头太平了，怎么改才有悬念？' });
db.addMessage({ conversationId: c1.id, role: 'assistant', content: '可以从「他早已知道要走」切入——先给结局，再倒叙过程。\n\n具体做法：第一句就写他把包袱系在腰上的动作，然后补一句「这一次，他没有回头看那扇门」。读者会立刻想知道门后面有什么。', tokensIn: 320, tokensOut: 186, ms: 4200 });
db.createConversation({ projectId: 'demo', title: '夜枫的功法设定' });
db.createConversation({ projectId: 'demo', title: '' });

/** 桩必须把 payload 透传给 fn —— 漏传会让所有入参变 undefined */
const h = (ch, fn) => ipcMain.handle(ch, async (_evt, payload) => {
  try { return { ok: true, data: await fn(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

const PID = 'demo';
h('config:get', () => ({ model: 'qwen3:latest', numCtx: 8192, temperature: 0.3, fontSize: 16, theme: 'gold', currentProject: PID }));
h('config:set', () => ({}));
h('ollama:check', () => ({ connected: true, version: '0.40.2' }));
h('project:list', () => db.listProjects());
h('project:create', () => db.listProjects());
h('project:open', () => ({}));
h('chapter:list', () => db.listChapters(PID));
h('chapter:get', ({ id }) => db.getChapter(id));
h('chapter:create', () => ({}));
h('chapter:save', () => ({}));
h('chapter:delete', () => ({}));
h('settings:list', () => db.loadSettings(PID));
h('settings:summary', () => summarizeBible(db.loadSettings(PID), { maxChars: 1200 }));
h('settings:upsert', () => ({}));
h('settings:importBible', () => ({ canceled: true }));
h('bible:query', ({ query, entityType, topK }) => {
  const q = String(query || '').toLowerCase();
  const out = [];
  for (const s of db.loadSettings(PID)) {
    if (entityType && s.type !== entityType) continue;
    const name = String(s.name || '').toLowerCase();
    const al = (s.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q) || q.includes(name)) score = 80;
    else if (al.some((a) => a === q)) score = 70;
    else if (String(s.note || '').toLowerCase().includes(q) && q.length >= 2) score = 40;
    if (score > 0) out.push({ ...s, _score: score });
  }
  out.sort((a, b) => b._score - a._score || a.name.length - b.name.length);
  return { ok: true, count: out.length, hits: out.slice(0, topK || 8).map(({ _score, ...s }) => s) };
});
h('state:list', () => db.listEntityStates(PID));
h('state:writeback', () => ({ updated: [], conflicts: [] }));
h('state:set', () => ({}));
h('thread:list', () => db.listOpenThreads(PID));
h('thread:create', () => db.listOpenThreads(PID));
h('thread:resolve', () => ({ ok: true }));
h('skill:list', () => db.listSkills(PID));
h('skill:create', () => ({}));
h('skill:delete', () => ({}));
h('conv:list', () => db.listConversations(PID).map((c) => ({ ...c, messageCount: db.countMessages(c.id) })));
h('conv:create', ({ title }) => db.createConversation({ projectId: PID, title }));
h('conv:rename', ({ id, title }) => db.renameConversation(id, title));
h('conv:delete', ({ id }) => ({ deleted: db.deleteConversation(id) }));
h('conv:messages', ({ conversationId }) => db.listMessages(conversationId, 300));
h('conv:send', () => ({ started: true }));
h('generate:start', () => ({ started: true }));
h('generate:stop', () => ({ stopped: true }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节，风格基准只能来自你自己的历史正文' }));
h('style:check', () => ({ ok: false, error: '无画像' }));
h('app:info', () => ({ version: '0.1.0' }));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440, height: 1000, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  const html = PRODUCT
    ? path.join(PRODUCT, 'resources', 'app.asar', 'dist', 'index.html')
    : path.join(__dirname, 'dist', 'index.html');

  await win.loadFile(html);
  await new Promise((r) => setTimeout(r, 2500));

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, `${name}.png`);
    fs.writeFileSync(p, img.toPNG());
    console.log(`  ✓ ${name}.png  ${Math.round(fs.statSync(p).size / 1024)} KB`);
  };

  /** 用 startsWith 匹配——按钮上带计数，精确匹配会 not-found */
  const clickText = async (t) => win.webContents.executeJavaScript(`
    (() => {
      const bs = [...document.querySelectorAll('button, select, option')];
      const b = bs.find(x => (x.textContent || '').trim() === ${JSON.stringify(t)})
             || bs.find(x => (x.textContent || '').trim().startsWith(${JSON.stringify(t)}));
      if (!b) return 'not-found: ' + bs.map(x => (x.textContent || '').trim()).join('|').slice(0, 180);
      b.click(); return 'ok';
    })()
  `);

  await shot('n1-默认-墨金');

  // 打开 @技能 选择器
  console.log('  点 @技能:', await clickText('@技能'));
  await new Promise((r) => setTimeout(r, 400));
  await shot('n2-引用-技能');

  // 关掉，打开 @文件
  console.log('  关闭:', await clickText('关闭'));
  console.log('  点 @文件:', await clickText('@文件'));
  await new Promise((r) => setTimeout(r, 400));
  await shot('n3-引用-文件');

  console.log('  关闭:', await clickText('关闭'));

  // 切主题
  const setTheme = async (id, name) => {
    await win.webContents.executeJavaScript(`
      (() => {
        const sels = [...document.querySelectorAll('select')];
        const s = sels.find(x => [...x.options].some(o => o.value === ${JSON.stringify(id)}));
        if (!s) return 'no-select';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(s, ${JSON.stringify(id)});
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
    await shot(name);
  };

  await setTheme('night', 'n4-主题-夜墨');
  await setTheme('moss', 'n5-主题-松绿');
  await setTheme('ink', 'n6-主题-黛蓝');
  await setTheme('contrast', 'n7-主题-高对比');
  await setTheme('gold', 'n8-回到墨金');

  // 先切到正文页签看编辑器（activeChapterId 已在前面点过）
  console.log('  直接切正文:', await clickText('正文'));
  await new Promise((r) => setTimeout(r, 800));
  await shot('n8b-正文页签');

  // 右栏：先在「章节」里点一章（会自动跳到正文页签）
  console.log('  章节页签按钮:', await clickText('章节'));
  await new Promise((r) => setTimeout(r, 500));
  console.log('  点章节条目:', await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => /字 ·/.test(x.textContent || ''));
      if (!b) return 'no-chapter-btn';
      b.click();
      return 'clicked';
    })()
  `));
  await new Promise((r) => setTimeout(r, 1000));
  await shot('n9-文件框-正文');

  // 直接查 DOM：编辑器到底挂没挂
  console.log('  DOM 诊断:', await win.webContents.executeJavaScript(`
    (() => {
      const pm = document.querySelector('.ProseMirror');
      const aside = document.querySelectorAll('aside');
      const last = aside[aside.length - 1];
      const info = { pmFound: !!pm };
      if (pm) {
        const r = pm.getBoundingClientRect();
        info.pmSize = Math.round(r.width) + 'x' + Math.round(r.height);
        info.pmText = (pm.textContent || '').slice(0, 30);
      }
      if (last) {
        info.asideH = Math.round(last.getBoundingClientRect().height);
        info.asideChildren = [...last.children].map(c => c.className.slice(0, 20) + ':' + Math.round(c.getBoundingClientRect().height));
      }
      return JSON.stringify(info);
    })()
  `));

  // 回到章节页签，看列表本身
  console.log('  回章节页签:', await clickText('章节'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('n9b-章节列表');

  // 设置面板
  console.log('  点设置:', await clickText('设置'));
  await new Promise((r) => setTimeout(r, 500));
  await shot('n10-设置展开');

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
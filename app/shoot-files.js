const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fsMod = require('node:fs');

/**
 * 第 4 栏改版验证：两行式头部、拖拽、回收站弹窗、项目切换弹窗。
 *
 * 关键点：**注册真实的 project-fs / trash 模块**，
 * 而不是一个返回假数据的桩——拖拽与回收站要验的是
 * "文件真的动了、顺序真的落盘了"，桩返回什么都证明不了。
 */

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');

app.disableHardwareAcceleration();
for (const s of ['no-sandbox', 'disable-gpu', 'disable-software-rasterizer', 'in-process-gpu']) {
  app.commandLine.appendSwitch(s);
}

const h = (ch, fn) => ipcMain.handle(ch, async (_e, p) => {
  try { return { ok: true, data: await fn(p) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---- 真实模块 ----
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const { Trash } = require(path.join(APPDIR, 'electron', 'trash.js'));
const md = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { Store } = require(path.join(MODULES, 'db', 'store.js'));

// ⚠ 测试数据落在项目目录下的 .tmp-shot/ 里，不碰 %APPDATA%。
//   原因：app.getPath('userData') 在 app.whenReady() 之前调用会抛，
//   而这个脚本原来在模块顶层就调它——结果是 require 阶段就挂，
//   一行日志都没有（我为此浪费了三轮"是不是脚本没跑"的排查）。
//   顺带的好处：跑完直接删目录就干净，不会污染用户库。
const SANDBOX = path.join(APPDIR, '.tmp-shot');
fsMod.rmSync(SANDBOX, { recursive: true, force: true });
fsMod.mkdirSync(SANDBOX, { recursive: true });

const PROJECTS_ROOT = path.join(SANDBOX, 'projects');
const DB_PATH = path.join(SANDBOX, 'shot.db');

const pfs = new ProjectFs(PROJECTS_ROOT);
const trash = new Trash(pfs);
const db = new Store(DB_PATH);
const PID = 'demo-novel';
db.createProject({ id: PID, name: '墨染仙途' });
pfs.ensureProject(PID);

// 造一批有层次的文件
pfs.write(PID, '卷纲/第一卷.md', '# 第一卷\n\n- **主线**：夜枫入道\n');
pfs.write(PID, '卷纲/第二卷.md', '# 第二卷\n\n- **主线**：入京都\n');
pfs.write(PID, '章节/第001章.md', '# 第一章\n\n夜枫走进院子。\n');
pfs.write(PID, '章节/第002章.md', '# 第二章\n\n雨下了一夜。\n');
pfs.write(PID, '设定/境界体系.md', '# 境界\n\n炼气 → 筑基 → 金丹\n');
pfs.write(PID, '灵感碎片.md', '# 灵感碎片\n\n随手记。\n');
pfs.write(PID, '时间线.md', '# 时间线\n\n| 章 | 事件 |\n|---|---|\n| 001 | 入村 |\n');

// 预置回收站。先写再删——否则文件不存在、trash.add 会抛，
// 结果只进得去一项（第一版就这样，截图里只有一条）。
trash.empty(PID);
pfs.write(PID, '全书体检报告_20260908.md', '# 全书体检\n\n- 节奏偏慢\n');
trash.add(PID, '全书体检报告_20260908.md');
pfs.write(PID, '卷纲/废稿_卷结构重构.md', '# 废稿\n\n这一卷的结构推倒重来。\n');
trash.add(PID, '卷纲/废稿_卷结构重构.md');
pfs.write(PID, '章节/_归档.md', '# 归档\n\n早期的零散草稿。\n');
trash.add(PID, '章节/_归档.md');

const CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID, thinkLevel: 'off',
};

h('config:get', () => CFG);
h('config:set', (p) => { Object.assign(CFG, p); return CFG; });
h('app:version', () => ({
  version: '1', minor: '0', patch: '0', full: 'v1.0.0', downloadUrl: '', levels: {},
}));
h('app:setDownloadUrl', (p) => ({ ok: true, downloadUrl: p.url }));
h('app:openExternal', () => ({ ok: true }));
h('app:info', () => ({ version: '1.0.0', userDir: SANDBOX }));

h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: PID }));
h('project:create', (p) => {
  db.createProject({ id: p.id, name: p.name });
  const made = pfs.ensureProject(p.id);
  return { projects: db.listProjects(), createdFolder: made.created, dir: made.dir };
});
h('project:rename', (p) => ({ ok: true, name: db.renameProject(p.id, p.name), projects: db.listProjects() }));
h('project:delete', (p) => {
  const r = db.deleteProject(p.id);
  pfs.remove(p.id, '', { rootDelete: true });
  return { ok: true, projects: db.listProjects(), ...r };
});
h('project:export', () => ({ ok: true, dest: 'C:\\Users\\备份\\墨染仙途-备份', files: 9, bytes: 4096 }));

h('chapter:list', () => db.listChapters(PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.loadSettings(PID));
h('state:list', () => db.listEntityStates(PID));
h('thread:list', () => db.listOpenThreads(PID));
h('bible:query', () => ({ hits: [] }));
h('conv:list', () => db.listConversations(PID));
h('conv:create', () => db.createConversation({ projectId: PID, title: '' }));
h('conv:messages', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('ollama:check', () => ({ ok: true, version: '0.40.2', models: [{ name: 'qwen3:latest' }] }));

h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => {
  const r = pfs.read(p.projectId, p.path);
  return { ...r, blocks: md.parse(r.content), stat: md.stat(r.content) };
});
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:validateName', (p) => pfs.validateName(p.name));
h('fs:move', (p) => pfs.move(p.projectId, p.from, p.toDir, { anchor: p.anchor, place: p.place }));
h('fs:reveal', () => ({ ok: true }));

// ---- provider 桩 ----
//
// ⚠ 连接列表与量表走**真实模块**：手写假数据会与实际量表漂移，
//   截图看着对、真实用的时候地址是错的。2026-10-12 改多连接后，
//   界面能显示的连接条数直接来自 provider-presets.js。
const P = require(path.join(APPDIR, 'electron', 'provider.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const FMT = require(path.join(APPDIR, 'electron', 'skill-format.js'));

// 内存里的连接（截图脚本不落库）
let CONNS = PRESETS.PROVIDERS
  .filter((p) => !p.key.startsWith('custom-'))
  .map((p) => ({
    id: p.id, name: p.name, protocol: p.protocol, providerKey: p.key,
    base: p.base, model: '', needKey: !!p.needKey, isPreset: true, hasKey: false,
  }));
// 模拟用户自己加的两条：一条云（已存密钥）、一条本地
CONNS.push({
  id: 'conn-mine-sf', name: '我的硅基流动', protocol: 'openai',
  providerKey: 'siliconflow', base: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V3', needKey: true, isPreset: false, hasKey: true,
});
CONNS.push({
  id: 'conn-mine-local', name: '公司内网代理', protocol: 'openai',
  providerKey: 'custom-openai', base: 'http://192.168.1.50:8000/v1',
  model: '', needKey: true, isPreset: false, hasKey: false,
});
let KEYS = { 'conn-mine-sf': 'sk-fake-1234abcd' };

h('provider:capabilities', () => ({
  providers: PRESETS.PROVIDERS,
  customs: PRESETS.customs().map((c) => c.key),
}));
h('provider:listConnections', () => CONNS);
h('provider:createConnection', (p = {}) => {
  const preset = PRESETS.get(p.providerKey);
  const c = {
    id: `conn-new-${Date.now()}`, name: p.name || '新连接',
    protocol: p.protocol || preset.protocol,
    providerKey: p.providerKey || 'custom-openai',
    base: p.base != null ? p.base : preset.base,
    model: '', needKey: p.needKey != null ? p.needKey : preset.needKey,
    isPreset: false, hasKey: false,
  };
  CONNS.push(c);
  return c;
});
h('provider:updateConnection', ({ id, ...patch }) => {
  const c = CONNS.find((x) => x.id === id);
  if (c) Object.assign(c, patch);
  return c;
});
h('provider:deleteConnection', ({ id }) => {
  if (CONNS.length <= 1) return { ok: false, error: '至少要保留一条连接' };
  CONNS = CONNS.filter((x) => x.id !== id);
  delete KEYS[id];
  return { ok: true };
});
h('provider:activate', ({ id }) => ({ ok: !!CONNS.find((x) => x.id === id) }));
h('provider:setKey', ({ id, apiKey }) => {
  if (apiKey) { KEYS[id] = String(apiKey); CONNS.find((x) => x.id === id).hasKey = true; }
  else { delete KEYS[id]; const c = CONNS.find((x) => x.id === id); if (c) c.hasKey = false; }
  const k = KEYS[id] || '';
  return { ok: true, encrypted: true, masked: k ? '••••••••' + k.slice(-4) : '' };
});
h('provider:keyStatus', ({ id } = {}) => {
  const k = KEYS[id] || '';
  return { has: !!k, encrypted: true, masked: k ? '••••••••' + k.slice(-4) : '' };
});
h('provider:probe', (p = {}) => {
  // 不真连：按地址给不同结果，好看出几种状态
  const b = String(p.base || '');
  if (!b) return { ok: false, engine: p.protocol || 'openai', error: '请先填服务地址' };
  if (b.includes('9999')) return { ok: false, engine: 'openai',
    error: '连不上 127.0.0.1:9999（端口没开）。请确认服务已启动、地址与端口对。' };
  if (b.includes('192.168')) return { ok: false, engine: 'openai',
    error: '连接 192.168.1.50:8000 超时。可能是网络不通，或者该服务需要代理。' };
  if (b.includes('11434')) return { ok: true, engine: 'ollama', version: '0.40.2',
    models: ['qwen3:latest', 'gemma3:4b', 'llama3.1:8b'] };
  if (b.includes('dashscope')) return { ok: true, engine: 'openai',
    models: ['qwen-plus', 'qwen-max', 'qwen3-max'] };
  return { ok: true, engine: 'openai',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct',
             'THUDM/glm-4-9b-chat', 'moonshotai/Kimi-K2-Instruct'] };
});
h('provider:switch', () => ({ ok: true }));

// ---- skill 桩：走真实的 SKILL.md 解析与内置目录 ----
//
// ⚠ 技能数据也用真的：从 builtin-skills/ 读 SKILL.md，
//   这样截图里的 description 就是真会进系统提示的那一句。
const BUILTIN_DIR = path.join(APPDIR, 'builtin-skills');
function readSkillDir(dir) {
  const files = [];
  const walk = (sub) => {
    const d = path.join(dir, sub);
    if (!fsMod.existsSync(d)) return;
    for (const f of fsMod.readdirSync(d)) {
      if (f.startsWith('.')) continue;
      const full = path.join(d, f);
      if (fsMod.statSync(full).isDirectory()) continue;
      const rel = sub ? `${sub}/${f}` : f;
      files.push({ path: rel, kind: /^scripts?\//.test(rel) ? 'script' : 'reference',
        content: fsMod.readFileSync(full, 'utf8') });
    }
  };
  walk('');
  for (const s of ['references', 'scripts', 'assets']) walk(s);
  return files;
}

let SKILLS = [];
for (const d of fsMod.existsSync(BUILTIN_DIR) ? fsMod.readdirSync(BUILTIN_DIR) : []) {
  const dir = path.join(BUILTIN_DIR, d);
  if (!fsMod.statSync(dir).isDirectory()) continue;
  const files = readSkillDir(dir);
  const main = files.find((f) => f.path === 'SKILL.md');
  if (!main) continue;
  const meta = FMT.parse(main.content);
  SKILLS.push({
    id: d, project_id: null, name: meta.name === 'novel-writer' ? '小说写作助手'
      : meta.name === 'skill-creator' ? '技能创建助手' : meta.name,
    type: 'built-in', enabled: 1, prompt_content: main.content,
    __files: files.filter((f) => f.path !== 'SKILL.md')
      .map((f) => ({ path: f.path, size: f.content.length })),
  });
}
// 补几条旧式的单条提示词技能，让分组看起来是真的
for (const s of [
  ['写对白', '只写对话。用「」包裹，每句不超过 40 字，符合各自身份与处境。'],
  ['润色改写', '保持原意与情节，只改语言。删掉形容词堆砌，句子变短。'],
  ['检查设定', '列出与已给设定冲突的地方，指明位置，不要改写正文。'],
]) {
  SKILLS.push({ id: 'sk-' + s[0], name: s[0], type: 'built-in', enabled: 1,
    prompt_content: s[1], __files: [] });
}
SKILLS.push({
  id: 'sk-mine-1', name: '按夜枫视角重写', type: 'custom', enabled: 1,
  prompt_content: '全部用夜枫的视角，不写他的内心活动，只写他看到什么、做了什么。',
  __files: [],
});

h('skill:listAll', () => SKILLS);
h('skill:list', () => SKILLS.filter((x) => x.enabled));
h('skill:index', ({ only }) => SKILLS.filter(
  (x) => (!only || only.includes(x.id)) && FMT.parse(x.prompt_content).description)
  .map((x) => {
    const meta = FMT.parse(x.prompt_content);
    return { id: x.id, name: x.name, description: meta.description,
      hasFrontmatter: meta.hasFrontmatter, files: (x.__files || []).map((f) => f.path) };
  }));
h('skill:lookup', ({ id }) => {
  const sk = SKILLS.find((x) => x.id === id);
  if (!sk) throw new Error('技能不存在');
  return { id: sk.id, name: sk.name, content: sk.prompt_content,
    files: sk.__files || [] };
});
h('skill:files', ({ id }) => (SKILLS.find((x) => x.id === id).__files) || []);
h('skill:file', ({ id, path: rel }) => {
  const dir = path.join(BUILTIN_DIR, id);
  const f = readSkillDir(dir).find((x) => x.path === rel);
  if (!f) throw new Error(`没有这个文件：${rel}`);
  return { path: f.path, kind: f.kind, content: f.content, executable: 0 };
});
h('skill:saveFile', ({ id, path: rel, content }) => {
  const sk = SKILLS.find((x) => x.id === id);
  if (!sk) throw new Error('技能不存在');
  sk.__files = sk.__files || [];
  const e = sk.__files.find((x) => x.path === rel);
  if (e) e.size = String(content || '').length;
  else sk.__files.push({ path: rel, size: String(content || '').length });
  return { path: rel, content, kind: 'reference', executable: 0 };
});
h('skill:deleteFile', ({ id, path: rel }) => {
  const sk = SKILLS.find((x) => x.id === id);
  if (sk) sk.__files = (sk.__files || []).filter((x) => x.path !== rel);
  return { deleted: 1 };
});
h('skill:update', ({ id, name, promptContent }) => {
  const t = SKILLS.find((x) => x.id === id);
  if (t) { t.name = name; t.prompt_content = promptContent; }
  return t || {};
});
h('skill:setEnabled', ({ id, enabled }) => {
  const t = SKILLS.find((x) => x.id === id);
  if (t) t.enabled = enabled ? 1 : 0;
  return { skill: t || {} };
});
h('skill:create', (p) => {
  const sk = { id: 'sk-new-' + Date.now(), project_id: p.projectId || null,
    name: p.name, type: 'custom', enabled: 1,
    prompt_content: p.promptContent || '', __files: [] };
  SKILLS.push(sk);
  return sk;
});
h('skill:import', ({ content }) => {
  const v = FMT.validate(content);
  const parsed = FMT.parse(content);
  return { ok: v.ok, name: parsed.name, description: parsed.description,
    body: parsed.body, extra: parsed.extra,
    errors: v.errors, warnings: v.warnings };
});
h('skill:importCommit', ({ content, name, files }) => {
  const parsed = FMT.parse(content);
  const id = 'sk-' + (parsed.name || name || 'new');
  const sk = { id, name: parsed.name || name, type: 'custom', enabled: 1,
    prompt_content: content, __files: (files || []).map((f) => ({ path: f.path, size: (f.content || '').length })) };
  SKILLS.push(sk);
  return { skill: sk, files: (files || []).map((f) => ({ path: f.path, ok: true })) };
});
h('skill:export', ({ id }) => {
  const sk = SKILLS.find((x) => x.id === id);
  if (!sk) throw new Error('技能不存在');
  return { name: sk.name, content: sk.prompt_content, files: [] };
});
h('skill:delete', ({ id }) => {
  const i = SKILLS.findIndex((x) => x.id === id);
  const t = SKILLS[i];
  if (t && t.type === 'built-in') throw new Error('内置技能不能删除，可以先停用它');
  if (i >= 0) SKILLS.splice(i, 1);
  return { deleted: i >= 0 ? 1 : 0 };
});


h('trash:list', (p) => ({ items: trash.list(p.projectId), stats: trash.stats(p.projectId) }));
h('trash:add', (p) => ({ ok: true, entry: trash.add(p.projectId, p.path) }));
h('trash:restore', (p) => trash.restore(p.projectId, p.id, { toPath: p.toPath }));
h('trash:purge', (p) => trash.purge(p.projectId, p.id));
h('trash:empty', (p) => trash.empty(p.projectId));


const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 860, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await wait(1400);

  const shot = async (name) => {
    const img = await win.capturePage();
    fsMod.mkdirSync(path.join(APPDIR, 'shots'), { recursive: true });
    fsMod.writeFileSync(path.join(APPDIR, 'shots', `${name}.png`), img.toPNG());
    console.log('  ✓', name);
  };

  /**
   * 在弹窗内按可见文字点按钮。
   *
   * ⚠ 必须在 [role="dialog"] 里找：界面上「＋ 新建」有两个
   *   （第 4 栏底栏的、弹窗里的），用 includes 全局匹配会命中
   *   第 4 栏那个 —— 它开的是 PromptDialog，
   *   于是弹窗里的新建输入框从没出现，
   *   而脚本一路点「创建」全部 not-found。
   *   截图 t7 与 t8 字节完全相同，就是这么来的。
   */
  const clickIn = async (text, where = '[role="dialog"]') => {
    const r = await win.webContents.executeJavaScript(`
      (() => {
        const root = document.querySelector(${JSON.stringify(where)});
        if (!root) return 'no-container: ' + ${JSON.stringify(where)};
        const els = [...root.querySelectorAll('button')];
        const el = els.find(x => (x.textContent||'').trim() === ${JSON.stringify(text)})
                || els.find(x => (x.textContent||'').includes(${JSON.stringify(text)}));
        if (!el) return 'not-found: ' + els.map(x=>(x.textContent||'').trim()).join('|').slice(0,180);
        // 用真实鼠标事件而不是 el.click()：React 的 onClick 两者都响应，
        // 但 el.click() 不带 clientX 等坐标，某些靠坐标判断的逻辑会走空。
        const r = el.getBoundingClientRect();
        for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
          const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true,
            clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 }));
        }
        return 'dispatched:' + (el.textContent||'').trim();
      })()
    `);
    console.log(`  点「${text}」:`, r);
    return r;
  };
  const clickText = async (text) => clickIn(text, 'body');

  /** 点一个图标按钮（按 title） */
  const clickTitle = async (title) => {
    const r = await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[title*=${JSON.stringify(title)}]');
        if (!el) {
          const all = [...document.querySelectorAll('[title]')].map(x=>x.title);
          return 'not-found: ' + all.join(' | ').slice(0,200);
        }
        el.click();
        return 'ok';
      })()
    `);
    console.log(`  点图标「${title}」:`, r);
    return r;
  };

  const rows = () => win.webContents.executeJavaScript(`
    (() => {
      const pane = document.querySelector('[data-pane="files"]');
      if (!pane) return 'no-pane';
      return [...pane.querySelectorAll('div[title]')]
        .map(d => d.title + (d.style.boxShadow && d.style.boxShadow !== 'none' ? '  ←插入点' : ''))
        .join('\\n');
    })()
  `);


  console.log('\\n=== 2. 拖拽：把「时间线.md」拖到「卷纲」文件夹上 ===');
  // 用真实 DOM 的 draggable 事件序列。浏览器的 HTML5 拖拽
  // 在合成事件里需要 dataTransfer 对象，手工造一个。
  const dragResult = await win.webContents.executeJavaScript(`
    (() => {
      const pane = document.querySelector('[data-pane="files"]');
      const rows = [...pane.querySelectorAll('div[title]')];
      const src = rows.find(d => d.title === '时间线.md');
      const dstDir = rows.find(d => d.title === '卷纲');
      if (!src || !dstDir) return 'not-found src=' + !!src + ' dir=' + !!dstDir;

      let dt;
      try { dt = new DataTransfer(); }
      catch (err) { return 'DataTransfer 不可用: ' + err.message; }
      const rect = dstDir.getBoundingClientRect();
      // 落在右侧 1/3 → 「放进去」
      const cx = rect.left + rect.width * 0.85;
      const cy = rect.top + rect.height / 2;

      const log = [];
      ['dragstart','dragenter','dragover','drop','dragend'].forEach(t => {
        src.addEventListener(t, () => log.push('src:' + t), true);
        dstDir.addEventListener(t, () => log.push('dst:' + t), true);
      });
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dstDir.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      dstDir.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      const midState = [...pane.querySelectorAll('div[title]')]
        .filter(d => d.style.background && d.style.background.includes('accent'))
        .map(d => d.title);
      dstDir.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return JSON.stringify({ highlighted: midState, events: log });
    })()
  `);
  console.log('  拖拽手势:', dragResult);
  await wait(700);
  await shot('t2-拖拽后-时间线进了卷纲');
  console.log('  落盘验证:', fsMod.existsSync(pfs.resolveIn(PID, '卷纲/时间线.md'))
    ? '✓ 卷纲/时间线.md 真的存在了'
    : '✗ 没移动');
  console.log('  树内容:\\n    ' + (await rows()).split('\\n').join('\\n    '));

  console.log('\\n=== 3. 同目录重排：把「灵感碎片.md」拖到最上面 ===');
  const reorder = await win.webContents.executeJavaScript(`
    (() => {
      const pane = document.querySelector('[data-pane="files"]');
      const rows = [...pane.querySelectorAll('div[title]')];
      const src = rows.find(d => d.title === '灵感碎片.md');
      const dst = rows.find(d => d.title === '章节摘要.md' || d.title === '世界观.md');
      if (!src || !dst) return 'not-found src=' + !!src + ' dst=' + !!dst;
      const dt = new DataTransfer();
      const rect = dst.getBoundingClientRect();
      const cx = rect.left + rect.width * 0.3;   // 左侧 → before
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: rect.top + 3 }));
      const line = [...pane.querySelectorAll('div[title]')]
        .filter(d => d.style.boxShadow && d.style.boxShadow.includes('inset'))
        .map(d => d.title);
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: rect.top + 3 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return JSON.stringify({ insertLineAt: line });
    })()
  `);
  console.log('  重排手势:', reorder);
  await wait(700);
  await shot('t3-重排后');

  console.log('\\n=== 4. 回收站弹窗 ===');
  await clickTitle('回收站');
  await wait(700);
  await shot('t4-回收站弹窗');
  console.log('  弹窗条目数:', await win.webContents.executeJavaScript(
    "document.querySelectorAll('[role=\"dialog\"] .truncate').length"
  ));
  console.log('  底层第4栏还在吗:', await win.webContents.executeJavaScript(
    "!!document.querySelector('[data-pane=\"files\"] div[title]')"
  ));

  console.log('\\n=== 5. 关掉弹窗（Esc）===');
  await win.webContents.executeJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))"
  );
  await wait(500);
  console.log('  弹窗还在吗:', await win.webContents.executeJavaScript(
    "!!document.querySelector('[role=\"dialog\"]')"
  ));
  console.log('  文件树回来了吗:', await win.webContents.executeJavaScript(
    "!!document.querySelector('[data-pane=\"files\"] div[title]')"
  ));
  await shot('t5-关闭回收站后');

  console.log('\\n=== 6. 项目切换弹窗（点第 2 行项目名）===');
  await clickTitle('切换小说项目');
  await wait(600);
  await shot('t6-项目切换弹窗');

  await wait(400);
  console.log('  点新建(按 testid):', await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-testid="btn-new-project"]');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()
  `));
  await wait(500);
  console.log('  点击后立刻诊断:', await win.webContents.executeJavaScript(`
    (() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return 'no-dialog';
      const btns = [...dlg.querySelectorAll('button')].map(b => JSON.stringify((b.textContent||'').trim()));
      const inputs = [...dlg.querySelectorAll('input')].map(i => i.placeholder || '(空)');
      return JSON.stringify({ btns, inputs });
    })()
  `));
  console.log('  弹窗里有新建输入框:', await win.webContents.executeJavaScript(`
    (() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return 'no-dialog';
      return [...dlg.querySelectorAll('input')].map(i => i.placeholder || '(无)').join('|');
    })()
  `));
  await win.webContents.executeJavaScript(`
    (() => {
      const dlg = document.querySelector('[role="dialog"]');
      const inp = dlg && [...dlg.querySelectorAll('input')].find(i => /起个名字/.test(i.placeholder||''));
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '第二个小说');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await wait(250);
  await shot('t7-新建项目-输入名字');
  console.log('  点「创建」:', await clickIn('创建'));
  await wait(900);
  await shot('t8-新建后-项目列表');
  console.log('  项目数:', await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('[role=\"dialog\"] .truncate')].filter(d=>/墨染仙途|第二个小说/.test(d.textContent)).length"
  ));

  console.log('\\n=== 7. 顶栏不该再有新建项目 / 项目 select ===');
  const header = await win.webContents.executeJavaScript(`
    (() => {
      const hd = document.querySelector('header');
      return JSON.stringify({
        hasSelect: !!hd.querySelector('select'),
        text: hd.textContent.replace(/\\s+/g,' ').trim().slice(0,90),
      });
    })()
  `);
  console.log('  顶栏:', header);

  console.log('\\n=== 8. 切回第一个项目，看回收站是不是跟着项目走 ===');
  await win.webContents.executeJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))"
  );
  await wait(500);

console.log('\n=== 9. AI 提供商（多连接）===');
  console.log('  打开设置:', await win.webContents.executeJavaScript(
    "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/设置/.test(x.textContent||''));if(b){b.click();return 'ok'}return 'not-found'})()"
  ));
  await wait(700);
  console.log('  点「AI 提供商」:', await clickText('AI 提供商'));
  await wait(1000);
  console.log('  左栏连接数:', await win.webContents.executeJavaScript(
    "(()=>{const d=[...document.querySelectorAll('div')].filter(x=>x.textContent.trim().endsWith('✕'));return d.length})()"
  ));
  await wait(600);
  await shot('q1-连接列表');

  // 点「我的硅基流动」——已存密钥的那条
  console.log('  点硅基流动那条:', await win.webContents.executeJavaScript(
    "(()=>{const d=document.querySelector('[data-conn=conn-preset-siliconflow]');"
    + "if(d){d.click();return 'ok'}return 'not-found'})()"
  ));
  await wait(700);
  console.log('  地址与模型:', await win.webContents.executeJavaScript(
    "(()=>{const i=[...document.querySelectorAll('input')];return JSON.stringify(i.map(x=>x.value).filter(Boolean))})()"
  ));
  console.log('  点「获取模型列表」:', await clickText('获取模型列表'));
  await wait(1200);
  console.log('  模型按钮数:', await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('/')).length"
  ));
  await shot('p2-AI提供商-获取到模型');

  // 切到 Anthropic —— 看思考强度是否变成只有开关
  console.log('  点 Anthropic 那条:', await win.webContents.executeJavaScript(
    "(()=>{const d=document.querySelector('[data-conn=conn-preset-anthropic]');"
    + "if(d){d.click();return 'ok'}return 'not-found'})()"
  ));
  await wait(700);
  await shot('p3-AI提供商-Anthropic');

  // 换个连不上的地址，看错误提示
  console.log('  点内网代理那条:', await win.webContents.executeJavaScript(
    "(()=>{const d=document.querySelector('[data-conn=conn-mine-local]');"
    + "if(d){d.click();return 'ok'}return 'not-found'})()"
  ));
  await wait(600);
  console.log('  点「获取模型列表」:', await clickText('获取模型列表'));
  await wait(900);
  await shot('p4-AI提供商-连接失败');

  console.log('\n=== 10. Skill 页 ===');
  console.log('  点「Skill」:', await clickText('Skill'));
  await wait(900);
  console.log('  技能条数:', await win.webContents.executeJavaScript(
    "document.body.innerText.match(/已开启[^\\n]*/)?.[0] || 'no-count'"
  ));
  await shot('p5-Skill-列表');

  // 点配套文件的 📎，验证能打开
  console.log('  点第一个 📎:', await win.webContents.executeJavaScript(
    "(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('📎'));if(b.length){b[0].click();return 'ok:'+b[0].textContent.trim()}return 'not-found'})()"
  ));
  await wait(600);
  console.log('  弹层里的文件名:', await win.webContents.executeJavaScript(
    "document.body.innerText.match(/references[^\\n]*/)?.[0] || 'none'"
  ));
  await shot('p6-Skill-配套文件');
  await win.webContents.executeJavaScript(
    "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='✕');if(b)b.click();return 'ok'})()"
  );
  await wait(300);

  // 点「＋ 新建」，看 SKILL.md 骨架
  console.log('  点「＋ 新建」:', await clickText('＋ 新建'));
  await wait(500);
  console.log('  新建区有 textarea:', await win.webContents.executeJavaScript(
    "!!document.querySelector('textarea')"
  ));
  await shot('p7-Skill-新建');

  // 点「导入」，粘贴一份真实的 SKILL.md 并检查
  console.log('  取消新建:', await clickText('取消'));
  await wait(300);
  console.log('  点「导入」:', await clickText('导入'));
  await wait(500);
  const SKILL_SAMPLE = [
    '---',
    'name: novel-reviewer',
    'description: 小说审稿助手。当用户要求审稿、检查章节、看看有没有问题时使用。',
    '---',
    '',
    '# 小说审稿助手',
    '',
    '检查章节质量。',
  ].join('\n');
  await win.webContents.executeJavaScript(`
    (() => {
      // ⚠ 取**最后一个** textarea：新建区与导入区都有输入框，
      //   而点「导入」时新建区还开着（startImport 只清了 editing，
      //   没关新建区）—— 这是真问题，见下面。
      const tas = [...document.querySelectorAll('textarea')];
      const ta = tas[tas.length - 1];
      if (!ta) return 'no-ta';
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(SKILL_SAMPLE)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()
  `);
  await wait(400);
  console.log('  textarea 个数:', await win.webContents.executeJavaScript(
    'document.querySelectorAll("textarea").length'
  ));
  console.log('  点「检查」:', await clickText('检查'));
  await wait(700);
  console.log('  校验结果:', await win.webContents.executeJavaScript(
    "document.body.innerText.match(/(可以导入|✗[^\\n]*)/)?.[0] || 'none'"
  ));
  await shot('p8-Skill-导入校验');

  
  app.exit(0);
});

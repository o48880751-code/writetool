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

const APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shot-skill-'));
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

// ---------------------------------------------------------------
// 真跑一遍内置技能种子 —— 截图里要显示的是真东西，不是编造的列表。
// 用临时库（APPDATA 已改成 mkdtemp），不污染用户真实数据。
// ---------------------------------------------------------------
const { loadBuiltin } = require(path.join(MODULES, 'db', 'builtin-skills.js'));
const seedResult = db.seedBuiltinSkills(loadBuiltin);
console.log('内置技能种子：', JSON.stringify(seedResult));

const SKILL_NAMES = db.listAllSkills(PID).map((x) => x.name);
console.log('库里技能：', SKILL_NAMES.join(' / '));

h('skill:listAll', () => db.listAllSkills(PID));
h('skill:files', (p) => db.listSkillFiles(p.id));
h('skill:file', (p) => db.getSkillFile(p.id, p.path));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); } else {
    fail++; console.log('  ✗', name, extra ? `　${extra}` : '');
  }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // ⚠ 不关后台节流的话 capturePage 会一直返回旧帧，
  //   截图张张一样而脚本还一路 ok —— 踩过两次。
  win.webContents.setBackgroundThrottling(false);

  // 看门狗：executeJavaScript 的未处理拒绝会让 Electron 静默挂住
  const watchdog = setTimeout(() => {
    console.log('  ✗ 看门狗超时（90s）');
    process.exit(1);
  }, 90000);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); } catch (e) {
      return `__ERR__${e.message}`;
    }
  };

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  win.showInactive();
  win.focus();

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 900));
    let img = null;
    for (let i = 0; i < 3 && !img; i++) {
      try { img = await win.webContents.capturePage(); } catch (e) {
        console.log(`    capturePage 第 ${i + 1} 次失败：${e.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!img) { fail++; console.log('  ✗ 截图失败', name); return null; }
    const buf = img.toPNG();
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
    console.log('  ✓ 拍了', name, `${img.getSize().width}x${img.getSize().height}`);
    return buf;
  };

  const clickText = async (text) => js(`
    (() => {
      const bs = [...document.querySelectorAll('button')];
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || bs.find(x => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  /**
   * 按**首字符**点按钮。
   *
   * ⚠⚠ 设置按钮的真实文字是 `⚙设置v1.0.6` —— 图标与文字之间没有空格、
   *   后面还挂着版本号。所以 `includes('⚙ 设置')` 永远中不了
   *   （踩过：截图里按钮明明在，脚本报 not-found，看着像界面坏了）。
   *   MEMORY.md 里就写着「用锚点字符，别用关键词匹配」，这次判据没照做。
   */
  const clickAnchor = async (ch) => js(`
    (() => {
      const bs = [...document.querySelectorAll('button')];
      const b = bs.find(x => x.textContent.trim().charAt(0) === ${JSON.stringify(ch)});
      if (!b) return 'not-found: ' + bs.map(x=>x.textContent.trim()).slice(0,20).join('|');
      b.click();
      return 'ok';
    })()
  `);

  console.log('\n=== 设置 → Skill 页截图与判据 ===\n');

  console.log('  点「⚙ 设置」（按首字符）:', await clickAnchor('⚙'));
  await new Promise((r) => setTimeout(r, 900));
  console.log('  点「Skill」:', await clickText('Skill'));
  await new Promise((r) => setTimeout(r, 1100));

  // ---- 判据 1：六个内置技能都在列表里 ----
  const names = await js(`
    JSON.stringify([...document.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && e.textContent.trim())
      .map(e => e.textContent.trim())
      // ⚠ 别把上限压太窄：那句「关着。每次要用的 Skill 都要自己在
      //   输入框上方 @ 勾选。」刚好 30 字，上限写 30 就被滤掉，
      //   判据显示"文案不存在"而页面上明明有 —— 又是判据自己的错。
      .filter(x => x.length < 120))
  `);
  const txt = String(names);
  const EXPECT = ['写新章节', '修订已保存章节', '一致性检查与文档同步',
    '写对白', '润色改写', '技能创建助手'];
  console.log('\n—— 六项技能是否都可见 ——');
  for (const n of EXPECT) {
    t(`显示「${n}」`, txt.includes(n), txt.slice(0, 200));
  }

  // ---- 判据 2：文笔层之外的六项约束确实写在技能里（查库，不查界面）----
  console.log('\n—— 六项约束是否落在内置技能正文里 ——');
  const bodies = db.listAllSkills(PID)
    .filter((x) => x.type === 'built-in')
    .map((x) => `${x.name}\n${x.prompt_content || ''}`).join('\n');
  t('资料读取：提到 设定/ 人物库（不是 小说资料/）',
    bodies.includes('设定/人物库') && !bodies.includes('小说资料/'),
    bodies.includes('小说资料/') ? '仍有 小说资料/ 字样' : '');
  t('场景定义：有场景卡段落', bodies.includes('场景'));
  t('章节输出硬性要求：有字数/输出约束段落',
    /字数|输出|不得|必须/.test(bodies));
  t('维护文档：提到章节摘要', bodies.includes('章节摘要'));
  t('同步文档：提到同步', bodies.includes('同步'));
  t('安全约束：有禁止/红线类表述',
    /禁止|不得|不要/.test(bodies));

  // ---- 判据 3：自动路由开关渲染出来了 ----
  console.log('\n—— 自动路由开关 ——');
  const gate = await js(`
    (() => {
      const bs = [...document.querySelectorAll('button')];
      const b = bs.find(x => x.textContent.trim() === '开启');
      if (!b) return JSON.stringify({ found: false, btns: bs.map(x=>x.textContent.trim()).slice(0,40) });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ found: true, w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled });
    })()
  `);
  const g = JSON.parse(String(gate));
  t('「开启」按钮存在', g.found === true, gate.slice(0, 200));
  t('按钮有尺寸（不是塌成 0）', g.found && g.w > 20 && g.h > 10, JSON.stringify(g));
  t('文案「自动挑选 Skill」在页面上', txt.includes('自动挑选'));
  t('默认关着时的说明文案在', txt.includes('关着。每次要用的 Skill 都要自己在输入框上方 @ 勾选'));

  const pngOff = await shot('skill-cat-1-默认关');

  // ---- 判据 4：点一下能开，且写进 config ----
  console.log('  点「开启」:', await clickText('开启'));
  await new Promise((r) => setTimeout(r, 700));
  const after = await js(`
    JSON.stringify({
      btn: [...document.querySelectorAll('button')].map(x=>x.textContent.trim()).filter(x=>x==='已开'||x==='开启'),
      hint: (document.body.textContent||'').includes('已开。发消息前会先判断该用哪些 Skill'),
      extra: (document.body.textContent||'').includes('手动 @ 的优先'),
    })
  `);
  const af = JSON.parse(String(after));
  t('按钮变成「已开」', af.btn.includes('已开'), JSON.stringify(af.btn));
  t('开启后的说明文案出现', af.hint === true);
  t('补充说明「手动 @ 的优先」出现', af.extra === true);
  t('config 里 autoSkill 已写成 true', CFG.autoSkill === true, `CFG.autoSkill=${CFG.autoSkill}`);

  const pngOn = await shot('skill-cat-2-已开');

  // ---- 判据 5：两张图不一样（证明真拍到了，不是旧帧）----
  console.log('\n—— 截图有效性 ——');
  const md5 = (b) => require('node:crypto').createHash('md5').update(b).digest('hex').slice(0, 12);
  t('两张图都拍到了', !!pngOff && !!pngOn);
  t('两张图 md5 不同（不是同一帧）',
    pngOff && pngOn && md5(pngOff) !== md5(pngOn),
    pngOff && pngOn ? `${md5(pngOff)} vs ${md5(pngOn)}` : '');

  clearTimeout(watchdog);
  console.log(`\n通过 ${pass} / ${pass + fail}`);
  console.log(`临时目录：${APPDATA}`);
  if (fail) process.exitCode = 2;
  setTimeout(() => app.quit(), 300);
});

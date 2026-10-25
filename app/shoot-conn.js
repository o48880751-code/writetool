/**
 * 「当前连接」界面截图 + 主动断言。
 *
 * ## 为什么又要一个截图脚本
 *
 * 2026-10-13 羽毛菌连提四件事：
 *   「保存并测试成功后没有弹窗」「重新进入设置之后就需要重新连接」
 *   「进来后直接跳到本地接入选项」「进来之后应该是一个已保存的界面」
 *
 * 这四条都是**只有把界面跑起来才看得见**的问题，扫源码的判据
 * （test-ui-wiring.js）只能证明"代码写了"，证明不了"跑起来是那样"。
 * 上一次真跑渲染进程就当场抓到过全白 bug（config.thinkLevel 空指针），
 * 这次同理：判据和截图各管一半，缺一半就还是靠嘴说。
 *
 * ## 三个场景 + 每场一条断言
 *
 *   card   进屏就是「当前连接」卡片，徽章写「已连接 · Nms」
 *   saved  点「保存并测试」后弹出一个**要手动关**的结果窗口
 *   free   点「断开连接」后回到选择页，且云端排第一、本地排最后
 *
 * 运行：cmd //c "electron-run.cmd shoot-conn.js [card|saved|free|broken]"
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
const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-conn';

/**
 * 场景从命令行取。
 *
 * ⚠ 不能用 `process.argv[2]` 也不能用"第一个不以 - 开头又不以 .js 结尾"的：
 *   electron-run.cmd 把脚本名放在 argv[2]、场景放在 argv[3]，
 *   而 argv[1] 是 electron.exe 本身（路径不含 .js）——
 *   第一版那条 filter 抓到的就是 exe 路径，场景名变成了
 *   `D:\...\electron.exe`，于是所有分支都不进，断言跑了 0 条还"通过"。
 *   静默通过比失败更难查，所以这里从**脚本名的位置**往后取。
 */
const ARGV = process.argv.slice(1).filter((a) => !a.startsWith('-'));
const SCRIPT_AT = ARGV.findIndex((a) => a.endsWith('.js'));
const SCENARIO = (SCRIPT_AT >= 0 ? ARGV[SCRIPT_AT + 1] : ARGV[0]) || 'card';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '连接验证' });
pfs.ensureProject(PID);

// ---- 连接与配置的真数据 ----
const CONNS = [
  {
    id: 'conn-deepseek', name: 'DeepSeek', protocol: 'openai',
    providerKey: 'deepseek', base: 'https://api.deepseek.com',
    model: 'deepseek-chat', need_key: 1, has_key: 1,
  },
  {
    id: 'conn-ollama', name: 'Ollama', protocol: 'ollama',
    providerKey: 'ollama', base: 'http://127.0.0.1:11434',
    model: 'qwen3:latest', need_key: 0, has_key: 0,
  },
];

let CFG = {
  model: 'deepseek-chat', numCtx: 8192, temperature: 0.3,
  fontSize: 16, fontFamily: 'system-ui', theme: 'gold', notify: 'window',
  currentProject: PID, thinkLevel: 'off',
  // 断开的场景从空开始，card/saved 从 DeepSeek 开始
  activeConnectionId: SCENARIO === 'free' ? '' : 'conn-deepseek',
};

const h = (ch, fn) => {
  // ⚠ 注册前先摘掉：下面"自动枚举兜底桩"与"真数据覆盖"会注册同一个通道两次，
  //   而 Electron 对二次注册**直接抛错**（Attempted to register a second handler），
  //   症状是脚本在加载期就挂掉，一张截图都出不来。
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

/**
 * 从 preload 抠出全部通道名，先注册兜底桩。
 *
 * ⚠ 不这么做就会漏：`thread:list` 没注册时渲染进程里报
 *   "No handler registered"，而它是**别的页面**要的通道——
 *   截图脚本只准备了设置页要用的那几个，漏掉的在渲染期炸。
 */
const PRELOAD_SRC = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...PRELOAD_SRC.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
function fallbackFor(ch) {
  if (/_list$/.test(ch)) return [];
  if (/_get$/.test(ch) && ch !== 'config:get') return null;
  return null;
}
for (const ch of ALL_CHANNELS) h(ch, () => fallbackFor(ch));

/** 探测：断开的场景返失败，其余返成功（带耗时，界面要显示它） */
function probeResult() {
  if (SCENARIO === 'broken') {
    return { ok: false, engine: 'openai', error: '401 鉴权失败：密钥无效或已过期' };
  }
  return {
    ok: true, engine: 'openai', latencyMs: SCENARIO === 'free' ? 0 : 412,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  };
}

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('provider:capabilities', () => ({
  providers: presets.PROVIDERS,
  customs: presets.customs().map((c) => c.key),
}));
h('provider:listConnections', () => CONNS.map((c) => ({ ...c, needKey: !!c.need_key, hasKey: !!c.has_key })));
h('provider:createConnection', (p) => ({ id: 'conn-new', name: '新连接', ...p }));
h('provider:updateConnection', (p) => {
  const c = CONNS.find((x) => x.id === p.id);
  if (c) Object.assign(c, {
    name: p.name, protocol: p.protocol, providerKey: p.providerKey,
    base: p.base, model: p.model,
  });
  return { ok: true };
});
h('provider:deleteConnection', () => ({ ok: true }));
h('provider:activate', ({ id }) => {
  const c = CONNS.find((x) => x.id === id);
  if (!c) return { ok: false, error: '连接不存在' };
  CFG = { ...CFG, activeConnectionId: id, model: c.model };
  return { ok: true, connection: c };
});
h('provider:disconnect', () => {
  CFG = { ...CFG, activeConnectionId: '' };
  return { ok: true, activeConnectionId: '' };
});
h('provider:probe', () => probeResult());
h('provider:setKey', () => ({ ok: true, encrypted: true, masked: 'sk-…7f3a' }));
h('provider:keyStatus', () => ({ has: true, encrypted: true, masked: 'sk-…7f3a' }));

// ---- 其它页面要用的 ----
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
h('ollama:check', () => ({ ok: true, version: '0.40.2', models: [{ name: 'qwen3:latest' }] }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => { const r = pfs.read(p.projectId, p.path); return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) }; });
h('fs:write', (p) => pfs.write(p.projectId, p.path, p.content));
h('fs:create', (p) => pfs.create(p.projectId, p.path, { dir: p.dir }));
h('fs:rename', (p) => pfs.rename(p.projectId, p.from, p.to));
h('fs:remove', (p) => pfs.remove(p.projectId, p.path, { recursive: p.recursive }));
h('fs:reveal', () => ({ ok: true }));
h('app:info', () => ({ version: '1.0.0', userDir: path.join(APPDATA, 'writetool'), dbPath: DB, node: process.versions.node, electron: process.versions.electron }));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', () => ({ ok: true }));
h('trash:list', () => ({ items: [], stats: {} }));
h('trash:add', () => ({ ok: true }));
h('trash:restore', () => ({ ok: true }));
h('trash:purge', () => ({ ok: true }));
h('trash:empty', () => ({ ok: true }));
h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份' }));
h('data:inspectBackup', () => ({ canceled: true }));

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  // confirm（断开/删除会问）一律自动同意，否则流程停在原生弹窗上
  win.webContents.on('console-message', () => {});
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  await win.webContents.executeJavaScript("window.confirm = () => true; true");

  const js = (code) => win.webContents.executeJavaScript(code);
  /**
   * 截图。
   *
   * ⚠⚠ **拍两次，扔掉第一张**。
   *   capturePage() 返回的是合成器**最后一帧**，不是"此刻的界面"。
   *   刚切进设置页时新帧还没产出来，于是三个不同场景
   *   （卡片 / 连不上 / 断开后选择页）拍出来的 md5 一模一样——
   *   而断言全过，因为 DOM 是对的。
   *   截图骗人比没截图更坏：第一版就是这么交了三张"看起来一样"的图。
   *   现在先等一帧、再拍一次，扔掉前一张。
   */
  const shot = async (name) => {
    await js("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.capturePage();          // 丢弃：等它把新帧做出来
    await new Promise((r) => setTimeout(r, 200));
    const img = await win.webContents.capturePage();
    await js("document.body.style.transition=''; true");
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  截图', name);
  };
  /**
   * 按可见文字点按钮。
   *
   * ⚠⚠ **只点可见的**（offsetParent 非空）。
   *   设置页整页覆盖但**一直在 DOM 里**（display:none），
   *   于是 document.querySelectorAll('button') 会先撞上隐藏页面里的
   *   「保存设置」这类按钮：click 报 'ok'，界面纹丝不动，
   *   截图拍回来的还是工作区 —— 看起来像"功能没做出来"。
   *   隐藏元素点得到但用户看不到，这个坑比 not-found 更费时间。
   */
  const clickText = (text) => js(`
    (() => {
      const bs = [...document.querySelectorAll('button')]
        .filter(x => x.offsetParent !== null || x.getClientRects().length > 0);
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(text)})
             || bs.find(x => x.textContent.includes(${JSON.stringify(text)}));
      if (!b) return 'not-found(可见按钮: ' + bs.map(x=>x.textContent.trim()).join('|').slice(0,180) + ')';
      b.click(); return 'ok';
    })()
  `);
  const clickSel = (sel) => js(`
    (() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return 'not-found'; e.click(); return 'ok'; })()
  `);

  // 先确认界面真的活着（上一轮的白屏就是这么发现的）
  const alive = await js(`(() => {
    const r = document.getElementById('root');
    return JSON.stringify({ kids: r ? r.children.length : -1,
      buttons: document.querySelectorAll('button').length });
  })()`);
  const aliveObj = JSON.parse(alive);
  console.log(`\n=== 连接界面截图（场景 ${SCENARIO}）===`);
  console.log('  界面:', alive);
  if (aliveObj.kids < 1 || aliveObj.buttons < 3) {
    console.log('  ❌ 界面没渲染出来，后面几张图没意义');
    app.exit(1);
  }

  // 进设置 → AI 提供商
  // ⚠ 每一步都要回报点没点上。静默的 clickText 在"没找到"时只是白等，
  //   截图会拍回工作区，看起来像"界面没做出来"。
  console.log('  可见按钮:', await js(`JSON.stringify(
    [...document.querySelectorAll('button')]
      .filter(x => x.getClientRects().length > 0)
      .map(x => x.textContent.trim().slice(0, 14)))`));
  const d1 = await clickText('设置');
  await new Promise((r) => setTimeout(r, 600));
  const d2 = await clickText('AI 提供商');
  await new Promise((r) => setTimeout(r, 900));
  const where = await js(`JSON.stringify({
    card: !!document.querySelector('[data-testid="active-card"]'),
    picker: /新建连接|换一条 \\/ 新建/.test(document.body.textContent),
    head: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 160),
  })`);
  console.log('  点设置:', d1, '｜点 AI 提供商:', d2, '｜位置:', where);
  if (!JSON.parse(where).card && !JSON.parse(where).picker) {
    console.log('  ❌ 没进到设置页的 AI 提供商，截图没意义');
    await shot('c0-没进到设置页');
    app.exit(1);
  }

  if (SCENARIO === 'card' || SCENARIO === 'broken') {
    const st = JSON.parse(await js(`(() => {
      const card = document.querySelector('[data-testid="active-card"]');
      const badge = document.querySelector('[data-testid="active-badge"]');
      return JSON.stringify({
        card: !!card,
        badge: badge ? badge.textContent.trim() : null,
        btnDisconnect: !!document.querySelector('[data-testid="btn-disconnect"]'),
        text: card ? card.textContent.replace(/\\s+/g, ' ').slice(0, 120) : '',
      });
    })()`));
    console.log('  卡片:', JSON.stringify(st));
    t('进屏就是「当前连接」卡片，不是新建页', st.card, 'active-card 不存在');
    t('卡上有「断开连接」按钮', st.btnDisconnect, '没有 btn-disconnect');
    if (SCENARIO === 'broken') {
      t('连不上时徽章写「连不上」而不是「已连接」',
        st.badge === '连不上', `徽章写的是「${st.badge}」`);
      t('给出了失败原因', /401/.test(st.text), st.text);
    } else {
      t('徽章写「已连接」并带实测耗时（不是空口无凭）',
        /已连接/.test(st.badge || '') && /ms/.test(st.badge || ''),
        `徽章写的是「${st.badge}」`);
      t('显示了正在用的模型', /deepseek-chat/.test(st.text), st.text);
    }
    await shot(SCENARIO === 'broken' ? 'c4-当前连接-连不上' : 'c1-当前连接-已连接');
  }

  if (SCENARIO === 'saved') {
    // 进编辑 → 改模型 → 保存并测试 → 应该弹窗
    await clickSel('[data-testid="btn-edit-active"]');
    await new Promise((r) => setTimeout(r, 500));
    await shot('c2-编辑表单');
    await clickText('保存并测试');
    await new Promise((r) => setTimeout(r, 1200));
    const st = JSON.parse(await js(`(() => {
      const m = document.querySelector('[data-testid="save-result"]');
      return JSON.stringify({
        modal: !!m,
        text: m ? m.textContent.replace(/\\s+/g, ' ').slice(0, 200) : '',
        toasts: document.querySelectorAll('[data-testid="toast"]').length,
      });
    })()`));
    console.log('  结果窗口:', JSON.stringify(st));
    t('保存后弹出了结果窗口（羽毛菌：「没有弹窗我怎么知道」）',
      st.modal, 'save-result 不存在');
    t('窗口里有实测证据（耗时 / 模型数）',
      /\d+\s*ms/.test(st.text) && /个模型/.test(st.text), st.text);
    t('窗口说明了它已成为正在使用的连接',
      /正在使用的连接/.test(st.text), st.text);
    const active = await js(`window.api.config.get().then(c => c.activeConnectionId)`);
    t('保存成功后它成了当前连接（不用再重连）',
      active === 'conn-deepseek', `activeConnectionId = ${active}`);
    await shot('c3-保存结果-成功');
  }

  if (SCENARIO === 'free') {
    const st = JSON.parse(await js(`(() => {
      // ⚠ 只取**选择页的分组标题**：带括号补充说明的才是选择页的
      //   （左栏连接分组是「☁️ 云端 API」这种裸标题，不带括号）。
      //   混在一起量顺序，量的其实是左栏，而左栏顺序和选择页是两件事。
      const groups = [...document.querySelectorAll('.text-\\\\[11px\\\\]')]
        .map(e => e.textContent.trim())
        .filter(t => /（推荐）|（按文档填地址）|（需要本机环境）/.test(t));
      return JSON.stringify({
        card: !!document.querySelector('[data-testid="active-card"]'),
        groups,
        body: document.body.textContent.replace(/\\s+/g, ''),
      });
    })()`));
    console.log('  选择页:', JSON.stringify(st).slice(0, 260));
    t('断开后不再显示「当前连接」卡片', !st.card, '卡片还在');
    t('选择页第一个分组是云端',
      /云端/.test(st.groups[0] || ''), `分组顺序：${st.groups.join(' / ')}`);
    t('本地大模型排在最后', /本地/.test(st.groups[st.groups.length - 1] || ''),
      `分组顺序：${st.groups.join(' / ')}`);
    // ⚠ 这里查的是整页文本、且去掉了空白：
    //   第一版 slice(0,300) 只截到工作区那几行，断言必然红 ——
    //   说明文字在选择页靠后位置，不是"没写"。
    t('本地那组说明了代价（轻薄本/显存）',
      /轻薄本/.test(st.body) && /显存/.test(st.body), '没说清本地模型吃显存');
    await shot('c5-断开后-选择页云端排最前');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${SCENARIO}：通过 ${pass} / 失败 ${fail}`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('崩溃：', e); app.exit(1); });

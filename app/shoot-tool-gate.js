/**
 * 截图：输入框上的「终端 / 联网」放行 chip（三态）+ 设置页「长度」组（本地/云端两态）。
 *
 * ## 为什么单独一个脚本
 *
 * shoot-tool-ui.js 拍的是设置页「工具」类目与审批弹窗，
 * 而这次要验的东西在**两个不同的地方**：一个是工作区输入框那一行，
 * 一个是设置页「参数」类目。共用一个脚本就要在两个页面之间来回切，
 * 场景组合会变成 3×2 六张，反而看不清。
 *
 * 场景：
 *   --scenario=locked  工具总开关关着 → 两个 chip 灰 + 虚线 + 🔒
 *   --scenario=both    总开关开、两个都放行  → 两个实心（这是默认状态）
 *   --scenario=one     总开关开、只放行终端  → 终端实心、联网描边
 *   --scenario=local   设置页参数，当前连接是本机 Ollama
 *                      → 窗口 8192、预留自动 4096、可用前文 4,096
 *   --scenario=cloud   设置页参数，当前连接是云端 API
 *                      → 窗口 200000、输出 32768、预留自动 16384、可用前文 183,616
 *
 * ⚠ cloud 这个场景是 1.0.1 新增的，用来钉住一个**改错过的判断**：
 *   1.0.0 把云端的「上下文窗口」藏掉了，理由是"窗口由服务商定，客户端改不了"。
 *   这句话只对了一半 —— 窗口确实传不到服务端，但**客户端必须知道它**，
 *   否则上下文压缩器会按错的窗口丢历史（200K 的模型按 8192 压，
 *   前文设定白丢 96%，而且不报任何错）。现在两项都要在，且值要对得上。
 *
 * 运行：./electron-run.cmd shoot-tool-gate.js --scenario=locked
 *
 * ⚠ 退出码有意义：判据没过就 exit(1)。截图脚本最怕的是
 *   "拍了但拍的是错的"，所以每张图都配了 DOM 判据，光看 PNG 看不出来。
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
// ⚠ 用**真实模块**算参数，不要在桩里手写一份。
//   手写的那份一旦与实现脱节，截图会拍出一个"看起来很对"的界面，
//   而真实运行时是另一个数 —— 这种假绿比没有截图更糟。
const connParamsMod = require(path.join(APPDIR, 'electron', 'conn-params.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { versionInfo } = require(path.join(APPDIR, 'electron', 'version-info.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-tool-gate';

const SCENARIO = (process.argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || 'both';
const VALID = ['locked', 'both', 'one', 'local', 'cloud'];
if (!VALID.includes(SCENARIO)) {
  console.log(`✗ 未知场景 ${SCENARIO}，可选：${VALID.join(' / ')}`);
  process.exit(1);
}

/** 后两个场景是设置页参数页，前三个是工作区输入框 */
const IS_SETTINGS = SCENARIO === 'local' || SCENARIO === 'cloud';
/** 连接是不是本地 Ollama —— 决定「长度」组显示几项 */
const CONN_LOCAL = SCENARIO !== 'cloud';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '放行开关验证' });
pfs.ensureProject(PID);

const winRef = { win: null };

const h = (ch, fn) => {
  // ⚠ 先摘再挂：热重载/重复 require 会报
  //   "Attempted to register a second handler for 'xxx'"
  if (ipcMain.removeHandler) ipcMain.removeHandler(ch);
  ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

/**
 * ⚠ 默认状态必须跟主进程 DEFAULT_CONFIG 一致。
 *   toolsEnabled 默认是 false，所以只有 both/one 才给 true ——
 *   写成默认 true，截图就变成"装出来默认开着"，是骗人的图。
 */
const TOOLS_ON = SCENARIO === 'both' || SCENARIO === 'one';

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434',
  numCtx: 8192, maxOutput: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID,
  activeConnectionId: 'conn-1',
  toolsEnabled: TOOLS_ON,
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: CFG.currentProject }));
h('chapter:list', () => db.listChapters(PID));
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => db.loadSettings(PID));
h('state:list', () => db.listEntityStates(PID));
h('thread:open', () => db.listOpenThreads(PID));
h('thread:list', () => db.listOpenThreads(PID));
h('thread:create', () => ({ id: 'th-1' }));
h('thread:resolve', () => ({ ok: true }));

h('provider:capabilities', () => {
  const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
  return { providers: presets.PROVIDERS, customs: presets.customs().map((c) => c.key) };
});

/**
 * ⚠ protocol 决定「长度」组显示几项：
 *   ollama → 上下文窗口（本地）滑块也在；其它 → 只剩输出上限。
 *   cloud 场景换成 openai-compatible，好对比。
 */
h('provider:listConnections', () => ([CONN_LOCAL ? {
  id: 'conn-1', name: '本机 Ollama', protocol: 'ollama',
  providerKey: 'ollama', base: 'http://127.0.0.1:11434',
  model: 'qwen3:latest', needKey: false, isPreset: true, hasKey: false,
} : {
  id: 'conn-1', name: 'DeepSeek 官方', protocol: 'openai-compatible',
  providerKey: 'deepseek', base: 'https://api.deepseek.com',
  model: 'deepseek-chat', needKey: true, isPreset: true, hasKey: true,
}]));

/**
 * 生成参数：窗口 / 输出上限 / 输出预留。
 *
 * ⚠ 1.0.1 起这三项**按连接存**（`config.connParams[connId]`），
 *   已不在 config 的全局字段里。设置页会主动问主进程要 ——
 *   桩不给的话，界面会显示兜底默认值，截图看着"对"但对不上真实路径。
 */
const CONN_PARAMS = CONN_LOCAL
  ? { numCtx: 8192, maxOutput: 8192 }                  // 本地：吃显存的保守值
  : { numCtx: 200000, maxOutput: 32768 };              // 云端：用户报的那个配置
h('provider:connParams', () => ({
  connectionId: 'conn-1',
  isLocal: CONN_LOCAL,
  connName: CONN_LOCAL ? '本机 Ollama' : 'DeepSeek 官方',
  ...connParamsMod.resolveConnParams(CONN_PARAMS, {}),
}));
h('provider:setConnParams', (p = {}) => {
  for (const k of ['numCtx', 'maxOutput', 'reserve']) {
    if (p[k] === undefined) continue;
    if (p[k] === null) delete CONN_PARAMS[k];
    else CONN_PARAMS[k] = Math.round(Number(p[k]));
  }
  console.log('  [桩] 参数已改:', JSON.stringify(CONN_PARAMS));
  return { ok: true, params: connParamsMod.resolveConnParams(CONN_PARAMS, {}) };
});

h('bible:query', () => ({ hits: [] }));
h('skill:list', () => db.listSkills(PID));
h('conv:list', () => ([{ id: 'cv-1', projectId: PID, title: '放行开关验证', updatedAt: Date.now() }]));
h('conv:create', () => ({ id: 'cv-1', projectId: PID, title: '放行开关验证' }));
h('conv:messages', () => ([{ id: 'm1', role: 'user', content: '帮我看看设定库里有哪些门派。' }]));
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
h('app:openExternal', () => ({ ok: true }));
h('data:backup', () => ({ ok: true, path: 'C:\\Users\\备份\\writetool-backup' }));
h('data:inspectBackup', () => ({ canceled: true }));

const { Trash } = require(path.join(APPDIR, 'electron', 'trash.js'));
const trash = new Trash(pfs);
trash.empty(PID);
h('trash:list', (p) => ({ items: trash.list(p.projectId), stats: trash.stats(p.projectId) }));
h('trash:add', (p) => ({ ok: true, entry: trash.add(p.projectId, p.path) }));
h('trash:restore', (p) => trash.restore(p.projectId, p.id, { toPath: p.toPath }));
h('trash:purge', (p) => trash.purge(p.projectId, p.id));
h('trash:empty', (p) => trash.empty(p.projectId));
h('app:setDownloadUrl', () => ({ ok: true }));

h('tool:searchKeyStatus', () => ({ has: false, encrypted: true }));
h('tool:setSearchKey', () => ({ ok: true, encrypted: true, has: false }));
h('tool:decide', () => ({ ok: true }));

const fails = [];

/**
 * getComputedStyle 给的背景是一长串
 *   "rgba(0, 0, 0, 0) none repeat scroll 0% 0"
 * 所以判断"透明"必须开头匹配。写成 === 'rgba(0, 0, 0, 0)'
 * 会**永远不相等**，于是那条判据永远绿 —— 假绿比没判据更糟。
 */
const isTransparent = (bg) => /^rgba\(0, 0, 0, 0\)|^transparent/.test(String(bg));

const expect = (name, cond, msg) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name}\n    ${msg}`); fails.push(name); }
};

app.whenReady().then(async () => {
  const { screen } = require('electron');
  /**
   * ⚠ 按屏宽建窗，别写死 1500。
   *   写死后 Windows 会把它缩到屏宽，于是"按 1500 算的基线"全错，
   *   五张图宽度明明一致却全判不合格 —— 那是基线算错，不是实现坏了。
   */
  const primary = screen.getPrimaryDisplay();
  const W = Math.min(1500, primary.workAreaSize.width);
  const H = Math.min(950, primary.workAreaSize.height);

  winRef.win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  const win = winRef.win;

  /** ⚠ 必须 show 出来，否则 capturePage 拍到的是首次绘制那一帧 */
  win.showInactive();

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  const shot = async (name) => {
    await win.webContents.executeJavaScript("document.body.style.transition='none'; true");
    await new Promise((r) => setTimeout(r, 130));
    /**
     * ⚠⚠ capturePage 首拍常抛 UnknownVizError，而且是**未捕获的 promise 拒绝** ——
     *   结果是脚本中途死掉，后面几张压根没拍，日志看着却像"拍完了"。
     *   必须 try/catch + 重试。
     */
    let buf = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try {
        const img = await win.webContents.capturePage();
        buf = img.toPNG();
      } catch (e) {
        console.log(`  [重试 ${i + 1}] capturePage: ${e.message}`);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!buf) { fails.push(`${name}（拍不出来）`); console.log(`  ✗ ${name} 拍不出来`); return; }
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
    // 顺手把尺寸记上：宽高对不上说明窗口被系统缩过，那张图不可信
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    console.log(`  ✓ ${name}  ${w}x${h}  ${buf.length}B`);
  };

  const js = (src) => win.webContents.executeJavaScript(src);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log(`\n=== 放行开关 / 长度组截图（场景 ${SCENARIO}）===`);

  // ---------- 场景 A：工作区输入框上的 chip ----------
  if (!IS_SETTINGS) {
    const chipState = async () => JSON.parse(await js(`
      (() => {
        const out = {};
        for (const k of ['terminal', 'web']) {
          const b = document.querySelector('[data-testid="tool-chip-' + k + '"]');
          if (!b) { out[k] = null; continue; }
          const st = getComputedStyle(b);
          out[k] = {
            文字: b.textContent.trim(),
            边框样式: st.borderTopStyle,
            背景: st.background.slice(0, 40),
            透明度: st.opacity,
            可见: b.offsetParent !== null,
          };
        }
        return JSON.stringify(out);
      })()
    `));

    let st = await chipState();
    console.log('  chip 初始状态:', JSON.stringify(st, null, 0));

    expect('两个 chip 都在输入框那一行',
      st.terminal && st.web && st.terminal.可见 && st.web.可见,
      `找不全：${JSON.stringify(st)}`);

    if (SCENARIO === 'locked') {
      // 总开关关：灰 + 虚线 + 🔒
      expect('总开关没开时两个 chip 都是虚线边框',
        st.terminal.边框样式 === 'dashed' && st.web.边框样式 === 'dashed',
        `边框是 ${st.terminal.边框样式}/${st.web.边框样式}，应是 dashed`);
      expect('总开关没开时两个 chip 都带锁',
        st.terminal.文字.includes('🔒') && st.web.文字.includes('🔒'),
        `没看到锁：${st.terminal.文字} / ${st.web.文字}`);
      expect('总开关没开时 chip 是半透明的（表示不可用）',
        Number(st.terminal.透明度) < 1 && Number(st.web.透明度) < 1,
        `透明度是 ${st.terminal.透明度}`);
      await shot('g-locked-总开关没开两个都锁着');
    }

    if (SCENARIO === 'both') {
      // 默认：两个都放行 → 实心
      expect('默认两个 chip 都是实线（已放行）',
        st.terminal.边框样式 === 'solid' && st.web.边框样式 === 'solid',
        `边框是 ${st.terminal.边框样式}/${st.web.边框样式}`);
      // ⚠ 光比 !== 'rgba(0, 0, 0, 0)' 是假绿：实际值是一长串，永远不等
      expect('已放行的 chip 有实心背景',
        !isTransparent(st.terminal.背景) && !isTransparent(st.web.背景),
        `背景是透明的，看着像没放行：${st.terminal.背景}`);
      expect('已放行的 chip 不带锁',
        !st.terminal.文字.includes('🔒') && !st.web.文字.includes('🔒'),
        `还带锁：${st.terminal.文字}`);
      await shot('g-both-两个都放行');
    }

    if (SCENARIO === 'one') {
      // 点一下「联网」，把它收回去
      console.log('  点「联网」收回去:', await js(`
        (() => {
          const b = document.querySelector('[data-testid="tool-chip-web"]');
          if (!b) return 'not-found';
          b.click();
          return 'ok';
        })()
      `));
      await wait(400);
      st = await chipState();
      console.log('  点完之后:', JSON.stringify(st, null, 0));

      expect('终端仍实心（有背景）',
        !isTransparent(st.terminal.背景),
        `终端背景是透明的：${st.terminal.背景}`);
      expect('联网被收回（背景透掉）',
        isTransparent(st.web.背景),
        `联网还有背景：${st.web.背景}`);
      expect('联网仍是实线（可用，只是这一轮不给）',
        st.web.边框样式 === 'solid',
        `联网边框是 ${st.web.边框样式} —— 那是"总开关没开"的样式，不是"没放行"`);
      await shot('g-one-只放行终端');
    }
  }

  // ---------- 场景 B：设置页「长度」组 ----------
  if (IS_SETTINGS) {
    console.log('  打开设置:', await js(`
      (() => { const b = document.querySelector('button[title*="打开设置"]');
               if (!b) return 'not-found'; b.click(); return 'ok'; })()
    `));
    await wait(700);

    // ⚠ 必须限定在设置页侧栏里点，全局 clickText 会命中主区的东西
    console.log('  点侧栏「🎚️参数」:', await js(`
      (() => {
        const navs = document.querySelectorAll('nav');
        let t = null;
        for (const n of navs) {
          const b = [...n.querySelectorAll('button')]
            .find(x => x.textContent.replace(/\\s+/g, '') === '🎚️参数');
          if (b) { t = b; break; }
        }
        if (!t) {
          return 'not-found, 侧栏有：' + [...navs].map(n =>
            [...n.querySelectorAll('button')].map(b => b.textContent.trim()).join('/')).join(' | ');
        }
        t.click();
        return 'ok';
      })()
    `));
    await wait(700);

    const page = await js(
      "document.getElementById('root').textContent.replace(/\\s+/g,' ')");

    // ⚠ 读**输入框的真实值**，不做文本匹配 ——
    //   "页面上出现了 '200K' 这串字符"说明不了它挂在哪个字段上，
    //   也说明不了后面那个数字是 200000 而不是别的。
    const valOf = async (testId) => js(
      `(() => { const e = document.querySelector('[data-testid="param-${testId}"]');`
      + ` return e ? e.value : null; })()`);

    const ctxVal = await valOf('numCtx');
    const outVal = await valOf('maxOutput');
    const reserveVal = await valOf('reserve');
    console.log(`  [诊断] 输入框值：窗口=${ctxVal} 输出上限=${outVal} 预留=${reserveVal}`);

    expect('三项都在（窗口 / 输出上限 / 输出预留）',
      ctxVal !== null && outVal !== null && reserveVal !== null,
      `缺字段：窗口=${ctxVal} 输出=${outVal} 预留=${reserveVal}`);

    expect('页面给出「实际可用前文」这个联动结果',
      page.includes('实际可用前文'),
      '只摆三个独立字段，用户改完窗口不知道该期待什么变化');

    /**
     * ⚠ 这一项在折叠线以下，滚一点让它进画面。
     *   它是这次改动的**核心结论**（窗口 − 预留 = 能带多少前文）——
     *   被裁掉的话，图里只剩三个孤立数字，看图的看不出它们的关系。
     */
    await js(`(() => {
      const box = document.querySelector('.max-w-2xl');
      const sc = box && box.parentElement;
      if (sc) sc.scrollTop = 300;
      return true;
    })()`);
    await wait(300);

    if (SCENARIO === 'local') {
      expect(`本地：窗口 = 8192（实际 ${ctxVal}）`, ctxVal === '8192',
        '本地窗口值不对 —— 它真吃显存，错了会 OOM 或浪费');
      expect(`本地：预留自动算成 4096（实际 ${reserveVal}）`, reserveVal === '4096',
        '自动预留不等于输出上限的一半');
      expect('本地：可用前文 = 窗口 − 预留 = 4,096',
        page.includes('4,096'),
        `没看到 4,096 这个数：${page.slice(page.indexOf('实际可用前文'), page.indexOf('实际可用前文') + 90)}`);
      expect('本地提示说的是「费显存」',
        page.includes('费显存'),
        '本地该提醒显存代价，而不是让用户以为随便调');
      await shot('g-local-长度三项都在');
    }

    if (SCENARIO === 'cloud') {
      expect(`云端：窗口 = 200000（实际 ${ctxVal}）`, ctxVal === '200000',
        '云端窗口没取到连接里存的值 —— 压缩器会按错的窗口丢历史');
      expect(`云端：输出上限 = 32768（实际 ${outVal}）`, outVal === '32768',
        '云端的输出上限被本地那个 8192 串味了');
      expect(`云端：预留自动算成 16384（实际 ${reserveVal}）`, reserveVal === '16384',
        '云端自动预留不等于输出上限的一半');
      expect('云端：可用前文 = 200000 − 16384 = 183,616',
        page.includes('183,616'),
        `没算对：${page.slice(page.indexOf('实际可用前文'), page.indexOf('实际可用前文') + 90)}`);
      expect('云端提示要求以服务商文档为准（不能瞎填）',
        page.includes('以服务商文档为准'),
        '云端窗口填错会静默丢历史，必须警告用户');
      expect('云端不再出现「由服务商定，改不了」那种旧说法',
        !page.includes('改不了也不需要改'),
        '这是 1.0.0 的错误说法 —— 窗口确实不用发给服务端，但本地必须知道它');
      await shot('g-cloud-窗口也能填');
    }
  }

  console.log('  根节点文本:', await js(
    "document.getElementById('root').textContent.replace(/\\s+/g,' ').slice(0,110)"));

  win.destroy();
  if (fails.length) {
    console.log(`\n✗ 场景 ${SCENARIO}：${fails.length} 条判据没过`);
    app.exit(1);
  }
  console.log(`\n✓ 场景 ${SCENARIO}：判据全过`);
  app.exit(0);
});

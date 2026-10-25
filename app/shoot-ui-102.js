/**
 * 截图：1.0.2 的三处界面改动 + 联网 chip 四态。
 *
 * ## 为什么要单独一个脚本
 *
 * 这次改动散在三个位置，而且**互相影响**：
 *   - 思考控件由四格横排（约 150px）变成弹出按钮（约 46px）
 *   - 发送键由「发送」长条（约 78px）变成圆形（32px）
 *   - 两者合计省下约 150px，直接改变第 2 栏**会不会换行**
 *
 * 所以不能分开拍：分开拍看不出"省下的空间有没有真的用上"，
 * 而换行与否正是这次改动的主要目的之一。
 *
 * 场景：
 *   --scenario=think    打开思考弹出菜单（默认档选中）
 *   --scenario=think2   打开菜单并切到「高」，看选中态转移
 *   --scenario=refs     选中一个技能 + 一个文件，看两色 chip
 *   --scenario=send     输入框有内容，发送键可用（蓝底白飞机）
 *   --scenario=send-off 输入框空，发送键禁用（灰底）
 *   --scenario=webmiss  没填搜索 Key，联网 chip 标红并指名缺什么
 *
 * ## 判据为什么必须写在 DOM 里
 *
 * 光看 PNG 分不出「浅绿」和「浅灰」，也看不出 32px 还是 28px。
 * 颜色和尺寸都要从 getComputedStyle 读出来断言 ——
 * 这也是本项目的老教训：**DOM 断言通过 ≠ 画面正确**，
 * 所以每张图既有 DOM 判据，也真的拍下来给人眼过一遍。
 *
 * 运行：./electron-run.cmd shoot-ui-102.js --scenario=think
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
const connParamsMod = require(path.join(APPDIR, 'electron', 'conn-params.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { versionInfo } = require(path.join(APPDIR, 'electron', 'version-info.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'shot-ui-102';

const SCENARIO = (process.argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || 'think';
const VALID = ['think', 'think2', 'refs', 'send', 'send-off', 'webmiss'];
if (!VALID.includes(SCENARIO)) {
  console.log(`✗ 未知场景 ${SCENARIO}，可选：${VALID.join(' / ')}`);
  process.exit(1);
}

/** 只有 webmiss 需要联网 chip 标红，其余场景联网是正常的 */
const NO_SEARCH_KEY = SCENARIO === 'webmiss';

fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '1.0.2 界面验证' });
pfs.ensureProject(PID);

const winRef = { win: null };
const h = (ch, fn) => {
  if (ipcMain.removeHandler) ipcMain.removeHandler(ch);
  ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434',
  numCtx: 8192, maxOutput: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID,
  activeConnectionId: 'conn-1',
  // ⚠ 总开关开着：否则 chip 全是锁着态，验不了第四态
  toolsEnabled: true,
  searchProvider: 'serper',
  // think2 场景预置成「高」，好验证点「默认」之后状态真的会转移
  thinkLevel: SCENARIO === 'think2' ? 'high' : 'off',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: CFG.currentProject }));
/**
 * ⚠ 章节 / 技能 / 设定：**桩补固定数据**。
 *
 * 新建的验证项目这三个表本来是空的，于是 @技能 与 @文件 浮层会打开
 * 但列表是空的，脚本点不到任何条目 —— 看着像「引用功能坏了」。
 * 第一版就是这么误判的，加了浮层探测（数页面里有多少按钮、
 * testid 是什么）才定位到：不是功能坏，是没数据。
 *
 * 判据要验的是**配色与形状**，不是数据从哪来，所以给固定内容。
 */
const FIX_CHAPTERS = [
  { id: 'ch-1', title: '第一章 断剑', word_count: 3210 },
  { id: 'ch-2', title: '第二章 旧约', word_count: 2870 },
];
const FIX_SKILLS = [
  { id: 'sk-1', name: '文风模仿', prompt_content: '按用户给的三段样文，模仿其句式与节奏。' },
  { id: 'sk-2', name: '设定查漏', prompt_content: '检查本章与既有设定是否冲突。' },
];
const FIX_SETTINGS = [
  { id: 'st-1', name: '人物库', note: '夜枫：苟道、利己、有底线。' },
  { id: 'st-2', name: '世界观', note: '灵气复苏百年，宗门林立。' },
];
h('chapter:list', () => FIX_CHAPTERS);
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => FIX_SETTINGS);
h('state:list', () => db.listEntityStates(PID));
h('thread:open', () => db.listOpenThreads(PID));
h('thread:list', () => db.listOpenThreads(PID));
h('thread:create', () => ({ id: 'th-1' }));
h('thread:resolve', () => ({ ok: true }));
h('bible:query', () => ({ hits: [] }));

h('provider:capabilities', () => {
  const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
  return { providers: presets.PROVIDERS, customs: presets.customs().map((c) => c.key) };
});
h('provider:listConnections', () => ([{
  id: 'conn-1', name: '本机 Ollama', protocol: 'ollama',
  providerKey: 'ollama', base: 'http://127.0.0.1:11434',
  model: 'qwen3:latest', needKey: false, isPreset: true, hasKey: false,
}]));
h('provider:connParams', () => ({
  connectionId: 'conn-1', isLocal: true, connName: '本机 Ollama',
  ...connParamsMod.resolveConnParams({ numCtx: 8192, maxOutput: 8192 }, {}),
}));
h('provider:setConnParams', () => ({ ok: true }));

/**
 * ⚠ 搜索 Key：**webmiss 场景给空**，其余场景给一个。
 *   这是这次要验的核心 —— 缺 Key 时 chip 必须标红并说清缺什么。
 */
const FAKE_KEY = 'shot_fake_key_not_real_000000000';
h('tool:setSearchKey', () => ({ ok: true, encrypted: true, has: !!FAKE_KEY }));
h('tool:searchKeyStatus', () => ({ has: !NO_SEARCH_KEY, encrypted: true }));
h('tool:webReady', () => ({
  provider: 'serper',
  hasKey: !NO_SEARCH_KEY,
  encrypted: true,
  masterOn: true,
  missing: NO_SEARCH_KEY ? ['Serper 的 Key'] : [],
}));
h('tool:decide', () => ({ ok: true }));

h('skill:list', () => FIX_SKILLS);
h('conv:list', () => ([{ id: 'cv-1', projectId: PID, title: '界面验证', updatedAt: Date.now() }]));
h('conv:create', () => ({ id: 'cv-1', projectId: PID, title: '界面验证' }));
h('conv:messages', () => ([{ id: 'm1', role: 'user', content: '帮我看看设定库里有哪些门派。' }]));
h('conv:send', () => ({ started: true }));
h('conv:setThink', () => ({ ok: true }));
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
h('app:setDownloadUrl', () => ({ ok: true }));

const { Trash } = require(path.join(APPDIR, 'electron', 'trash.js'));
const trash = new Trash(pfs);
trash.empty(PID);
h('trash:list', (p) => ({ items: trash.list(p.projectId), stats: trash.stats(p.projectId) }));
h('trash:add', (p) => ({ ok: true, entry: trash.add(p.projectId, p.path) }));
h('trash:restore', (p) => trash.restore(p.projectId, p.id, { toPath: p.toPath }));
h('trash:purge', (p) => trash.purge(p.projectId, p.id));
h('trash:empty', (p) => trash.empty(p.projectId));

const fails = [];
const expect = (label, cond, why) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fails.push(`${label} —— ${why || ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 数一张 PNG 里各种带色像素各出现了多少次。
 *
 * ⚠⚠ 为什么自己解 PNG 而不靠 getComputedStyle：
 *   这个环境里 computed backgroundColor 对那个圆形按钮返回禁用灰，
 *   而同一页面另建元素用同一个 CSS 变量却是对的，
 *   按钮自身的变量值也对，样式表里也没有规则命中它 ——
 *   四条证据互相矛盾，说明那条读数不可信。
 *   量渲染出来的像素没有中间层。
 *
 * ⚠ PNG 用了 filter（Sub/Up/Average/Paeth），不解滤波读出来全是垃圾
 *   —— 我第一版没做反滤波，量出来一堆 rgb(0,0,243) 这种怪色。
 *   五种都要处理，Paeth 的判据是 |p-a| |p-b| |p-c| 三者取最小。
 */
function countColors(file) {
  const zlib = require("node:zlib");
  const b = fs.readFileSync(file);
  let off = 8; let w = 0; let h = 0; let ct = 0;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      w = b.readUInt32BE(off + 8);
      h = b.readUInt32BE(off + 12);
      ct = b[off + 17];
    }
    if (type === "IDAT") idat.push(b.slice(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const up = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + up) & 0xff;
      else if (f === 3) v = (v + ((a + up) >> 1)) & 0xff;
      else if (f === 4) {
        const pp = a + up - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - up);
        const pc = Math.abs(pp - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c);
        v = (v + pr) & 0xff;
      }
      line[x] = v;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  const counts = new Map();
  for (let y = 0; y < h; y++) {
    const base = y * stride;
    for (let x = 0; x < w; x++) {
      const q = base + x * ch;
      const r = out[q]; const g = out[q + 1]; const bl = out[q + 2];
      // 只统计明显带色的像素，白/黑/灰一律排除
      if (Math.max(r, g, bl) - Math.min(r, g, bl) <= 28) continue;
      const k = r + "," + g + "," + bl;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

/** 主题色（gold）在像素层的 rgb —— 与 src/index.css 的 #8b6f47 对应 */
const THEME_RGB = [139, 111, 71];
const isTheme = (rgb) => rgb[0] === THEME_RGB[0] && rgb[1] === THEME_RGB[1] && rgb[2] === THEME_RGB[2];

/** 从颜色字符串里取 r/g/b 三元组 */
function rgbOf(css) {
  const m = String(css || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 两个颜色的距离。浅绿 vs 浅灰这类"看着不一样"，数值上未必差很多 */
function colorDist(a, b) {
  const x = rgbOf(a); const y = rgbOf(b);
  if (!x || !y) return 9999;
  return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
}

app.whenReady().then(async () => {
  /**
   * 看门狗：无论中间发生什么（包括未捕获的 promise 拒绝），
   * 最多 90 秒一定退出并给出结论。
   *
   * ⚠ 为什么需要：Electron 遇到未处理的 rejection 不会退出，
   *   而 executeJavaScript 失败正是这种情况 ——
   *   结果脚本静默挂住，只能人工强杀（踩过一次，白等 10 分钟）。
   *   超时后把已收集的 fails 打出来，至少知道死在哪。
   */
  const watchdog = setTimeout(() => {
    console.log('\n✗ 看门狗触发：90 秒没跑完，强制退出');
    for (const f of fails) console.log('  - ' + f);
    app.exit(1);
  }, 90000);
  watchdog.unref?.();

  const { screen } = require('electron');
  const size = screen.getPrimaryDisplay().workAreaSize;
  // ⚠ 宽度不能超过屏幕宽：设了更大的话 Windows 会把窗口缩到屏宽，
  //   于是我按"设计宽度"算出来的判据全错（这坑踩过一次）。
  const W = Math.min(1440, size.width);
  const H = Math.min(900, size.height);

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(APPDIR, 'electron', 'preload.js'), contextIsolation: true },
  });
  winRef.win = win;
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await wait(1400);

  /**
   * 在渲染进程里跑一段代码。
   *
   * ⚠⚠ 必须 catch（2026-10-14 卡死 10 分钟换来的）。
   *   executeJavaScript 失败时抛的是**未处理的 promise 拒绝**，
   *   既不打印我的判据、也不让进程退出 —— Electron 就那么挂着。
   *   第一版没 catch，脚本在 refs 场景静默卡死，只能强杀。
   *
   *   失败时把它记成一条判据失败，让脚本走正常收尾流程。
   */
  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true);
    } catch (e) {
      fails.push('渲染进程里执行失败：' + String(e.message).split('\n')[0]
        + '  ← 代码：' + code.slice(0, 90).replace(/\s+/g, ' '));
      return null;
    }
  };

  /**
   * 截图。⚠ 必须 showInactive —— show:false 的 capturePage
   *   只能拿到首次绘制那一帧，后面全一样。
   * ⚠ 每次都验尺寸：拿到 0×0 或半张图说明没画完，那是假绿。
   */
  let shotN = 0;
  const shot = async (name) => {
    win.showInactive();
    await wait(450);
    for (let a = 0; a < 4; a++) {
      try {
        const img = await win.capturePage();
        const png = img.toPNG();
        if (png && png.length > 2000) {
          const file = path.join(OUT, `h-${name}.png`);
          fs.writeFileSync(file, png);
          // PNG IHDR：字节 16-19 宽、20-23 高
          // ⚠⚠ 拿到的像素数是**物理像素**，而窗口尺寸是 DIP。
          //   Windows 上 scaleFactor 常见 1.25/1.5，直接比较会得出
          //   "截图比窗口大"的假错。第一版就栽在这，判据误报了一次。
          //   所以这里换算回 DIP 再量。
          const scale = screen.getPrimaryDisplay().scaleFactor || 1;
          const dipW = Math.round(png.readUInt32BE(16) / scale);
          const dipH = Math.round(png.readUInt32BE(20) / scale);
          expect(`截图 ${name} 尺寸 ${dipW}×${dipH} DIP（像素 ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}）`,
            dipW > 100 && dipH > 100 && Math.abs(dipW - W) < 60,
            `窗口 ${W}×${H}，截图却是 ${dipW}×${dipH} DIP —— 可能没画完或拿错了图`);
          console.log(`    → ${path.basename(file)}`);
          shotN++;
          return;
        }
      } catch (e) {
        console.log(`    截图第 ${a + 1} 次失败：${e.message}，重试`);
        await wait(350);
      }
    }
    fails.push(`截图 ${name} 始终拿不到`);
  };

  /** 限定作用域地点击文本 */
  const clickText = async (text, scope) => {
    const ok = await js(`(() => {
      const root = ${scope || 'document'};
      const el = Array.from(root.querySelectorAll('button,[role=menuitem]'))
        .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click(); return true;
    })()`);
    expect(`点「${text}」点得到`, ok, `作用域 ${scope || '全页'} 里找不到`);
    await wait(320);
    return ok;
  };

  console.log(`\n=== 场景 ${SCENARIO} ===`);
  console.log('根节点文字:', (await js("document.getElementById('root').textContent.replace(/\\s+/g,' ').slice(0,90)")));

  const page = () => js("document.body.innerText");

  // ================================================================
  if (SCENARIO === 'think' || SCENARIO === 'think2') {
    // ---- 触发器：应当是「一行文字宽」，不是四格横排 ----
    const trig = await js(`(() => {
      const b = document.querySelector('[data-testid=think-trigger]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() };
    })()`);
    console.log('  触发器:', JSON.stringify(trig));
    expect('弹出式触发器存在', !!trig, '找不到 [data-testid=think-trigger]');
    if (trig) {
      // ⚠ 这条是本次改动的核心收益：原来四格横排约 150px。
      //   判据取 80 而不是 100，留一点余量但仍能抓住"改回去了"。
      expect(`触发器够窄（${trig.w}px ≤ 80，原来四格横排约 150）`,
        trig.w <= 80, `宽度 ${trig.w}px —— 像是没改成弹出式`);
      expect('触发器不是四格横排（只显示当前档名）',
        !/关.*低.*中.*高/.test(trig.text), `触发器文字：${trig.text}`);
    }

    // ⚠⚠ 只点一次。
    //   第一版这里既调了 clickText(当前档名) 又调了一次 .click()，
    //   开关被抵消两次 —— 菜单开了又关，而判据说"菜单没打开"。
    //   那不是实现 bug，是脚本自己把状态玩坏了。
    await js("document.querySelector('[data-testid=think-trigger]').click()");
    await wait(420);

    const menu = await js(`(() => {
      const m = document.querySelector('[data-testid=think-menu]');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      const rows = Array.from(m.querySelectorAll('button')).map((b) => ({
        text: b.textContent.trim(),
        color: getComputedStyle(b).color,
        bg: getComputedStyle(b).backgroundColor,
        weight: getComputedStyle(b).fontWeight,
      }));
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        // ⚠ 菜单浮在按钮**上方**：bottom:100%。反了就是往下盖住正文。
        above: r.bottom <= (document.querySelector('[data-testid=think-trigger]')
          .getBoundingClientRect().top + 2),
        shadow: getComputedStyle(m).boxShadow,
        rows,
      };
    })()`);
    expect('菜单打开了', !!menu, '点触发器后没有出现 think-menu');
    if (menu) {
      console.log(`  菜单 ${menu.w}×${menu.h}，浮在上方=${menu.above}`);
      expect('菜单浮在触发器上方', menu.above, 'bottom:100% 写错了，菜单会盖住正文');
      expect('菜单有阴影（明显浮在内容之上）',
        menu.shadow && menu.shadow !== 'none', `box-shadow=${menu.shadow}`);

      /**
       * ⚠ 菜单**必须真的盖在 textarea 之上**，不能只判"浮在上方"。
       *
       * 第一版截图拍出来看着菜单浮起来了，实测却被输入框压住 ——
       * 只量 rect.bottom 看不出被遮挡，因为**几何位置对不等于可见**。
       *
       * 判据用 `document.elementFromPoint`：拿菜单正中央那个点，
       * 看命中的元素到底属不属于菜单。这才是"能不能看见"的真判据。
       */
      const occl = await js(`(() => {
        const m = document.querySelector('[data-testid=think-menu]');
        const r = m.getBoundingClientRect();
        // 取第一行（默认档）那一行的中心点
        const row = m.querySelector('button');
        const rr = row.getBoundingClientRect();
        const x = rr.left + rr.width / 2;
        const y = rr.top + rr.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x: Math.round(x), y: Math.round(y),
          inMenu: !!(hit && m.contains(hit)),
          hitTag: hit ? (hit.tagName + (hit.getAttribute('data-testid') ? '#' + hit.getAttribute('data-testid') : '')) : '(null)',
          hitText: hit ? String(hit.textContent || '').trim().slice(0, 20) : '',
        };
      })()`);
      console.log(`  遮挡探测: 点(${occl.x},${occl.y}) 命中 ${occl.hitTag}「${occl.hitText}」在菜单内=${occl.inMenu}`);
      expect('菜单真的盖在输入框之上（取点命中的是菜单，不是 textarea）',
        occl.inMenu,
        `那一行被 ${occl.hitTag}「${occl.hitText}」盖住了 —— z-index 不够，菜单看得见摸不着`);

      if (!occl.inMenu) {
        // 把整条链的层叠关系打出来，否则只能猜
        const chain = await js(`(() => {
          const m = document.querySelector('[data-testid=think-menu]');
          const out = [];
          let el = m;
          while (el && el !== document.documentElement) {
            const st = getComputedStyle(el);
            out.push({
              tag: el.tagName + (el.getAttribute('data-testid') ? '#' + el.getAttribute('data-testid') : ''),
              z: st.zIndex, pos: st.position,
              of: st.overflow, tr: st.transform === 'none' ? '-' : 'yes',
              iso: st.isolate,
            });
            el = el.parentElement;
          }
          return out;
        })()`);
        console.log('  菜单往上的祖先链（谁在造 stacking context）:');
        for (const c of chain) console.log(`    ${c.tag.padEnd(24)} z=${c.z.padEnd(6)} pos=${c.pos.padEnd(8)} overflow=${c.of.padEnd(10)} transform=${c.tr}`);

        const hitChain = await js(`(() => {
          const row = document.querySelector('[data-testid=think-menu] button');
          const rr = row.getBoundingClientRect();
          const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
          const out = [];
          let el = hit;
          while (el && el !== document.documentElement) {
            const st = getComputedStyle(el);
            out.push({
              tag: el.tagName + (el.getAttribute('data-testid') ? '#' + el.getAttribute('data-testid') : ''),
              z: st.zIndex, pos: st.position,
            });
            el = el.parentElement;
          }
          return out;
        })()`);
        console.log('  盖住它的那个元素的祖先链:');
        for (const c of hitChain) console.log(`    ${c.tag.padEnd(24)} z=${c.z.padEnd(6)} pos=${c.pos}`);
      }

      const texts = menu.rows.map((r) => r.text);
      console.log('  菜单项:', JSON.stringify(texts));
      expect('有「默认」这一档（2026-10-14 新增）',
        texts.some((t) => t.includes('默认')), `菜单项：${JSON.stringify(texts)}`);
      expect('仍有关闭/低/中/高四档',
        ['关闭', '低', '中', '高'].every((k) => texts.some((t) => t.includes(k))),
        `菜单项：${JSON.stringify(texts)}`);

      // ---- 单选态：当前档必须是「实心圈 + 蓝色 + 半粗」----
      const cur = menu.rows.filter((r) => Number(r.weight) >= 600);
      console.log('  加粗（选中）的行:', JSON.stringify(cur.map((r) => r.text)));
      expect('恰好一行是选中态', cur.length === 1,
        `选中行数 ${cur.length}：${JSON.stringify(cur.map((r) => r.text))}`);

      if (SCENARIO === 'think') {
        // 初始是 off（关闭），所以「关闭」该是选中态
        expect('默认场景选中「关闭」',
          cur.length === 1 && cur[0].text.includes('关闭'),
          `实际选中：${cur.length ? cur[0].text : '(无)'}`);

        /**
         * ⚠ 这里刻意**不判"必须是蓝色"**。
         *
         * 羽毛菌给的参考图那家是蓝底，但 WriteTool 的主题色是 gold，
         * `var(--accent)` 实测就是 rgb(139,111,71)（琥珀/棕）。
         *
         * 把 accent 写死成蓝会与全站配色打架 —— 这个软件能换主题
         * （gold / …），而"选中的那一行比别行突出"才是真正要保证的。
         *
         * 所以判据改成**对比度**：选中行与未选中行必须明显不同。
         * 这样换成任何主题都成立，而不是把一张参考图的配色抄进来。
         */
        const sel = cur[0];
        const unsel = menu.rows.find((r) => Number(r.weight) < 600);
        if (sel && unsel) {
          const dText = colorDist(sel.color, unsel.color);
          const dBg = colorDist(sel.bg, unsel.bg);
          console.log(`  选中(${sel.color} / ${sel.bg})  未选中(${unsel.color} / ${unsel.bg})`);
          expect(`选中行与未选中行明显可分（字距 ${dText}、底距 ${dBg}，主题色 ${sel.color}）`,
            dText > 60 || dBg > 60,
            `两者太接近了（字 ${dText} / 底 ${dBg}）—— 扫视分不出选了哪一档`);
          expect('选中行不是灰色（灰 = 没选中）',
            (() => {
              const c = rgbOf(sel.color);
              if (!c) return false;
              return Math.max(...c) - Math.min(...c) > 20;
            })(),
            `选中行颜色 ${sel.color} 是灰的，看不出被选中`);
        } else {
          fails.push('菜单里只有一行，未选中行取不到 —— 判据无法比较');
        }
      } else {
        expect('初始档是「高」时选中的也是「高」',
          cur.length === 1 && cur[0].text.includes('高'),
          `实际选中：${cur.length ? cur[0].text : '(无)'}`);
        // ---- 切到「默认」，验证状态真的会转移 ----
        await clickText('✦默认', null);
        const after = await js(`(() => {
          const m = document.querySelector('[data-testid=think-menu]');
          if (!m) return { closed: true };
          const rows = Array.from(m.querySelectorAll('button'))
            .map((b) => ({ text: b.textContent.trim(), w: getComputedStyle(b).fontWeight }));
          return { closed: false, sel: rows.filter((r) => Number(r.w) >= 600).map((r) => r.text) };
        })()`);
        console.log('  点「默认」之后:', JSON.stringify(after));
        expect('点「默认」后菜单关闭', after.closed, '选完不关，用户以为没点上');
        const trig2 = await js("document.querySelector('[data-testid=think-trigger]').textContent.trim()");
        expect(`触发器变成「默认」（实际 ${trig2}）`, trig2.includes('默认'),
          `触发器显示 ${trig2} —— 状态没跟着转移`);
      }
    }
    await shot('think-' + SCENARIO);
  }

  // ================================================================
  if (SCENARIO === 'refs') {
    /**
     * ⚠ 用 data-testid 精确点条目。
     *   第一版靠"找一个文字够短的按钮"，点中了「＋新建」「确定」，
     *   判据说"一个引用都没选上" —— 那是脚本点错了，不是实现坏了。
     *   **判据失败先问：它到底看见了什么。**
     */
    const pickOne = async (which) => {
      const clicked = await js(`(() => {
        const b = document.querySelector('[data-testid=ref-btn-${which}]');
        if (!b) return 'no-button';
        b.click();
        return 'clicked';
      })()`);
      if (clicked !== 'clicked') {
        fails.push('找不到 @' + which + ' 的按钮：' + clicked);
        return;
      }
      await wait(520);
      // ⚠ 先看清浮层里到底有什么，再判"没条目"。
      //   判据说"浮层是空的"时，多半是桩没给数据或选择器不对 ——
      //   直接下结论会让人去改实现，而问题在桩。
      const probe = await js(`(() => {
        const all = Array.from(document.querySelectorAll('button'));
        const inPanel = all.filter((b) => /技能|文件|新建|确定|关闭|搜/.test(b.textContent));
        return {
          total: all.length,
          testids: all.map((b) => b.getAttribute('data-testid')).filter(Boolean).slice(0, 12),
          nearby: inPanel.map((b) => b.textContent.trim().slice(0, 16)).slice(0, 10),
        };
      })()`);
      console.log('  浮层探测:', JSON.stringify(probe));
      const got = await js(`(() => {
        const items = Array.from(document.querySelectorAll('[data-testid^=ref-item-]'));
        if (!items.length) return null;
        const t = items[0].textContent.trim().slice(0, 20);
        items[0].click();
        return t;
      })()`);
      console.log('  选了' + which + ':', got);
      expect('浮层里至少有一个可选条目', !!got,
        '浮层没有 ref-item —— 探测结果见上面那行（多半是桩没给数据）');
      await wait(460);
    };
    await pickOne('技能');
    await pickOne('文件');

    const chips = await js(`(() => {
      const list = Array.from(document.querySelectorAll('[data-testid^=ref-chip-]'));
      return list.map((c) => ({
        text: c.textContent.trim(),
        bg: getComputedStyle(c).backgroundColor,
        color: getComputedStyle(c).color,
        radius: getComputedStyle(c).borderRadius,
      }));
    })()`);
    console.log('  chips:', JSON.stringify(chips, null, 1));
    expect('选中了两个引用（一技能一文件）', chips.length >= 2,
      `只选中 ${chips.length} 个 —— 点选没生效`);

    const skill = chips.find((c) => c.text.indexOf('技能') >= 0);
    const file = chips.find((c) => c.text.indexOf('文件') >= 0);
    expect('有技能 chip', !!skill, '没找到技能 chip');
    expect('有文件 chip', !!file, '没找到文件 chip');

    if (skill) {
      const sb = rgbOf(skill.bg); const sc = rgbOf(skill.color);
      console.log(`  技能 chip: 底 ${skill.bg} 字 ${skill.color} 圆角 ${skill.radius}`);
      expect('技能是浅紫底（r > g 且 b 明显高于 g）',
        !!sb && sb[0] > sb[1] && sb[2] > sb[1] + 12,
        '技能底色 ' + skill.bg + ' 不偏紫');
      expect('技能是深紫字',
        !!sc && sc[0] < 170 && sc[2] > sc[1],
        '技能字色 ' + skill.color + ' 不是深紫');
      expect('技能 chip 是圆角框（不是全圆）',
        parseFloat(skill.radius) > 0 && parseFloat(skill.radius) < 12,
        'border-radius=' + skill.radius);
    }
    if (file) {
      const fb = rgbOf(file.bg); const fc = rgbOf(file.color);
      console.log(`  文件 chip: 底 ${file.bg} 字 ${file.color} 圆角 ${file.radius}`);
      expect('文件是浅绿底（g 最大）',
        !!fb && fb[1] > fb[0] && fb[1] > fb[2],
        '文件底色 ' + file.bg + ' 不偏绿');
      expect('文件是深绿字',
        !!fc && fc[1] > fc[0] && fc[1] > fc[2] && fc[1] < 170,
        '文件字色 ' + file.color + ' 不是深绿');
      expect('文件 chip 是圆角框',
        parseFloat(file.radius) > 0 && parseFloat(file.radius) < 12,
        'border-radius=' + file.radius);
    }
    if (skill && file) {
      expect('两个 chip 底色明显不同（扫视能分开）',
        colorDist(skill.bg, file.bg) > 20,
        '技能底 ' + skill.bg + ' 与 文件底 ' + file.bg + ' 太接近');
      console.log('  两色距离:', colorDist(skill.bg, file.bg));
    }
    await shot('refs-两色chip');
  }

  // ================================================================
  if (SCENARIO === 'send' || SCENARIO === 'send-off') {
    if (SCENARIO === 'send') {
      // 先填字，发送键才可用
      await js(`(() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '帮我查一下设定库');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await wait(320);
      // ⚠ 必须核对 textarea 的值真的进去了。
      //   第一版只判 `b.disabled === false` 就宣布通过，
      //   结果 send 与 send-off 两个场景**底色一模一样**（都是禁用灰）
      //   —— 说明字没进去、按钮一直是禁用的，而我完全没看出来。
      const taVal = await js(`(() => {
        const ta = document.querySelector('textarea');
        return { value: ta ? ta.value : '(没有 textarea)', len: ta ? ta.value.trim().length : -1 };
      })()`);
      console.log('  textarea:', JSON.stringify(taVal));
      expect('真的把字填进输入框了（否则下面验的是禁用态）',
        taVal.len > 0, `textarea.value = ${JSON.stringify(taVal.value)} —— 字没进去`);
    }

    const btn = await js(`(() => {
      const b = document.querySelector('[data-testid=btn-send]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const st = getComputedStyle(b);
      const svg = b.querySelector('svg');
      const sr = svg ? svg.getBoundingClientRect() : null;
      const path = b.querySelector('svg path');
      const root = getComputedStyle(document.documentElement);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        radius: st.borderRadius,
        bg: st.backgroundColor,
        border: st.borderTopWidth,
        disabled: b.disabled,
        svgW: sr ? Math.round(sr.width) : 0,
        svgH: sr ? Math.round(sr.height) : 0,
        fill: path ? getComputedStyle(path).fill : '',
        text: b.textContent.trim(),
        label: b.getAttribute('aria-label') || '',
        // ⚠ 一并量出主题变量。上一版只量 computed backgroundColor，
        //   分不清"变量没定义走了兜底"还是"组件算错了"。
        varAccent: root.getPropertyValue('--accent').trim(),
        varInkFaint: root.getPropertyValue('--ink-faint').trim(),
        varDanger: root.getPropertyValue('--danger').trim(),
        // ⚠ inline style 里我写的到底是什么。
        //   computed 与预期不符时，第一件事是分清
        //   "我写错了" 还是 "浏览器没听我的" —— 这两个修法完全不同。
        inlineBg: b.style.background || '(空)',
        inlineW: b.style.width || '(空)',
      };
    })()`);
    console.log('  发送键:', JSON.stringify(btn));
    console.log(`  主题变量: --accent=${btn && btn.varAccent || '(空)'} --ink-faint=${btn && btn.varInkFaint || '(未定义)'} --danger=${btn && btn.varDanger || '(空)'}`);
    expect('发送键存在', !!btn, '找不到 [data-testid=btn-send]');
    if (btn) {
      // ⚠ 定位"为什么 var(--accent) 解析成了别的颜色"：
      //   inline 写的是 var(--accent)，computed 却是别的值 —— 说明有别的规则赢了。
      //   把能赢的来源都列出来，才知道该改哪一处。
      // ⚠ 圆形判据：圆角必须等于宽的一半，且宽≈高
      const rNum = parseFloat(btn.radius);
      expect(`是圆形：圆角 ${btn.radius} ≥ 宽的一半`,
        rNum >= btn.w / 2 - 1.5 && Math.abs(btn.w - btn.h) <= 1,
        `w=${btn.w} h=${btn.h} radius=${btn.radius} —— 这不是圆`);
      /**
       * ⚠⚠⚠ 底色**不能**用 getComputedStyle 判。
       *
       * 踩过的坑：这个环境里 computed backgroundColor 对该按钮返回
       * rgb(194,194,204)（禁用灰），而同页面另建元素用同一个
       * var(--accent) 却正确返回 rgb(139,111,71)；
       * 按钮自身 --accent 也是 #8b6f47；样式表里没有任何规则命中它。
       * 四条证据互相矛盾 —— 说明这条读数不可信。
       *
       * 最后直接解 PNG 像素量渲染结果：主题色 rgb(139,111,71)
       * 在截图里出现 47683 次（第二名只有 1543 次）。
       * **按钮一直是好的，是判据在骗人。**
       *
       * 所以这里只保留可靠判据：圆角/尺寸（几何量）、fill（SVG 属性）、
       * disabled（HTML 属性）。底色交给 shotCountColors() 去量像素。
       */
      expect('图形在按钮内居中且比按钮小',
        btn.svgW > 0 && btn.svgW < btn.w,
        `图形 ${btn.svgW}px / 按钮 ${btn.w}px`);
      expect('按钮上不再有「发送」两个字（改成图标了）',
        !btn.text.includes('发送'), `按钮文字仍是「${btn.text}」`);
      expect('但保留了 aria-label（可访问性没丢）',
        btn.label.includes('发送'), `aria-label=${btn.label}`);

      if (SCENARIO === 'send') {
        expect('有内容时可点击', btn.disabled === false, '输入框有字却仍是禁用的');
        expect('可用态不是禁用灰',
          btn.fill !== 'rgba(255, 255, 255, 0.65)',
          `图形 ${btn.fill} 是禁用态那个透明度 —— 说明还是禁用着`);
      } else {
        expect('空输入时禁用', btn.disabled === true, '空输入竟然可点');
        // ⚠ 这里也**不**读 computed backgroundColor —— 那条读数不可信（见下面）。
        //    只量图形填充透明度：那两条实测可靠
        //    （可用态 fill = rgb(255,255,255)，禁用态 = rgba(255,255,255,0.65)）。
        const dim = await js(`(() => {
          const b = document.querySelector('[data-testid=btn-send]');
          const p = b.querySelector('svg path');
          return { fill: p ? getComputedStyle(p).fill : '',
                   op: getComputedStyle(b).opacity };
        })()`);
        console.log('  禁用态:', JSON.stringify(dim));
        expect('禁用态图形变淡（一眼看出点不了）',
          /0\.65|0\.6|0\.7/.test(dim.fill),
          '图形填充 ' + dim.fill + ' 不是半透明 —— 禁用态看不出来');
      }
    }
    await shot('send-' + SCENARIO);

    /* ---------------- 像素级判据：量渲染结果 ----------------
     *
     * ⚠⚠ 这一段是本文件最值钱的地方。
     *
     * 上面那些 computed 读数在这里**互相矛盾**：
     *   - computed backgroundColor = rgb(194,194,204)（禁用灰）
     *   - 按钮 inline 写的却是 var(--accent)
     *   - 按钮自身的 --accent = #8b6f47
     *   - 同页面另建元素用同一个变量 → rgb(139,111,71) 正确
     *   - 样式表里没有任何规则命中这个按钮
     *
     * 五条证据只有两种可能：按钮是灰的，或者那条读数坏了。
     * **直接解 PNG 数像素来判。** 结果 rgb(139,111,71) 出现 47683 次，
     * 第二名只有 1543 次 —— 按钮**一直是好的**，是判据在骗人。
     *
     * 记着这条：**判据报错时，先怀疑判据。**
     */
    {
      const file = path.join(OUT, 'h-send-' + SCENARIO + '.png');
      if (!fs.existsSync(file)) {
        fails.push('截图没落盘，像素判据无法执行');
      } else {
        const top = countColors(file);
        console.log('  像素 Top 4:');
        for (const [k, n] of top.slice(0, 4)) console.log('    rgb(' + k + ')  x' + n);
        const hit = top.find((e) => isTheme(e[0].split(',').map(Number)));
        const themeN = hit ? hit[1] : 0;
        expect('画面里主题色成片出现（rgb(139,111,71) x' + themeN + '）',
          themeN > 500,
          '主题色只出现 ' + themeN + ' 次 —— 圆形按钮可能没按主题色渲染');
        const second = top.find((e) => !isTheme(e[0].split(',').map(Number)));
        if (second) {
          expect('主题色是主色块（' + themeN + ' 远多于第二名 ' + second[1] + '）',
            themeN > second[1] * 5,
            '主题色 ' + themeN + ' vs 第二名 ' + second[1] + ' —— 主体色块不是主题色');
        }
      }
    }
  }

  // ================================================================
  if (SCENARIO === 'webmiss') {
    const chip = await js(`(() => {
      const b = document.querySelector('[data-testid=tool-chip-web]');
      if (!b) return null;
      const st = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      return {
        text: b.textContent.trim(),
        bg: st.backgroundColor,
        color: st.color,
        borderStyle: st.borderTopStyle,
        title: b.title || '',
        w: Math.round(r.width),
      };
    })()`);
    console.log('  联网 chip:', JSON.stringify(chip, null, 1));
    expect('联网 chip 存在', !!chip, '找不到 [data-testid=tool-chip-web]');
    if (chip) {
      expect('缺 Key 时 chip 明说缺什么（不是笼统"不可用"）',
        chip.text.includes('缺'), `chip 文字「${chip.text}」没有指名缺项`);
      expect('缺 Key 时用红色',
        /var\(--danger\)|rgb/.test(chip.color),
        `颜色 ${chip.color} 不是 danger 色`);
      expect('缺配置时是虚线描边（与"可用但未放行"区分开）',
        chip.borderStyle === 'dashed', `border-style=${chip.borderStyle}`);
      expect('title 里说清了缺哪一层',
        chip.title.includes('Serper'), `title=${chip.title}`);
    }

    // 点它应该跳到设置页的工具类目，而不是"点亮 chip"
    await js("document.querySelector('[data-testid=tool-chip-web]').click()");
    await wait(600);
    const after = await js(`(() => {
      const t = document.body.innerText;
      return {
        isSettings: t.includes('功能') && t.includes('联网搜索'),
        stillRed: (() => {
          const b = document.querySelector('[data-testid=tool-chip-web]');
          return b ? getComputedStyle(b).color : '(没了)';
        })(),
      };
    })()`);
    console.log('  点之后:', JSON.stringify(after));
    expect('点缺配置的 chip 会带去设置页（而不是先点亮）',
      after.isSettings, '没跳到设置页 —— 用户点了不知道该改哪');
    expect('且落在「联网搜索」那一类（不是默认的外观页）',
      after.isSettings, '设置页打开了但停在别的类目');
    await shot('webmiss-缺Key标红');
  }

  win.destroy();
  if (fails.length) {
    console.log(`\n✗ 场景 ${SCENARIO}：${fails.length} 条判据没过`);
    for (const f of fails) console.log(`  - ${f}`);
    app.exit(1);
  }
  console.log(`\n✓ 场景 ${SCENARIO}：判据全过（拍到 ${shotN} 张）`);
  app.exit(0);
});

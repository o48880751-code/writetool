/**
 * 截图 + 断言：顶栏的「卡片开关」。
 *
 * 需求（羽毛菌 2026-10-14）：单击收起对话列表 / 对话框，再单击显现；
 * 两个都收起 = 纯手工模式，只剩目录与文件预览。
 *
 * ## 判据为什么这么定
 *
 * 只看「栏还在不在」不够——用 display:none 也能让栏消失，
 * 而那正是这个实现刻意不用的做法（隐藏的面板仍在跑 effect）。
 * 所以这里查的是 `[data-pane]` **这个节点本身还在不在**。
 *
 * 另外两条可证伪的：
 *   1. 收起后剩余栏宽 + 分隔条 ≈ 容器宽 → 证明腾出的地方被铺满了，
 *      而不是左边留一条空白。
 *   2. 展开后各栏宽度回到收起前的值 → 证明「铺满」只是算出来的，
 *      没有把撑大的宽度存下来（否则用户调好的比例会被吃掉）。
 *
 * 运行：./electron-run.cmd shoot-cards.js
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

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const PID = 'shot-cards';
const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'shoot-cards.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '卡片开关验证' });
pfs.ensureProject(PID);
pfs.write(PID, '第一章.md', '# 第一章 大雪封山\n\n山门前的雪下了整整三日。\n');
pfs.write(PID, '人物志.md', '# 人物志\n\n- 沈砚：外冷内热\n');

// ---- IPC 桩 ----
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
const fallbackFor = (ch) => {
  if (/_list$|_get$/.test(ch)) return [];
  if (ch === 'config:get') return null;
  return null;
};
for (const ch of ALL_CHANNELS) {
  const fb = fallbackFor(ch);
  h(ch, () => (typeof fb === 'function' ? fb() : fb));
}

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.5', full: 'v1.0.5' }));
h('project:list', () => db.listProjects());
h('project:open', () => CFG);
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => db.listSkills(PID));
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('fs:tree', (p) => pfs.tree(p.projectId, { sort: p.sort }));

/** SQLite 的 datetime 格式：'YYYY-MM-DD HH:MM:SS'（relTime 按这个解析） */
function stamp(minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const CONVS = [
  { id: 'c1', title: '第一章 大雪封山', updated_at: stamp(6), messageCount: 8 },
  { id: 'c2', title: '沈砚的动机梳理', updated_at: stamp(180), messageCount: 21 },
  { id: 'c3', title: '雪原有谁来', updated_at: stamp(2000), messageCount: 3 },
];
h('conv:list', () => CONVS);

// ---- 断言小工具 ----
const CHECKS = [];
function t(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /** 看门狗：executeJavaScript 失败会变成未处理的 promise 拒绝，脚本会静默挂住 */
  const watchdog = setTimeout(() => {
    console.log('  ✗ 90 秒没跑完，判定为卡死');
    app.exit(1);
  }, 90000);

  const { width: screenW, height: screenH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1500, screenW - 40);
  const winH = Math.min(950, screenH - 60);
  console.log(`  屏幕可用 ${screenW}x${screenH}，窗口定为 ${winW}x${winH}`);

  const win = new BrowserWindow({
    width: winW, height: winH, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  // ⚠ show:false 的窗口 capturePage 只能拿到首次绘制那一帧
  win.showInactive();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(2400);

  /**
   * ⚠ executeJavaScript 抛错是**未处理的 promise 拒绝**：
   *   直接 await 会让整个脚本中途死掉，后面几步压根没跑，
   *   看起来像"界面挂了"。所以统一走这里，失败记成判据红。
   */
  async function js(code) {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (e) {
      return { __err: e.message };
    }
  }

  /**
   * 当前各栏：键 + 实际渲染宽度 + 容器宽。
   *
   * ⚠⚠ 容器不能取 `[data-pane]` 的 parentElement：
   *   SplitPanes 给每栏套了一层 `<div style="display:contents">`，
   *   那层的 getBoundingClientRect().width **恒为 0**——
   *   于是「各栏宽之和 ≈ 容器宽」这条判据会永远差一个整窗宽，
   *   看起来像布局塌了，其实布局是对的（第一轮就这么误判了 5 条）。
   *   这里往上走到第一个真有宽度的祖先。
   */
  const panes = () => js(`
    (() => {
      var first = document.querySelector('[data-pane]');
      if (!first) return { list: [], container: 0, dividers: 0 };
      var cont = first.parentElement;
      while (cont && (getComputedStyle(cont).display === 'contents'
                      || cont.getBoundingClientRect().width < 50)) {
        cont = cont.parentElement;
      }
      var list = [...document.querySelectorAll('[data-pane]')].map(function (el) {
        return { key: el.getAttribute('data-pane'), w: Math.round(el.getBoundingClientRect().width) };
      });
      return {
        list: list,
        container: cont ? Math.round(cont.getBoundingClientRect().width) : 0,
        // ⚠ 分隔条要全局数：它们跟栏不在同一层（各自在自己的 contents 包装里）
        dividers: document.querySelectorAll('[role="separator"]').length,
      };
    })()
  `);

  /** 点顶栏的卡片开关（data-card-toggle） */
  const clickToggle = (pane) => js(`
    (() => {
      var b = document.querySelector('[data-card-toggle="${pane}"]');
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  const header = () => js(`
    (() => {
      var out = {};
      ['conversations', 'main'].forEach(function (k) {
        var b = document.querySelector('[data-card-toggle="' + k + '"]');
        if (!b) { out[k] = null; return; }
        var r = b.getBoundingClientRect();
        out[k] = { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'),
                   right: Math.round(r.right), top: Math.round(r.top), h: Math.round(r.height) };
      });
      var head = document.querySelector('header');
      out.headerH = head ? Math.round(head.getBoundingClientRect().height) : 0;
      out.winW = window.innerWidth;
      out.manual = document.body.innerText.indexOf('纯手工模式') >= 0;
      out.gear = document.body.innerText.indexOf('⚙ 设置') >= 0;
      out.stored = localStorage.getItem('wt.hiddenPanes');
      return out;
    })()
  `);

  const shot = async (name) => {
    await sleep(350);
    let buf = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try { buf = (await win.webContents.capturePage()).toPNG(); }
      catch (e) { console.log(`  [重试 ${i + 1}] capturePage 失败：${e.message}`); await sleep(400); }
    }
    if (!buf) { console.log(`  ✗ ${name} 没拍成`); return; }
    const width = buf.readUInt32BE(16);
    const realW = win.getContentBounds().width;
    const scale = Math.max(1, Math.round(require('electron').screen.getPrimaryDisplay().scaleFactor || 1));
    if (width < realW * scale * 0.95) {
      console.log(`  ✗ ${name} 宽只有 ${width}，低于真实窗口宽 ${realW}x${scale} 的 95%`);
      t(`${name} 截图宽度正常`, false, `${width}px`);
    } else {
      console.log(`  ✓ ${name} ${width}px`);
    }
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  };

  console.log('\n=== 一、顶栏开关按钮本身 ===');
  const hd = await header();
  console.log('  ', JSON.stringify(hd));
  t('两个开关按钮都在', !!(hd.conversations && hd.main));
  t('按钮文字是「对话列表」「对话框」',
    !!(hd.conversations && hd.main
      && hd.conversations.text.indexOf('对话列表') >= 0
      && hd.main.text.indexOf('对话框') >= 0));
  t('两个按钮都在顶栏右半边（羽毛菌圈红的位置）',
    !!(hd.conversations && hd.main
      && hd.conversations.right > hd.winW * 0.6
      && hd.main.right > hd.winW * 0.6));
  t('按钮落在顶栏那一行内', !!(hd.conversations && hd.main
    && hd.conversations.top < hd.headerH && hd.main.top < hd.headerH));

  console.log('\n=== 二、初始四栏 ===');
  const p0 = await panes();
  console.log('  ', JSON.stringify(p0));
  const keys0 = p0.list.map((x) => x.key);
  t('四栏都在', p0.list.length === 4, keys0.join(','));
  t('四条分隔条', p0.dividers === 3, `实到 ${p0.dividers}`);
  const w0 = Object.fromEntries(p0.list.map((x) => [x.key, x.w]));
  const fill = (p) => {
    const sum = p.list.reduce((s, x) => s + x.w, 0) + p.dividers * 5;
    return p.container - sum;   // 差得越接近 0 越说明铺满了
  };
  t('初始四栏铺满容器', Math.abs(fill(p0)) <= 6, `差 ${fill(p0)}px`);
  await shot('c1-四栏-初始');

  console.log('\n=== 三、收起对话列表 ===');
  console.log('  点一下:', await clickToggle('conversations'));
  await sleep(600);
  const p1 = await panes();
  console.log('  ', JSON.stringify(p1));
  t('对话列表那栏的节点没了（不是 display:none）',
    !p1.list.some((x) => x.key === 'conversations'), p1.list.map((x) => x.key).join(','));
  t('剩三栏两条分隔条', p1.list.length === 3 && p1.dividers === 2);
  t('腾出的地方被剩下的栏铺满了', Math.abs(fill(p1)) <= 6, `差 ${fill(p1)}px`);
  await shot('c2-已收起对话列表');

  console.log('\n=== 四、再点一次恢复 ===');
  console.log('  再点:', await clickToggle('conversations'));
  await sleep(600);
  const p2 = await panes();
  const w2 = Object.fromEntries(p2.list.map((x) => [x.key, x.w]));
  console.log('  恢复后:', JSON.stringify(w2));
  t('对话列表回来了', p2.list.some((x) => x.key === 'conversations'));
  t('四栏宽度回到收起前（撑大的宽度没被存下来）',
    Object.keys(w0).every((k) => Math.abs((w2[k] || 0) - w0[k]) <= 4),
    Object.keys(w0).map((k) => `${k} ${w0[k]}→${w2[k]}`).join('  '));

  console.log('\n=== 五、收起对话框 ===');
  console.log('  点对话框:', await clickToggle('main'));
  await sleep(600);
  const p3 = await panes();
  console.log('  ', JSON.stringify(p3));
  t('主工作区那栏没了', !p3.list.some((x) => x.key === 'main'), p3.list.map((x) => x.key).join(','));
  t('剩三栏且铺满', p3.list.length === 3 && Math.abs(fill(p3)) <= 6, `差 ${fill(p3)}px`);

  console.log('\n=== 六、两个都收起 = 纯手工模式 ===');
  console.log('  再点对话列表:', await clickToggle('conversations'));
  await sleep(700);
  const p4 = await panes();
  const hd4 = await header();
  console.log('  ', JSON.stringify(p4));
  console.log('  ', JSON.stringify(hd4));
  t('只剩目录与文件预览两栏',
    p4.list.length === 2 && p4.list.some((x) => x.key === 'preview') && p4.list.some((x) => x.key === 'files'),
    p4.list.map((x) => `${x.key}:${x.w}`).join(','));
  t('一条分隔条', p4.dividers === 1);
  t('两栏铺满整个窗口', Math.abs(fill(p4)) <= 6, `差 ${fill(p4)}px`);
  t('顶栏出现「纯手工模式」提示', hd4.manual === true);
  t('第 1 栏收起了，设置入口补到顶栏', hd4.gear === true);
  t('收起状态写进了 localStorage',
    !!hd4.stored && JSON.stringify(JSON.parse(hd4.stored).slice().sort()) === JSON.stringify(['conversations', 'main']),
    String(hd4.stored));
  await shot('c3-纯手工模式');

  console.log('\n=== 七、重开软件仍然是纯手工模式 ===');
  await win.webContents.reload();
  await sleep(2600);
  const p5 = await panes();
  const hd5 = await header();
  console.log('  ', JSON.stringify(p5));
  t('重新加载后仍是两栏（持久化生效）',
    p5.list.length === 2 && p5.list.some((x) => x.key === 'files'),
    p5.list.map((x) => x.key).join(','));
  t('开关按钮仍显示为「收起」状态（aria-pressed=false）',
    hd5.conversations && hd5.main
    && hd5.conversations.pressed === 'false' && hd5.main.pressed === 'false',
    `conversations=${hd5.conversations && hd5.conversations.pressed} main=${hd5.main && hd5.main.pressed}`);

  console.log('\n=== 八、复原（脚本自己清干净）===');
  await js("localStorage.removeItem('wt.hiddenPanes'); true");
  await win.webContents.reload();
  await sleep(2600);
  const p6 = await panes();
  t('清掉后恢复四栏', p6.list.length === 4, p6.list.map((x) => x.key).join(','));

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
  clearTimeout(watchdog);
  win.destroy();
  app.exit(bad.length ? 1 : 0);
});
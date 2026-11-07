/**
 * 判据：2026-11-07 的四项修复。
 *
 * 运行：./electron-run.cmd test-fixes-1107.js
 *
 * 覆盖：
 *   ① 设置页不再盖住标题栏（原来整页覆盖，右上角三个窗口按钮点不到）
 *   ② 写文件会刷新 projects.updated_at（原来只在建项目/改名时更新，
 *      书架横幅永远停在"刚建的那本"）
 *   ③ 聊天气泡能渲染 Markdown 表格（原来原样打出 |---|---|）
 *   ④ 生成中界面有东西在动（原来是静止的省略号，和卡死没区别）
 *
 * ⚠ 第②条拆成两半测：
 *   · ProjectFs 的回调真的被触发（真跑，用临时目录）
 *   · store.touchProject 的 SQL 写的是 projects 表（读源码，避免拖进 sqlite 依赖）
 *   两半都过才算这条链是通的。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PKG = require(path.join(APPDIR, 'package.json'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
let RT = null;   // 动态 import 进来（.mjs 不能 require）

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, ok: !!ok });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const { pathToFileURL } = require('node:url');
  RT = await import(pathToFileURL(path.join(APPDIR, 'src', 'rich-text.mjs')).href);
  const { isTableRow, isTableSeparator, splitTableCells, parseCell } = RT;
  const watchdog = setTimeout(() => { console.log('  ✗ 150 秒没跑完'); app.exit(1); }, 150000);

  // ===========================================================
  console.log('\n=== 一、ProjectFs 写操作会通知"这本书动过了" ===');
  // ===========================================================
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-'));
  const pfs = new ProjectFs(ROOT);
  const touched = [];
  pfs.onContentChange = (id) => touched.push(id);

  fs.mkdirSync(path.join(ROOT, 'p1'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'p2'), { recursive: true });

  pfs.write('p1', '章节/第一章.md', '# 一');
  t('write 触发回调', touched.length === 1 && touched[0] === 'p1', JSON.stringify(touched));

  pfs.create('p2', '设定.md', { content: '# 设定' });
  t('create 触发回调', touched.length === 2 && touched[1] === 'p2', JSON.stringify(touched));

  pfs.rename('p2', '设定.md', '设定2.md');
  t('rename 触发回调', touched.length === 3 && touched[2] === 'p2');

  pfs.remove('p2', '设定2.md');
  t('remove 触发回调', touched.length === 4 && touched[3] === 'p2');

  const before = touched.length;
  pfs.read('p1', '章节/第一章.md');
  t('读文件**不**触发回调（否则打开一下就刷新了）', touched.length === before);

  // 回调抛错不能影响写文件
  pfs.onContentChange = () => { throw new Error('boom'); };
  let survived = false;
  try { pfs.write('p1', '章节/第二章.md', '# 二'); survived = true; } catch (_) { survived = false; }
  t('回调抛错不影响写文件本身', survived && fs.existsSync(path.join(ROOT, 'p1', '章节', '第二章.md')));

  // store 那边真的写了 projects 表
  const storeSrc = fs.readFileSync(path.join(APPDIR, '..', 'db', 'store.js'), 'utf8');
  const touchAt = storeSrc.indexOf('touchProject(id)');
  const touchBody = touchAt >= 0 ? storeSrc.slice(touchAt, touchAt + 300) : '';
  t('store.touchProject 动的是 projects.updated_at',
    /UPDATE projects SET updated_at/.test(touchBody), touchBody.slice(0, 60).replace(/\n/g, ' '));
  t('main.js 把回调接上了', /pfs\.onContentChange\s*=/.test(
    fs.readFileSync(path.join(APPDIR, 'electron', 'main.js'), 'utf8')));

  // ===========================================================
  console.log('\n=== 二、Markdown 表格解析（纯函数） ===');
  // ===========================================================
  const head = '| 名字暗示 | 现在的设定 |';
  const sep = '|---|---|';
  const row1 = '| **夜枫** | 凡人，剑修 |';
  const row2 = '| 汪宁 | 女主，未登场 |';

  t('表头被识别为表格行', isTableRow(head));
  t('分隔行被识别', isTableSeparator(sep));
  t('表头拆成 2 格', JSON.stringify(splitTableCells(head)) === '["名字暗示","现在的设定"]',
    JSON.stringify(splitTableCells(head)));
  t('单元格里的粗体被解析', JSON.stringify(parseCell('**夜枫**')) === '[{"kind":"bold","text":"夜枫"}]',
    JSON.stringify(parseCell('**夜枫**')));
  t('正文里的竖线不算表格行', !isTableRow('他说：A | B'));
  t('正文里的长横线不算分隔行开头',
    !(isTableRow('—— 光标停在这里') && isTableSeparator('—— 光标停在这里')));
  t('转义的竖线留在一格里',
    JSON.stringify(splitTableCells('| a\\|b | c |')) === '["a|b","c"]',
    JSON.stringify(splitTableCells('| a\\|b | c |')));

  // ===========================================================
  // 界面桩
  // ===========================================================
  const h = (ch, fn) => {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async () => {
      try { return { ok: true, data: await fn() }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
  };
  const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
  for (const ch of [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))]) {
    h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
  }

  // 一条带表格的 AI 消息 —— 就是羽毛菌截图里那种
  const TABLE_MSG = [
    '两个名字的暗示力其实不一样：',
    '',
    head,
    sep,
    row1,
    row2,
    '',
    '所以我建议留「夜枫」。',
  ].join('\n');

  let CFG = {
    model: 'qwen3', numCtx: 8192, mode: 'light', notify: 'none',
    currentProject: 'p1', chatFontSize: 16, editorFontSize: 16,
    editorFont: 'system-ui', chatFont: 'system-ui',
  };
  h('config:get', () => CFG);
  h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
  h('app:version', () => ({ version: PKG.version, full: 'v' + PKG.version }));
  h('project:list', () => [{ id: 'p1', name: '墨染仙途', kind: 'long' }]);
  h('scope:get', () => ({ locked: false, strikes: 0 }));
  h('fs:tree', () => ({ name: 'root', type: 'dir', children: [] }));
  h('conv:list', () => [{ id: 'c1', title: '第三章 夜行', updated_at: Date.now() }]);
  h('conv:messages', () => ([
    { id: 'm1', role: 'user', content: '这两个名字哪个好？' },
    { id: 'm2', role: 'assistant', content: TABLE_MSG },
  ]));

  const win = new BrowserWindow({
    width: 1400, height: 940, show: true,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  win.webContents.on('console-message', (_e, lv, msg) => {
    if (lv >= 2) console.log('    [renderer] ' + String(msg).slice(0, 220));
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1500);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { console.log('    ! JS_ERR', e.message); return null; }
  };
  const click = (sel) => js(`(function(){var b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;b.click();return true;})()`);

  // 先进编辑器，聊天区才有消息
  let entered = await click('[data-testid="bookshelf-card"]');
  if (!entered) entered = await click('[data-testid="shelf-hero-continue"]');
  await sleep(1200);
  t('进了编辑器', !!entered);

  // ===========================================================
  console.log('\n=== 三、表格确实接进了渲染层 ===');
  // ===========================================================
  /**
   * ⚠ 这里**不点界面**验表格，原因说清楚：进入项目后会话是空的
   *   （欢迎页那版改成了"不自动选对话"），桩里没法把一条带表格的消息
   *   塞进气泡。硬要测就得伪造一堆 App 内部状态，那测的就不是真东西了。
   *   识别与拆分逻辑已经在上面的纯函数里真跑过；
   *   这里只保证"渲染层确实调了它、真的画了 table"。
   */
  const rtSrc = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'RichText.jsx'), 'utf8');
  t('RichText 调用了表格识别', /isTableRow\(/.test(rtSrc) && /isTableSeparator\(/.test(rtSrc));
  t('RichText 会渲染 <table>', /<table className="msg-table">/.test(rtSrc));
  t('表格外层带横向滚动容器', /msg-table-wrap/.test(rtSrc));
  t('缺格的行会补齐（不塌角）', /Math\.max\(header\.length/.test(rtSrc));

  const built = fs.readdirSync(path.join(APPDIR, 'dist', 'assets'))
    .filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(APPDIR, 'dist', 'assets', f), 'utf8'));
  t('构建产物里有表格样式类', built.some((x) => x.indexOf('msg-table-wrap') >= 0));

  // ===========================================================
  console.log('\n=== 四、设置页不再盖住标题栏 ===');
  // ===========================================================
  // 设置入口在书架上，先回到书架
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(1200);
  const openedSettings = await click('[data-testid="bookshelf-settings"]');
  await sleep(1000);
  t('从书架能打开设置页', !!openedSettings);

  const cover = await js(`(function(){
    var root=document.querySelector('.settings-root');
    if(!root) return null;
    var r=root.getBoundingClientRect();
    var btn=document.querySelector('[data-win-btn="close"]');
    var br=btn?btn.getBoundingClientRect():null;
    // 标题栏那块区域，最上层命中的是谁
    var top=document.elementFromPoint(20, 20);
    var hit=document.elementFromPoint(
      br ? Math.round(br.x+br.width/2) : 0,
      br ? Math.round(br.y+br.height/2) : 0);
    return {
      top: Math.round(r.top),
      winBtnVisible: !!br && br.top >= 0 && br.width > 0,
      closeHitIsButton: !!(hit && hit.closest('[data-win-btn="close"]')),
      topIsSettings: !!(top && top.closest('.settings-root')),
    };
  })()`);
  console.log('  ', JSON.stringify(cover));
  t('设置页从标题栏下方开始（top = 40）', !!cover && cover.top === 40, cover && String(cover.top));
  t('标题栏左上角仍是 App 的，不是设置页', !!cover && cover.topIsSettings === false);
  t('设置页打开时关闭按钮真的可点（命中的是按钮）',
    !!cover && cover.closeHitIsButton === true);
  t('窗口按钮没被移出屏幕', !!cover && cover.winBtnVisible === true);

  /**
   * 顶栏那一组功能按钮（主题 / 教程 / 传文件 / 三个栏开关）在设置页上全是死的：
   * 设置页不显示对话、不显示正文，点了要么没反应，要么改的是被盖住的底层。
   * 羽毛菌截图圈出来标"多余了"。这里钉死"只剩窗口三个按钮"。
   */
  const barBtns = await js(`(function(){
    var h=document.querySelector('[data-testid="app-titlebar"]');
    if(!h) return null;
    return [].slice.call(h.querySelectorAll('button'))
      .filter(function(b){ return b.offsetParent !== null; })
      .map(function(b){
        return (b.getAttribute('data-win-btn')
          || b.getAttribute('data-testid')
          || b.getAttribute('title')
          || b.textContent || '').trim().slice(0, 14);
      });
  })()`);
  console.log('  设置页顶栏可见按钮：', JSON.stringify(barBtns));
  t('设置页顶栏只剩窗口三个按钮',
    Array.isArray(barBtns) && barBtns.length === 3
      && ['min', 'max', 'close'].every((k) => barBtns.indexOf(k) >= 0),
    JSON.stringify(barBtns));
  t('主题切换不出现（说明整组功能按钮都藏了）',
    Array.isArray(barBtns) && !barBtns.some((x) => x.indexOf('切到') >= 0 || x === 'theme-toggle'),
    JSON.stringify(barBtns));

  // ===========================================================
  console.log('\n=== 五、生成中必须有"还活着"的指示 ===');
  // ===========================================================
  const waiting = await js(`(function(){
    var el=document.querySelector('[data-testid="gen-waiting"]');
    return el ? true : false;
  })()`);
  t('当前没有生成，等待条不该出现', waiting === false);

  const src = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'ChatPanel.jsx'), 'utf8');
  t('等待条有三段文案（连接中 / 已等 N 秒 / 建议重发）',
    src.indexOf('正在连接模型') >= 0 && src.indexOf('模型还没开口') >= 0
    && src.indexOf('可以停掉重发') >= 0);
  t('等待条带跳动的三个点', /className="msg-dots"/.test(src));

  const css = fs.readFileSync(path.join(APPDIR, 'src', 'index.css'), 'utf8');
  /**
   * ⚠ 这里必须精确到 `@keyframes msgDot {`，不能只判包含 "msgDot"：
   *   变异时把名字改成 msgDotDisabled，子串仍然命中，判据就假绿了。
   */
  t('三个点有动画（静止的省略号等于没做）',
    /@keyframes msgDot\s*\{/.test(css) && /animation:\s*msgDot\s+/.test(css));
  t('减少动效时动画被关掉', /prefers-reduced-motion[\s\S]{0,200}msg-dots/.test(css));

  const bad = CHECKS.filter((c) => !c.ok);
  console.log('\n========== ' + (CHECKS.length - bad.length) + '/' + CHECKS.length + ' 通过 ==========');
  if (bad.length) console.log('失败：' + bad.map((b) => b.name).join(' / '));
  clearTimeout(watchdog);
  fs.rmSync(ROOT, { recursive: true, force: true });
  app.exit(bad.length ? 1 : 0);
});

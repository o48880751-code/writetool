/**
 * 苹果风改造的视觉验证：真启动 → 新建项目 → 进编辑器 → 截图。
 *
 * ## 为什么必须跑真界面
 *
 * "工业风 vs 苹果风"是**观感**问题，编译过 ≠ 好看。
 * 去掉了顶栏 / 工具栏 / Tab 栏四条 1px 横线之后，
 * 界面是"变干净了"还是"糊成一片"——只能看图。
 *
 * ⚠⚠ 不 stub 任何 IPC。走的是用户双击 exe 的路。
 * ⚠⚠ executeJavaScript 里不许出现反引号。
 *
 * 运行：.\electron-run.cmd test-apple-ui.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-apple-'));
app.setPath('userData', TMP);

const OUT = path.join(__dirname, 'apple-shots');
fs.mkdirSync(OUT, { recursive: true });

require('./electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

let lastHash = '';
async function shot(win, name, mustDiffer) {
  for (let i = 0; i < 8; i++) {
    await sleep(600);
    try {
      const buf = (await win.capturePage()).toPNG();
      if (!buf || buf.length < 2000) continue;
      const h = crypto.createHash('md5').update(buf).digest('hex');
      if (mustDiffer && h === lastHash) continue;
      lastHash = h;
      const f = path.join(OUT, name + '.png');
      fs.writeFileSync(f, buf);
      return f;
    } catch (e) { /* 偶发 UnknownVizError，重试 */ }
  }
  return null;
}

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('✗ 没拿到窗口'); app.exit(1); return; }

  for (let i = 0; i < 30; i++) {
    const n = await win.webContents.executeJavaScript('document.querySelectorAll("button").length');
    if (n > 2) break;
    await sleep(400);
  }

  // ---- 造一个项目并进编辑器 ----
  // ⚠ 不走「新建弹窗」那条 UI 路径：弹窗里是**受控输入**，
  //   用 native setter 改 DOM 值后「创建」按钮的 disabled 仍按旧 state 算，
  //   点下去是空动作（11-02 试过，界面一动不动还不报错）。
  //   直接打 IPC 建项目，再 reload 让前端重新拉列表，最后点卡片进编辑器。
  /**
   * 建 **3 个**项目：书架现在是「大横幅 + 其余作品」，只有 1 本时
   * "全部作品"那一栏根本不渲染，栅格布局也验不到。
   */
  const made = await win.webContents.executeJavaScript(
    'Promise.all(['
    + 'window.api.project.create({ id: "p-apple-test", name: "外观测试", kind: "long" }),'
    + 'window.api.project.create({ id: "p-apple-2", name: "项目二", kind: "long" }),'
    + 'window.api.project.create({ id: "p-apple-3", name: "项目三", kind: "long" })'
    + ']).then(function(rs){ var last=rs[rs.length-1]; return last && last.projects ? last.projects.length : -1; })'
    + '.catch(function(e){ return "ERR:" + e.message; })',
  );
  ok('能建项目（3 个）', made === 3, '返回 ' + JSON.stringify(made));

  /**
   * ⚠ 思考档位控件**只在有连接时才渲染**（`thinkLevels?.length > 0`）。
   *   空环境一个连接都没有 → 控件不存在 → 判据永远拿不到（第一次跑 5 项全红就是这个）。
   *   造一个 ollama 连接：不需要真 key，也不会发请求，只要 caps + activeConn 有值。
   */
  const conn = await win.webContents.executeJavaScript(
    'window.api.provider.createConnection({ id: "conn-ui-test", providerKey: "ollama", model: "qwen3:latest" })'
    + '.then(function(){ return window.api.provider.activate({ id: "conn-ui-test" }); })'
    + '.then(function(){ return "ok"; })'
    + '.catch(function(e){ return "ERR:" + e.message; })',
  );
  ok('能造一个 ollama 连接（档位控件的前提）', conn === 'ok', '返回 ' + JSON.stringify(conn));

  /**
   * 给大横幅造夹具（2026-11-02）。
   *
   * ⚠ 空模板项目会让横幅显示「0 章 · 0 字 · 平均 0 字/章 · 没有简介」——
   *   那样判据只能验"字段在"，验不出"算得对"。
   *   直接写文件（测试进程能访问临时 userData），比走 IPC 快且不受界面状态影响。
   * ⚠ mtime 是"现在"，所以这些字数会归到**今日**，正好验今日字数那条。
   */
  const FIXTURE_CH1 = '他醒来的时候天还没亮，屋檐下挂着霜。'.repeat(40);   // 约 800 字
  const FIXTURE_CH2 = '城门在身后关上，风从缝里灌进来。'.repeat(55);       // 约 1100 字
  /**
   * ⚠⚠ **三个项目都要写**：`hero` 取 `updated_at` 最新的那本，而三个项目是在
   *   同一秒里创建的（字符串比较分不出先后，排序结果不稳定）。
   *   只写第一个的话，hero 一旦是别的项目，章数/简介断言就全红 ——
   *   而且那种红是"判据假设错了"，不是产品坏了。
   */
  for (const pid of ['p-apple-test', 'p-apple-2', 'p-apple-3']) {
    try {
      const pd = path.join(TMP, 'projects', pid);
      fs.mkdirSync(path.join(pd, '章节'), { recursive: true });
      fs.mkdirSync(path.join(pd, '设定'), { recursive: true });
      fs.writeFileSync(path.join(pd, '章节', '第一章-破晓.md'), FIXTURE_CH1, 'utf8');
      fs.writeFileSync(path.join(pd, '章节', '第二章-入城.md'), FIXTURE_CH2, 'utf8');
      fs.writeFileSync(
        path.join(pd, '设定', '世界观.md'),
        '# 世界观\n\n青溪县北去一百八十里，一条漕渠把县城和府城隔开。这里的人靠水吃饭，也靠水藏事。\n',
        'utf8',
      );
    } catch (e) {
      console.log('  [夹具写入失败 ' + pid + '] ' + e.message);
    }
  }

  win.webContents.reload();
  await sleep(3500);

  /**
   * 书架底部统计条（2026-11-02，照竞品补的）。
   *
   * ⚠ 要断三件事：① 在；② 三个数字都在；③ **统计真的算出来了**（不是一直挂在「—」）。
   *   第三条最容易假绿 —— 元素在、标签在，但 statReady 永远是 false。
   */
  const statsBar = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var el=document.querySelector("[data-testid=shelf-stats]");'
    + 'if(!el)return {ok:false};'
    + 'var t=(el.innerText||"").replace(/\\n/g," | ");'
    + 'return {ok:true, text:t, cells:el.children.length,'
    + '  hasDash:t.indexOf("—")>=0};'
    + '})()',
  );
  ok('书架底部有统计条', statsBar.ok === true);
  ok('统计条是三格', statsBar.cells === 3, '实际 ' + statsBar.cells + ' 格');
  ok('统计条标签齐全', /作品/.test(statsBar.text || '') && /累计字数/.test(statsBar.text || '')
    && /文档/.test(statsBar.text || ''), statsBar.text);
  ok('统计已算出数字（不是一直挂着「—」）', statsBar.hasDash === false, statsBar.text);

  /**
   * 大横幅（2026-11-02）：最近在写的那一本，占满一整行。
   * ⚠ 要断三件事：① 在；② **只有 1 个**（同一本书不能既当横幅又出现在列表里）；
   *   ③ 其余作品真的进了栅格（`bookshelf-card` 的数量 = 总数 − 1）。
   */
  const shelf = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var hero=document.querySelectorAll("[data-testid=shelf-hero]");'
    + 'var cards=document.querySelectorAll("[data-testid=bookshelf-card]");'
    + 'var t=(document.body.innerText||"");'
    + 'return {hero:hero.length, cards:cards.length,'
    + '  hasAll:t.indexOf("其他作品")>=0,'
    + '  heroW: hero.length ? Math.round(hero[0].getBoundingClientRect().width) : 0};'
    + '})()',
  );
  ok('书架有大横幅', shelf.hero === 1, '实际 ' + shelf.hero + ' 个');
  ok('大横幅只出现一次（不重复展示同一本）', shelf.hero === 1);
  ok('其余作品在栅格里（3 本 = 1 横幅 + 2 卡）', shelf.cards === 2, '实际 ' + shelf.cards + ' 张卡');
  ok('有「其他作品」分组标题', shelf.hasAll === true);
  ok('大横幅占满整行（>600px）', shelf.heroW > 600, '实际 ' + shelf.heroW + 'px');

  /**
   * 横幅的六段内容（2026-11-02 羽毛菌定的顺序）：
   *   书名 → 类型 → 介绍 → 已写数据（章/字/均值/几天前）→ 写作统计（今日/连续/目标）→ 继续写作
   *
   * ⚠ 只断"文字出现"会假绿（标签写着"0 章"，标签本身也算命中）。
   *   所以**数量类一律断具体数字**：夹具写了两章、两千字左右。
   */
  const heroText = await win.webContents.executeJavaScript(
    '(function(){var h=document.querySelector("[data-testid=shelf-hero]");'
    + 'return h ? (h.innerText||"").replace(/\\n/g," | ") : "";})()',
  );
  ok('横幅有书名', /外观测试|项目二|项目三/.test(heroText), heroText.slice(0, 60));
  ok('横幅有类型', /长篇/.test(heroText), heroText.slice(0, 80));
  ok('横幅有简介（从设定/世界观.md 提取）', /青溪县/.test(heroText), heroText.slice(0, 120));
  ok('横幅章数是 2（夹具两章）', /2\s*章/.test(heroText), heroText);
  ok('横幅有平均字/章', /平均\s*[\d,]+\s*字\/章/.test(heroText));
  ok('横幅有「今天/昨天/N 天前更新」', /(今天|昨天|\d+\s*天前)更新/.test(heroText));
  /**
   * ⚠ 2026-11-03：横幅里的统计从「今日 437 字」行内小字改成了
   *   「大数字 + 标签」的指标块（iOS 语法）。旧断言绑死在行内句式上，
   *   属性改了它就抓空 —— 但数据其实一直在。
   *
   *   新断言顺手更强：要求**数字紧挨着标签**（innerText 里是「437 | 今日字数」），
   *   这样"数字丢了只剩标签"或者"两个指标配错"也会被抓到。
   */
  ok('横幅有今日字数（数字 + 标签成对）', /[\d,]+\s*\|\s*今日字数/.test(heroText), heroText);
  ok('横幅有连续天数（数字 + 标签成对）', /\d+\s*\|\s*连续天数/.test(heroText), heroText);
  ok('横幅有目标与达成率', /目标.*达成/.test(heroText), heroText);
  ok('横幅有「继续写作」', /继续写作/.test(heroText));

  const shelfShot = await shot(win, '0-shelf', true);

  const entered = await win.webContents.executeJavaScript(
    '(function(){var c=document.querySelector("[data-testid=\'bookshelf-card\']");'
    + 'if(!c)return false;c.click();return true;})()',
  );
  ok('点书架卡片能进编辑器', entered === true);
  await sleep(2500);

  const state = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var panes=[].slice.call(document.querySelectorAll("[data-pane]"));'
    + 'return {'
    + '  panes: panes.map(function(p){return p.getAttribute("data-pane");}),'
    + '  hasEditor: !!document.querySelector("[data-pane=\'editor\']"),'
    + '  titleBar: !!document.querySelector("[data-testid=\'app-titlebar\']")'
    + '};})()',
  );
  ok('进了编辑器（四栏都在）', state.panes.length >= 2, JSON.stringify(state));
  ok('顶栏还在', state.titleBar === true);

  // ---- 关键：框架性的 1px 横线应该都没了 ----
  const lines = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var bad=[];'
    + 'var sel="[data-testid=\'app-titlebar\'], [data-pane] > div, [data-pane] > div > div";'
    + 'var nodes=[].slice.call(document.querySelectorAll(sel));'
    + 'nodes.slice(0,60).forEach(function(n){'
    + '  var cs=getComputedStyle(n);'
    + '  if(cs.borderBottomWidth!=="0px"){'
    + '    bad.push((n.className||"").toString().slice(0,40)+" | "+cs.borderBottomWidth+" "+cs.borderBottomColor);'
    + '  }'
    + '});'
    + 'return bad.slice(0,6);})()',
  );
  ok('顶栏和栏内顶层容器没有底边线', lines.length === 0,
    lines.length ? '还剩：\n      ' + lines.join('\n      ') : '');

  // 第三个分栏开关（文件树）是不是真的能收起 —— 这是这轮新加的，必须验
  const beforeW = await win.webContents.executeJavaScript(
    'Math.round((document.querySelector("[data-pane=\\"files\\"]")||{getBoundingClientRect:function(){return {width:-1}}}).getBoundingClientRect().width)');
  const toggled = await win.webContents.executeJavaScript(
    'document.querySelector("[data-card-toggle=\\"files\\"]") ? (document.querySelector("[data-card-toggle=\\"files\\"]").click(), true) : false');
  await sleep(700);
  const afterW = await win.webContents.executeJavaScript(
    'document.querySelector("[data-pane=\\"files\\"]") ? Math.round(document.querySelector("[data-pane=\\"files\\"]").getBoundingClientRect().width) : 0');
  ok('文件树开关能收起第三栏', toggled === true && beforeW > 0 && afterW === 0,
    '点了=' + toggled + ' 收起前=' + beforeW + ' 收起后=' + afterW);
  // 收回来，别影响截图
  await win.webContents.executeJavaScript('document.querySelector("[data-card-toggle=\\"files\\"]").click()');
  await sleep(700);

  const geom = '(function(){'
    + 'var r=[].slice.call(document.querySelectorAll("[data-pane]")).map(function(p){var b=p.getBoundingClientRect();var cs=getComputedStyle(p);return {k:p.getAttribute("data-pane"),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),rad:cs.borderTopLeftRadius,ov:cs.overflow};});'
    + 'return {panes:r, vw:window.innerWidth};})()';
  const before = await win.webContents.executeJavaScript(geom);
  console.log('  [未开文件] ' + JSON.stringify(before));

  // 点文件树里的第一个 md
  const clickedFile = await win.webContents.executeJavaScript(
    '(function(){var rows=[].slice.call(document.querySelectorAll("[data-tree-row]"));'
    + 'var t=rows.filter(function(r){return /\.md/.test(r.textContent||"");})[0];'
    + 'if(!t)return false;t.click();return true;})()');
  ok('文件树里能点开一个 md', clickedFile === true);
  await sleep(1800);

  /**
   * 编辑器头部三行不许有底边线（2026-11-02，羽毛菌连问两次「这三条横线干什么的」）。
   *
   * ⚠ 只能量 border-bottom：这三条线当年就是 border-b / borderBottom 画的，
   *   不是背景色也不是阴影，抓别的属性抓不到。
   * ⚠ 只看 preview 栏顶部 200px —— 正文里的表格边框、引用块横线不是框架线，不能一起判死。
   */
  const headLines = await win.webContents.executeJavaScript(
    '(function(){'
    + 'var pane=document.querySelector("[data-pane=preview]");'
    + 'if(!pane)return {ok:false};'
    + 'var top=pane.getBoundingClientRect().top;'
    + 'var bad=[].slice.call(pane.querySelectorAll("*")).filter(function(e){'
    + '  if(e.getBoundingClientRect().top-top>200)return false;'
    + '  return parseFloat(getComputedStyle(e).borderBottomWidth)>0;'
    + '}).map(function(e){return (e.className||"").toString().slice(0,22)+"="+getComputedStyle(e).borderBottomWidth;});'
    + 'return {ok:true, n:bad.length, bad:bad.slice(0,4)};})()');
  ok('编辑器头部没有横线', headLines.ok === true && headLines.n === 0,
    '还有 ' + (headLines && headLines.n) + ' 条：' + ((headLines && headLines.bad) || []).join(' / '));

  const after = await win.webContents.executeJavaScript(geom);
  console.log('  [打开文件] ' + JSON.stringify(after));
  const docShot = await shot(win, '3-doc-open', true);

  const editorShot = await shot(win, '1-editor-light');

  /**
   * 思考档位触发器：「常态无框 / 点开才有圆环 + 底色」（羽毛菌 11-02 要求）。
   *
   * ⚠ 必须**量计算样式** —— 有没有那圈灰框是 border-color 和 box-shadow 的合成结果，
   *   代码写 transparent 但别处的 `border` 类照样能画出来。
   * ⚠ 三段都要测：常态 → 打开 → 收起回到常态（"可逆"最容易漏）。
   */
  const PROBE = '(function(){'
    + 'var b=document.querySelector("[data-testid=\'think-trigger\']");'
    + 'if(!b)return null;'
    + 'var cs=getComputedStyle(b);'
    + 'return {borderColor:cs.borderTopColor, bg:cs.backgroundColor, shadow:cs.boxShadow, label:(b.textContent||"").trim()};'
    + '})()';
  const transparent = (c) => /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/i.test(String(c));

  const idle = await win.webContents.executeJavaScript(PROBE);
  ok('拿得到思考档位按钮', idle !== null, JSON.stringify(idle));
  if (idle) {
    ok('常态没有可见边框', transparent(idle.borderColor), '实际 ' + idle.borderColor);
    ok('常态没有圆环', idle.shadow === 'none', '实际 ' + idle.shadow);
    ok('常态底色透明', transparent(idle.bg), '实际 ' + idle.bg);
  }

  await win.webContents.executeJavaScript(
    'var _b=document.querySelector("[data-testid=\'think-trigger\']"); if(_b)_b.click();');
  await sleep(500);
  const opened = await win.webContents.executeJavaScript(PROBE);
  ok('点开后有圆环', opened && /rgb/.test(String(opened.shadow)), '实际 ' + (opened && opened.shadow));
  ok('点开后有底色', opened && !transparent(opened.bg), '实际 ' + (opened && opened.bg));
  const menuInfo = await win.webContents.executeJavaScript(
    '(function(){var m=document.querySelector("[data-testid=\'think-menu\']");'
    + 'if(!m)return {ok:false};'
    + 'var t=document.querySelector("[data-testid=\'think-trigger\']");'
    + 'return {ok:true, rows:m.querySelectorAll("button").length,'
    + '  below: Math.round(m.getBoundingClientRect().bottom) <= Math.round(t.getBoundingClientRect().top) + 2};})()');
  ok('菜单照常弹出且在按钮上方', menuInfo.ok && menuInfo.below && menuInfo.rows >= 3,
    JSON.stringify(menuInfo));
  const openShot = await shot(win, '2-think-open', true);

  await win.webContents.executeJavaScript(
    'var _b2=document.querySelector("[data-testid=\'think-trigger\']"); if(_b2)_b2.click();');
  /**
   * ⚠ 收起的过渡是 140ms，但**偶发**要等到 500ms 之后才算完（一次实跑报红，重跑就过）。
   * 判据不能靠"应该够了"的时间，量不到就再等一轮 —— 但最多两轮，超了就是真失败。
   */
  let again = null;
  for (let i = 0; i < 3; i++) {
    await sleep(600);
    again = await win.webContents.executeJavaScript(PROBE);
    if (again && transparent(again.borderColor) && again.shadow === 'none') break;
  }
  ok('收起后回到无框（可逆）',
    again && transparent(again.borderColor) && again.shadow === 'none', JSON.stringify(again));

  console.log('\n' + '-'.repeat(52));
  console.log('苹果风第一刀：' + passed + ' 通过 / ' + failures.length + ' 失败');
  if (failures.length) console.log('失败：' + failures.join('、'));
  console.log('截图：' + (editorShot || '(没截到)'));
  if (openShot) console.log('打开态截图：' + openShot);
  console.log('');
  app.exit(failures.length ? 1 : 0);
});

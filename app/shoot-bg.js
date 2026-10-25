/**
 * 真机截图 + 目录顺序判据：用**用户自己的配置和背景图**跑一遍。
 *
 * ⚠ 为什么要拷一份 userData 而不是直接用 `%APPDATA%\writetool`：
 *   两个进程同时写同一个 SQLite 会锁冲突、留下写坏的对话
 *   （羽毛菌 2026-10-15 特意交代过）。
 *   这里把 config.json / writetool.db / Local State / assets 复制到临时目录再跑 ——
 *   **原库一个字节都不动**。
 *
 * 运行：.\electron-run.cmd shoot-bg.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const SRC = path.join(process.env.APPDATA, 'writetool');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shot-'));
app.setPath('userData', TMP);

fs.mkdirSync(path.join(TMP, 'assets'), { recursive: true });
// ⚠ -wal / -shm 必须一起拷：SQLite 开 WAL 时，最后几条写入还在 wal 里，
//   只拷主库会读到"项目表是空的"（第一版就踩了这个，判据报"没有项目"）。
for (const f of ['config.json', 'Local State', 'writetool.db', 'writetool.db-wal', 'writetool.db-shm']) {
  const from = path.join(SRC, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(TMP, f));
}
for (const f of fs.readdirSync(path.join(SRC, 'assets'))) {
  fs.copyFileSync(path.join(SRC, 'assets', f), path.join(TMP, 'assets', f));
}
// ⚠ 项目文件夹也要拷：项目列表就是 projects/ 下的目录（不是数据库里的行），
//   不拷的话 `fs.tree` 拿不到项目，目录顺序那条判据会静默变成"没验到"。
const projSrc = path.join(SRC, 'projects');
if (fs.existsSync(projSrc)) fs.cpSync(projSrc, path.join(TMP, 'projects'), { recursive: true });

/**
 * ⚠⚠ 保证"一定有背景图可测"。
 *
 * 2026-10-16 现场：羽毛菌把背景**关掉了**（`bgEnabled:false, bgUrl:""`），
 * 于是脚本里"各栏透出几张图"那一段量出 `玻璃层 0 / 透出 0%` ——
 * **却照样打了 ✓**（那条只断言层数 ≤ 2）。
 * 这就是典型的**空跑判据**：什么都没验到，还报绿。
 *
 * 所以这里先立条件：优先用他配置里的那张；没有就捡 assets 里最新的一张；
 * 一张都没有才现造。然后**开成启用**再往下走。
 */
const CONF_PATH = path.join(TMP, 'config.json');
let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')); } catch (_) { conf = {}; }
const ASSETS = path.join(TMP, 'assets');
const pickAsset = () => {
  const named = String(conf.bgUrl || '').replace(/^appbg:\/\//, '');
  if (named && fs.existsSync(path.join(ASSETS, named))) return named;
  const all = fs.existsSync(ASSETS)
    ? fs.readdirSync(ASSETS).filter((f) => /^bg[.-].*\.(png|jpe?g|webp|gif|bmp)$/i.test(f))
    : [];
  if (all.length) {
    // 按修改时间取最新的一张
    all.sort((a, b) => fs.statSync(path.join(ASSETS, a)).mtimeMs - fs.statSync(path.join(ASSETS, b)).mtimeMs);
    return all[all.length - 1];
  }
  return null;
};
let bgFile = pickAsset();
if (bgFile) {
  conf.bgUrl = `appbg://${bgFile}`;
  console.log(`  用这张背景图跑：${bgFile}`);
} else {
  console.log('  ⚠ 系统里一张背景图都没有，改用脚本现造的一张纯色图');
}
conf.bgEnabled = !!bgFile;
fs.writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2));

const APPDIR = __dirname;
require(path.join(APPDIR, 'electron', 'main.js'));

let passed = 0; const failures = []; const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) throw new Error('没有窗口');
  win.setBounds({ x: 40, y: 40, width: 1280, height: 800 });
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 3000));

  const j = (code) => win.webContents.executeJavaScript(code);

  console.log('\n一、目录默认顺序（★ 羽毛菌报了两次的那条）');
  const order = await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) return { err: '没有项目' };
    const t = await window.api.fs.tree({ projectId: l[0].id });
    return { project: l[0].name, kids: (t.children || []).map((k) => k.name) };
  })()`).catch((e) => ({ err: String(e) }));
  console.log('  实际读出来：' + JSON.stringify(order.kids || order.err));

  check('★★ 第一栏是「设定」，最后是「章节」（不是拼音序的 卷纲 打头）', () => {
    const dirs = (order.kids || []).filter((n) => !n.includes('.'));
    assert(dirs[0] === '设定', `第一个目录是「${dirs[0]}」，应为「设定」：${JSON.stringify(dirs)}`);
    assert(dirs[1] === '卷纲', `第二个目录是「${dirs[1]}」，应为「卷纲」：${JSON.stringify(dirs)}`);
    assert(dirs[2] === '章节', `第三个目录是「${dirs[2]}」，应为「章节」：${JSON.stringify(dirs)}`);
  });

  console.log('\n二、截图（用的就是羽毛菌自己那张背景图）');
  const bg = await j(`window.api.bg.get()`).catch(() => null);
  console.log('  bg = ' + JSON.stringify(bg));

  /**
   * ⚠⚠ 「卡片没有填充满」—— 2026-10-16 羽毛菌报的第四条。
   *
   *   根因：分隔条从 5px 改成 1px 时只改了 `Divider` 里的 `width`，
   *   而布局算账用的常量 `DIVIDER_W` 还留着 5 →
   *   每栏之间按 5px 预留（4 栏 = 15px），屏幕上 3 条只占 3px，
   *   **剩下 12px 没人认领，全堆在容器最右边**。
   *   ⚠ 当年看不出来是因为那层容器刷的是 `--paper`（和面板同色）；
   *     容器改成 transparent 之后，这条缝立刻显形。
   *
   *   ⚠ 判据要量**几何**（最后一栏的右边界 == 容器右边界），不能靠"看着满不满"。
   */
  const fill = await j(`(() => {
    const c = document.querySelector('[data-panes-root]');
    if (!c) return null;
    const cr = c.getBoundingClientRect();
    const kids = [...c.querySelectorAll('section[data-pane], [role="separator"]')];
    const sum = kids.reduce((s, el) => s + el.getBoundingClientRect().width, 0);
    const right = Math.max(...kids.map((el) => el.getBoundingClientRect().right));
    return { container: Math.round(cr.width), sum: Math.round(sum), rightGap: Math.round(cr.right - right) };
  })()`);
  console.log('  分栏占宽：' + JSON.stringify(fill));
  check('★★ 四栏 + 分隔条正好占满容器，右边不留缝', () => {
    assert(fill, '找不到分栏容器');
    assert(Math.abs(fill.rightGap) <= 1.5,
      `容器右边空出 ${fill.rightGap}px（容器 ${fill.container} / 实际占 ${fill.sum}）`
      + ' —— 布局算账用的分隔条宽度和实际画出来的不一致');
  });

  /**
   * ⚠⚠ 分隔线"看起来比 1px 粗" —— 2026-10-16 羽毛菌第三次提这条。
   *
   *   真凶**不是** SplitPanes 的那根（它一直是 1px），而是
   *   `ConversationList` 里另写了一条 `borderRight: 1px solid var(--line)`，
   *   紧挨着分隔条 → 两条 1px 叠在同一像素列上，看起来就是一条 2px 的粗线。
   *
   *   ⚠ 所以判据**不能只看 CSS 宽度**（SplitPanes 那根永远是 1），
   *     必须量**屏幕上几个像素列是异色的** —— 这才是用户看到的"粗"。
   *   ⚠ 又因为 devicePixelRatio=2，1 CSS px = 2 设备列。
   */
  const seps = await j(`[...document.querySelectorAll('[role="separator"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, w: r.width, y: r.y, h: r.height };
  })`);
  console.log('  分隔条：' + JSON.stringify(seps));

  if (seps && seps.length) {
    const img = await win.webContents.capturePage();
    const bmp = img.toBitmap();
    const sz = img.getSize();
    const DPR2 = await j('window.devicePixelRatio');
    const limit = Math.ceil(DPR2) + 1;   // 1 CSS px 在 dpr=2 下就是 2 设备列，再容 1 列抗锯齿
    /**
     * ⚠⚠ 判据不能假设"线比底暗" —— 实测**反过来**：
     *   分隔条的底色是 `var(--line)`（不透明 #e3e0db），而两侧是被背景图
     *   压过的 66% 玻璃；羽毛菌那张图上这块偏暗，于是**线比底亮**（228 vs 173）。
     *   第一版按"最暗的列"去找，10 列全被判成"暗"，直接假红。
     *   ⚠ 改成"跟中位数差得多的连续列有多长"，跟谁亮谁暗无关。
     */
    /**
     * ⚠⚠ 这条判据连栽三次，每次都败在**背景图的内容**上，不是线上：
     *   ① 假设"线比底暗" → 实际线比底亮（--line 是不透明的浅灰）→ 10 列全判成暗；
     *   ② 改成"跟中位数差 > 6" → 图的**渐变**让两侧本来就差 7 级 → 连着 6 列算进来；
     *   ③ 再改成"跟两端插值比" → 图里恰好有一条**暗边**落在旁边 →
     *      4 列超标（228,228 明明只有 2 列）。
     *
     *   正解：**挑一个旁边最平的高度去量**。
     *   线在哪个高度都是 2 设备列宽；而图的暗边只存在于某些高度。
     *   沿分隔条试几个高度，取"两侧最平"的那一个再数列数 ——
     *   这样"线粗了"仍然一定抓得到（它对每个高度都成立），
     *   而"图上有条暗边"被绕开。
     */
    seps.forEach((sep, i) => {
      const x0 = Math.round((sep.x - 3) * DPR2);
      const width = Math.round(6 * DPR2);
      const lineFrom = Math.round(3 * DPR2);              // 线占的设备列区间
      const lineTo = lineFrom + Math.round(DPR2) - 1;

      const rowAt = (yD) => {
        const out = [];
        for (let dx = 0; dx < width; dx++) {
          const k = (yD * sz.width + x0 + dx) * 4;
          out.push(Math.round((bmp[k] + bmp[k + 1] + bmp[k + 2]) / 3));
        }
        return out;
      };
      /** 两侧各自对自己那半边做线性插值，返回最大偏差（越大说明旁边越"不平"） */
      const flatness = (lum) => {
        const side = (a, b) => {
          const n = b - a;
          if (n <= 0) return 0;
          let worst = 0;
          for (let k = a; k <= b; k++) {
            const base = lum[a] + (lum[b] - lum[a]) * ((k - a) / n);
            worst = Math.max(worst, Math.abs(lum[k] - base));
          }
          return worst;
        };
        return Math.max(side(0, lineFrom - 1), side(lineTo + 1, width - 1));
      };

      // 沿分隔条试 6 个高度，挑旁边最平的那一处
      let best = null;
      for (const frac of [0.15, 0.28, 0.42, 0.55, 0.7, 0.85]) {
        const yD = Math.round((sep.y + sep.h * frac) * DPR2);
        const lum = rowAt(yD);
        const flat = flatness(lum);
        if (!best || flat < best.flat) best = { yD, lum, flat, frac };
      }
      const { lum, flat } = best;

      /**
       * ⚠⚠ 用"**两侧边界之间的距离**"量线宽，不用"跟基准色差多少"。
       *
       *   为什么：基准色会被**被测对象本身**带偏 ——
       *   加回 `borderRight` 那种双线时，紧挨着线的那两列也是 228，
       *   基准就被拉到 234，色差只剩 6，怎么调阈值都不对
       *   （实测变异版本照样全绿，判据成了摆设）。
       *
       *   边界法则只看**相邻两列的跳变**：
       *     单线  250,250,… | 228,228 | 250,…  → 进 1 次、出 1 次，间隔 2 列
       *     双线  235,228,228,228,228,240       → 间隔 4 列
       *   图的渐变每列只变 1~2 级，够不到 4 级的门槛，所以不受影响。
       */
      const STEP = 4;
      let leftEdge = -1, rightEdge = -1;
      for (let k = lineFrom; k >= 1; k--) {
        if (Math.abs(lum[k] - lum[k - 1]) >= STEP) { leftEdge = k; break; }
      }
      for (let k = lineTo + 1; k < width; k++) {
        if (Math.abs(lum[k] - lum[k - 1]) >= STEP) { rightEdge = k; break; }
      }
      const band = (leftEdge >= 0 && rightEdge >= 0) ? rightEdge - leftEdge : -1;
      console.log(`  第 ${i + 1} 条 x=${Math.round(sep.x)} y=${best.yD} 线宽=${band} 设备列`
        + `（1 CSS px = ${Math.round(DPR2)} 列）  [${lum.join(',')}]`);
      check(`★★ 第 ${i + 1} 条分隔线在屏幕上是 1px`, () => {
        assert(sep.w <= 1.5, `CSS 宽度 ${sep.w}`);
        // ⚠ 量不到要说出来，不能当通过（"没验到" ≠ "没问题"）
        assert(band >= 0, `线的两侧找不到边界（图色太接近线色），这条没验到：[${lum.join(',')}]`);
        assert(band <= Math.round(DPR2) + 1,
          `屏幕上量到 ${band} 个设备列（1 CSS px 应该是 ${Math.round(DPR2)} 列）：[${lum.join(',')}]`
          + ' —— 要么分隔条变宽了，要么旁边又叠了一条 border');
      });
    });
  }

  async function shot(name, ms = 900) {
    await new Promise((r) => setTimeout(r, ms));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('  → shots/' + name);
  }

  await shot('bg-main.png');

  /**
   * ⚠ 细节要看**局部裁图**，别靠整窗缩略图 —— 1px 的线、图标的大小、
   *   按钮的圆角在缩略图里全糊成一团。这里把左栏单独裁出来。
   */
  const zoom = await j(`(() => {
    const r = document.querySelector('section[data-pane="conversations"]').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const railImg = await win.webContents.capturePage(zoom);
  fs.writeFileSync(path.join(OUT, 'bg-rail.png'), railImg.toPNG());
  console.log('  → shots/bg-rail.png（左栏，含标题行与设置按钮）');

  // 文件树那一栏（看层级：根目录下不该有散文件）
  const treeBox = await j(`(() => {
    const r = document.querySelector('section[data-pane="files"]').getBoundingClientRect();
    return { x: Math.round(r.x - 4), y: Math.round(r.y), width: Math.round(r.width) + 4, height: Math.round(r.height) };
  })()`);
  const treeImg = await win.webContents.capturePage(treeBox);
  fs.writeFileSync(path.join(OUT, 'bg-tree.png'), treeImg.toPNG());
  console.log('  → shots/bg-tree.png（文件树）');

  // 快捷工具那一行（看「简介」两个字有没有生效）
  // ⚠ 用 `[data-qt]` 找，别用文字找：窗口窄的时候「文风蒸馏」会被收进三点菜单里，
  //   按文字找会**静默返回 null**（那一段就悄悄不截了）——
  //   这跟"判据量不到当跳过"是同一个毛病。
  const toolsRow = await j(`(() => {
    const el = document.querySelector('[data-qt]');
    if (!el) return null;
    const r = el.parentElement.getBoundingClientRect();
    return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 4, width: Math.round(r.width) + 16, height: Math.round(r.height) + 8 };
  })()`);
  if (toolsRow) {
    const tImg = await win.webContents.capturePage(toolsRow);
    fs.writeFileSync(path.join(OUT, 'bg-tools.png'), tImg.toPNG());
    console.log('  → shots/bg-tools.png（快捷工具那一行）');
  } else {
    console.log('  ⚠ 没找到快捷工具行（[data-qt] 不存在）—— 这一段没截到');
  }

  // 各栏的透光度：有图时应**处处一致**，不能"左栏透、中栏死白"
  /**
   * ⚠ 透光度就是**各层透明度的乘积**（T = ∏(1−α)）。
   *   这就是整个功能的核心算式 —— 一层 0.66 透 34%，两层就只剩 11.6%，
   *   所以"有几层"比"每层多透明"重要得多。
   */
  const leak = await j(`(() => {
    /**
     * ⚠⚠ 每条栏**扫一列点取最好的那个**，别只戳一个坐标。
     *
     * 2026-10-16 现场：中栏量出"透出 0% —— 图被盖住了"，
     * 而真相是那一个点正好落在**聊天气泡**上（气泡本来就该是不透明的，
     * 羽毛菌要的正是"背景一层、气泡一层"）。
     * ⚠ 单点采样会把"这里有内容"当成"面板不透明" —— 又是"取法不对"。
     */
    const yPick = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    const pts = [];
    for (const [sel, label] of [['conversations', '左栏'], ['main', '中栏'], ['preview', '预览栏'], ['files', '右栏']]) {
      const el = document.querySelector('section[data-pane="' + sel + '"]');
      if (!el) continue;
      const r = el.getBoundingClientRect();
      for (const f of yPick) pts.push([Math.round(r.x + r.width / 2), Math.round(r.y + r.height * f), label]);
    }
    pts.push([600, 20, '顶栏']);
    const out = [];
    for (const [x, y, label] of pts) {
      const layers = document.elementsFromPoint(x, y)
        // ⚠ 必须排掉 body/html：它们的底色是**画在背景图下面**的 canvas 底，
        //   算进来会得到"透出 0%"（一个不透明的祖先把乘积直接归零）。
        //   第一版就是这么写的，五条判据全绿 0% —— 数字自洽但毫无意义。
        .filter((el) => el !== document.body && el !== document.documentElement)
        .map((el) => getComputedStyle(el).backgroundColor)
        .filter((c) => c !== 'rgba(0, 0, 0, 0)');
      let t = 1;
      let glassCount = 0;
      for (const c of layers) {
        const m = /\\/\\s*([\\d.]+)\\)/.exec(c);
        const a = m ? Number(m[1]) : 1;      // rgb(...) 就是不透明
        if (a < 1) glassCount++;
        t *= (1 - a);
      }
        out.push({ label, glassCount, leak: Math.round(t * 100) });
    }
    // 同一栏的多个点取**最大透出**（只要有一处能看见图，就说明面板是半透明的）
    const best = {};
    for (const o of out) {
      if (!best[o.label] || o.leak > best[o.label].leak) best[o.label] = o;
    }
    return Object.values(best);
  })()`).catch((e) => ({ err: String(e) }));
  console.log('\n三、各栏"透出几张图"（越大越好，且应彼此接近）');
  if (Array.isArray(leak)) {
    for (const l of leak) console.log(`  ${l.label.padEnd(5)} 玻璃层 ${l.glassCount}  透出 ${l.leak}%`);
  } else console.log('  ' + JSON.stringify(leak));

  check('★ 每一栏都真的透出了背景（不是只有顶栏那条缝）', () => {
    assert(Array.isArray(leak), `量不到：${JSON.stringify(leak)}`);
    /**
     * ⚠⚠ 先断言**前提**：背景得开着、图得在。
     *   否则这一段会量出「0 层玻璃 / 透出 0%」然后**照绿** ——
     *   2026-10-16 羽毛菌把背景关掉之后就真的发生了一次（他自己清的）。
     *   ⚠ 判据量出 0 要当"没验到"，不能当"通过"。
     */
    assert(leak.every((l) => l.glassCount >= 1),
      `玻璃层数是 0 —— 背景根本没开，这一段什么都没验到：${JSON.stringify(leak)}`);
    for (const l of leak) {
      assert(l.glassCount <= 2, `${l.label} 叠了 ${l.glassCount} 层玻璃 —— 纸色是乘起来的，会糊成死白`);
      assert(l.leak >= 20, `${l.label} 只透出 ${l.leak}% —— 图被盖住了`);
    }
  });

  // 设置页
  const opened = await j(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('设置'));
    if (b) b.click();
    return b ? (b.textContent || '').slice(0, 20) : '没找到设置按钮';
  })()`);
  console.log('  点到的按钮：' + opened);
  await shot('bg-settings.png', 1600);
  const same = await j(`!!document.querySelector('.absolute.inset-0.z-40')`);
  console.log('  设置页在 DOM 里：' + same);

  await Promise.all(pending);
  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `截图：${passed} 通过 / ${failures.length} 失败` : `截图：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('脚本崩了：', e && e.stack);
  setTimeout(() => app.exit(1), 300);
});

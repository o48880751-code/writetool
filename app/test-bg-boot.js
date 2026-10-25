/**
 * 真启动验证：require **真实的 main.js**，确认自定义背景这一整套活着。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-10-16 现场：我把 `protocol.handle('appbg', ...)` 写在了 main.js 的
 * **模块顶层**。它和 `app.getPath()` 一样要等 app ready —— 一行抛错，
 * 整个模块的加载就断在那里，**后面所有 handle 都不注册**：
 *
 *     font:presets / app:info / provider:modelCapability 全部 No handler
 *
 * 表面上的症状非常分散且看起来毫无关系：
 * 版本号没了、读取不到文件夹、设置页里没有自定义背景。
 * ⚠ **报错位置与真正的病灶毫无关系** —— 只有真的把 main.js 跑起来才抓得到。
 *
 * ⚠⚠ 所以这个脚本**不 stub 任何 IPC**，走的就是用户双击 exe 的那条路。
 *
 * 运行：.\electron-run.cmd test-bg-boot.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

// ⚠⚠ 必须在 require main.js **之前**重定向，否则会写到用户真实的
//    %APPDATA%\writetool，把他的对话和密钥一起弄脏。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-bg-'));
app.setPath('userData', TMP);

let passed = 0; const failures = []; const pending = [];
/**
 * ⚠⚠ 必须是 async 版。同步版会让 async 判据**假绿**：
 *   fn() 返回未完成的 Promise，check 立刻记「通过」，断言随后才跑。
 */
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const APPDIR = __dirname;

// ---- 造一张纯色 PNG（不引第三方库，判据不该再添依赖）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeSolidPng(w, h, rgb) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) { raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2]; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;            // 8bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * ⚠⚠ require 必须写在 **whenReady 之外**（模块顶层同步执行），
 *   因为 main.js 里有 `protocol.registerSchemesAsPrivileged` —— 它要求
 *   **在 app ready 之前**调用，反过来 `protocol.handle` 要求 ready 之后。
 *   放在 whenReady 回调里 require 会直接抛
 *   "registerSchemesAsPrivileged should be called before app is ready"，
 *   那是脚本自己造成的，不是产品的 bug。
 */
require(path.join(APPDIR, 'electron', 'main.js'));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) throw new Error('main.js 没有创建出窗口 —— 顶层代码大概率已经抛了');
  win.showInactive();
  await new Promise((r) => setTimeout(r, 2500));

  const j = (code) => win.webContents.executeJavaScript(code);

  console.log('\n一、main.js 真跑起来了（顶层没崩）');
  const hasRoot = await j(`!!document.getElementById('root')?.children.length`).catch(() => false);
  check('★ 渲染进程渲染出了内容（白屏就是没渲染）', () => {
    assert(hasRoot, '#root 是空的');
  });

  console.log('\n二、被那一处崩溃连坐的 handler 都还在');
  const info = await j(`window.api.app.info()`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★ app:info 有返回（版本号没了就是这一条挂了）', () => {
    assert(info && !info.err, `app:info 失败：${info && info.err}`);
    const v = info.version || info.appVersion || '';
    assert(/\d+\.\d+\.\d+/.test(String(v)), `版本号不像版本号：${JSON.stringify(info).slice(0, 160)}`);
  });

  const fonts = await j(`window.api.font.presets()`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★ font:presets 有返回', () => {
    assert(!(fonts && fonts.err), `font:presets 失败：${fonts && fonts.err}`);
    assert(Array.isArray(fonts), `font:presets 返回的不是数组：${JSON.stringify(fonts).slice(0, 160)}`);
  });

  console.log('\n三、自定义背景这一套');
  const bg = await j(`window.api.bg.get()`).then((r) => r).catch((e) => ({ err: String(e) }));
  check('★ bg:get 有返回，且字段就是「开关 + 图」', () => {
    assert(!(bg && bg.err), `bg:get 失败：${bg && bg.err}`);
    assert('enabled' in bg && 'url' in bg, `bg:get 字段不对：${JSON.stringify(bg).slice(0, 160)}`);
  });

  // ⚠ 判据要断言自己的前提：先真拿到一个项目 id 再读树。
  //   传 null 的话 handler 会在 path.resolve 上炸（那是**被测代码之外**的错），
  //   判据依然绿，但它什么都没验到。
  // ⚠ 临时 userData 是空的，没有项目 —— 先建一个再读树
  const projects = await j(`(async () => {
    let l = await window.api.project.list();
    if (!l || !l.length) {
      await window.api.project.create({ id: 'p-boot', name: '启动验证' });
      l = await window.api.project.list();
    }
    return l;
  })()`).then((r) => r).catch((e) => ({ err: String(e) }));
  const pid = Array.isArray(projects) && projects.length ? projects[0].id : null;
  check('★ project:list 有返回（拿不到项目就没法验读树）', () => {
    assert(pid, `project:list 没有给出项目：${JSON.stringify(projects).slice(0, 160)}`);
  });
  const tree = await j(`window.api.fs.tree({ projectId: ${JSON.stringify(pid)} })`)
    .then((r) => r).catch((e) => ({ err: String(e) }));
  check('★ fs:tree 真读出了目录（读取不到文件夹就是这一条挂了）', () => {
    assert(!(tree && tree.err), `fs:tree 报错：${tree && tree.err}`);
    // ⚠ fs:tree 返回的是**根节点对象**（children 里才是内容），不是数组
    const kids = (tree && tree.children) || [];
    assert(kids.length > 0, `读出来的树是空的：${JSON.stringify(tree).slice(0, 200)}`);

    /**
     * ⚠⚠ 这里原来只断言"三个目录**存在**"（`/设定/.test(names) && …`），
     *   —— 于是**顺序错了它照样绿**。羽毛菌因此报了两遍同一件事
     *   （2026-10-16：「新建项目之后，设定文件夹在最上面，中间的是卷纲，你没修好」）。
     *
     *   真实原因不是 `TEMPLATE_DIRS` 的顺序（那个我一直是对的），
     *   而是 `localeCompare(x, 'zh')` 是**拼音序**：juan(卷) < she(设) < zhang(章)，
     *   正好把 mkdir 的先后整个盖掉。
     *
     *   ⚠ 教训：判据里"存在"和"顺序"是两件事。用户报的是顺序，
     *     判据就该量顺序，别量存在。
     */
    const dirs = kids.filter((k) => k.type === 'dir').map((k) => k.name);
    assert(dirs.join('/') === '设定/卷纲/章节',
      `默认目录顺序不对：${dirs.join('/')}（应为 设定/卷纲/章节）`);
  });

  // ⚠⚠ 必须等所有 check 跑完 —— await 写在 check 之前的话，
  //    后面新加的判据永远等不到。
  await Promise.all(pending);

  console.log('\n三·五、选图这条链路真的能跑（2026-10-16 的报错就在这里）');

  /**
   * ⚠⚠ 2026-10-16 现场报错：
   *   `The "path" argument must be of type string or an instance of Buffer or URL.
   *    Received function bgDir`
   *   —— `bgDir` 从常量改成函数时有**一处漏了括号**，`fs.readdirSync(bgDir)`。
   *   上一轮的 test-bg-boot 只测了 `bg:get`（读配置），**根本没碰 `bg:pick`** ——
   *   而那才是出错的那一半。**只测"读"不测"写"，等于没测这个功能。**
   *
   * ⚠ 这里把 dialog 顶掉，走完整链路：选文件 → 拷进 userData/assets
   *   → 用 appbg 协议取回来。main.js 是解构 require 的同一个对象，改得到。
   */
  const srcPng = path.join(TMP, 'src-pic.png');
  fs.writeFileSync(srcPng, makeSolidPng(32, 32, [0, 128, 255]));
  const electron = require('electron');
  const realOpen = electron.dialog.showOpenDialog;
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [srcPng] });

  const picked = await j(`window.api.bg.pick()`).then((r) => r).catch((e) => ({ err: String(e) }));
  electron.dialog.showOpenDialog = realOpen;

  check('★★ bg:pick 不报错，返回 appbg:// 地址', () => {
    assert(!(picked && picked.err), `bg:pick 抛了：${picked && picked.err}`);
    assert(picked && picked.ok, `bg:pick 没成功：${JSON.stringify(picked)}`);
    /**
     * ⚠ 文件名**必须带时间戳**（`bg-1792125109015.png`），不能写死 `bg.png`：
     *   固定名字会让"换一张同扩展名的图"URL 不变 → 浏览器拿缓存的旧图
     *   （羽毛菌原话：「无法更换新的背景，被锁死了」）。
     *   这条判据本身也在提醒：**文件名是契约的一部分**。
     */
    assert(/^appbg:\/\/bg-\d+\.png$/.test(picked.url || ''), `返回的地址不对：${JSON.stringify(picked)}`);
  });
  check('★ 图真的被拷进 userData/assets', () => {
    const dst = path.join(TMP, 'assets', picked.name);
    assert(fs.existsSync(dst), `目标文件不存在：${dst}`);
    assert(fs.statSync(dst).size > 0, '拷过去的是空文件');
  });
  /**
   * ⚠ 用 `new Image()` 加载，**不用 fetch**。
   *   产品里这张图就是被 CSS `background-image` 引用的，走的是图片加载那条路；
   *   我第一版用 fetch 量，返回 `Failed to fetch` —— 那是**取法不对**，
   *   不是协议坏了（同一个地址铺上去像素确实变了，第四节证明）。
   *   ⚠ 「判据量不到」先怀疑判据的取法，别急着改产品代码。
   */
  check('★★ appbg 协议能把这张图取回来（取不到就是"设了但完全不显示"）', async () => {
    const r = await j(`new Promise((res) => {
      const i = new Image();
      i.onload = () => res('ok:' + i.naturalWidth + 'x' + i.naturalHeight);
      i.onerror = () => res('err');
      i.src = ${JSON.stringify(picked.url)};
      setTimeout(() => res('timeout'), 3000);
    })`);
    assert(/^ok:32x32$/.test(String(r)), `加载结果是 ${r}`);
  });
  /**
   * ⚠⚠★★ 「换一张图」——2026-10-16 羽毛菌报的「无法更换新的背景，被锁死了」。
   *
   *   根因：文件名固定叫 `bg<ext>`，换一张**同扩展名**的图 → URL 还是
   *   `appbg://bg.jpg` → **Chromium 按 URL 缓存**，界面上还是旧图（缩略图也不动）。
   *   ⚠ 而这里原来那条判据只测了「换个扩展名（png → jpg）旧文件被清掉」——
   *     **恰好绕开了唯一的故障情形**（同扩展名替换）。
   *     判据挑了个好走的用例，等于没测。
   *
   *   现在钉死：**两次同扩展名的选图，URL 必须不同**，并且新 URL 加载出来的
   *   像素必须是新图（用 canvas 取一个点，别只看字符串）。
   */
  check('★★ 换一张**同扩展名**的图之后，URL 变了、取回的像素也变了', async () => {
    const pickSolid = async (rgb, tag) => {
      const src = path.join(TMP, `src-${tag}.png`);
      fs.writeFileSync(src, makeSolidPng(16, 16, rgb));
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [src] });
      const r = await j(`window.api.bg.pick()`).then((x) => x).catch((e) => ({ err: String(e) }));
      electron.dialog.showOpenDialog = realOpen;
      return r;
    };

    const red = await pickSolid([255, 0, 0], 'red');
    assert(red && red.ok, `第一次选图失败：${JSON.stringify(red)}`);
    const green = await pickSolid([0, 255, 0], 'green');
    assert(green && green.ok, `第二次选图失败：${JSON.stringify(green)}`);

    assert(red.url !== green.url,
      `两次都是 ${red.url} —— 文件名固定，浏览器会一直拿缓存的旧图（"锁死了"就是这么来的）`);

    // 新 URL 必须真的指向**新图**：逐字节比对拷进去的文件与源文件
    const dstBuf = fs.readFileSync(path.join(TMP, 'assets', green.name));
    const srcBuf = fs.readFileSync(path.join(TMP, 'src-green.png'));
    assert(dstBuf.equals(srcBuf), '拷进去的不是这次选的那张图');

    /**
     * ⚠⚠ 这里原本想用 canvas 读像素（`drawImage` + `getImageData`），结果**永远超时**。
     *   真因：自定义协议的图会把 canvas **污染**（tainted），`getImageData` 抛
     *   SecurityError —— 异常发生在 onload 回调里，Promise 既不 resolve 也不 reject，
     *   判据只看到 "timeout"。**看起来像图片加载挂了，其实图早就加载好了。**
     *   ⚠ 教训：判据里凡是能在 Promise 里抛的代码，都要 try/catch 包住，
     *     否则"测量代码自己炸了"会被读成"产品坏了"。
     *   现在改测：新地址能**加载出来**（尺寸对），加上面的字节比对，足够定性。
     */
    const loaded = await j(`new Promise((res) => {
      const i = new Image();
      i.onload = () => res('ok:' + i.naturalWidth + 'x' + i.naturalHeight);
      i.onerror = () => res('err');
      i.src = ${JSON.stringify(green.url)};
      setTimeout(() => res('timeout'), 4000);
    })`);
    assert(String(loaded) === 'ok:16x16', `新地址加载结果是 ${loaded}`);

    const files = fs.readdirSync(path.join(TMP, 'assets'));
    assert(files.filter((f) => /^bg[.-]/i.test(f)).length === 1,
      `assets 里留下了多张背景图：${files.join(',')}`);
  });

  /**
   * ⚠⚠ 这一段必须在**截屏之前**跑完。
   *
   *   选图 → 用 `new Image()` 读回像素，是"图片请求"；第四节的 `capturePage()`
   *   是"合成器抓帧"。两者并发时（本机在这台机器上 GPU 进程会崩），
   *   图片加载会**既不 onload 也不 onerror** 地挂住 —— 判据报 `timeout`，
   *   而产品是好的（`probe-bg.js` 单独跑就是 ok:16x16）。
   *   ⚠ 「判据量到 timeout」照样先怀疑**测量的环境**，别急着改产品代码。
   */
  await Promise.all(pending);

  console.log('\n四、图真的显示在**面板背后**（不是盖在上面）');

  // ⚠⚠ 这一段是唯一能抓住「层级写反」和「只有一条缝透出图」的判据：
  //   背景层是 position:fixed，写 z-index:0 会盖住所有内容（绘制顺序排在
  //   普通流之后），写 -1 才在背后。两条都不报错、界面都能截图，
  //   只有**像素**能区分。
  /**
   * ⚠⚠ 截图前**不要** `win.focus()`。
   *   2026-10-16 现场：带上它之后 `capturePage()` 回来的是**一张被放大的糊帧**
   *   （整窗近乎一个色，250,208,165，与界面毫无关系），
   *   而"整窗平均色"那两条判据照旧通过 —— 只有**按区域采样**才暴露出来：
   *   四栏 + 顶栏五个点量出来是同一个颜色。
   *   ⚠ 这正是"平均值判据太弱"的第二次现形：它连"抓到的是废帧"都发现不了。
   *   去掉 focus、并把窗口尺寸固定成已知值后，帧恢复正常。
   */
  /** 最近一帧的位图与尺寸：按区域采样要用它（见下面 ★★ 那条） */
  let shotBmp = null, shotW = 0, shotH = 0, viewW = 0;
  async function shot() {
    await new Promise((r) => setTimeout(r, 900));
    const img = await win.webContents.capturePage();
    const buf = img.toBitmap();
    shotBmp = buf;
    const sz = img.getSize();
    shotW = sz.width; shotH = sz.height;
    if (!viewW) viewW = await j('window.innerWidth');
    let r = 0, g = 0, b = 0;
    const n = buf.length / 4;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  win.setBackgroundThrottling(false);
  const before = await shot();

  // 造一张纯品红的图（正常界面不可能有这个颜色），塞进背景目录
  const png = makeSolidPng(64, 64, [255, 0, 255]);
  fs.mkdirSync(path.join(TMP, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'assets', 'bg.png'), png);

  await j(`(async () => {
    await window.api.config.set({ bgEnabled: true, bgUrl: 'appbg://bg.png' });
    window.dispatchEvent(new Event('writetool:bg-changed'));
  })()`).catch((e) => ({ err: String(e) }));
  await new Promise((r) => setTimeout(r, 1200));

  const after = await shot();
  const diff = Math.max(
    Math.abs(after[0] - before[0]),
    Math.abs(after[1] - before[1]),
    Math.abs(after[2] - before[2]),
  );

  check('★ 开了背景后整窗像素真的变了（图被不透明面板盖住就是这里红）', () => {
    assert(diff >= 3, `开图前后画面几乎没变（差值 ${diff}）：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });
  check('★ 背景是"透出来"的，不是整窗被图盖住（品红不能占满）', () => {
    // 面板是不透明的 --paper 混 28% 图，整窗平均不该接近纯品红
    const magentaish = after[0] > 200 && after[1] < 60 && after[2] > 200;
    assert(!magentaish, `整窗几乎变成纯品红 ${JSON.stringify(after)} —— 图盖在内容上面了`);
  });

  /**
   * ⚠⚠ 上面两条**太弱了**，弱到漏掉了 2026-10-16 那个真实故障：
   *   当时图只从顶栏那条缝露出来（面板全是死白），而整窗平均色照样变了 3 以上、
   *   也照样不是纯品红 —— 两条判据全绿，羽毛菌看到的是「怎么就只有顶部」。
   *   ⚠ 教训：**平均值抓不住局部**。
   *
   * ⚠⚠ 而这一条**第一版是按区域采像素**写的，又踩了另一个坑：
   *   本机 GPU 进程崩了（`GPU process isn't usable. Goodbye.`）时，
   *   `capturePage()` 会回一张**放大的糊帧** —— 五个采样点量出来是同一个颜色
   *   （250,208,165，跟界面毫无关系），而 DOM 查下来一切正常。
   *
   *   ⚠ 教训：**能算的别去量**。"透不透"= 各层透明度的乘积，
   *     从 `getComputedStyle` 就能算出来 —— 不截图，也就不受 GPU 状态影响。
   *     真正的像素验收放在 `shoot-bg.js`（窗口尺寸固定、抓图稳定，
   *     而且用的是羽毛菌自己那张图）。
   */
  check('★★ 四栏 + 顶栏**每一处**都透出了图，不是只有顶栏那条缝', async () => {
    const leak = await j(`(() => {
      const pts = [[100, 300, '左栏'], [330, 300, '中栏'], [700, 300, '预览栏'], [1160, 300, '右栏'], [600, 20, '顶栏']];
      const out = [];
      for (const [x, y, label] of pts) {
        // ⚠ body/html 必须排掉：它们的底色是**画在背景图下面**的 canvas 底，
        //   算进来乘积直接归零（"透出 0%"），看着自洽其实毫无意义。
        const layers = document.elementsFromPoint(x, y)
          .filter((el) => el !== document.body && el !== document.documentElement)
          .map((el) => getComputedStyle(el).backgroundColor)
          .filter((c) => c !== 'rgba(0, 0, 0, 0)');
        let t = 1, n = 0;
        for (const c of layers) {
          const m = /\\/\\s*([\\d.]+)\\)/.exec(c);
          const a = m ? Number(m[1]) : 1;
          if (a < 1) n++;
          t *= (1 - a);
        }
        out.push({ label, layers: n, leak: Math.round(t * 100) });
      }
      return out;
    })()`);
    for (const l of leak) console.log(`     ${l.label.padEnd(5)} 玻璃层 ${l.layers} 层  透出 ${l.leak}%`);
    for (const l of leak) {
      assert(l.layers <= 2,
        `${l.label} 叠了 ${l.layers} 层纸 —— 纸色是乘起来的，三层 66% 就只剩 4% 能看见`);
      assert(l.leak >= 20, `${l.label} 只透出 ${l.leak}% —— 背景图被盖住了`);
    }
  });

  // ⚠ 第四节的判据是**在第一次 await 之后**才注册的 —— 必须再等一轮，
  //    否则它们的断言跑完之前就已经打印结果了（看着像漏了两条）。
  await Promise.all(pending);

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `真启动：${passed} 通过 / ${failures.length} 失败` : `真启动：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('脚本崩了：', e && e.message);
  setTimeout(() => app.exit(1), 300);
});

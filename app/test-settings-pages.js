/**
 * 真机验证：设置页**每一个分类**都能打开且不崩。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-10-16 现场：点「参数」→ `ReferenceError: capability is not defined`，
 * 整页白屏。原因是我把 `useState` 插在 `SettingsPage` 里，
 * **而用它的 JSX 在 `Params` 里** —— 两个平级组件，作用域互不相通。
 *
 * ⚠⚠ 这类错 `node --check` 抓不到（语法完全合法）、
 *   `npm run build` 也不报（只转译、不查作用域）——
 *   **只有真点那个页才炸**。
 *
 * ⚠ 我试过写静态扫描（扫 JSX 里用到的变量有没有声明），**放弃了**：
 *   回调参数 `{e}`、map 的第二个参数、解构别名…误报率极高，
 *   第一版就把 3 个正常写法判成未声明。
 *   **一条天天误报的判据会训练人忽略红字，比没有判据更糟。**
 *   作用域错误天生只有真渲染才炸，那就用真渲染验。
 *
 * 运行：.\electron-run.cmd test-settings-pages.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PID = 'p1';

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

const CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 131072,
  chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'ink', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
  // ⚠ 给一份窗口参数，让「参数」页走完整分支
  connParams: { c1: { numCtx: 131072, maxOutput: 8192, reserve: 4096 } },
};
// ⚠ 模拟本地连接（isLocal）并让能力查询有结果 —— 覆盖那两条新提示
const CAP = { contextLength: 40960, parameterSize: '8.2B', quantization: 'Q4_K_M' };

/**
 * ⚠⚠⚠ 连接级参数的**可变**桩 —— 而且必须注册在下面的通用循环**之后**。
 *
 *   两个坑叠在一起：
 *   ① 原来 `provider:connParams` / `provider:setConnParams` 都返回写死的
 *      `{numCtx:131072,...}`，于是"滚轮填 24 有没有真的存成 24576"
 *      根本测不出来：无论界面上发生什么，读回来的都是那个常量。
 *   ② 自定义 handler 如果注册在通用循环**之前**，会被 `h()` 里的
 *      `removeHandler` + `handle` 覆盖成 `return null` ——
 *      症状是"按钮点了、通道也调了，就是什么都不变"。
 *      判据自己也骗了自己：直调一次返回 null 才暴露出来。
 */
const CP = { numCtx: 131072, maxOutput: 8192, reserve: 4096 };

for (const ch of ALL) {
  h(ch, (p) => {
    if (ch === 'config:get') return CFG;
    /**
     * ⚠⚠ config:set 必须**真的改 CFG**（桩里直接把 patch 合并进去）。
     *   原来它返回 null 而 config:get 永远给同一份 CFG，
     *   于是「开关点下去有没有存上」这类**写**的判据永远测不出来 ——
     *   读的部分全绿，而真功能是坏的（自动压缩那个开关就是这样坏的）。
     *   又一次「只测读不测写等于没测」。
     */
    if (ch === 'config:set') { Object.assign(CFG, p || {}); return null; }
    if (ch === 'provider:modelCapability') return CAP;
    if (ch === 'provider:connParams') return { ...CP, isLocal: true };
    if (/list$|messages$|tree$/.test(ch)) return [];
    return null;
  });
}
h('app:version', () => ({ version: '1.0.8' }));
h('project:list', () => [{ id: PID, name: '测试项目' }]);
h('conv:list', () => [{ id: 'c1', projectId: PID, title: 't', messageCount: 1 }]);
h('conv:messages', () => []);
h('provider:listConnections', () => [{ id: 'c1', name: '本地 Ollama', protocol: 'ollama', model: 'qwen3:latest' }]);
h('style:profile', () => ({ available: false, reason: '还没有章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));

/**连接级参数的**写**通道（必须在通用循环之后，见上面 ②）。 */
ipcMain.removeHandler('provider:setConnParams');
/**
 * ⚠⚠⚠ preload 是 `setConnParams: (id, patch) => call('provider:setConnParams',
 *   { connectionId: id, ...patch })` —— 两个参数被合成**一个对象**发过来。
 *   我按"第二个参数才是 patch"写 handler，结果 patch 是 undefined、什么都不写。
 *   **参数形状只能照 preload 的实际写法抄，不能照直觉。**
 */
ipcMain.handle('provider:setConnParams', async (_e, payload) => {
  const p = payload || {};
  for (const k of ['numCtx', 'maxOutput', 'reserve']) {
    if (p[k] === undefined) continue;
    if (p[k] === null) { delete CP[k]; continue; }
    CP[k] = Math.round(Number(p[k]));
  }
  return {
    ok: true,
    data: {
      ok: true,
      params: {
        numCtx: CP.numCtx, maxOutput: CP.maxOutput,
        reserve: CP.reserve, isLocal: true,
      },
    },
  };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  /** ⚠ 收集渲染进程的所有报错 —— 作用域错���就靠它发现 */
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2 && /ReferenceError|TypeError/.test(String(message))) {
      errors.push(String(message).split('\n')[0]);
    }
  });

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));
  const j = (c) => win.webContents.executeJavaScript(c);

  // 打开设置
  const opened = await j(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  check('★ 设置页能打开', () => assert(opened, '找不到设置按钮'));

  // 逐个分类点一遍
  const cats = ['参数', '外观', '数据', '工具', '关于'];
  const texts = {};
  for (const cat of cats) {
    const before = errors.length;
    // ⚠ 导航按钮的文字是「图标 + 标签」拼在一起的（textContent 是 "⚙参数"），
    //   用 === 永远匹配不上 —— 结果是没有一个类目被点开，
    //   五次快照都是默认那一栏，判据红得莫名其妙。
    //   跟「⚙设置v1.0.2」那个坑是同一件事：按钮文字混了图标。
    await j(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => x.textContent.trim().endsWith(${JSON.stringify(cat)}));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    // ⚠ 只取**设置内容区**的文字：整页 innerText 的前 400 字会被左侧栏和
    //   底下还没卸载的工作区吃掉，判据会读到完全无关的内容
    //   （2026-10-16 就因此把参数页的两条提示判成"没有"）。
    const snapshot = await j(
      `(document.querySelector('[data-testid="settings-body"]')||document.body).innerText.slice(0, 1200)`
    );
    texts[cat] = snapshot;
    check(`★ 「${cat}」打开不崩`, () => {
      const news = errors.slice(before);
      assert(news.length === 0, `渲染报错：${news.join(' | ')}`);
      assert(snapshot && snapshot.length > 30, '页面几乎空白，疑似没渲染');
    });
  }

  check('★ 全程没有白屏', () => {
    assert(errors.length === 0, `累计报错 ${errors.length} 条：${errors.slice(0, 3).join(' | ')}`);
  });

  // 参数页的那两条提示
  check('★★ 超模型能力时明说「会被静默压到上限」', () => {
    const t = texts['参数'] || '';
    assert(/静默压到上限/.test(t),
      `参数页没有那条提示。实际内容开头：${t.slice(0, 160)}`);
    assert(/40K|40960/.test(t), '没有显示模型真实的 40K 能力');
  });

  check('★ 自动压缩开关在参数页上', () => {
    const t = texts['参数'] || '';
    assert(/自动压缩上下文/.test(t), '参数页没有「自动压缩上下文」开关');
  });

  /**
   * 外观页的自定义背景（2026-10-16）。
   *
   * ⚠ 这个功能的定义就是「上传一张图替代白色底」——
   *   羽毛菌明确要求去掉模糊/玻璃层/遮罩三个滑杆，
   *   所以判据不只断言「有这一栏」，还要断言**没有**那几个滑杆。
   *   ★★ 「什么不许出现」和「什么必须出现」一样重要。
   */
  check('★★ 外观页有自定义背景，且没有多余滑杆', () => {
    const t = texts['外观'] || '';
    assert(/自定义背景图片/.test(t), '外观页没有「自定义背景图片」这一栏');
    assert(/选择图片|换一张/.test(t), '没有选图按钮');
    assert(!/模糊调节/.test(t), '模糊滑杆还在（已要求去掉）');
    assert(!/玻璃层/.test(t), '玻璃层滑杆还在（已要求去掉）');
    assert(!/遮罩调节/.test(t), '遮罩滑杆还在（已要求去掉）');
  });

  // ================================================================
  // 参数页：开关能不能**点得动**（2026-10-16 羽毛菌报"取消不了勾选"）
  // ================================================================
  /**
   * ⚠⚠ 这一段的价值全在**点一下**。
   *   上一版只有「参数页有『自动压缩上下文』这几个字」这种读断言，
   *   所以 `onConfigChange` 那个不存在的变量（Params 里根本没这个 prop）
   *   一路绿灯到用户手上 —— 点一下 ReferenceError，勾选弹回去，
   *   而判据显示"通过"。
   *   教训：**能点的就必须真点**（同 bg:pick 那次只测 bg:get）。
   */
  await j(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.trim().endsWith('参数'));
    if (b) b.click();
    return !!b;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const swBefore = await j(`(() => {
    const el = document.querySelector('[data-testid="switch-autocompress"]');
    return el ? el.checked : null;
  })()`);
  check('★★ 「自动压缩上下文」默认是勾上的，且元素找得到', () => {
    assert(swBefore !== null, '页面上没有这个开关');
    assert(swBefore === true, `默认状态是 ${swBefore}`);
  });

  const errBefore = errors.length;
  await j(`document.querySelector('[data-testid="switch-autocompress"]').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const after = await j(`(() => {
    const el = document.querySelector('[data-testid="switch-autocompress"]');
    return { checked: el ? el.checked : null };
  })()`);
  const stored = CFG.autoCompress;
  check('★★★ 点一下真的能取消勾选（羽毛菌报的 bug）', () => {
    const news = errors.slice(errBefore);
    assert(news.length === 0,
      `点下去抛错了：${news.join(' | ')} —— 典型是引用了 Params 里不存在的变量`);
    assert(after.checked === false, `点完还是 ${after.checked} —— 勾选弹回去了`);
    assert(stored === false, `config.autoCompress=${JSON.stringify(stored)} —— 没存上`);
  });

  // 再点回来，必须能勾上（单向的开关等于另一个坏法）
  await j(`document.querySelector('[data-testid="switch-autocompress"]').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const back = await j(`(() => {
    const el = document.querySelector('[data-testid="switch-autocompress"]');
    return el ? el.checked : null;
  })()`);
  check('★★ 再点一下能勾回来（开关必须双向）', () => {
    assert(back === true, `勾不回来了：${back}`);
    assert(CFG.autoCompress !== false, `config.autoCompress=${JSON.stringify(CFG.autoCompress)}`);
  });

  // ---- 「长度」组的三项（2026-10-16 羽毛菌定的规矩）----
  const lenUi = await j(`(() => {
    const q = (s) => document.querySelector(s);
    const btnLabels = [...document.querySelectorAll('button')]
      .map((b) => b.textContent.trim())
      .filter((t) => /^(8K|16K|32K|64K|128K|200K|300K|自动)$/.test(t));
    const kBox = q('[data-testid="param-numCtx-k"]');
    return {
      hasKBox: !!kBox,
      kMin: kBox ? kBox.getAttribute('min') : null,
      kMax: kBox ? kBox.getAttribute('max') : null,
      kStep: kBox ? kBox.getAttribute('step') : null,
      kValue: kBox ? kBox.value : null,
      hasUnit: !!(kBox && kBox.parentElement
        && kBox.parentElement.textContent.includes('K')),
      kDisabled: kBox ? kBox.disabled === true : null,
      hasMaxOutputBox: !!q('[data-testid="param-maxOutput"]'),
      hasReserveBox: !!q('[data-testid="param-reserve"]'),
      big: ['128K', '200K', '300K'].filter((k) => btnLabels.includes(k)),
    };
  })()`);
  console.log('  ' + JSON.stringify(lenUi));
  check('★★ 「单次输出上限」与「输出预留」不再有手填框，只剩档位', () => {
    assert(!lenUi.hasMaxOutputBox, '单次输出上限还有数字输入框（已要求去掉）');
    assert(!lenUi.hasReserveBox, '输出预留还有数字输入框（已要求去掉）');
  });
  check('★★ 上下文窗口是 8–64 的 K 滚轮（系统自己换算）', () => {
    assert(lenUi.hasKBox, '找不到那个 K 滚轮');
    assert(lenUi.kMin === '8' && lenUi.kMax === '64',
      `滚轮范围是 ${lenUi.kMin}~${lenUi.kMax}，要求 8~64`);
    assert(lenUi.kStep === '1', `滚轮步进是 ${lenUi.kStep}，要求 1（一格 1K）`);
    assert(lenUi.hasUnit, '滚轮后面没有跟单位 K —— 用户不知道这个数的单位');
    // ⚠⚠ 夹取：配置里是 131072（=128K，超出滚轮范围）时，
    //   框上**不能**显示 128 —— `<input type=number max=64>` 不会自动纠正它，
    //   结果是明晃晃一个自己声明为非法的数。第一版就漏了下限之外的那一半。
    assert(Number(lenUi.kValue) >= 8 && Number(lenUi.kValue) <= 64,
      `滚轮当前值是 ${lenUi.kValue} —— 超出 8~64（配置是 131072）`);
    assert(lenUi.kDisabled === true,
      '当前窗口超 64K 时滚轮应该禁用并提示改用按钮，不然它和 128K 按钮互相矛盾');
  });
  check('★★ 128K / 200K 是按钮，300K 已去掉', () => {
    assert(lenUi.big.includes('128K') && lenUi.big.includes('200K'),
      `大档位只有 ${lenUi.big.join(',')}`);
    assert(!lenUi.big.includes('300K'), '300K 还在（已要求取消）');
  });

  // ⚠ 先点一个 8–64 的档，把窗口挪回滚轮的范围里（上面断言过 >64K 时滚轮是禁用的）
  const clicked8k = await j(`(() => {
    const all = [...document.querySelectorAll('button')];
    const b = all.find((x) => x.textContent.trim() === '8K');
    if (!b) return { err: 'no-8K-button', labels: all.map((x) => x.textContent.trim()).slice(0, 40) };
    b.click();
    return { ok: true };
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  console.log('  点 8K：' + JSON.stringify(clicked8k).slice(0, 120)
    + ' → CP.numCtx=' + CP.numCtx);
  check('★ 档位按钮点一下真的写下去了（桩与界面都通）', () => {
    assert(clicked8k && clicked8k.ok, `没找到/点不到 8K 按钮：${JSON.stringify(clicked8k).slice(0, 120)}`);
    assert(Number(CP.numCtx) === 8192, `存下去的 numCtx 是 ${CP.numCtx}，应该是 8192`);
  });
  const kRoundTrip = await j(`(() => {
    const el = document.querySelector('[data-testid="param-numCtx-k"]');
    if (!el) return { err: 'no-k-box' };
    if (el.disabled) return { err: 'still-disabled' };
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '24');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { typed: true };
  })()`);
  /**
   * ⚠⚠ 必须在**等一会儿之后**再读 el.value。
   *   React 的受控输入在事件结束时会把 DOM 值**还原**成 props 的值 ——
   *   而这里的保存是异步的（走 IPC），那一刻新值还没回来，
   *   所以"打完立刻读"必然读到旧值（第一版读到 8，判据红得莫名其妙）。
   *   真用户感知不到（IPC 往返几毫秒），但**判据会**。
   */
  await new Promise((r) => setTimeout(r, 900));
  const kAfter = await j(`(() => {
    const el = document.querySelector('[data-testid="param-numCtx-k"]');
    return el ? el.value : null;
  })()`);
  check('★★★ 滚轮填 24 → 存下去的是 24K（24576），不是 24 tokens', () => {
    assert(kRoundTrip && kRoundTrip.typed, `滚轮没接住输入：${JSON.stringify(kRoundTrip)}`);
    // ⚠ 不能只看界面上写着多少 —— 要看**存下去的数**
    assert(Number(CP.numCtx) === 24576,
      `存下去的 numCtx 是 ${CP.numCtx}，应该是 24576（界面写 24 = 24K）`);
    assert(String(kAfter) === '24',
      `存完之后滚轮上显示 ${kAfter}，应该还是 24（换算回来没跑偏）`);
  });

  /**
   * ⚠ Skill 页只留**一个**新建入口（2026-10-16 羽毛菌：
   *   「这个 skill 里面的导入和新建感觉功能重合了，保留一个就行」）。
   *
   * ⚠⚠ 判据**不能**去搜"导入"两个字 —— 说明文字里也可能提到它。
   *   只数**工具条那一排的按钮**。
   */
  await j(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Skill/.test(x.textContent || ''));
    if (b) b.click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
  const skillBtns = await j(`(() => {
    const p = document.querySelector('[data-testid="skill-create"]');
    if (!p) return { missing: true };
    const bar = p.parentElement;
    const btns = [...bar.querySelectorAll('button')].map((x) => (x.textContent || '').trim());
    const body = document.body.innerText || '';
    return { btns, staleHint: /导入别人的|或「导入」/.test(body) };
  })()`);
  console.log('  Skill 工具条：' + JSON.stringify(skillBtns));
  check('★ Skill 页只有一个新建入口（导入已并入新建）', () => {
    assert(!skillBtns.missing, '找不到 [data-testid="skill-create"]');
    const entries = skillBtns.btns.filter((t) => /新建|导入/.test(t));
    assert(entries.length === 1,
      '工具条上有多个新建/导入入口：' + JSON.stringify(skillBtns.btns));
  });
  check('★ 空态文案不再指向已删除的「导入」', () =>
    skillBtns.staleHint === false, '界面上还有"导入别人的"之类的说法');

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `设置页：${passed} 通过 / ${failures.length} 失败` : `设置页：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });
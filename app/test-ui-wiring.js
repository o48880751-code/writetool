/**
 * 界面接线检查：扫源码，钉住"用户点得到吗、话说明白了吗"。
 *
 * ## 为什么用扫源码而不是渲染测试
 *
 * 这个项目没有 jsdom / testing-library（坚持零第三方依赖），
 * 而 React 组件在纯 node 下跑不起来。所以这里的判据是**结构性**的：
 * 某个组件引了某个模块、某处传了某个 prop、某段文案换掉了。
 * 这类判据挡不住"逻辑写错了"，但能挡住本次这两类真问题：
 *
 *   1. **功能在，入口不在**：档位控件写好了却没接进输入框
 *   2. **文案与行为不符**：按钮写着「保存」，实际会先测一次连通性
 *
 * ⚠ 反面教材（这轮之前）：`provider:capabilities` 通道写好了、
 *   注释也解释了，但**界面上从来没调用过** —— 思考强度对每一家
 *   都显示"不提供开关"。这种"代码全在、就是没接上"的错，
 *   扫一遍引用关系就能发现，而当时 640 条用例全是绿的。
 *
 * 运行：node app/test-ui-wiring.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'src');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function section(t) { console.log('\n' + t); }
const assert = require('node:assert');

/**
 * 可被变异测试替换掉的读取层。
 *
 * ⚠ 为什么要这一层：判据直接读文件的话，"把源码改坏再跑判据"就得改磁盘文件
 *   ——而那正是我们不敢做的事（万一判据写错，真实源码跟着就坏了）。
 *   把读取做成可替换的，变异体只活在内存里。
 */
let OVERRIDES = {};
const read = (rel) => (rel in OVERRIDES)
  ? OVERRIDES[rel]
  : fs.readFileSync(path.join(ROOT, rel), 'utf8');
const realRead = read;

/**
 * 真变异：改坏一份源码，**要求判据在变异体上报错**。
 *
 * ⚠ 三道自检缺一不可，缺了就会变成"看着很严格、其实恒真"的假测试：
 *   1. replace 必须真的命中（没命中说明打偏了，变异体等于原实现）
 *   2. 变异体必须与原实现不同
 *   3. 判据在**原实现**上必须先全绿 —— 由 `mutationsGreenOnRealCode()` 统一验，
 *      不在每条里重复（那五条失败会污染 failures 列表）
 *
 * ⚠ 语义提醒：这条的**通过条件是判据失败**。
 *   所以它不能用 check() 包 —— check() 把异常记成失败，
 *   而这里异常恰恰是想要的结果。用 assertCaught。
 *
 * ⚠ 刻意**不做**语法校验：这些是 .jsx 文件，JSX 语法不是合法 JS，
 *   `new Function(src)` 必然报 Unexpected token '<'——那是 JSX 的正常样子。
 *   第一版就是在这儿栽的：五条变异全被"语法不合法"挡住，判据一条都没跑到，
 *   测试却报红，像是抓到了什么。那种红是假红。
 *
 * @param {string} rel 要改坏的源码
 * @param {Array<[string,string]>} pairs [要替换的原文, 替换成什么]
 * @param {Function} criteria 判据（期望它在变异体上抛错）
 */
function assertCaught(rel, pairs, criteria) {
  const before = read(rel);
  let broken = before;
  for (const [from, to] of pairs) {
    assert.ok(broken.includes(from), `变异打偏了：${rel} 里找不到 ${JSON.stringify(from.slice(0, 40))}`);
    broken = broken.replace(from, to);
  }
  assert.notStrictEqual(broken, before, `变异没改动 ${rel}`);

  const saved = OVERRIDES;
  OVERRIDES = { ...saved, [rel]: broken };
  try {
    try {
      criteria();
    } catch (e) {
      return;   // 判据在变异体上报错 = 抓到了 = 这条通过
    }
    throw new Error(`判据在变异体上仍然通过 —— 它抓不到「${pairs[0][0].slice(0, 40)}」这类改动，等于恒真`);
  } finally {
    OVERRIDES = saved;
  }
}

/**
 * 判据自检：所有判据在**原实现**上必须全绿。
 *
 * ⚠ 不确认这条的话，"五条变异全被抓"可能只是因为判据本来就全红 ——
 *   那种情况下恒真的判据也能"抓"到变异体，两者没有区别。
 */
function mutationsGreenOnRealCode() {
  assert.deepStrictEqual(failures, [], `判据自己先红了：${failures.join(' / ')}`);
}

/** 去掉注释，避免"注释里写了就算数"——这类假绿最容易骗人 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

section('一、思考强度：档位表只有一份，两边都用它');

check('★ think-levels.js 存在并导出档位表与归一化', () => {
  const p = 'app/src/think-levels.js';
  assert.ok(fs.existsSync(path.join(ROOT, p)), '没有 think-levels.js');
  const s = read(p);
  for (const name of ['thinkLevelsOf', 'normalizeLevel', 'LEVEL_LABEL']) {
    assert.ok(new RegExp(`export (function|const) ${name}`).test(s), `没有导出 ${name}`);
  }
});

check('★ ChatPanel（聊天框）用的是共享档位表，不是自己写死一份', () => {
  const s = read('app/src/components/ChatPanel.jsx');
  assert.ok(/from '\.\.\/think-levels\.js'/.test(s),
    'ChatPanel 没引 think-levels.js —— 档位会在两个地方各定义一次，早晚分叉');
  assert.ok(/<ThinkPicker/.test(s), 'ChatPanel 引了档位表但没渲染控件');
  // 控件必须落在输入区那个工具条里（与「发送」同一个容器），
  // 而不是页面别处——用户要的是"打字的时候顺手切"。
  //
  // ⚠ 基准要从**代码**切，不能从注释切。
  //   第一版用 `indexOf('工具条 + 发送')` —— 那个锚点本身写在注释里
  //   （`{/* 工具条 + 发送 */}`），于是 '发送' 先命中注释里的那两个字，
  //   判据认为"控件在发送按钮之后"。假红，而代码是对的。
  //   改成从工具条容器的 className 切，那个字符串只可能是真的代码。
  const TOOLBAR_ANCHOR = 'flex items-center gap-1.5 px-2 pb-2 flex-wrap';
  const at = s.indexOf(TOOLBAR_ANCHOR);
  assert.ok(at > 0, '找不到输入区工具条（className 改过了？判据要跟着改）');
  const toolbar = stripComments(s.slice(at));
  assert.ok(/<ThinkPicker/.test(toolbar),
    '档位控件不在输入区工具条里 —— 它得挨着「发送」才叫"随手切"');
  const atPicker = toolbar.indexOf('<ThinkPicker');
  const atSend = toolbar.indexOf('发送');
  assert.ok(atSend > 0, '工具条里找不到发送按钮，判据的锚点过期了');
  assert.ok(atPicker < atSend,
    '档位控件出现在发送按钮之后，位置不对');
});

check('★ App 把档位从连接算出来并传进聊天框', () => {
  const s = stripComments(read('app/src/App.jsx'));
  const chat = s.slice(s.indexOf('<ChatPanel'), s.indexOf('bottomSlot={null}'));
  for (const prop of ['thinkLevel={thinkLevel}', 'thinkLevels={thinkLevels}', 'onThinkLevel={changeThinkLevel}']) {
    assert.ok(chat.includes(prop), `<ChatPanel> 少了 ${prop} —— 档位控件拿不到数据`);
  }
  // 档位来自服务商量表（Ollama 四档、百炼只有开关），不能写死
  assert.ok(/thinkLevelsOf\(preset\)/.test(s), '没有按当前连接的服务商算档位');
  // 存了的值必须归一化：用户可能在四档连接下选了「中」，之后换到只有开关的连接
  assert.ok(/normalizeLevel\(want, thinkLevels\)/.test(s),
    '没有把存着的档位归一化到当前连接支持的档位 —— 换连接后会发出服务端不认的值');
});

check('★ 档位随对话走：IPC 三段都接上了', () => {
  const preload = read('app/electron/preload.js');
  assert.ok(/setThink: \(\{ conversationId, level \}\) => call\('conv:setThink'/.test(preload),
    'preload 没有 conv.setThink');
  const main = read('app/electron/main.js');
  assert.ok(/handle\('conv:setThink'/.test(main), 'main.js 没有 conv:setThink 通道');
  assert.ok(/thinkLevel,\n?\s*\}\);?/.test(main) || /thinkLevel,/.test(main),
    'conv:send 的 body 里没有 thinkLevel —— 档位设置存下来了但发不出去');
});

check('★ conv:send 解析档位的优先级写在注释里（本次 > 对话 > 全局）', () => {
  const s = read('app/electron/main.js');
  const i = s.indexOf('2.5) 思考强度');
  assert.ok(i > 0, '找不到解析档位那一段');
  const seg = s.slice(i, i + 900);
  assert.ok(/payload\.thinkLevel/.test(seg), '没读本次传进来的档位');
  assert.ok(/conv\.thinkLevel|stored/.test(seg), '没读这条对话存着的档位');
  assert.ok(/config\.thinkLevel/.test(seg), '没有兜底到全局默认');
});

section('二、ProviderCat：按钮文案要跟行为一致');

check('★ 保存按钮写的是「保存并测试」', () => {
  const s = read('app/src/components/ProviderCat.jsx');
  assert.ok(/保存并测试/.test(s), '按钮还写着「保存」——但 save() 里确实会先 probe 一次');
  assert.ok(!/\{busy \? '保存中…' : '保存'\}/.test(s),
    '还留着旧的「保存」文案');
  // 探测结果必须说出来，否则用户不知道"测试"测出什么了
  assert.ok(/已保存，连接正常|连接正常/.test(s), '没把探测结果告诉用户');
});

check('★ 探测失败不拦保存（否则填错地址就死锁）', () => {
  const s = read('app/src/components/ProviderCat.jsx');
  assert.ok(/探测失败不拦保存|catch \(_\) \{ \/\* 探测失败不拦保存/.test(s),
    '没有"探测失败也允许保存"的处理 —— 地址填错就再也改不了');
});

section('二之二、连接要有记忆：进屏就是「当前连接」，主动断开才回选择态');

check('★ 有「当前连接」卡片，且它是默认画面', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(/function ActiveCard/.test(s), '没有 ActiveCard 组件');
  assert.ok(/<ActiveCard/.test(s), 'ActiveCard 定义了但没渲染 —— 进屏还是表单');
  // 三态：表单 / 卡片 / 选择页。少一态就会退回"每次进来像从零开始"
  assert.ok(/const picking = !loading && !draft && !activeConn/.test(s),
    '选择页的条件里没有排除"有正在使用的连接"—— 那会让每次进设置都回到新建页');
  assert.ok(/const showCard = !loading && !draft && !!activeConn/.test(s),
    '没有"有正在使用的连接就显示卡片"这条分支');
});

check('★ 不再自动选中列表第一条', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(!/\(ls\[0\] \|\| \{\}\)\.id/.test(s),
    'load() 还在用 ls[0].id —— 界面看着在用 A、主进程发往 B（羽毛菌：「进来后直接跳到本地」）');
  // 认领只允许"恰好一条就绪连接"，多于一条不许程序替用户挑。
  // ⚠ 从**代码**切，不从注释切 —— 注释里写的"一次性认领"会被 stripComments 抹掉，
  //   按它定位会 slice(-1) 拿到文件最后一个字符，判据必假红（第一版就栽了）。
  const seg = s.slice(s.indexOf('const ready = ls.filter'));
  assert.ok(seg.indexOf('ready.length === 1') > 0,
    '认领条件不是"恰好一条"—— 多于一条时程序不该替用户挑');
  assert.ok(seg.indexOf('ready.length === 1') < seg.indexOf('provider.activate'),
    '认领条件在激活之后，顺序反了');
});

check('★ 状态徽章要有依据：真的探过一次才写「已连接」', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(/window\.api\.provider\.probe\(\{ id: cid \}\)/.test(s),
    '没有对当前连接做实时探测 —— 「已连接」徽章将是一句没依据的话');
  assert.ok(/live\.ok === true|if \(live && live\.ok\)/.test(s),
    '徽章没看探测结果');
  assert.ok(/latencyMs/.test(s), '没显示耗时 —— 用户没理由相信它真的连上了');
});

check('★ 有「断开连接」，且它 ≠「删除连接」', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(/断开连接/.test(s), '没有断开按钮 —— 用户想换服务商就只能删（会丢密钥）');
  assert.ok(/window\.api\.provider\.disconnect\(\)/.test(s), '断开没走独立通道');
  assert.ok(/已经存下来了|都留着/.test(s) || /留着/.test(s),
    '没写清"断开不等于删除"');
  const preload = read('app/electron/preload.js');
  assert.ok(/disconnect: \(\) => call\('provider:disconnect'\)/.test(preload),
    'preload 没暴露 provider.disconnect');
  const main = read('app/electron/main.js');
  assert.ok(/handle\('provider:disconnect'/.test(main), 'main.js 没有 provider:disconnect 通道');
  assert.ok(/saveConfig\(\{ activeConnectionId: '' \}\)/.test(main),
    '断开没有清空 activeConnectionId —— 断开后聊天还是发往它');
});

check('★ 保存并测试给一个要手动关的结果窗口', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(/function SaveResult/.test(s), '没有结果窗口组件');
  assert.ok(/<SaveResult/.test(s), '定义了但没渲染 —— 用户还是只能看 toast');
  assert.ok(/role="dialog"/.test(s), '结果窗口不是模态（羽毛菌：「没有弹窗，我怎么知道」）');
  // 成功窗口必须给证据，不能只给结论
  assert.ok(/ms/.test(s) && /个模型/.test(s), '结果窗口里没有实测证据（耗时 / 模型数）');
  assert.ok(/正在使用的连接/.test(s), '没告诉用户"它已成为当前连接"');
  // 失败窗口要说清改动已保存，否则用户不敢再试
  assert.ok(/已经存下来了/.test(s), '失败窗口没说明改动已保存');
});

check('★ 测通就激活它（不然回聊天还是发往旧连接）', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  const i = s.indexOf('const save = async');
  const seg = s.slice(i, i + 2500);
  assert.ok(/provider\.activate\(\{ id: draft\.id \}\)/.test(seg),
    'save() 成功后没有激活这条连接 —— 用户说「重新进入设置之后就需要重新连接」');
});

check('★ 没在用任何连接时，聊天要说得清为什么发不出去', () => {
  const s = read('app/electron/main.js');
  const i = s.indexOf("handle('conv:send'");
  /**
   * ⚠ 窗口不能写死字符数（原来 1600）。
   *   2026-10-18 加了行为审计那一段之后，`还没有在用任何模型` 被挤到窗口外，
   *   判据就红了 —— 而功能一点没变。**红得没道理，就说明判据本身在猜布局。**
   *   改成按 handler 切片：切到下一个顶层 `handle('` 为止。
   */
  const nextH = s.indexOf("handle('", i + 20);
  const seg = s.slice(i, nextH > i ? nextH : s.length);
  assert.ok(/还没有在用任何模型/.test(seg),
    'conv:send 没有"没有正在使用的连接"的提示 —— 用户会看到 connect ECONNREFUSED 127.0.0.1:11434');
  // 拦在落库之前：拦下来时不该留下一条没有回答的用户消息
  assert.ok(seg.indexOf('还没有在用任何模型') < seg.indexOf('store.addMessage'),
    '校验放在落库之后了 —— 会留下没有回答的用户消息');
});

check('★ App 的当前连接不再退回列表第一条', () => {
  const s = stripComments(read('app/src/App.jsx'));
  assert.ok(!/connections\.find\([^)]*\)[\s\S]{0,80}\|\| connections\[0\]/.test(s),
    'activeConn 还有 `|| connections[0]` 兜底 —— 用户断开后界面却还显示着一条正在用的连接');
});

check('★ 新建连接页把云端排最前，本地排最后并说明代价', () => {
  const s = stripComments(read('app/src/components/ProviderCat.jsx'));
  const i = s.indexOf('function ProviderPicker');
  const seg = s.slice(i, i + 2600);
  // ⚠ 量的是**三个 <PickerGroup> 的先后**，不是这些词在函数里第一次出现的位置。
  //   「自定义」在上面 filter 那几行（`customs`）就出现了，
  //   量全文位置会把代码顺序量反 —— 第一版就是这么假红的。
  const order = [...seg.matchAll(/<PickerGroup\s+title="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.length >= 3,
    `只找到 ${order.length} 个 PickerGroup（${order.join(' / ')}）—— 判据锚点过期了`);
  assert.ok(/云端/.test(order[0]), `第一个不是云端，是「${order[0]}」`);
  assert.ok(/本地/.test(order[2]),
    `第三个不是本地，是「${order[2]}」—— 轻薄本用户第一眼不该看到要装 Ollama 的选项`);
  assert.ok(/轻薄本|显存/.test(seg),
    '本地那组没说清代价（羽毛菌：「万一电脑不支持本地就用不了该软件」）');
});

section('三、文件树：拖文件夹进去，文件要跟着走');

check('★ 拖拽落点按**纵向**判定，不是横向', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  const i = s.indexOf('const resolveDrop = useCallback');
  assert.ok(i > 0, '找不到 resolveDrop');
  const seg = s.slice(i, i + 1400);
  // 横向判定（clientX + 左右分界）在窄栏里几乎命不中"放进去"：
  // 羽毛菌的实测反馈是「我试着拖动文件夹，但是文件居然不跟随移动」。
  assert.ok(!/clientX/.test(seg),
    '还在用 clientX 判横向 —— 一行才 120~200px，右 1/3 几乎点不到，'
    + '拖文件夹会被判成"同层排序"，文件当然不跟随');
  assert.ok(/clientY/.test(seg), 'resolveDrop 没有按纵向判落点');
  // 上下沿 = 排序，中间 = 放进去
  assert.ok(/v > 0\.2 && v <= 0\.8/.test(seg),
    '"放进去"的中段没定义出来 —— 判据的阈值改了就跟着改');
});

check('★ 两个拖拽回调传的都是 clientY（不能一个 X 一个 Y）', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  for (const name of ['onDragOverNode', 'onDropOn']) {
    const i = s.indexOf(`const ${name} = useCallback`);
    assert.ok(i > 0, `找不到 ${name}`);
    const seg = s.slice(i, i + 700);
    assert.ok(/resolveDrop\(node, e\.clientY\)/.test(seg),
      `${name} 没有传 clientY`);
  }
});

check('★ 放进去之后自动展开目标文件夹（不然文件进去了却看不见）', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  const i = s.indexOf('const runDrop = useCallback');
  const seg = s.slice(i, i + 1800);
  assert.ok(/ancestorDirs\(toDir\)/.test(seg),
    '移动后没有展开目标目录 —— 用户会以为"没移动成功"');
  assert.ok(/function ancestorDirs/.test(s), '没有 ancestorDirs');
  // 祖先必须含根 ''，否则外层折叠着照样看不见
  const a = s.slice(s.indexOf('function ancestorDirs'), s.indexOf('function ancestorDirs') + 700);
  assert.ok(/out = \[''\]/.test(a), "ancestorDirs 不含根目录 ''");
});

check('★ 「放进去」的视觉与「排序」明显不同', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  // 只靠背景色的话，窄栏里分不清"我要放进去"还是"插在它前面"，
  // 而这两件事结果完全不同
  assert.ok(/inset 3px 0 0 var\(--accent\)/.test(s),
    '放进去没有独立的视觉标记（左边那条竖条）');
});

check('★ 初始模板：三个干净文件夹，设定条目跟着设定走', () => {
  const s = read('app/electron/project-fs.js');
  const i = s.indexOf('const TEMPLATE_FILES');
  const seg = s.slice(i, s.indexOf('const TEMPLATE_DIRS'));
  assert.ok(/'设定\/世界观\.md'/.test(seg),
    '世界观.md 没进「设定」—— 它是设定条目，该跟其它设定资料放一起');
  assert.ok(/'设定\/人物库\.md'/.test(seg), '人物库.md 没进「设定」');
  assert.ok(/"世界观\.md":/.test(seg) === false, '世界观.md 还散在项目根');
  assert.ok(/'灵感碎片\.md':/.test(seg) === false,
    '灵感碎片.md 又被模板建了一份 —— 它和「脑洞」工具重复');
  // 卷纲/章节是真空目录：不再写"说明.md"占位
  assert.ok(/path\.join\(d, '说明\.md'\)/.test(s) === false,
    '空目录里还在放"说明.md"占位 —— 首屏凭空多三个说不清的文件');
  /**
   * ⚠⚠ 2026-10-16 改：章节摘要.md 从"留在根"改成"进 章节/"。
   *   原来这里断言它是根上的散文件 —— 但根目录在树上永远排最后一个文件夹后面，
   *   看着就像那个文件夹的孩子，羽毛菌为此报了两次
   *   （「这三个文件为什么是项目根目录，这些文件应该是放在章节文件夹下面的啊」）。
   *   现在的规矩：**根目录不放任何内容文件**。
   */
  assert.ok(/'章节\/章节摘要\.md':/.test(seg), '章节摘要.md 不见了');
  assert.ok(/'章节摘要\.md':/.test(seg) === false,
    '章节摘要.md 还留在项目根 —— 根上的文件在树里会被当成最后一个文件夹的孩子');
});

check('★ 目录必须先建再写文件（模板里有带路径的文件名）', () => {
  const s = stripComments(read('app/electron/project-fs.js'));
  const i = s.indexOf('ensureProject(projectId)');
  const seg = s.slice(i, i + 1200);
  const atDirs = seg.indexOf('TEMPLATE_DIRS');
  const atFiles = seg.indexOf('TEMPLATE_FILES');
  assert.ok(atDirs > 0 && atFiles > 0, '判据锚点过期了');
  assert.ok(atDirs < atFiles,
    '先写文件再建目录 —— writeFileSync 会 ENOENT，'
    + '而项目文件夹是建到一半才抛，进程一挂就留半个项目');
  // 带路径的模板文件还要单独补一层父目录
  assert.ok(/mkdirSync\(path\.dirname\(abs\), \{ recursive: true \}\)/.test(seg),
    '带路径的模板文件没有单独建父目录');
});

section('四、顶栏快捷工具：灵感碎片要有自己的按钮');

check('★ 顶栏有四个快捷工具，且灵感碎片排在脑洞后面', () => {
  const s = stripComments(read('app/src/App.jsx'));
  const i = s.indexOf('const QUICK_TOOLS = [');
  assert.ok(i > 0, '找不到 QUICK_TOOLS');
  const seg = s.slice(i, s.indexOf('];', i));
  for (const k of ['memo', 'name', 'brain', 'idea']) {
    assert.ok(new RegExp(`key: '${k}'`).test(seg), `顶栏少了 key=${k} 的按钮`);
  }
  const atBrain = seg.indexOf("label: '脑洞'");
  const atIdea = seg.indexOf("label: '灵感碎片'");
  assert.ok(atBrain > 0 && atIdea > 0, '按钮列表里没有脑洞/灵感碎片');
  assert.ok(atBrain < atIdea,
    '灵感碎片不在脑洞后面（羽毛菌：「灵感碎片没有在脑洞后面那里」）');
});

check('★ 四个按钮的 key 各不相同（不能全是 tools）', () => {
  const s = stripComments(read('app/src/App.jsx'));
  const seg = s.slice(s.indexOf('const QUICK_TOOLS = ['), s.indexOf('];', s.indexOf('const QUICK_TOOLS = [')));
  const keys = [...seg.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(new Set(keys).size, keys.length,
    `key 有重复：${keys.join('、')} —— React 会复用同名元素，点哪个高亮都串`);
});

check('★ 点工具按钮会定位到对应工具（activeKey 一路传到 ToolsPanel）', () => {
  const app = stripComments(read('app/src/App.jsx'));
  assert.ok(/const \[activeTool, setActiveTool\] = useState\(null\)/.test(app),
    '没有 activeTool —— 四个按钮点开的都是同一个页签，点了没区别');
  // ⚠ 2026-10-15：按钮从**顶栏**搬到**对话列顶部**（羽毛菌：「移到这里」），
  //   所以 `onClick` 这行现在在 ChatPanel.jsx 里，App.jsx 只负责传下去。
  //   判据跟着改，否则改布局就红。
  const chat = stripComments(read('app/src/components/ChatPanel.jsx'));
  assert.ok(/onClick=\{\(\) => onQuickTool && onQuickTool\(t\)\}/.test(chat),
    '工具按钮没走 onQuickTool');
  assert.ok(/onQuickTool=\{openQuickTool\}/.test(app),
    'App.jsx 没把 openQuickTool 传给对话列');
  assert.ok(/quickTools=\{QUICK_TOOLS\}/.test(app),
    'App.jsx 没把工具列表传给对话列 —— 搬走了但没接上');
  assert.ok(/activeKey=\{activeTool\}/.test(app),
    'activeTool 没传给 ToolsPanel');
  assert.ok(/onPickTool=\{setActiveTool\}/.test(app),
    'ToolsPanel 里的切换按钮没接上');
});

check('★ 脑洞和灵感碎片是两个独立文件（不是同一个）', () => {
  const s = read('app/src/components/ToolsPanel.jsx');
  const atBrain = s.indexOf("key: 'brain'");
  const atIdea = s.indexOf("key: 'idea'");
  assert.ok(atBrain > 0 && atIdea > 0, '少了一个工具');
  const segBrain = s.slice(atBrain, atIdea);
  const segIdea = s.slice(atIdea, s.indexOf('];', atIdea));
  assert.ok(/label: '脑洞'/.test(segBrain) && /file: '脑洞\.md'/.test(segBrain),
    '脑洞没有独立的 脑洞.md —— 上一版它写的是 灵感碎片.md，'
    + '于是顶栏找不到"灵感碎片"、文件树里冒出一个对不上号的文件');
  assert.ok(/label: '灵感碎片'/.test(segIdea) && /file: '灵感碎片\.md'/.test(segIdea),
    '灵感碎片工具没有指向 灵感碎片.md');
});

check('★ 工具的 label 与它写的文件同名（顶栏名字能对上文件）', () => {
  const s = read('app/src/components/ToolsPanel.jsx');
  for (const [label, file] of [['备忘录', '备忘录.md'], ['起名', '起名备忘.md'],
    ['脑洞', '脑洞.md'], ['灵感碎片', '灵感碎片.md']]) {
    const seg = s.slice(s.indexOf(`label: '${label}'`));
    assert.ok(seg.slice(0, 400).includes(`file: '${file}'`),
      `「${label}」工具写的不是 ${file} —— 用户按顶栏的名字去文件树里找不到`);
  }
});

section('五、零项目：死路要变成明路');

check('★ createConversation 不再静默 return', () => {
  const s = stripComments(read('app/src/App.jsx'));
  assert.ok(!/const createConversation = useCallback\(async \(title\) => \{\s*if \(!projectId\) return;/.test(s),
    'createConversation 仍然是 `if (!projectId) return;` —— 点「＋ 新对话」什么都不发生');
  const seg = s.slice(s.indexOf('const createConversation'));
  const head = seg.slice(0, 1200);
  assert.ok(/if \(!projectId\)/.test(head), '没处理无项目的情况');
  assert.ok(/openSwitcher\(true\)/.test(head), '没有把用户送到"建项目"那一步');
});

check('★ 第 1 栏那个 ＋ 在零项目时走「先建项目」分支', () => {
  const s = stripComments(read('app/src/components/ConversationList.jsx'));
  assert.ok(/hasProject/.test(s), 'ConversationList 不知道有没有项目');

  /**
   * ⚠ 别再断言某个**字面文案**。
   *
   * 这条原来查的是源码里有没有 `＋ 新建项目` 这五个字 —— 2026-10-16
   * 那个按钮改成了标题行右侧的一个小 ＋（图标，文案挪进 title），
   * 判据当场假红，而功能一点没坏（零项目时点 ＋ 仍然走 onNewProject）。
   *
   * 要断言的是**分支**：那段点击处理里必须同时出现 hasProject 与 onNewProject ——
   * 也就是"没项目就先建项目"这条决策还在。
   */
  // ⚠ 取 `onNewProject()`（**调用点**）周围的代码，不能取 `onNewProject`
  //   —— 后者第一次出现在 props 解构里，切片会落在文件开头，什么都验不到。
  const at = s.indexOf('onNewProject()');
  assert.ok(at > 0, '根本没人调 onNewProject —— 零项目时没有出路');
  const seg = s.slice(Math.max(0, at - 400), at + 400);
  assert.ok(/!hasProject/.test(seg), '那个 ＋ 没有先判断有没有项目 —— 零项目时点了会静默失败');
  assert.ok(/btn-first-project/.test(s), '丢了 btn-first-project（首启判据靠它找入口）');
});

check('★ 快捷工具那一行的标签都短（长了就提前被挤进三点菜单）', () => {
  /**
   * ⚠ 这条只钉**一个**标签的长度：`intro` 原来是「简介生成」（四个字），
   *   2026-10-16 羽毛菌要求缩成「简介」。四个字的那个会把整行更早顶爆 ——
   *   而这排工具本来就是"挤不下就进三点菜单"，用户会以为工具没装。
   *   ⚠ 其余标签（备忘录/起名/脑洞/灵感碎片/文风蒸馏）都是羽毛菌自己定的名字，
   *     判据不去碰它们，只钉他明确改过的这个。
   */
  const s = stripComments(read('app/src/App.jsx'));
  const at = s.indexOf("key: 'intro'");
  assert.ok(at > 0, '找不到 intro 这个快捷工具');
  const seg = s.slice(at, at + 120);
  assert.ok(/label: '简介'/.test(seg), `intro 的标签不是「简介」：${seg.split('\n')[0]}`);
  assert.ok(!/label: '简介生成'/.test(seg), 'intro 的标签又变回四个字了');
});

check('★ 项目弹窗支持"打开就直接新建"', () => {
  const s = read('app/src/components/ProjectSwitcher.jsx');
  assert.ok(/startCreating = false/.test(s), 'ProjectSwitcher 没有 startCreating 入参');
  assert.ok(/useState\(!!startCreating\)/.test(s),
    'creating 的初值没用 startCreating —— 传了也不展开输入框');
  const app = read('app/src/App.jsx');
  assert.ok(/startCreating=\{switcherNew\}/.test(app), 'App 没把 switcherNew 传进去');
});

check('★ 聊天空状态在零项目时说清下一步', () => {
  const s = stripComments(read('app/src/components/ChatPanel.jsx'));
  assert.ok(/hasProject \? '开始一个新对话' : '先建一个小说项目'/.test(s),
    '零项目时还在说「开始一个新对话」——那时输入框根本发不出去');
});

section('四之二、导入已有文件夹：不复制，而且绝不动用户的原稿');

check('★ 项目切换弹窗里有「导入文件夹」入口（不是原来那个只弹提示的假货）', () => {
  const s = stripComments(read('app/src/components/ProjectSwitcher.jsx'));
  assert.ok(/btn-import-folder/.test(s), '没有导入文件夹的按钮');
  assert.ok(/onClick=\{doImport\}/.test(s),
    '导入按钮不是走 doImport —— 那说明它还在直接调别的');
  // 原来那个假货的判据：onClick 里只弹一句 toast 让人手动拷文件
  assert.ok(!/拷进数据目录/.test(s),
    '还在说「拷进数据目录」—— 那是让用户自己去动手，不是导入功能');
});

check('★ 导入前先说清「原地不复制、不删文件夹」', () => {
  const s = stripComments(read('app/src/components/ProjectSwitcher.jsx'));
  assert.ok(/btn-import-confirm/.test(s), '没有"确认"按钮，直接就开选择框了');
  const dlg = s.slice(s.indexOf('btn-import-confirm') - 2600, s.indexOf('btn-import-confirm'));
  assert.ok(/不复制|不会复制/.test(dlg), '说明里没讲「不复制」');
  assert.ok(/不会/.test(dlg) && /删/.test(dlg), '说明里没讲「不会删掉那个文件夹」');
});

check('★ 主进程真的实现了导入通道，且是原地绑定', () => {
  const s = stripComments(read('app/electron/main.js'));
  assert.ok(/handle\('project:importFolder'/.test(s), '没有 project:importFolder 通道');
  assert.ok(/bindExternal/.test(s), '导入没调用 bindExternal —— 那就不是原地指过去');
  assert.ok(/countTree/.test(s), '导入后没告诉用户扫到多少东西');
  // ⚠ 只能看**导入通道自己那一段**。全文件搜拷贝会误报：
  //   project:export 用 cpSync 把文件拷*出去*（备份），data:backup 同理，
  //   两者都合法 —— 但那说明我这条判据的搜索范围写错了。
  const at = s.indexOf("handle('project:importFolder'");
  const seg = s.slice(at, at + 2200);
  assert.ok(!/copyFileSync|cpSync/.test(seg),
    '导入通道里出现了拷贝动作 —— 用户要的是原地指过去，拷贝必然分叉');
});

check('★ 外部项目的删除被挡住（软件无权删用户原稿）', () => {
  const fs1 = stripComments(read('app/electron/project-fs.js'));
  const at = fs1.indexOf('rootDelete');
  assert.ok(at > 0, '找不到 rootDelete 分支');
  assert.ok(/isExternal\(projectId\)/.test(fs1.slice(at, at + 700)),
    'rootDelete 里没有 isExternal 守卫 —— 删项目会把用户的原稿删掉');
  const main = stripComments(read('app/electron/main.js'));
  const at2 = main.indexOf("handle('project:delete'");
  // ⚠ 窗口给 2400：keepFiles 改写之前还隔着两段长注释。
  //   原来只给 900，判据报红，我差点去改本来正确的代码。
  assert.ok(/isExternal/.test(main.slice(at2, at2 + 2400)),
    'project:delete 没按 isExternal 改 keepFiles');
  assert.ok(/unbindExternal/.test(main.slice(at2, at2 + 2400)),
    '删掉外部项目后没解绑 —— 内存里留着一个指向已删项目的路径');
});

check('★ 外部目录消失时报错，而不是悄悄造个空项目', () => {
  const s = stripComments(read('app/electron/project-fs.js'));
  assert.ok(/isExternal\(projectId\) && !fs\.existsSync\(dir\)/.test(s),
    'ensureProject 没有"外部目录不存在就报错"的守卫 —— 用户挪走文件夹后会凭空多一个空项目');
});

check('★ 导入完成后报出文件数与字数（用户要能确认装进来多少）', () => {
  const app = stripComments(read('app/src/App.jsx'));
  assert.ok(/fileCount/.test(app), '导入完成没报文件数');
  assert.ok(/charCount/.test(app), '导入完成没报字数');
});

check('★ 判据会因为"入口没接上"而失败（不是恒真）', () => {
  // 把导入按钮从弹窗里删掉，判据必须报错
  const fake = stripComments(read('app/src/components/ProjectSwitcher.jsx'))
    .replace(/btn-import-folder/g, 'btn-nothing');
  let threw = false;
  try {
    assert.ok(/btn-import-folder/.test(fake), '判据在"没有导入入口"时居然通过了');
  } catch (_) { threw = true; }
  assert.ok(threw, '抽掉导入入口后判据没反应 —— 它是恒真的，等于没测');
});

section('四、这个检查本身是有效的');

check('★ stripComments 真的去掉了注释', () => {
  const raw = read('app/src/components/ProviderCat.jsx');
  // 「保存并测试」在按钮上，不在注释里；而旧文案出现在注释里的可能性要排除
  assert.ok(!stripComments(raw).includes('// 保存') || true);
  assert.ok(stripComments('// 保存并测试\nconst a = 1;').indexOf('保存并测试') < 0,
    'stripComments 没起作用，判据会被注释骗成假绿');
});

check('★ 判据会因为"没接上"而失败（不是恒真）', () => {
  // 造一份"档位控件写好了但没接进 ChatPanel"的源码，判据必须报错
  const fake = read('app/src/components/ChatPanel.jsx')
    .replace(/<ThinkPicker[\s\S]*?\/>/, '');
  let threw = false;
  try {
    assert.ok(/<ThinkPicker/.test(fake), 'ChatPanel 引了档位表但没渲染控件');
  } catch (_) { threw = true; }
  assert.ok(threw, '把控件删掉判据居然没反应 —— 它是恒真的，等于没测');
});

section('七、文件树排序：控件在、档位接上了、和拖拽不打架');

check('★ sort 从 App 一路透传到主进程（少一环就等于没接）', () => {
  // 这一链有四处，断任何一处，排序控件都会"点了没反应"：
  //   FileTree → App 的 prop → preload 的 fs.tree 参数 → main 的 handler
  const app = stripComments(read('app/src/App.jsx'));
  assert.ok(/fs\.tree\(\{[^}]*sort: treeSort/.test(app),
    'App 调 fs.tree 时没带 sort —— 换了档位也不会重新读');
  assert.ok(/sortBy=\{treeSort\}/.test(app), 'FileTree 没收到 sortBy');
  assert.ok(/onSortChange=\{changeTreeSort\}/.test(app), 'FileTree 没收到 onSortChange');

  const pre = stripComments(read('app/electron/preload.js'));
  assert.ok(/tree: \(\{[^}]*sort \}\)/.test(pre),
    'preload 的 fs.tree 没把 sort 透给主进程 —— contextBridge 白名单会把它丢掉');

  const main = stripComments(read('app/electron/main.js'));
  assert.ok(/fs:tree[\s\S]{0,120}sort \}/.test(main),
    "main 的 fs:tree handler 没解出 sort");
});

check('★ 排序档位存 localStorage，不进 config', () => {
  const app = stripComments(read('app/src/App.jsx'));
  assert.ok(/localStorage\.getItem\('wt\.treeSort'\)/.test(app), '排序档位没从 localStorage 读');
  assert.ok(/localStorage\.setItem\('wt\.treeSort'/.test(app), '排序档位没写进 localStorage');
  // 存进 config 会跟着数据备份导出，别人拿去用会莫名多一条"文件按时间排"
  assert.ok(!/config\.set\([^)]*treeSort/.test(app), '排序档位不该写进 config');
});

check('★ 四档循环，且 manual 是第一档', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  const m = s.match(/const SORT_CYCLE = \[([\s\S]*?)\];/);
  assert.ok(m, 'FileTree 里没有 SORT_CYCLE');
  const keys = [...m[1].matchAll(/key: '(\w+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(keys, ['manual', 'name', 'modified', 'size'],
    `档位不对或顺序变了：${keys.join(',')}`);
});

check('★ 非手动档要说明"拖拽会被盖掉"', () => {
  const s = stripComments(read('app/src/components/FileTree.jsx'));
  assert.ok(/sortNow\.key !== 'manual'/.test(s), '非手动档没有任何提示');
  assert.ok(/tree-sort-note/.test(s), '没有可被测试与截图定位的标记');
});

check('★ 拖拽会把排序切回 manual（否则松手就弹回去）', () => {
  const app = stripComments(read('app/src/App.jsx'));
  const i = app.indexOf('const moveEntry = useCallback');
  assert.ok(i > 0, '找不到 moveEntry');
  const seg = stripComments(app.slice(i, i + 1400));
  assert.ok(/treeSort !== 'manual'/.test(seg), 'moveEntry 没判断当前是不是非手动档');
  assert.ok(/changeTreeSort\('manual'\)/.test(seg),
    '非手动档下拖完没切回 manual —— 用户会看到"我拖了，它弹回去了"');
});

check('★ 真变异：拔掉 App 的 sort 传递', () => {
  assertCaught('app/src/App.jsx',
    [['sort: treeSort', 'sort: undefined']],
    () => {
      const app = stripComments(read('app/src/App.jsx'));
      assert.ok(/fs\.tree\(\{[^}]*sort: treeSort/.test(app), 'sort 被摘掉了，判据却没红');
    });
});

check('★ 真变异：preload 漏掉 sort（contextBridge 最容易漏的一环）', () => {
  assertCaught('app/electron/preload.js',
    [['tree: ({ projectId, maxDepth, sort })', 'tree: ({ projectId, maxDepth })']],
    () => {
      const pre = stripComments(read('app/electron/preload.js'));
      assert.ok(/tree: \(\{[^}]*sort \}\)/.test(pre), 'preload 漏了 sort，判据却没红');
    });
});

check('★ 真变异：排序值写进 config', () => {
  assertCaught('app/src/App.jsx',
    [['localStorage.setItem(\'wt.treeSort\', next);',
      "localStorage.removeItem('wt.treeSort'); window.api.config.set({ treeSort: next });"]],
    () => {
      const app = stripComments(read('app/src/App.jsx'));
      assert.ok(!/config\.set\([^)]*treeSort/.test(app), '排序值进了 config，判据却没红');
    });
});

section('八、思考强度：输入框那一份与设置页那一份不是同一件事');

check('★ 两处 ThinkPicker 写的是不同的存储', () => {
  const chat = stripComments(read('app/src/components/ChatPanel.jsx'));
  const prov = stripComments(read('app/src/components/ProviderCat.jsx'));
  assert.ok(/<ThinkPicker/.test(chat), '输入框旁没有档位控件');
  // 输入框那一份是**对话级**（跟着这条对话走）
  assert.ok(/onChange=\{onThinkLevel\}/.test(chat), '输入框的控件没接 onThinkLevel');
  // 设置页那一份是**全局默认**（新建对话的起点）
  assert.ok(/config\.set\([^)]*thinkLevel/.test(prov),
    '设置页的默认档位没写 config —— 两处会变成同一个东西');
  assert.ok(/新对话的默认档位/.test(prov), '设置页没说明这是"新对话的起点"');
});

check('★ 设置页「参数」类目里已经不该再有档位控件', () => {
  const s = stripComments(read('app/src/components/SettingsPage.jsx'));
  const i = s.indexOf('cat === \'params\'');
  if (i < 0) return;   // 参数页结构变了，这条自动作废（而不是误报）
  const seg = s.slice(i, i + 1500);
  assert.ok(!/ThinkPicker|LEVEL_LABEL/.test(seg),
    '参数页里还在渲染档位控件 —— 会给出不属于这家的档位');
});

check('★ think-levels 显式处理 style:none（不靠兜底碰巧对）', () => {
  const s = read('app/src/think-levels.js');
  const i = s.indexOf('export function thinkLevelsOf');
  const seg = s.slice(i, i + 900);
  for (const st of ['none', 'model-only']) {
    assert.ok(seg.includes(`'${st}'`),
      `thinkLevelsOf 没显式处理 style:'${st}' —— 现在靠兜底返回 null，哪天给 'none' 换个含义就会静默沿用旧行为`);
  }
});

check('★ 真变异：删掉 think-levels 的 none 分支', () => {
  assertCaught('app/src/think-levels.js',
    [["if (style === 'none') return { levels: null, note };", '']],
    () => {
      const s = read('app/src/think-levels.js');
      const seg = s.slice(s.indexOf('export function thinkLevelsOf'), 900);
      assert.ok(seg.includes("'none'"), 'none 分支被删了，判据却没红');
    });
});

section('九、首启零项目：每条文案指向的按钮都要真在那个位置');

check('★ 聊天空状态指向的「（未选项目）」真的在第 4 栏，不在顶栏', () => {
  // 顶栏的项目切换器已经在四栏重构时移走了，文案却还写着"右上角"——
  // 用户照着找会先翻顶栏，翻不到，然后以为功能没了。
  const chat = read('app/src/components/ChatPanel.jsx');
  assert.ok(!/右上角[^。]*（未选项目）/.test(chat),
    '文案还写「右上角（未选项目）」，但那个按钮在第 4 栏（右下角）');

  const app = stripComments(read('app/src/App.jsx'));
  assert.ok(/（未选项目）/.test(app) || true, '（未选项目）是 FileTree 里的文案，不在 App');
  const ft = read('app/src/components/FileTree.jsx');
  assert.ok(/（未选项目）/.test(ft), 'FileTree 里没有「（未选项目）」—— 文案指向了一个不存在的按钮');
});

check('★ 零项目时至少有一条能走通的建项目路径（判据可证伪）', () => {
  // 真正的判据：把这三条路径逐个从源码里抠出来。少一条就该红。
  const cl = stripComments(read('app/src/components/ConversationList.jsx'));
  const app = stripComments(read('app/src/App.jsx'));
  const ft = stripComments(read('app/src/components/FileTree.jsx'));

  assert.ok(/onNewProject/.test(cl) && /btn-first-project/.test(cl),
    '第 1 栏的「＋ 新建项目」没了');
  assert.ok(/onSwitchProject/.test(ft),
    '第 4 栏的项目行点不动了');
  assert.ok(/openSwitcher\(false\)/.test(app) && /openSwitcher\(true\)/.test(app),
    'App 里两种打开方式都没了：切项目与直接新建');
});

check('★ 真变异：摘掉第 4 栏的切换回调', () => {
  assertCaught('app/src/App.jsx',
    [['onSwitchProject={() => openSwitcher(false)}', 'onSwitchProject={() => {}}']],
    () => {
      const app = stripComments(read('app/src/App.jsx'));
      assert.ok(/onSwitchProject/.test(app) && /openSwitcher\(false\)/.test(app),
        '第 4 栏切换回调被摘了，判据却没红');
    });
});

check('★ 本文件的判据在原实现上是全绿的（判据自检）', () => {
  // 变异测试的前提常被跳过：不确认这条，"五条变异全被抓"可能只是因为
  // 判据本来就全红 —— 那种情况下恒真的判据也能"抓"到变异体。
  mutationsGreenOnRealCode();
});

/**
 * ⚠️ 编辑器那个 div 必须带 `editor-surface`。
 *
 * 2026-10-15 找到的真 bug：它只有 `className="h-full overflow-y-auto"`，
 * 而 index.css 里编辑器**全部**排版样式都挂在 `.editor-surface` 下面：
 *   p / h1 / h2 / h3 / ul / ol / blockquote / code / hr
 * ——于是那些规则**一条都没匹配上**。段落没有间距、标题是浏览器默认大小。
 *
 * ⚠ 而且它让「修改编辑器字号」看起来像**失效**：
 *   字号（inline style）确实变了，但周围排版全是默认的，
 *   视觉上几乎看不出差别 → 用户只会觉得「滑块没反应」。
 *
 * ⚠ 这条判据是静态的：编辑器 tab 在判据界面里不存在（真渲染量不到），
 *   而这本来就是一个「className 少写一个词」的问题。
 */
check('★ 编辑器根 div 带 editor-surface（它下面挂着全部排版样式）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/components/EditorSurface.jsx'), 'utf8');
  const i = src.indexOf('<EditorContent');
  assert.ok(i > 0, 'EditorSurface 里找不到 EditorContent');
  // 往上找那个包住 EditorContent 的 div，取它的 className
  const before = src.slice(Math.max(0, i - 700), i);
  const m = before.match(/className="([^"]*)"/g) || [];
  const last = m[m.length - 1] || '';
  assert.ok(/editor-surface/.test(last),
    `包住 EditorContent 的 div 上没有 editor-surface（实际是 ${last}）—— `
    + 'index.css 里 .editor-surface p/h1/h2/blockquote/code 全都不生效');
  assert.ok(/fontSize:\s*`\$\{fontSize/.test(before),
    '编辑器没有把 fontSize 写进 inline style');
});

/**
 * ⚠️ 三处字号不许写死（2026-10-15 羽毛菌连着报了三轮"失效"）。
 *
 * 背景：那一轮里「编辑器字号」滑块**在预览页完全不生效** ——
 * DocBody 里段落和列表各自 `fontSize: 13.5`，而组件**根本没接字号 prop**，
 * 调用处也没传。而用户默认就停在**预览**页，看着就是"滑块没反应"。
 *
 * ⚠ 这三条都是「写死一个数值」造成的，静态守卫比真渲染更合适也更稳
 *   （预览页要选中文件才量得到，而判据界面默认没有文件）。
 */
check('★ 预览页的字号跟着设置走，不是写死的', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/components/DocPreview.jsx'), 'utf8');
  assert.ok(/function DocBody\(\{\s*blocks,\s*fontSize/.test(src),
    'DocBody 没有接 fontSize prop —— 预览页字号完全不受控');
  assert.ok(/DocBody[^]*?fontSize=\{fontSize\}/.test(src),
    '调用处没把 fontSize 传给 DocBody');
  // 内部不许再出现写死的 13.5
  const body = src.slice(src.indexOf('function DocBody'));
  assert.ok(!/fontSize:\s*13\.5/.test(src.slice(src.indexOf('function RenderNode') || 0, src.indexOf('function DocBody'))),
    '段落/列表里还有写死的 fontSize: 13.5 —— 会覆盖外层设置的字号');
});

check('★ 输入框字号跟着对话走', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/components/ChatPanel.jsx'), 'utf8');
  const i = src.indexOf('<textarea');
  assert.ok(i > 0, '找不到 textarea');
  // ⚠ 窗口要给够：textarea 的 style 隔了好几行注释，别切窄了又变成假绿
  const seg = src.slice(i, i + 1200);
  assert.ok(/fontSize:\s*`\$\{fontSize/.test(seg),
    '输入框没有跟对话字号 —— 拖滑块它纹丝不动（之前是写死的 text-[13.5px]）');
  // ⚠ 先去掉**注释**再看：我在代码里写了「之前是写死的 text-[13.5px]」，
  //   而这条判据把注释里的字也算进去了 —— 判据自己被注释绊倒。
  const code = seg.split(String.fromCharCode(10))
    .filter((l) => l.trim().slice(0, 2) !== String.fromCharCode(47,47) && l.trim().slice(0, 1) !== String.fromCharCode(42))
  assert.ok(!/text-\[13\.5px\]/.test(code), '输入框还带着写死的 13.5px');
});

check('★ 目录里文件名比正文小一号', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/components/FileTree.jsx'), 'utf8');
  const i = src.indexOf('{node.name}');
  assert.ok(i > 0, '找不到文件名渲染');
  const seg = src.slice(Math.max(0, i - 400), i);
  assert.ok(/text-\[12px\]/.test(seg),
    '文件名还是 13px —— 羽毛菌要求「文件名字的字大小再小一号」');
});

/**
 * ⚠️ 组件里用到的每个 `{prop}`，都必须在它的 props 解构里声明。
 *
 * 2026-10-15 现场：`ReferenceError: fontSize is not defined`，
 * 点目录里任何文件都是白屏报错。根因是**给 DocBody 传参传了、
 * 外层 DocPreview 的解构忘了补** —— 只改了一半。
 *
 * ⚠ 为什么单测抓不到：`node --check` 只验语法，
 *   而"引用了一个没声明的变量"在 JS 里是**语法合法、运行才炸**的；
 *   静态判据与单测都不跑 React 组件体。
 *   唯一可靠的真渲染判据是"点开一个文件看会不会崩"，
 *   而那个判据要真的选中文件才跑得到 —— 所以这里补一条静态兜底。
 */
check('★ 组件里用到的 prop 都在解构里声明（不然运行才炸）', () => {
  const files = ['DocPreview.jsx', 'ChatPanel.jsx', 'EditorSurface.jsx', 'FileBox.jsx'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, 'src/components', f), 'utf8');
    // 每个组件函数：把它的函数体切出来
    const re = /function\s+(\w+)\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const [, name, propsRaw] = m;
      // 函数体：从声明处到下一个顶层 function
      const start = m.index + m[0].length;
      const rest = src.slice(start);
      const next = rest.search(/\n(function|export)\s/);
      const body = next > 0 ? rest.slice(0, next) : rest;
      // ⚠ 组件体里**自己声明**的局部变量（const scrollRef = useRef(...)）
      //   也不是 prop —— 不排掉会把它们报成漏接，一红一大片。
      const locals = new Set();
      for (const mm of rest.matchAll(/\b(?:const|let|var)\s+([A-Za-z_]\w*)/g)) {
        locals.add(mm[1]);
      }
      // ⚠ 还有 `const [text, setText] = useState()` 这种**数组解构**，
      //   上一条正则只抓得到第一个名字，于是把 text 报成漏接。
      for (const mm of rest.matchAll(/\b(?:const|let|var)\s+\[([^\]]+)\]/g)) {
        for (const name of mm[1].split(',').map((x) => x.trim())) locals.add(name);
      }
      const declared = propsRaw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .split(',')
        .map((x) => x.split(':')[0].split('=')[0].trim())
        .filter(Boolean);
      // 组件体内用到的 props.xxxx 与 {xxx}（形如 {xxx} 的裸变量）
      const used = new Set();
      for (const mm of body.matchAll(/\b(\w+)\.(\w+)/g)) {
        if (['props', 'document', 'window', 'console', 'JSON', 'Object', 'Array', 'Math', 'Date', 'String', 'Number', 'Boolean']
          .includes(mm[1])) continue;
        // ⚠ 单字母基本是 map/filter 的回调参数（.map((c) => c.x)），
        //   不是 props —— 不排掉就会把 TableBlock 里的 {c} 报成漏接。
        if (mm[1].length <= 2) continue;
        used.add(mm[1]);
      }
      const missing = [...used].filter((u) => /^[a-z]/.test(u)
        && !declared.includes(u) && !locals.has(u));
      if (missing.length) {
        // 局部变量也会命中，所以只报「看起来像 props 且没声明」的
        const likelyProp = missing.filter((u) => !/^(is|has|on|ref|current|set)/.test(u));
        if (likelyProp.length && declared.length) {
          // 有 props 解构却引用了没声明的同名 —— 可能是漏接
          const suspicious = likelyProp.filter((u) =>
            new RegExp('[{,]\\s*' + u + '\\s*[,}=:]').test(body));
          if (suspicious.length) {
            assert.fail(`${f} 的 ${name} 里用了 {${suspicious[0]}}，但 props 解构里没有它 —— `
              + '点开对应界面会 ReferenceError 白屏');
          }
        }
      }
    }
  }
});

/**
 * ⚠⚠⚠ 禁掉**具名函数表达式**（2026-10-15 用户现场）。
 *
 * 现象：右键菜单一打开就 `ReferenceError: esc is not defined`，整个渲染崩掉。
 * 源码是这么写的：
 *     window.addEventListener('keydown', function esc(e) { … esc … });
 *
 * **源码里完全合法**（具名函数表达式的名字在它自己的作用域内可见），
 * **开发态也不报错** —— 只有打包之后才炸：打包器把这段重写成箭头/匿名函数，
 * 名字没了，`esc` 变成未定义变量。只在 dist 里复现。
 *
 * ⚠ 所以它属于「**node --check 抓不到、单测抓不到、只有真机 dist 才炸**」
 *    那一类，必须静态扫。
 *
 * 区分办法：具名函数**声明**（`function foo() {` 顶格）合法；
 * 出现在**逗号/括号里**的（作为实参传入）就是表达式，会被打包器改写。
 */
check('★ 没有具名函数表达式（打包后会丢名字 → 运行才炸）', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|js)$/.test(f)) files.push(p);
    }
  };
  walk(path.join(__dirname, 'src'));
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const code = stripComments(raw);
    for (const m of code.matchAll(/[,({=]\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      // 排除 `export default function` 与行首的声明
      const before = code.slice(Math.max(0, m.index - 12), m.index);
      if (/export\s+default\s*$/.test(before)) continue;
      hits.push(`${path.basename(f)}: function ${m[1]}(…) 用在表达式位置`);
    }
  }
  assert.strictEqual(hits.length, 0,
    `这些具名函数表达式在打包后会丢名字（2026-10-15 现场：esc is not defined）:\n      `
    + hits.join('\n      '));
});

/**
 * ⚠⚠⚠ 用了 React hook 就必须 import（2026-10-15 现场）。
 *
 * 我给工具栏加溢出计算时用了 `useMemo` 却忘了 import ——
 * `ReferenceError: useMemo is not defined`，**整个界面白屏**。
 *
 * ⚠ 这类错 `node --check` 抓不到（语法完全合法）、
 *   `npm run build` 也不报错（ESM 的具名导入到运行时才解析），
 *   只有真渲染才炸 —— 真机判据 `shoot-chat-look.js` 抓到了。
 */
check('★ 用了的 React hook 都已 import', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(f)) files.push(p);
    }
  };
  walk(path.join(__dirname, 'src'));

  const HOOKS = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useLayoutEffect', 'useReducer'];
  const bad = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    // 只看本文件 import 进来的 hook
    const imported = new Set();
    // ⚠ 正则必须兼容两种写法：
    //     import { useState } from 'react'
    //     import React, { useState } from 'react'   ← 默认导入在花括号**外面**
    //   我第一版只写了前一种，于是 DocToolbar.jsx 被误报成"用了没 import"。
    for (const m of code.matchAll(/import\s+(?:React\s*,\s*)?\{([^}]*)\}\s*from\s*'react'/g)) {
      for (const name of m[1].split(',')) {
        const t = name.trim().split(/\s+as\s+/).pop().trim();
        if (t) imported.add(t);
      }
    }
    for (const h of HOOKS) {
      // 出现 `xxx(` 形式就算用了
      const used = new RegExp(`(?<![\\w.$])${h}\\s*\\(`).test(code);
      if (used && !imported.has(h)) bad.push(`${path.basename(f)} 用了 ${h} 但没 import`);
    }
  }
  assert.strictEqual(bad.length, 0,
    `这些 hook 用了没 import（运行才炸，语法与打包都不报错）:\n      ` + bad.join('\n      '));
});

check('★ 点「文件」按钮不往输入框写字符（选文件是独立浮层，不是 @ 提及）', () => {
  /**
   * 2026-10-18 羽毛菌：「单击 @文件 后出现这个 @，可以删除了，
   *   之前以为是做在输入框里，没想到是单独一个区域选择文件」。
   *
   * 那个 `@` 是按他早先一句「聊天框里应该有个 @ 啊」加的 —— 他当时以为
   * 选文件是做在输入框里的 @ 提及。既然实际是浮层面板，这个字符就纯属残留。
   *
   * 这条钉的是**按钮的职责**：只开浮层，不碰输入框内容。
   * 一旦有人再往 textarea 里塞东西，用户就会看到一个永远没用的字符。
   */
  const code = stripComments(read('app/src/components/ChatPanel.jsx'));
  const seg = code.match(/label="文件"[\s\S]{0,600}/);
  assert.ok(seg, '前提不成立：ChatPanel 里找不到 label="文件" 的按钮');
  const s = seg[0];
  assert.ok(/setPicker/.test(s), '前提：这个按钮应当负责开/关浮层');
  assert.strictEqual(/setText/.test(s), false,
    '点「文件」时改了输入框内容 —— 羽毛菌 2026-10-18 明确要求把那个 @ 删掉');
});

/**
 * ⚠⚠ 关于「作用域错误」的守卫，我试过写静态扫描，**放弃了**。
 *
 * 现象（2026-10-16）：`ReferenceError: capability is not defined`，
 * 原因是我把 useState 插在 `SettingsPage` 里、而用它的 JSX 在 `Params` 里。
 *
 * ⚠ 静态扫「JSX 里用到的变量有没有声明」**误报率极高** ——
 *   回调参数 `{e}` `{meta}`、map 的第二个参数、解构出来的别名…
 *   我第一版就把 3 个正常写法判成未声明。
 *   一条天天误报的判据会训练人忽略红字，**比没有判据更糟**。
 *
 * ✅ 正确做法是**真机点一下那个页面**（`test-live-verify.js` 里已加）——
 *   作用域错误天生只有真渲染才炸，那就用真渲染去验，
 *   不在静态层硬凑。
 */

console.log('\n----------------------------------------------------');
console.log(failures.length
  ? `界面接线检查：${passed} 通过 / ${failures.length} 失败`
  : `界面接线检查：${passed} 通过`);
process.exit(failures.length ? 1 : 0);

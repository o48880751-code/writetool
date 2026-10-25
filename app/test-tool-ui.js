/**
 * 工具界面的接线检查。
 *
 * ## 覆盖什么
 *
 * 主进程与循环都有测试了（approval 19 / agent-loop 17 / wiring 16），
 * 但那些都看不见界面。这一批盯的是**用户这一侧**：
 *   1. 开关真的在设置里，而且默认关
 *   2. 订阅真的接上了（写了订阅不接 = 工具跑完了但界面毫无反应）
 *   3. 审批弹窗盖得住一切，且拒绝路径是安全的
 *
 * ## 为什么用扫源码而不是渲染测试
 *
 * 本项目零第三方依赖，没有 jsdom / testing-library。
 * 所以判据是结构性的：某组件引了某模块、某处传了某 prop、
 * 某个订阅被赋给了 unsubs。
 *
 * ⚠ 这类判据**挡不住逻辑写错**，只挡"接错/没接"。
 *   但本次真正容易出的错恰恰是后者——
 *   上一轮就有过 `provider:capabilities` 通道全在、界面一次没调的事故，
 *   当时 640 条用例全绿。
 *
 * 运行：node app/test-tool-ui.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
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
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 去掉注释——"注释里写了就算数"是这类判据最常见的假绿 */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let APP = code('app/src/App.jsx');
let CHAT = code('app/src/components/ChatPanel.jsx');
let SETTINGS = code('app/src/components/SettingsPage.jsx');
let TOOLCAT = code('app/src/components/ToolCat.jsx');
let CARDS = code('app/src/components/ToolCards.jsx');
const PRELOAD = read('app/electron/preload.js');

// ============================================================
section('一、设置页：开关在这儿，而且默认是关的');
// ============================================================

check('★ 设置页类目里有「工具」', () => {
  assert(/key:\s*'tools'/.test(SETTINGS), '类目列表里没有 tools');
});

check('★ 「工具」类目渲染 ToolCat', () => {
  assert(/cat === 'tools'/.test(SETTINGS), '没有按 cat 渲染分支');
  assert(/<ToolCat/.test(SETTINGS), '没有渲染 ToolCat');
});

check('★ ToolCat 真被 import 了（不是写了个组件没挂）', () => {
  assert(/import ToolCat from '\.\/ToolCat\.jsx'/.test(SETTINGS), '缺少 import');
});

check('★ 设置页拿得到 projectId（判断"有没有项目"要用）', () => {
  assert(/projectId=\{projectId\}/.test(SETTINGS), 'ToolCat 没收到 projectId');
});

check('★ 主进程默认 toolsEnabled=false', () => {
  const main = read('app/electron/main.js');
  assert(/toolsEnabled: false/.test(main), 'DEFAULT_CONFIG 里不是 false');
});

check('★ 界面上默认值也按关处理（config 缺字段时不显示成开）', () => {
  assert(/const enabled = !!config\?\.toolsEnabled/.test(TOOLCAT),
    '未用 !!config?.toolsEnabled —— config 为 undefined 时会被当成开');
});

// ============================================================
section('二、开关要说清后果');
// ============================================================

check('★ 写明「默认关闭是有意的」', () => {
  assert(/默认关闭是有意的/.test(TOOLCAT), '缺少这句');
});

check('★ 写明只在项目文件夹里执行（用户最该知道的一条）', () => {
  assert(/当前项目文件夹/.test(TOOLCAT), '没说执行范围');
});

check('★ 写明危险命令每次都会问', () => {
  assert(/每次都会弹窗问你/.test(TOOLCAT) || /每一次都问/.test(TOOLCAT),
    '没说明审批是每次都问');
});

check('★ 写明关掉工具就是模型看不见任何工具', () => {
  assert(/模型看不见任何工具/.test(TOOLCAT), '缺少这条说明');
});

check('★ 没项目时明说"还不会生效"，而不是给个能点但没用的开关', () => {
  assert(/还不会真的生效/.test(TOOLCAT), '缺少这条提示');
  assert(/enabled && !projectId/.test(TOOLCAT), '没有按 projectId 卡住');
});

// ============================================================
section('三、工具调用卡片接上了');
// ============================================================

check('★ App 订阅了 tool:onStart / onEnd / onApprove', () => {
  assert(/window\.api\.tool\.onStart/.test(APP), '没订阅 onStart');
  assert(/window\.api\.tool\.onEnd/.test(APP), '没订阅 onEnd');
  assert(/window\.api\.tool\.onApprove/.test(APP), '没订阅 onApprove');
});

check('★ 订阅返回值进了 unsubs（否则切对话后重复订阅）', () => {
  const i = APP.indexOf('window.api.tool.onStart');
  assert(i > 0, '找不到 onStart');
  // 这三项都必须在 unsubs.current = [...] 这个数组字面量里
  const arrStart = APP.lastIndexOf('unsubs.current = [', i);
  const arrEnd = APP.indexOf('];', i);
  assert(arrStart > 0 && arrStart < i && i < arrEnd,
    'onStart 不在 unsubs 数组里 —— 切对话会重复订阅，事件处理两遍');
});

check('★ preload 真的暴露了这三个订阅方法', () => {
  for (const m of ['onStart', 'onEnd', 'onApprove']) {
    assert(new RegExp(`${m}: \\(fn\\)`).test(PRELOAD), `preload 缺 ${m}`);
  }
});

check('★ 订阅都返回取消函数（不返回就无法退订）', () => {
  const onStart = PRELOAD.slice(PRELOAD.indexOf('onStart:'), PRELOAD.indexOf('onStart:') + 400);
  assert(/return \(\) => ipcRenderer\.removeListener/.test(onStart), 'onStart 没返回退订函数');
});

check('★ 生成结束要清空工具卡片', () => {
  const i = APP.indexOf('window.api.generate.onDone');
  const blk = APP.slice(i, i + 900);
  assert(/setToolCalls\(\[\]\)/.test(blk), 'onDone 里没清 toolCalls —— 下一轮会叠着旧卡片');
});

check('★ 出错也要清（否则"执行中"的卡片永远挂着）', () => {
  const i = APP.indexOf('window.api.generate.onError');
  const blk = APP.slice(i, i + 500);
  assert(/setToolCalls\(\[\]\)/.test(blk), 'onError 里没清 toolCalls');
});

check('★ 出错时审批弹窗也要收', () => {
  const i = APP.indexOf('window.api.generate.onError');
  const blk = APP.slice(i, i + 500);
  assert(/setApproval\(null\)/.test(blk),
    'onError 没清 approval —— 弹窗会挂在屏幕上，点也没反应');
});

check('★ 按 id 合并而不是无脑追加', () => {
  assert(/function upsertTool/.test(APP), '没有 upsertTool');
  assert(/findIndex\(\(t\) => t\.id === id\)/.test(APP), '不是按 id 合并');
});

check('★ upsertTool 兜住"没有 id"（React key 重复会整块崩）', () => {
  const i = APP.indexOf('function upsertTool');
  const fn = APP.slice(i, i + 700);
  assert(/if \(id\)/.test(fn), '没有 id 判断');
});

check('★ 卡片渲染在消息流里，且不是空 div', () => {
  assert(/<ToolCallList/.test(CHAT), 'ChatPanel 没渲染 ToolCallList');
  assert(/if \(!items\?\.length\) return null;/.test(CARDS),
    '空列表应返回 null —— 空 div 会占一行，像"本来该有东西"');
});

check('★ 滚动依赖里带了工具数量（不滚的话用户以为卡住了）', () => {
  assert(/toolCalls\.length/.test(CHAT), '自动滚动的依赖里没有 toolCalls.length');
});

// ============================================================
section('四、审批弹窗：盖得住、关不掉、默认拒绝');
// ============================================================

check('★ 弹窗 z-50 高于设置页的 z-40', () => {
  assert(/z-50/.test(CARDS), '弹窗没有更高的层级');
  assert(/z-40/.test(SETTINGS), '设置页的层级变了，判据要跟着改');
});

check('★ 弹窗渲染在设置页之后（DOM 顺序也保证盖得住）', () => {
  const i = APP.indexOf('<SettingsPage');
  const j = APP.indexOf('<ToolApprovalModal');
  assert(i > 0 && j > i, 'ToolApprovalModal 必须渲染在 SettingsPage 之后');
});

check('★ 没有给任何按钮 autoFocus（回车误放行一条删除命令）', () => {
  assert(!/autoFocus/.test(CARDS), '弹窗里出现了 autoFocus');
});

check('★ Esc = 拒绝', () => {
  assert(/e\.key === 'Escape'\) onDecide\(false\)/.test(CARDS), 'Esc 不是拒绝');
});

check('★ 点遮罩 = 拒绝（不是忽略）', () => {
  assert(/onClick=\{\(\) => decide\(false\)\}/.test(CARDS), '点遮罩不是拒绝');
});

check('★ 弹窗内部拦住冒泡，否则点它自己的空白也会拒', () => {
  assert(/e\.stopPropagation\(\)/.test(CARDS), '内部没拦冒泡');
});

check('★ 两个按钮都在，且文案说清是一次性的', () => {
  assert(/data-testid="tool-approval-deny"/.test(CARDS), '缺拒绝按钮');
  assert(/data-testid="tool-approval-allow"/.test(CARDS), '缺允许按钮');
  assert(/只对这一条命令生效/.test(CARDS), '没说清不是永久授权');
});

check('★ 命令原文完整显示，不截断（要判断就得看到整条）', () => {
  const i = CARDS.indexOf('tool-approval-command');
  assert(i > 0, '找不到命令展示区');
  const blk = CARDS.slice(i - 400, i + 400);
  assert(!/brief|slice\(0,\s*\d+\)/.test(blk),
    '命令区用了截断 —— 用户没法判断该不该放行');
});

check('★ 危险原因与越界标记都展示出来', () => {
  assert(/request\.reasons/.test(CARDS), '没展示危险原因');
  assert(/request\.outside/.test(CARDS), '没展示越界标记');
});

check('★ 决定之后立刻关弹窗（连点不会挂死）', () => {
  assert(/setApproval\(null\);/.test(APP), 'App 里决定后没收起弹窗');
});

check('★ 回传失败不算致命（主进程那边已按拒绝处理）', () => {
  const i = APP.indexOf('window.api.tool.decide');
  const blk = APP.slice(i - 200, i + 300);
  assert(/\.catch\(/.test(blk), '回传没有 catch —— unhandled rejection 会打断界面');
});

// ============================================================
section('五、可证伪：真的把接线拔掉，判据必须变红');
// ============================================================

/**
 * ⚠⚠ 上一版这里写的是「判据自检」——只确认正则能看见自己，
 *   那不是可证伪：删掉整段订阅，判据照样全绿。
 *   真变异是：把 App.jsx 的源码**在内存里改坏**，
 *   然后用改坏后的文本重新跑同一批判据。
 */
/** 取出某个 handler 的源码块：从它的位置到**下一个 window.api. 之前** */
function block(anchor) {
  const i = APP.indexOf(anchor);
  if (i < 0) return '';
  const j = APP.indexOf('window.api.', i + anchor.length);
  return APP.slice(i, j < 0 ? undefined : j);
}

const CRITERIA = [
  ['订阅 onStart', () => assert(/window\.api\.tool\.onStart/.test(APP), 'onStart 订阅没了')],
  ['订阅 onEnd', () => assert(/window\.api\.tool\.onEnd/.test(APP), 'onEnd 订阅没了')],
  ['订阅 onApprove', () => assert(/window\.api\.tool\.onApprove/.test(APP), 'onApprove 订阅没了')],
  // ⚠⚠ 窗口要卡到**下一个 handler 之前**。
  //   第一版写死 900 字符，结果 onError 整个落在 onDone 的窗口里 ——
  //   删掉 onDone 里的 setToolCalls([])，onError 里那行照样顶着，判据全绿。
  //   教训还是那句：判据报绿时先量一量它到底看见了什么。
  ['done 里清卡片', () => {
    const b = block('window.api.generate.onDone');
    assert(/setToolCalls\(\[\]\)/.test(b), 'done 不清卡片');
  }],
  ['error 里清审批', () => {
    const b = block('window.api.generate.onError');
    assert(/setApproval\(null\)/.test(b), 'error 不清审批');
  }],
  ['按 id 合并', () => assert(/function upsertTool/.test(APP) && /findIndex\(\(t\) => t\.id === id\)/.test(APP), '没有按 id 合并')],
  ['弹窗盖在设置页之后', () => {
    const i = APP.indexOf('<SettingsPage');
    const k = APP.indexOf('<ToolApprovalModal');
    assert(i > 0 && k > i, '弹窗渲染顺序不对');
  }],
];

check('★ 变异一：拔掉三个工具订阅 → 相关判据变红', () => {
  // 判据自检：原文本必须全绿
  const red0 = (() => {
    const r = [];
    for (const [n, f] of CRITERIA) { try { f(); } catch (_) { r.push(n); } }
    return r;
  })();
  assert(red0.length === 0, `判据自检失败：原实现上这些就红了：${red0.join('、')}`);

  // 真变异：把三个订阅替换成 noop
  const broken = APP
    .replace(/window\.api\.tool\.onStart\(\(c\) => \{[\s\S]*?\}\)/, 'void 0')
    .replace(/window\.api\.tool\.onEnd\(\(c\) => \{[\s\S]*?\}\)/, 'void 0');
  const red = [];
  const save = APP;
  APP = broken;
  for (const [n, f] of CRITERIA) { try { f(); } catch (_) { red.push(n); } }
  APP = save;

  assert(broken !== save, '变异没生效——正则没命中');
  assert(red.length >= 2, `拔掉订阅只有 ${red.length} 条判据变红（应至少 2 条）：${red.join('、')}`);
});

check('★ 变异二：done 不清 toolCalls → 该判据变红', () => {
  const save = APP;
  // ⚠ 不能靠注释里的中文做锚点：APP 是 code() 剥掉注释后的文本。
  //   正确做法是按 onDone 块的位置定位，只改**第一处**（done 里的那个）。
  const at = APP.indexOf('window.api.generate.onDone');
  assert(at > 0, '找不到 onDone');
  const clearAt = APP.indexOf('setToolCalls([]);', at);
  assert(clearAt > 0, 'onDone 里本来就没有 setToolCalls([])');
  const broken = APP.slice(0, clearAt) + 'void 0;' + APP.slice(clearAt + 'setToolCalls([]);'.length);
  assert(broken !== save, '变异没生效');

  APP = broken;
  let red = 0;
  for (const [, f] of CRITERIA) { try { f(); } catch (_) { red++; } }
  APP = save;

  assert(red >= 1, '去掉清理后没有任何判据变红 —— 这批判据测不到它');
});

check('★ 变异三：审批弹窗渲染到设置页之前 → 该判据变红', () => {
  const save = APP;
  // 交换顺序：把 ToolApprovalModal 那块移到 SettingsPage 之前
  const i = APP.indexOf('<SettingsPage');
  const j = APP.indexOf('<ToolApprovalModal');
  const modal = APP.slice(j - 200, j + 500);
  const broken = APP.slice(0, i) + modal + '\n' + APP.slice(i);
  APP = broken;
  let red = 0;
  for (const [, f] of CRITERIA) { try { f(); } catch (_) { red++; } }
  APP = save;
  assert(red >= 1, '把弹窗挪到设置页之前竟然没有判据变红');
});

// ============================================================
console.log(`\n工具界面：${passed} 通过 / ${failures.length} 失败`);
process.exit(failures.length ? 1 : 0);

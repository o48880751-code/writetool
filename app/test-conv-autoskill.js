/**
 * conv:send 里技能自动路由的接线判据。
 *
 * ## 为什么必须单独写
 *
 * test-main-boot 只验「main.js 加载不抛错」，而本轮真正危险的代码
 * （conv:send 第 3.5 步那段）**在加载阶段一行都不会执行**。
 * 它要等到用户点发送才跑 —— 也就是说语法错、TDZ、拼写错都能通过
 * 全部既有测试，然后在用户手里第一次崩。
 *
 * 这里直接调那个 handler，看自动命中的技能有没有真的进到 refs。
 *
 * ## 怎么做到不发 IPC 也能调 handler
 *
 * main.js 的 handle() 在 Electron 之外跑不起来（要 electron 模块）。
 * 所以这里不加载 main.js，而是**把要验的那段逻辑单独跑一遍**：
 * 从 main.js 里读出 conv:send 的源码，抠出第 3.5 步那段，
 * 用 Function 构造器拼起来跑。
 *
 * ⚠ 这只抠「代码段」，不加载整个 main.js —— 因为加载它会去
 *   Menu.setApplicationMenu，而 Module._load 的 patch 还原时机不对
 *   就会把整个测试进程带崩（2026-10-14 踩过，见 test-tool-wiring 的注释）。
 *
 * 跑法：node test-conv-autoskill.js
 */

const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}

const MAIN = path.join(__dirname, 'electron', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

// ---- 抠出 conv:send 的第 3.5 步 ----
// ⚠ 用「代码标识」而不是注释文本当标记：注释会被我随手改格式
//   （第一版用「4) 引用与当前状态…」当结束标记，因为那段注释是
//   `   * 4) …` 三空格星号缩进而不是我以为的四空格，直接没匹配上）。
//   代码标识不会被格式化工具碰。
const MARK_A = 'let autoSkillIds = [];';
// ⚠⚠ 结束标记用**正则**，不用整行字符串。
//   前三版都栽在标记上：注释文本当标记（缩进记错）、
//   后面的代码标识当标记（中间混进 20 行导致 ReferenceError）、
//   整行代码当标记（`const cp = connParamsOf(config.activeConnectionId);`
//   我写成少了参数的形式，没匹配上）。
//   「标记会随代码改动而失效」这件事本身就是个坑：抠出来的段
//   能不能独立跑通，才是有意义的判据。
const MARK_B = 'const cp = connParamsOf(';
const iA = src.indexOf(MARK_A);
const mEnd = /\n {2}const cp = connParamsOf\(/.exec(src.slice(iA));
const iB = mEnd ? iA + mEnd.index : -1;

t('main.js 里有自动路由那段代码', iA >= 0 && iB > iA,
  iA < 0 ? `找不到 ${MARK_A}` : `找不到结束标记 ${MARK_B}`);

if (iA < 0 || iB <= iA) {
  console.log('\n结论：代码被挪走或删了，本判据失效。');
  process.exit(1);
}

const SEGMENT_RAW = src.slice(iA, iB);
// ⚠ 裁到第 3.5 步自己结束 —— MARK_B 在下一段里，中间那段
//   （窗口与预留的注释块）依赖 connParamsOf，在独立作用域里会 ReferenceError。
//   「抠出来的段必须能独立跑通」本身就是一条判据，所以裁干净。
const SEGMENT = SEGMENT_RAW.slice(
  0, SEGMENT_RAW.lastIndexOf('}') + 1,
);
console.log(`抠出的代码段 ${SEGMENT.split('\n').length} 行`
  + `（原始 ${SEGMENT_RAW.split('\n').length} 行，已裁掉下一段的依赖）\n`);

// ---- 搭一个最小的执行环境 ----
const INDEX = [
  { id: 'sk-novel-writer', name: '写新章节', description: '写新章节、续写时使用。' },
  { id: 'sk-novel-sync', name: '一致性检查与文档同步', description: '检查矛盾时使用。' },
];

/** 跑一次那段代码，返回 autoSkillIds 与合并后的 refs */
async function run(setup) {
  const state = {
    config: { autoSkill: true },
    refs: [{ kind: 'skill', id: 'sk-manual' }],
    text: '帮我续写下一章',
    // ⚠⚠ projectId 与 askOnce 也是段里的自由变量。
    //   漏掉它们 → Function 构造器里 ReferenceError →
    //   被实现里的 catch 吞掉 → autoSkillIds 永远是空。
    //   而现象是「命中那条判据红了」，看着像实现不工作，
    //   其实是判据的运行环境不全。
    //   （顺带证明：实现的 try/catch 确实兜住了这类坏法。）
    projectId: 'p1',
    askOnce: async () => { throw new Error('本测试不该真的问模型'); },
    store: { skillIndex: () => INDEX },
    skillRouter: {
      route: async () => { throw new Error('本测试不该真的调路由'); },
    },
    log: (a, b) => { state.logged.push([a, b]); },
    logged: [],
    askCalls: 0,
  };
  if (setup) setup(state);

  // ⚠ 替换必须真的命中。`text` 这种短词最容易漏——
  //   第一版漏了它，state.text 是 undefined，被 shouldRoute 的
  //   「太短」规则短路，于是「路由命中」那条判据测的是短路而不是注入。
  //   所以每条替换都验一次：没命中就是判据自己坏了。
  const REPL = [
    // ⚠⚠ 必须用**全局正则**：`config.autoSkill` 在段里出现两次
    //   （`if (config.autoSkill)` 与 `enabled: !!config.autoSkill`），
    //   字符串版 replace 只换第一处 → 剩下那个在构造器里是自由变量
    //   → ReferenceError → 被实现的 catch 吞掉 → 命中判据红了。
    //   现象极像"实现不工作"，实际是判据的替换没做全。
    [/config\.autoSkill/g, 'state.config.autoSkill'],
    [/\btext\b(?!\s*[:=])/g, 'state.text'],
    [/\bprojectId\b/g, 'state.projectId'],
    [/\baskOnce\b/g, 'state.askOnce'],
    [/\bstore\.skillIndex\b/g, 'state.store.skillIndex'],
    [/\bskillRouter\.route\b/g, 'state.skillRouter.route'],
    [/\blog\(/g, 'state.log('],
    // ⚠⚠ refs 只用**一条整词规则**。
    //   先加「refs.filter → state.refs.filter」再加快照规则的话，
    //   后者会把前者产出的 state.refs.filter 里的 refs 再套一层
    //   → state.state.refs → undefined.filter → 被实现的 catch 吞掉。
    //   现象又是「命中判据红了但看不出为什么」。
    [/\brefs\b/g, 'state.refs'],
  ];
  let body = SEGMENT;
  for (const [pat, to] of REPL) {
    const next = body.replace(pat, to);
    if (next === body) {
      console.error(`❌ 替换没命中：${pat} —— 判据自己坏了，不是实现有问题`);
      process.exit(2);
    }
    body = next;
  }

  const fn = new Function('state', 'INDEX', 'return (async () => {' + body + '\nreturn { autoSkillIds, _refs: state.refs, logged: state.logged }; })()');
  const out = await fn(state, INDEX);
  out.refs = out._refs;
  return out;
}

async function main() {
  console.log('—— 开关关着时不路由 ——');
  {
    const out = await run((s) => {
      s.config.autoSkill = false;
      s.skillRouter.route = async () => { throw new Error('不该被调'); };
    });
    t('开关关：不调路由', true);
    t('开关关：不注入任何技能', out.autoSkillIds.length === 0, JSON.stringify(out));
    t('开关关：refs 原样（只有手动那条）',
      out.refs.length === 1 && out.refs[0].id === 'sk-manual', JSON.stringify(out.refs));
  }

  console.log('\n—— 开关开着，路由命中 ——');
  {
    const out = await run((s) => {
      s.skillRouter.route = async () => ({ ids: ['sk-novel-writer'], reason: 'ok' });
    });
    t('命中 1 个技能', out.autoSkillIds.join() === 'sk-novel-writer',
      `${JSON.stringify(out.autoSkillIds)}｜日志：${JSON.stringify(out.logged)}`);
    t('refs 变成 2 条',
      out.refs.length === 2, JSON.stringify(out.refs.map((r) => r.id)));
    t('手动那条在前（用户明确要的排前面）',
      out.refs[0].id === 'sk-manual', JSON.stringify(out.refs.map((r) => r.id)));
    t('自动补的在后', out.refs[1].id === 'sk-novel-writer');
    t('自动补的带 kind=skill（buildRefBlock 靠它分流）',
      out.refs[1].kind === 'skill', JSON.stringify(out.refs[1]));
  }

  console.log('\n—— ⚠ 去重：模型返回了手动已勾的那个 ——');
  {
    const out = await run((s) => {
      s.skillRouter.route = async () => ({ ids: ['sk-manual', 'sk-novel-sync'], reason: 'ok' });
    });
    const ids = out.refs.map((r) => r.id);
    t('同一个 id 不会出现在 refs 里两次',
      ids.filter((x) => x === 'sk-manual').length === 1, JSON.stringify(ids));
    t('其他命中的仍然补进去了', ids.includes('sk-novel-sync'), JSON.stringify(ids));
  }

  console.log('\n—— ⚠ 路由抛异常不能影响生成 ——');
  {
    const out = await run((s) => {
      s.skillRouter.route = async () => { throw new Error('路由炸了'); };
    });
    t('路由抛异常时照样跑完，不向上抛',
      out.autoSkillIds.length === 0, JSON.stringify(out));
    t('refs 保持原样', out.refs.length === 1, JSON.stringify(out.refs));
  }

  console.log('\n—— ⚠ store.skillIndex 抛异常也不能影响生成 ——');
  {
    const out = await run((s) => {
      s.store.skillIndex = () => { throw new Error('库坏了'); };
      s.skillRouter.route = async () => ({ ids: [], reason: 'empty' });
    });
    t('取索引失败时降级', out.autoSkillIds.length === 0, JSON.stringify(out));
  }

  console.log(`\n通过 ${pass}｜失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * 拖拽排序的顺序存储。
 *
 * ## 为什么必须单独存一个文件
 *
 * 用户能在文件树里上下拖动改顺序，但**文件系统不记顺序**：
 * `fs.readdirSync` 的返回顺序取决于目录项在磁盘上的物理布局，
 * 删一个文件再新建，同名文件就可能插到中间。
 *
 * 第一版想靠 `readdir` 的天然顺序做排序，实测下来刷新一次界面就跳了——
 * 表现为"我刚拖好的顺序，打开软件又乱了"。所以顺序必须显式落盘。
 *
 * ## 格式：一个扁平映射，不建树
 *
 * ```json
 * { "v": 1, "dirs": { "": ["卷纲", "章节", "设定", "世界观.md"], "卷纲": [...] } }
 * ```
 *
 * 键是**目录的相对路径**（根是空串），值是该目录下子项名的一个**全序**。
 *
 * ⚠ 为什么不按"部分排序"存（比如只存被拖过的那几项）：
 *   那就要在每次读取时做拓扑合并，规则（冲突时谁优先）很难解释，
 *   而用户看到的结果取决于规则，不取决于他拖了什么。
 *   全序只有一个解释："就是屏幕上那个顺序"。
 *
 * ## 脏数据处理
 *
 * 顺序文件会被用户手工改、被旧版本遗留、被同步盘搞坏。
 * 任何异常都退回"按名字排"——顺序错了只是不好看，
 * 但顺序文件坏了导致界面打不开，就是灾难。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 顺序文件名。用点开头，与 .trash 一样被 tree() 的 `startsWith('.')` 过滤掉 */
const ORDER_FILE = '.order.json';
const ORDER_VERSION = 1;

/** 顺序文件最大 512KB。异常膨胀时截断，避免每次读都解析一大坨 */
const MAX_ORDER_BYTES = 512 * 1024;

/**
 * 目录名规范化成 posix 风格（与 tree() 用的 rel 一致）。
 *
 * ⚠ 必须把 '.' 归一成 ''：`path.posix.dirname('甲.md')` 返回的是 '.'，
 *   而 tree() 里根目录的键是空串。若不归一，
 *   根层的顺序会被写到键 '.' 下、tree() 读键 '' 时读不到——
 *   表现为"在根目录拖拽排序完全不生效"。
 */
function normDir(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return s === '.' ? '' : s;
}

/** 把文件名规范化成可直接放进数组的字符串 */
function normName(n) {
  return String(n == null ? '' : n).trim();
}

/**
 * 读顺序表。**任何异常都返回空表**，绝不抛。
 * @returns {{v:number, dirs:Record<string,string[]>}}
 */
function readOrder(projectDir) {
  const file = path.join(projectDir, ORDER_FILE);
  let raw;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_ORDER_BYTES) return { v: ORDER_VERSION, dirs: {} };
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { v: ORDER_VERSION, dirs: {} };   // 不存在是最常见情况
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return { v: ORDER_VERSION, dirs: {} };
    const dirs = {};
    if (o.dirs && typeof o.dirs === 'object') {
      for (const [k, v] of Object.entries(o.dirs)) {
        if (!Array.isArray(v)) continue;
        dirs[normDir(k)] = v.map(normName).filter(Boolean);
      }
    }
    return { v: Number(o.v) || ORDER_VERSION, dirs };
  } catch (_) {
    // 损坏了就备份再当空的——留一份现场，用户能看出是自己改坏的
    try {
      fs.renameSync(file, `${file}.bad-${Date.now().toString(36)}`);
    } catch (_) { /* 备份失败也无所谓，不能因此挡住用户 */ }
    return { v: ORDER_VERSION, dirs: {} };
  }
}

/**
 * 写顺序表。
 *
 * ⚠ 写的是「先写临时文件再 rename」：直接覆写时如果进程在写到一半被杀，
 *   顺序文件会变成半截 JSON，而它下一次读会被当成损坏——
 *   用户的自定义顺序就丢了。原子替换能保证要么是旧的完整内容、
 *   要么是新的完整内容，不会有中间态。
 */
function writeOrder(projectDir, order) {
  const file = path.join(projectDir, ORDER_FILE);
  const payload = {
    v: ORDER_VERSION,
    dirs: order && order.dirs ? order.dirs : {},
  };
  let text;
  try {
    text = JSON.stringify(payload);
  } catch (_) {
    return { ok: false, error: '顺序数据无法序列化' };
  }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 按顺序表给某一层的节点排序（**原地**）。
 *
 * 规则：
 *   1. 顺序表里排在前面的在前
 *   2. 表里没有的（新建的、或表漏了）**按 `fallback` 排**，接在表内项之后
 *   3. 表里有但实际已不存在的直接忽略
 *
 * @param {Array} nodes 这一层的节点
 * @param {string[]} order 该目录的顺序数组（子项名）
 * @param {function} [fallback] 表外项的排序比较器。
 *   **必须提供，且必须与 tree() 的默认排序一致**。
 *   不给的话表外项会保持传入数组的原始次序——那通常是 readdir 的
 *   物理布局，于是「拖一下文件，三个目录的相对位置悄悄变了」
 *   （实测踩过：卷纲,设定,章节 变成 卷纲,章节,设定）。
 */
function applyOrder(nodes, order, fallback) {
  if (!Array.isArray(nodes)) return nodes;
  if (!Array.isArray(order) || !order.length) return nodes;
  const cmp = typeof fallback === 'function' ? fallback : null;

  const rank = new Map();
  order.forEach((name, i) => {
    if (!rank.has(name)) rank.set(name, i);
  });

  const inTable = [];
  const outTable = [];
  for (const n of nodes) {
    (rank.has(n.name) ? inTable : outTable).push(n);
  }
  if (cmp) outTable.sort(cmp);

  const byRank = (a, b) => {
    const ra = rank.get(a.name);
    const rb = rank.get(b.name);
    if (ra !== rb) return ra - rb;
    return 0;
  };
  // 稳定排序：rank 相同（表里有重复名）时保持传入次序
  inTable.sort(byRank);
  return [...inTable, ...outTable];
}

/**
 * 把某一层的当前顺序写回顺序表。
 *
 * 只写这一层，不动其他目录——拖一次只该影响一个目录。
 *
 * @param {string} projectDir
 * @param {string} dirRel 目录相对路径（'' 表示根）
 * @param {string[]} names 该层子项名，已是最终顺序
 */
function recordLayer(projectDir, dirRel, names) {
  const order = readOrder(projectDir);
  const key = normDir(dirRel);
  order.dirs[key] = (names || []).map(normName).filter(Boolean);
  return writeOrder(projectDir, order);
}

/**
 * 把一条路径插到另一条之前/之后，返回新的一层顺序。
 *
 * 纯函数，不碰磁盘。拖拽时先算预览，落下时才落盘。
 *
 * @param {string[]} names 当前层顺序（完整）
 * @param {string} moving 要移动的项名
 * @param {string|null} anchor 锚点项名；null 表示移动到最末
 * @param {'before'|'after'} where 插到锚点前还是后
 */
function reorderNames(names, moving, anchor, where) {
  const list = (names || []).filter((n) => n !== moving);
  if (anchor == null || !list.includes(anchor)) {
    return [...list, moving];
  }
  const at = list.indexOf(anchor);
  const idx = where === 'before' ? at : at + 1;
  return [...list.slice(0, idx), moving, ...list.slice(idx)];
}

/**
 * 移动文件 / 目录到目标目录。
 *
 * 两个用途共用一个函数：
 *   - 跨文件夹拖动 → 改 from 的父目录
 *   - 同目录内排序 → from 与 to 同父，只改顺序表
 *
 * ## 三道必须拦的情况
 *
 * 1. **移进自己的子目录**：`卷纲/` 拖进 `卷纲/子集/`。
 *    文件系统允许（目录能被移进自己的后代），但之后
 *    `tree()` 递归会无限深入直到 maxDepth，文件也再也拿不到。
 *    必须在动手前判断。
 * 2. **目标已存在同名**：直接覆盖会毁掉用户资料。报错，不覆盖。
 * 3. **目标在项目外**：走 resolveIn，与其他所有操作同一套检查。
 *
 * @param {import('node:path').PlatformPath} _unused
 */
function isAncestorPath(ancestorRel, childRel) {
  const a = normDir(ancestorRel);
  const c = normDir(childRel);
  if (!a) return false;                       // 根是所有人的祖先，但不是有效目标
  return c === a || c.startsWith(a + '/');
}

module.exports = {
  ORDER_FILE,
  ORDER_VERSION,
  normDir,
  normName,
  readOrder,
  writeOrder,
  applyOrder,
  recordLayer,
  reorderNames,
  isAncestorPath,
};

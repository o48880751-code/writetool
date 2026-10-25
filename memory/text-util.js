/**
 * 文本归一与简称变体。
 *
 * ## 为什么单独抽出来
 *
 * `state-writer.js` 原本 `require('../run-verify.js')` 取这两个函数——
 * 但 run-verify.js 是 65KB 的**验证脚本**，里面有工具执行、结果落盘、
 * 模型调用等一大堆无关逻辑。打包时把它塞进安装包有两个问题：
 *   1. 体积白白翻几倍
 *   2. 验证脚本的副作用（写 chapters/ 目录、读结果目录）可能在运行时被触发
 *
 * 抽出来后 `memory/` 与 `db/` 就是自足的，打包只需带这两个目录。
 */

/**
 * 归一化：去空白与标点，转小写。
 * 用于别名/简称匹配——「乱葬岗」与「乱葬崗」要能匹配上。
 */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s　。，、；：？！“”‘’（）()《》〈〉\-_·.]/g, '');
}

/** 通用地/物后缀：命中则尝试切分出核心词 */
const SUFFIXES = ['岗', '宗', '城', '山', '剑', '诀', '派', '岛', '塔', '寺', '谷', '崖', '海', '宫', '门'];

/**
 * 生成一个实体名的可接受简称变体。
 *
 * 存在的理由：锚点指标若只做字面匹配，会把「乱葬岗 → 岗北」这类
 * 合理简称判成未命中（实测 8B 已知组 2/20 属此类假阴性）。
 *
 * 只生成高置信变体：去通用后缀取核心词，不做激进截断——
 * 避免把「赤霄宗」与「霄宗」这类不同实体误判为同一个。
 *
 * @param {string} name 实体名
 * @returns {string[]} 变体列表（已去重）
 */
function suffixVariants(name) {
  const n = String(name || '');
  const out = [];
  if (n.length < 3) return out;
  for (const s of SUFFIXES) {
    if (n.endsWith(s)) out.push(n.slice(0, -1));   // 去后缀：残月剑谱 → 残月剑
    if (n.startsWith(s)) out.push(n.slice(1));      // 去前缀：乱葬岗 → 葬岗
    if (n.includes(s)) {
      const i = n.indexOf(s);
      if (i > 0) out.push(n.slice(i));             // 乱葬岗 → 岗
    }
  }
  return [...new Set(out)];
}

module.exports = { norm, suffixVariants, SUFFIXES };
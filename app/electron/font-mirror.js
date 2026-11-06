/**
 * 字体下载的镜像候选（2026-11-02）。
 *
 * ## 起因
 *
 * 羽毛菌在国内点「下载」报 `read ECONNRESET` —— 主站 `cdn.jsdelivr.net`
 * 被掐断，而原来**既没有重试也没有备用节点**，一次连接被重置就整单失败。
 *
 * ## 为什么只换域名
 *
 * 下面这几个是**同一套 CDN** 的其它入口，路径与内容完全一致，
 * 换 host 就能通。这样不用维护"各家代理"那种随时会变的列表
 * （ghproxy 之类三天两头失效，写死在代码里等于埋雷）。
 *
 * ⚠ 抽成单独模块是为了能被判据直接打到：`main.js` 里的东西
 *   判据 require 不到（一 require 就把整个 Electron 主进程拖起来）。
 */

/** 同一套 CDN 的其它入口，路径一致 */
const JSDELIVR_HOSTS = [
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'gcore.jsdelivr.net',
  'testingcf.jsdelivr.net',
];

/**
 * 把一条链接展开成"主站 + 备用节点"的候选列表。
 *
 * ⚠ 非 jsDelivr 的链接原样返回（只有一条）—— 不能瞎猜别人的镜像。
 * ⚠ 必须保留 `search`：jsDelivr 的版本锁有时在 query 里。
 *
 * @param {string} url
 * @returns {string[]}
 */
function mirrorUrls(url) {
  try {
    const u = new URL(url);
    if (!JSDELIVR_HOSTS.includes(u.hostname)) return [url];
    return JSDELIVR_HOSTS.map((h) => `${u.protocol}//${h}${u.pathname}${u.search}`);
  } catch (_) {
    return [url];
  }
}

/**
 * 判断下下来的东西到底是不是字体文件。
 *
 * ⚠⚠ 只查"大小 > 1KB"是不够的：实测服务器回了一个 **199 字节的网页**
 *   （被网络劫持 / 该节点返回错误页）。把它当字体存进 fonts 目录之后，
 *   界面显示"已安装"、打开却报字体损坏，用户根本想不到是文件本身是网页。
 *
 * 字体文件开头是固定的几种魔数，验一下就能拦住。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isFontFile(buf) {
  if (!buf || buf.length < 12) return false;
  // 0x00010000 = TrueType；'OTTO' = CFF/OpenType；'true'/'typ1' = 老 Mac；'ttcf' = 字体集
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return true;
  return ['OTTO', 'true', 'typ1', 'ttcf'].includes(buf.slice(0, 4).toString('latin1'));
}

/**
 * 一个已存在的字体文件该怎么处理。
 *
 * ⚠⚠ 这条策略是踩出来的：上一版 `font:installed` 是"文件头不像字体就删掉"，
 *   结果**霞鹜文楷凭空消失** —— 它是个正经 17MB 字体，只是没通过我那道
 *   魔数检查，于是一个**只读查询接口**把用户下好的字体删了。
 *
 * 现在分三档：
 *   · ok      —— 文件头是字体，正常
 *   · garbage —— 很小（< 64KB）且不像字体：八成是当初那个 199 字节的错误页，清掉
 *   · suspect —— 大文件但文件头不认识：**保留**，只记日志。
 *                误删用户的文件比留一个坏文件严重得多。
 *
 * @param {number} size 字节数
 * @param {boolean} looksLikeFont 文件头是否符合字体魔数
 * @returns {'ok'|'garbage'|'suspect'}
 */
function classifyFontFile(size, looksLikeFont) {
  if (looksLikeFont) return 'ok';
  return Number(size) < 64 * 1024 ? 'garbage' : 'suspect';
}

module.exports = { JSDELIVR_HOSTS, mirrorUrls, isFontFile, classifyFontFile };

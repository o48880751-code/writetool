'use strict';

/**
 * 开源字体预置表。
 *
 * 字体文件较大（中文开源字体普遍 5~20MB），且 CSP 禁止渲染进程直接
 * 联网下载，所以下载由主进程完成，渲染进程只负责「选择 + 应用」。
 *
 * 每条字段：
 *   id     内部标识
 *   label  界面显示名
 *   family CSS font-family 名（@font-face 与元素 style 都用它；含空格要带引号）
 *   file   下载后落在 userData/fonts/ 下的文件名
 *   url    jsDelivr 直链（已逐一验证可达，国内有 CDN 节点）
 *   sizeMB 仅用于界面显示「约 X MB」
 *   desc   一句话说明
 *
 * ⚠ url 必须带版本锁（@v1.xxx），不能用 @latest —— jsDelivr 对超大仓库
 *   （如 noto-cjk）的 @latest 会直接 403，且 @latest 不锁版本等于每次
 *   下载都可能变，出问题没法复现。
 */
const FONTS = [
  /**
   * ⚠ 原来的「霞鹜文楷」（id: `lgwk`）2026-11-02 移除。
   *
   *   它那个 17.3MB 的 TTF 在这台机器上始终下不下来（jsDelivr 全线被掐），
   *   留在列表里就是一个永远点不动的「下载」按钮 —— 用户看到的不是
   *   "网络不通"，而是"这软件坏了"。宁可拿掉。
   *
   *   下方 `lgwk-gb` 是同一套字的 GB 版：字表更全、同样规整，留一个够了。
   */
  {
    id: 'lgwk-gb',
    label: '霞鹜文楷 GB',
    family: "'LXGW WenKai GB'",
    file: 'LXGW-WenKai-GB.ttf',
    url: 'https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKaiGB@v1.330/fonts/TTF/LXGWWenKaiGB-Regular.ttf',
    sizeMB: 15.6,
    desc: '规整楷体，GB 字表更全',
  },
  {
    id: 'iansui',
    label: '芫荽',
    family: "'Iansui'",
    file: 'Iansui.ttf',
    url: 'https://cdn.jsdelivr.net/gh/ButTaiwan/iansui@1.020/fonts/ttf/Iansui-Regular.ttf',
    sizeMB: 9.2,
    desc: '台湾风楷书，圆润秀气',
  },
  {
    id: 'zcool',
    label: '站酷快乐体',
    family: "'ZCOOL KuaiLe'",
    file: 'ZCOOL-KuaiLe.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf',
    sizeMB: 4.6,
    desc: '圆润活泼，适合标题/对话',
  },
];

const FONT_DIR = 'fonts';

/** 按 id 取预置 */
function fontById(id) {
  return FONTS.find((f) => f.id === id) || null;
}

module.exports = { FONTS, FONT_DIR, fontById };

/**
 * 版本与发布渠道。
 *
 * ## 为什么不做在线更新检查
 *
 * 羽毛菌的方案是「弄个网站，网站上发布新一代版本，用户下载覆盖」。
 * 这条路线是对的，理由不只是"更简单"：
 *
 * 1. **静默自动更新需要代码签名证书**。未签名的 exe 在 Windows 上
 *    会被 SmartScreen 拦在下载阶段，用户看到的是「网络错误」——
 *    一个比"没有自动更新"更糟的体验。证书要数千元/年。
 * 2. 自动更新器要 30+ 个依赖，还要在 package.json 里配 `publish`，
 *    而发布源就是那个网站。等于绕一大圈回到同一个地方。
 * 3. 用户拿到的是**自己选的版本**，而不是某天早上被动换掉的版本。
 *
 * 所以这里只做两件事：显示当前版本、提供一个去下载页的入口。
 * 不发任何网络请求，不检查，不下载。
 *
 * ## 版本号语义（羽毛菌 2026-10-14 改成机械规则）
 *
 *   **每发一次更新，第三位加 1**：1.0.0 → 1.0.1 → 1.0.2 …
 *
 * 原来定的是「1.0 大更新（界面或数据结构变了）/ 1.1 加功能 / 1.0.1 只修 bug」。
 * 那个分法的问题不是不精确，而是**每次发版都要人判断"这次算大还是算小"** ——
 * 判断本身就会出错，出错之后版本号就再也对不上语义了。
 * 改成机械 +1：谁都不会记错，翻 commit 也能按号找到对应的包。
 *
 * ⚠ 版本号**不影响数据目录** —— 用户数据在 `app.getPath('userData')`，
 *   不跟着版本走。改版本号是纯安全的，不触发任何数据迁移。
 */

/** 三个段的语义说明，用于界面提示 */
/**
 * 三段的字面含义，界面上用。
 *
 * ⚠ 这三条**不再是"什么时候该进位"的判断标准**（见文件头：
 *   现在每次发版第三位 +1）。留着是为了让用户看懂版本号的结构，
 *   不要再拿它们去推导"这次该发 1.1 还是 1.0.2"。
 */
const LEVELS = {
  major: '第一位：大版本，界面或数据结构重做时会动',
  minor: '第二位：一般只在合并大版本时动',
  patch: '第三位：每次更新往上加 1',
};

/**
 * 读当前版本与发布页地址。
 *
 * @param {object|null} pkg package.json 内容
 * @param {string} fallbackVersion 读不到 package.json 时用 app.getVersion()
 * @param {object} config 用户配置（发布页地址存在这里，不放 build 段——
 *   因为 electron-builder 的 schema 里没有相应字段，加了会
 *   报 Invalid configuration object）
 */
function versionInfo(pkg, fallbackVersion, config) {
  const raw = (pkg && pkg.version) || fallbackVersion || '1.0.0';
  // ⚠ 每一段都要兜底成 '0'。第一版只在返回对象里兜了，
  //   full 那里直接用 parts[i] 拼模板串，
  //   于是 version:'1.0' 会显示成「v1.0.undefined」——
  //   而"新增网站发布版"这件事的第一版版本号恰恰就是 1.0。
  const parts = String(raw).replace(/^v/i, '').split('.');
  const major = parts[0] || '1';
  const minor = parts[1] || '0';
  const patch = parts[2] || '0';
  return {
    version: major,
    minor,
    patch,
    full: `v${major}.${minor}.${patch}`,
    /** 发布页地址。用户在设置里填，填了才有"去下载"按钮 */
    downloadUrl: (config && config.downloadUrl) || '',
    levels: LEVELS,
  };
}

/**
 * 校验发布页地址。
 *
 * ⚠ 只允许 http/https。file: 打开本地可执行文件、
 *   javascript: 执行代码——而这个值是用户在设置里输的，
 *   虽然是自己填，但主进程是最终执行者，必须自己把关。
 */
function validateDownloadUrl(u) {
  const s = String(u || '').trim();
  if (!s) return { ok: true, empty: true };
  if (!/^https?:\/\//i.test(s)) {
    return { ok: false, error: '只支持 http:// 或 https:// 开头的网址' };
  }
  if (s.length > 500) return { ok: false, error: '网址太长' };
  return { ok: true, url: s };
}

module.exports = { versionInfo, validateDownloadUrl, LEVELS };
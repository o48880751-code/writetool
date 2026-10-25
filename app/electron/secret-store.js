const { safeStorage } = require('electron');

/**
 * API 密钥的本地存储。
 *
 * ## 为什么要单独一个模块
 *
 * 密钥是唯一一类"泄露了就有真实损失"的数据：
 * 别人拿你的 key 可以花你的钱、跑你的额度。
 * 而这个软件的其他配置（字号、主题、思考强度）泄露了只是不好看。
 * 所以它的规则必须与其他配置分开钉死，混在 saveConfig 里迟早被顺手改坏。
 *
 * ## 多连接（2026-10-12 改）
 *
 * 用户会同时有「公司代理」「硅基流动」「本地 Ollama」三条连接，
 * 每条一个密钥。所以这里从"全局一份"改成**按连接 id 分组**。
 *
 * 密文不进 config.json、不进 connections 表 —— 存在独立的
 * connection_secrets 表。这样做的好处是那两张表可以随便经 IPC
 * 传给渲染进程，而密钥不会跟着走。
 *
 * 因此本模块不直接碰数据库，而是拿一对读写函数（见 bind）。
 *
 * ## 存储方式
 *
 * Electron 的 `safeStorage` 走的是操作系统凭据服务：
 *   Windows  → DPAPI（绑定当前用户账户）
 *   macOS    → Keychain
 *   Linux    → kwallet / gnome-libsecret
 * 加密结果是 base64 的密文。明文**只在内存里存在**，随进程退出消失。
 *
 * ## 降级路径（C4：失败要有明确出口，不能静默）
 *
 * `safeStorage.isEncryptionAvailable()` 为 false 的情况：
 *   - Linux 无 keyring / 无 DISPLAY 的纯 SSH 会话
 *   - 某些 Windows 域策略禁用 DPAPI
 * 这时**不能明文落盘**（那等于没加密），也不能报错让用户没法用。
 * 折中：退回内存存储 —— 本次运行能用，关掉软件就得重填。
 * 界面上必须显示这个状态，否则用户以为"填了就是存好了"。
 */

/** 内存中的明文：连接 id → 明文。进程退出即消失 */
const memoryKeys = new Map();

/** 上次是否能加密（决定界面上要不要提示） */
let encAvailable = false;

/**
 * 数据库读写口。由 main.js 在 store 建好后 bind 进来。
 * 不直接 require store 是为了避免循环依赖，也让本模块能单独测。
 *
 * ⚠⚠ 服务级密钥（联网搜索等）走**另一组**口（2026-10-14）。
 *
 * 为什么不能复用连接的：
 *   connection_secrets 的 connection_id 有外键 REFERENCES connections(id)，
 *   而服务级密钥不属于任何一条连接 —— 硬塞进去会被数据库拒绝：
 *   `加密失败：FOREIGN KEY constraint failed`。
 *   那个错误被包成「加密失败」，用户看到的是「填了也存不进去」。
 *
 *   所以：**不试图绕过外键，也不建一条假连接** —— 单开一张表。
 */
let io = null;
let ioService = null;
function bind(readEnc, writeEnc) {
  io = { readEnc, writeEnc };
}

/**
 * 绑定服务级密钥的读写口。
 *
 * ⚠ 不传也能用：save/load 会返回「缺少服务标识」而不是静默失败，
 *   让上层能明确报出来。
 */
function bindService(readEnc, writeEnc) {
  ioService = { readEnc, writeEnc };
}

/**
 * 检测加密能力。
 *
 * ⚠ app 在 ready 之前 safeStorage 不可用，
 *   所以这个函数要在 app ready 之后调（main.js 的 whenReady 里初始化）。
 */
function init() {
  try {
    encAvailable = safeStorage.isEncryptionAvailable();
  } catch (_) {
    encAvailable = false;
  }
  return encAvailable;
}

/** 加密能力是否可用 */
function isEncrypted() {
  return encAvailable;
}

/** 读某条连接的密文。null id = 没绑定具体连接（老调用方） */
function readEncOf(id) {
  if (!io || !id) return null;
  try { return io.readEnc(id); } catch (_) { return null; }
}

/** 写某条连接的密文。null 密文 = 清掉 */
function writeEncOf(id, enc) {
  if (!io || !id) return 0;
  return io.writeEnc(id, enc);
}

/**
 * 存密钥。
 *
 * @param {string} plain 明文
 * @param {string} connId 连接 id
 * @returns {{ok:boolean, encrypted:boolean, error?:string}}
 */
function save(plain, connId) {
  const key = String(plain == null ? '' : plain);
  if (!connId) {
    return { ok: false, encrypted: encAvailable, error: '缺少连接标识，密钥无处可存' };
  }

  if (!key) {
    // 空 = 用户清掉了密钥。内存与落盘都要清，否则会残留旧密文。
    memoryKeys.delete(connId);
    writeEncOf(connId, null);
    return { ok: true, encrypted: encAvailable };
  }

  memoryKeys.set(connId, key);

  if (!encAvailable) {
    // ⚠ 绝不降级成明文落盘——那等于给"没加密"这件事打了个假补丁。
    //   只留内存，界面上要如实告知用户「本次运行有效，重启后需重填」。
    return {
      ok: true,
      encrypted: false,
      error: '系统未提供加密凭据服务，密钥只保存在本次运行中，重启软件后需要重新填写。',
    };
  }

  try {
    writeEncOf(connId, safeStorage.encryptString(key).toString('base64'));
    return { ok: true, encrypted: true };
  } catch (e) {
    // ⚠ 加密失败要**把内存里的也清掉**：留在内存里会让界面显示
    //   "已保存"，而实际下次就用不了了 —— 那是骗用户。
    memoryKeys.delete(connId);
    return { ok: false, encrypted: false, error: `加密失败：${e.message}` };
  }
}

/**
 * 取密钥（明文）。
 *
 * 解密失败不是致命错误——常见于换机器、换用户账户后旧密文读不了。
 * 这时当成"没有密钥"，界面提示重填即可，不该崩溃也不该反复报错。
 *
 * @returns {string} 空字符串表示没有可用密钥
 */
function load(connId) {
  if (!connId) return '';
  if (memoryKeys.has(connId)) return memoryKeys.get(connId);
  const enc = readEncOf(connId);
  if (!enc || !encAvailable) return '';
  try {
    const plain = safeStorage.decryptString(Buffer.from(String(enc), 'base64'));
    memoryKeys.set(connId, plain);
    return plain;
  } catch (_) {
    // 读不出来就清掉这段坏密文——留着每次启动都会失败一次
    writeEncOf(connId, null);
    return '';
  }
}

/** 清掉内存里的明文（切换连接、删连接时用） */
function forget(connId) {
  if (connId == null) memoryKeys.clear();
  else memoryKeys.delete(connId);
}

/**
 * 存**服务级**密钥（联网搜索等）。
 *
 * ⚠ 与 save 的唯一区别是落到 service_secrets 表（无外键），
 *   逻辑完全一致：不降级明文、加密失败要清内存。
 *
 * @param {string} plain
 * @param {string} provider  'serper' / 'bing'
 */
function saveService(plain, provider) {
  const key = String(plain == null ? '' : plain);
  if (!provider) {
    return { ok: false, encrypted: encAvailable, error: '缺少服务标识，密钥无处可存' };
  }
  if (!ioService) {
    return {
      ok: false, encrypted: encAvailable,
      error: '服务密钥存储未就绪（bindService 没调）',
    };
  }

  if (!key) {
    memoryKeys.delete(provider);
    try { ioService.writeEnc(provider, null); } catch (_) { /* 清掉失败不算错 */ }
    return { ok: true, encrypted: encAvailable };
  }

  memoryKeys.set(provider, key);

  if (!encAvailable) {
    return {
      ok: true,
      encrypted: false,
      error: '系统未提供加密凭据服务，密钥只保存在本次运行中，重启软件后需要重新填写。',
    };
  }

  try {
    ioService.writeEnc(provider, safeStorage.encryptString(key).toString('base64'));
    return { ok: true, encrypted: true };
  } catch (e) {
    // ⚠ 加密失败要把内存里的也清掉：留着会让界面显示"已保存"，
    //   而实际下次就用不了 —— 那是骗用户。
    memoryKeys.delete(provider);
    return { ok: false, encrypted: false, error: `加密失败：${e.message}` };
  }
}

/**
 * 取服务级密钥（明文）。
 *
 * @param {string} provider  'serper' / 'bing'
 * @returns {string} 空串表示没有可用密钥
 */
function loadService(provider) {
  if (!provider || !ioService) return '';
  if (memoryKeys.has(provider)) return memoryKeys.get(provider);
  let enc = null;
  try { enc = ioService.readEnc(provider); } catch (_) { return ''; }
  if (!enc || !encAvailable) return '';
  try {
    const plain = safeStorage.decryptString(Buffer.from(String(enc), 'base64'));
    memoryKeys.set(provider, plain);
    return plain;
  } catch (_) {
    try { ioService.writeEnc(provider, null); } catch (__) { /* 忽略 */ }
    return '';
  }
}

/**
 * 给界面用的脱敏显示。
 *
 * ⚠ 绝不能把明文传给渲染进程——渲染进程拿不到就是需要，
 *   一旦传出去，任何一处日志或截图都能把它带走。界面只显示末 4 位。
 */
function masked(connId) {
  const k = connId ? (memoryKeys.get(connId) || '') : '';
  if (!k) return '';
  if (k.length <= 4) return '••••';
  return `••••••••${k.slice(-4)}`;
}

module.exports = {
  init,
  isEncrypted,
  bind,
  bindService,
  save,
  load,
  forget,
  masked,
  // 服务级密钥（2026-10-14）。走 service_secrets 表，**没有外键** ——
  // 联网搜索的 Key 不属于任何一条连接，塞 connection_secrets 会被拒。
  saveService,
  loadService,
};

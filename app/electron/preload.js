/**
 * preload —— 渲染进程与主进程之间的唯一通道。
 *
 * ## 为什么需要它
 *
 * Electron 的 `contextIsolation: true` + `nodeIntegration: false` 意味着
 * 渲染进程（React）默认拿不到 `require` / `fs`。这是**安全底线**：
 * 模型生成的正文会进编辑器，如果渲染进程有文件权限，
 * 一段恶意的正文就可能读走用户硬盘。
 *
 * 所以这里用 contextBridge 只暴露**白名单方法**，
 * 每个方法都是 ipcRenderer.invoke 的薄封装，不传任意 channel。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 统一处理主进程返回的 {ok, data, error} 信封 */
async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || res.ok !== true) {
    throw new Error(res && res.error ? res.error : `IPC ${channel} 调用失败`);
  }
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  // ---- 配置 ----
  config: {
    get: () => call('config:get'),
    set: (patch) => call('config:set', patch),
  },

  // ---- 工具（终端 / 联网）----
  //
  // ⚠ 这一组是「模型能碰到你电脑」的入口，所以分两类：
  //   decide / onApprove —— 审批往返
  //   setSearchKey / searchKeyStatus —— 搜索服务 Key（走 safeStorage，不进 config）
  tool: {
    /** 回传审批结果。allow=false 拒绝。 */
    decide: ({ id, allow }) => call('tool:decide', { id, allow }),
    /** 危险命令请求放行。返回取消订阅函数 */
    onApprove: (fn) => {
      const h = (_e, payload) => fn(payload);
      ipcRenderer.on('tool:approve', h);
      return () => ipcRenderer.removeListener('tool:approve', h);
    },
    /** 工具开始执行 */
    onStart: (fn) => {
      const h = (_e, payload) => fn(payload);
      ipcRenderer.on('tool:start', h);
      return () => ipcRenderer.removeListener('tool:start', h);
    },
    /** 工具执行完（带结果摘要） */
    onEnd: (fn) => {
      const h = (_e, payload) => fn(payload);
      ipcRenderer.on('tool:end', h);
      return () => ipcRenderer.removeListener('tool:end', h);
    },
    /** 填 Bing Web Search 的 Key */
    setSearchKey: ({ apiKey }) => call('tool:setSearchKey', { apiKey }),
    searchKeyStatus: () => call('tool:searchKeyStatus'),
    /**
     * 联网整体能不能用（2026-10-14）。
     * ⚠ 为什么要它：chip 亮 ≠ 联网能用。缺 Key 时 chip 照样亮，
     *   但搜索必然失败 —— 界面必须把缺哪一层说清楚。
     */
    webReady: () => call('tool:webReady'),
  },

  // ---- Ollama ----
  ollama: {
    check: () => call('ollama:check'),
  },

  // ---- 项目 ----
  project: {
    list: () => call('project:list'),
    create: ({ id, name }) => call('project:create', { id, name }),
    open: ({ id }) => call('project:open', { id }),
    /** 改显示名（不动文件夹） */
    rename: ({ id, name }) => call('project:rename', { id, name }),
    /** 删项目。keepFiles=true 时保留磁盘上的文件夹 */
    delete: ({ id, keepFiles }) => call('project:delete', { id, keepFiles }),
    /**
     * 导入一个已有的小说文件夹（原地指过去，不复制）。
     * 不传 dir 会弹系统选择框；传了则直接用该目录（测试/脚本用）。
     */
    importFolder: ({ dir } = {}) => call('project:importFolder', { dir }),
    /** 导出整个项目文件夹到用户选的位置；取消返回 {canceled:true} */
    export: ({ id }) => call('project:export', { id }),
  },

  // ---- 章节 ----
  chapter: {
    list: ({ projectId }) => call('chapter:list', { projectId }),
    get: ({ id }) => call('chapter:get', { id }),
    create: (p) => call('chapter:create', p),
    save: ({ id, content }) => call('chapter:save', { id, content }),
    remove: ({ id }) => call('chapter:delete', { id }),
  },

  // ---- 设定库 ----
  settings: {
    list: ({ projectId }) => call('settings:list', { projectId }),
    summary: (p) => call('settings:summary', p),
    upsert: (p) => call('settings:upsert', p),
    importBible: (p) => call('settings:importBible', p || {}),
  },

  // ---- 检索 ----
  bible: {
    query: (p) => call('bible:query', p),
  },

  // ---- 状态 ----
  state: {
    list: ({ projectId }) => call('state:list', { projectId }),
    // commit 之后强制回写——实测模型 20/20 只查 location，不会自己维护状态
    writeback: ({ projectId, chapterId }) => call('state:writeback', { projectId, chapterId }),
    set: (p) => call('state:set', p),
  },

  // ---- 伏笔 ----
  thread: {
    open: ({ projectId }) => call('thread:list', { projectId }),
    create: (p) => call('thread:create', p),
    resolve: ({ id, chapterId }) => call('thread:resolve', { id, chapterId }),
  },

  // ---- 对话（新版主交互）----
  conv: {
    list: ({ projectId }) => call('conv:list', { projectId }),
    create: ({ projectId, title }) => call('conv:create', { projectId, title }),
    rename: ({ id, title }) => call('conv:rename', { id, title }),
    remove: ({ id }) => call('conv:delete', { id }),
    messages: ({ conversationId }) => call('conv:messages', { conversationId }),
    /**
     * 设这一条对话的思考强度档位。
     *
     * 与 `config.set({thinkLevel})` 是两件事：那个是**新对话的默认值**，
     * 这个是**这一条对话的**。界面上只有输入框旁边那一个控件，
     * 它改的是后者。
     */
    setThink: ({ conversationId, level }) => call('conv:setThink', { conversationId, level }),
    /** 发送一条消息并流式生成。onChunk/onDone/onError 与 generate 共用同一套订阅。 */
    send: (p) => call('conv:send', p),
  },

  /** 消息级的操作（每条消息下面那三个按钮） */
  msg: {
    /** 删掉这一条。用户发错了只能靠这个救回来。 */
    remove: ({ id }) => call('msg:delete', { id }),
    /** 撤回：从这条起后面全清，回到能重新提问的状态。 */
    undo: ({ id }) => call('msg:deleteFrom', { id }),
  },

  // ---- 技能（输入框 @ 引用）----
  skill: {
    /** 只列启用的（输入框 @ 引用用） */
    list: ({ projectId }) => call('skill:list', { projectId }),
    /** 列全部含停用的（设置页管理用） */
    listAll: ({ projectId }) => call('skill:listAll', { projectId }),
    create: (p) => call('skill:create', p),
    update: ({ id, name, promptContent }) =>
      call('skill:update', { id, name, promptContent }),
    setEnabled: ({ id, enabled }) => call('skill:setEnabled', { id, enabled }),
    remove: ({ id }) => call('skill:delete', { id }),

    // ---- 目录式 Skill（渐进式加载）----
    /** 配套文件清单（不含内容） */
    files: ({ id }) => call('skill:files', { id }),
    /** 读一个配套文件的完整内容 */
    file: ({ id, path }) => call('skill:file', { id, path }),
    saveFile: (p) => call('skill:saveFile', p),
    deleteFile: ({ id, path }) => call('skill:deleteFile', { id, path }),

    /**
     * 校验一份 SKILL.md（不落库）。
     * @returns {ok, name, description, errors[], warnings[], body}
     */
    importCheck: (content) => call('skill:import', { content }),
    /** 校验并落库 */
    importCommit: ({ content, name, projectId, files }) =>
      call('skill:importCommit', { content, name, projectId, files }),
    /** 导出成可带走的结构 */
    export: ({ id }) => call('skill:export', { id }),

    /** 渐进式加载的第一级：只给 name + description */
    index: ({ projectId, only }) => call('skill:index', { projectId, only }),
    /** 第二级：@ 引用时取完整正文 */
    lookup: ({ id }) => call('skill:lookup', { id }),
  },

  // ---- 生成 ----
  generate: {
    start: (p) => call('generate:start', p),
    stop: () => call('generate:stop'),
    /** 订阅流式分片；返回取消订阅函数 */
    onChunk: (fn) => {
      const h = (_e, text) => fn(text);
      ipcRenderer.on('generate:chunk', h);
      return () => ipcRenderer.removeListener('generate:chunk', h);
    },
    onDone: (fn) => {
      const h = (_e, meta) => fn(meta);
      ipcRenderer.on('generate:done', h);
      return () => ipcRenderer.removeListener('generate:done', h);
    },
    /**
     * 生成结束后自动把正文写回章节文件的通知（2026-10-18）。
     *
     * 载荷 {path, mode, chars, backup, why}：界面据此提示"已写入第一章"，
     * 并让用户知道原文件备份到了哪里。
     *
     * ⚠ 这是**独立通道**，不是 generate:done 里的一个字段：落盘发生在 done
     *   之前，挤进 done 会让界面在处理 done 的分支里多一个嵌套判断，
     *   而这条提示的显示条件跟 done 完全无关（没写就不该提示）。
     */
    onAutosave: (fn) => {
      const h = (_e, info) => fn(info);
      ipcRenderer.on('generate:autosave', h);
      return () => ipcRenderer.removeListener('generate:autosave', h);
    },
    onError: (fn) => {
      const h = (_e, msg) => fn(new Error(msg));
      ipcRenderer.on('generate:error', h);
      return () => ipcRenderer.removeListener('generate:error', h);
    },
    /**
     * 思考过程分片。**与 onChunk 是两条独立通道**。
     * 界面用它显示"正在想"，但绝不能把它写进编辑器。
     */
    onThink: (fn) => {
      const h = (_e, text) => fn(text);
      ipcRenderer.on('generate:think', h);
      return () => ipcRenderer.removeListener('generate:think', h);
    },
  },

  // ---- 菜单栏动作（新建项目 / 新建对话 / 保存…）----
  /** 订阅菜单点击；返回取消订阅函数 */
  onMenuAction: (fn) => {
    const h = (_e, action) => fn(action);
    ipcRenderer.on('menu:action', h);
    return () => ipcRenderer.removeListener('menu:action', h);
  },

  /**
   * 项目文件夹在**主进程那边**被改了（模型调 write_note 写文件、
   * 回收站还原…）。返回取消订阅函数。
   *
   * ⚠ 2026-10-15 加的。写文件能力早就有了，而这一条通知一直没接线：
   *   模型答「已写入 章节/第一章.md」，右边目录里没有那个文件，
   *   重启一次又出来 —— 文件真在磁盘上，缺的是让界面重拉。
   *
   * ⚠ 只带 `path` 不够：watch 目录会漏事件，而这里是**写完就通知**，
   *   所以每条通知都对应一次真实的写入。
   */
  onFilesChanged: (fn) => {
    const h = (_e, info) => fn(info || {});
    ipcRenderer.on('fs:changed', h);
    return () => ipcRenderer.removeListener('fs:changed', h);
  },

  // ---- 风格（第 3 步）----
  // 基准来自用户自己已保存的章节，不是内置词表。
  // 所以「还没写过章节」时 styleProfile 会返回 unavailable —— 这是正常状态，不是错误。
  /** 自定义背景图（图片走 appbg:// 协议，不占内存） */
  bg: {
    pick: () => call('bg:pick'),
    get: () => call('bg:get'),
  },

  /** 上下文用量（自动压缩在后台跑，但没有可见性——界面靠它显示指示器） */
  ctx: {
    status: () => call('ctx:status'),
  },

  /**
   * 范围守卫：这个软件只做小说写作。
   * ⚠ 判定发生在**主进程**（`scope-guard.js`），界面只能读状态、只能申请解锁，
   *   改不了判定结果 —— 安全边界不能只写在渲染层。
   */
  /**
   * 行为审计（2026-10-18，第三道防线）。
   *
   * 与 `scope` 分开：scope 管的是"这句话该不该放行"（会落盘、会锁连接），
   * 这一组管的是"这个对话是不是在干活"（临时闸门、重启即恢复）。
   * 两者的严重程度差一个量级，混在一起会让用户分不清是被判越狱还是被劝回。
   */
  audit: {
    state: () => call('audit:state'),
    /** 点「继续使用」：清零并解除暂停（误伤的明路） */
    resume: () => call('audit:resume'),
    /** 被判定为连续无产出时推送说明；返回取消订阅函数 */
    onPaused: (fn) => {
      const h = (_e, msg) => fn(msg);
      ipcRenderer.on('audit:paused', h);
      return () => ipcRenderer.removeListener('audit:paused', h);
    },
  },

  scope: {
    status: () => call('scope:status'),
    unlock: () => call('scope:unlock'),
    /**
     * 《用户协议》全文。
     *
     * ⚠ 正文只有主进程那一份（`user-agreement.js`），界面原样取来显示 ——
     *   前端自己抄一份的话，用户看到的协议和实际约束迟早对不上。
     */
    agreement: () => call('scope:agreement'),
    /**
     * 守卫状态变了（锁上 / 解锁）就通知界面。
     *
     * ⚠ 不只是"自己点了解锁"才需要：守卫在两个入口都会锁
     *   （聊天发送、正文生成），界面得**跟着**禁用/放开输入框。
     *   少了这条订阅，另一个入口锁掉之后界面还装作能发。
     */
    onChange: (fn) => {
      const h = (_e, st) => fn(st);
      ipcRenderer.on('scope:changed', h);
      return () => ipcRenderer.removeListener('scope:changed', h);
    },
  },

  /** 一次性文本生成（不进对话历史、不触发工具） */
  text: {
    ask: ({ prompt, timeoutMs }) => call('text:ask', { prompt, timeoutMs }),
  },

  style: {
    profile: ({ projectId }) => call('style:profile', { projectId }),
    /**
     * 文风蒸馏（2026-10-15 新增）。
     *
     * ⚠ 与 `distill:*`（资料蒸馏，抽设定条目）是**两件事**：
     *   这个读原文学**怎么写**，产出可挂载的 skill。
     *
     * `distill` 只做分析、不落库；`distillSave` 才写进自定义技能 ——
     * 分两步是为了让用户先看一遍生成结果再决定要不要留下。
     */
    distill: ({ name, text }) => call('style:distill', { name, text }),
    distillSave: ({ name, skillMd }) => call('style:distillSave', { name, skillMd }),
    /** 弹出系统文件选择框读 txt/md/docx（自己解 zip，项目零第三方依赖） */
    pickFiles: () => call('style:pickFiles'),
    check: ({ projectId, text }) => call('style:check', { projectId, text }),
  },

  // ---- 项目文件树（第 4 栏）与文档预览（第 3 栏）----
  //
  // ⚠ 这里刻意只暴露项目目录内的操作，没有「任意路径读写」。
  //   越界检查在主进程 ProjectFs.resolveIn 里做——渲染进程连
  //   fs 的边都碰不到，传进来的路径全部经过主进程校验。
  fs: {
    tree: ({ projectId, maxDepth, sort }) => call('fs:tree', { projectId, maxDepth, sort }),
    read: ({ projectId, path }) => call('fs:read', { projectId, path }),
    write: ({ projectId, path, content }) => call('fs:write', { projectId, path, content }),
    /**
     * 这个文件的历史版本（AI 改坏了能退回去）。
     * 返回 {items:[{name, stamp, size, mtime}]}，新的在前。
     */
    history: ({ projectId, path }) => call('fs:history', { projectId, path }),
    /** 恢复到某个备份；恢复前会自动把当前内容再备份一次 */
    restore: ({ projectId, path, backup }) => call('fs:restore', { projectId, path, backup }),
    create: ({ projectId, path, dir, content }) => call('fs:create', { projectId, path, dir, content }),
    rename: ({ projectId, from, to }) => call('fs:rename', { projectId, from, to }),
    remove: ({ projectId, path, recursive }) => call('fs:remove', { projectId, path, recursive }),
    validateName: (name) => call('fs:validateName', { name }),
    /**
     * 拖拽落点。跨目录移动与同目录重排都走这里。
     * @param anchor 该层里的锚点项名；不给表示"放进这个文件夹的末尾"
     */
    move: ({ projectId, from, toDir, anchor, place }) =>
      call('fs:move', { projectId, from, toDir, anchor, place }),
    /** 在系统文件管理器里打开项目文件夹 */
    reveal: ({ projectId }) => call('fs:reveal', { projectId }),
  },

  // ---- AI 提供商 ----
  //
  // ⚠ 这里没有任何方法会返回密钥明文。
  //   keyStatus 只给「有没有 / 能不能加密 / 末 4 位」，
  //   setKey 是**单向**的（进去，不出来）。
  provider: {
    /** 服务商量表。界面不写死任何一家的地址 */
    capabilities: () => call('provider:capabilities'),

    /** 连接列表。不含密钥密文——那是主进程的事 */
    listConnections: () => call('provider:listConnections'),
    createConnection: (p) => call('provider:createConnection', p),
    updateConnection: ({ id, ...patch }) => call('provider:updateConnection', { id, ...patch }),
    deleteConnection: ({ id }) => call('provider:deleteConnection', { id }),
    /** 切换当前使用的连接 */
    /**
     * 查本地模型**真实**支持的窗口（Ollama /api/show）。
     * ⚠ 因为 Ollama 会把超出的窗口静默压到模型上限，不报错 ——
     *   所以必须查，不能只看用户填了什么。
     */
    modelCapability: ({ model }) => call('provider:modelCapability', { model }),
    activate: ({ id }) => call('provider:activate', { id }),
    /**
     * 断开连接：清空"正在使用"，回到选一条的状态。
     * ⚠ 不是删除——连接、地址、密钥都留着，再点一下就切回去。
     */
    disconnect: () => call('provider:disconnect'),

    /**
     * 测连通性。传 base/apiKey 只用于这一次探测，**不落盘**。
     * @param {string} [id] 测哪条连接。不传则测当前连接
     * @returns {ok, engine, base?, version?, models?, latencyMs?, error?}
     */
    probe: ({ id, base, model, apiKey } = {}) =>
      call('provider:probe', { id, base, model, apiKey }),
    /** 单向存密钥；返回里只有脱敏后的结果 */
    setKey: (apiKey, id) => call('provider:setKey', { id, apiKey }),
    /** 读密钥状态（脱敏） */
    keyStatus: (id) => call('provider:keyStatus', { id }),

    /**
     * 生成参数：窗口 / 输出上限 / 输出预留。
     * ⚠ 按连接存（numCtx 在本地是"吃多少显存"、在云端是"模型窗口多大"）。
     */
    connParams: (id) => call('provider:connParams', { connectionId: id }),
    /**
     * 写生成参数。传 null 表示恢复"自动"（输出预留会按输出上限的一半算）。
     * ⚠ 返回是**内层信封**，读到 ok:true 还要再看 data.ok。
     */
    setConnParams: (id, patch) => call('provider:setConnParams', { connectionId: id, ...patch }),
  },

  // ---- 诊断 ----
  app: {
    info: () => call('app:info'),
    /** 当前版本（不发网络请求） */
    version: () => call('app:version'),
    /** 设置发布页地址；不合格返回 {ok:false,error} */
    setDownloadUrl: (url) => call('app:setDownloadUrl', { url }),
    /**
     * 打开外部链接。
     * ⚠ 主进程只允许 http/https——这里的 url 来自 GitHub 响应，
     *   不校验协议就等于把「打开任意协议」的能力交给了外网。
     */
    openExternal: (url) => call('app:openExternal', { url }),
    /** 生成完成时闪动任务栏窗口 */
    flashFrame: () => call('app:flashFrame'),
  },

  /**
   * ---- 窗口控制（自定义标题栏，2026-10-16 20:20）----
   *
   * ⚠⚠ 因为主窗口改成了 `frame: false`（两横标题栏合并成一条），
   *   系统那条标题栏连同它的三个按钮一起没了 —— 这里补上。
   *
   * ⚠⚠ `onStateChange` 走 ipcRenderer.on 而**不是** call：
   *   它是主进程主动推过来的（最大化/还原/聚焦变化），
   *   没有对应的返回值通道。
   * ⚠⚠⚠ 返回值必须是**取消函数**：不取消的话，组件每次重渲染都会
   *   再注册一个监听器 —— 点一次窗口按钮发 N 次 IPC，监听器越堆越多。
   */
  win: {
    minimize: () => call('win:minimize'),
    toggleMaximize: () => call('win:toggleMaximize'),
    close: () => call('win:close'),
    isMaximized: () => call('win:isMaximized'),
    onStateChange: (cb) => {
      const listener = (_e, st) => cb(st);
      ipcRenderer.on('win:state', listener);
      return () => ipcRenderer.removeListener('win:state', listener);
    },
  },

  // ---- 字体（开源字体按需下载）----
  //
  // ⚠ 下载在主进程做（CSP 禁止渲染进程联网）。这里只暴露「列 / 装 / 删 / 进度」。
  //   装好的字体通过 appfont:// 协议喂给界面，渲染进程用 @font-face 接。
  font: {
    /** 全部预置（不含 url，url 只在主进程内部用） */
    presets: () => call('font:presets'),
    /** 已下载到本机的字体 id 列表 */
    installed: () => call('font:installed'),
    /** 下载某个字体（首次需联网）。失败抛错 */
    install: ({ id }) => call('font:install', { id }),
    /** 删除某个已下载字体 */
    uninstall: ({ id }) => call('font:uninstall', { id }),
    /** 订阅下载进度；返回取消订阅函数 */
    onProgress: (fn) => {
      const h = (_e, p) => fn(p);
      ipcRenderer.on('font:progress', h);
      return () => ipcRenderer.removeListener('font:progress', h);
    },
  },

  // ---- 回收站 ----
  //
  // 「放入回收站」与「删除」是两条路：删除不可逆，回收站可还原。
  // 界面上的右键菜单默认给「放入回收站」，永久删除放在二级菜单里。
  trash: {
    list: ({ projectId }) => call('trash:list', { projectId }),
    add: ({ projectId, path }) => call('trash:add', { projectId, path }),
    restore: ({ projectId, id, toPath }) => call('trash:restore', { projectId, id, toPath }),
    purge: ({ projectId, id }) => call('trash:purge', { projectId, id }),
    empty: ({ projectId }) => call('trash:empty', { projectId }),
  },

  // ---- 数据：备份 ----
  data: {
    /** 备份整个项目文件夹；不传 destDir 会弹目录选择框 */
    backup: ({ projectId, destDir }) => call('data:backup', { projectId, destDir }),
    /** 弹框选一个备份文件夹，返回其统计信息 */
    inspectBackup: () => call('data:inspectBackup'),
  },
});
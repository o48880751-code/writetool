# WriteTool

面向**长篇连载**（十万字到数百万字）的本地优先写作工具。把一个能读能写的大模型，放进一个**受控**的工作台里：它能查设定、读章节、改文件，但每一次动你的稿子都要你点头。

> 数据全部留在本机。模型可以接云端 API，也可以接本地 Ollama。

<!-- 截图放在 app/shots/ 下 -->
![主界面：左侧对话，右侧章节编辑器](app/shots/main-ui.png)

**168** 个源码文件 · **6.6 万** 行代码 · **70** 个判据文件（39 个零依赖，clone 下来直接跑） · 无后端服务

---

## 它解决什么问题

写长篇最难的从来不是"写不出来"，是**前后一致**：

- 第 300 章要提到第 40 章埋的伏笔，但你记不清当时的原话
- 人物性格在 50 章里慢慢漂移，等你发现时已经不像同一个人
- 战力体系（境界、术法、势力）互相矛盾，改一处要翻三百章

通用聊天工具解决不了这个，因为它们**看不见你的项目**。WriteTool 的做法是：

1. **把项目文件变成模型能读的上下文**（设定库、章节、摘要，按需检索而不是全塞）
2. **把写作动作变成受控的工具调用**（读文件、写章节、改设定，每一步要审批）
3. **把每次改动留下痕迹**（章节可回退，改动可追溯）

---

## 技术栈

| 层 | 选型 | 为什么 |
|---|---|---|
| 桌面壳 | **Electron 44** | 需要本地文件系统 + 本地进程（Ollama），浏览器做不到 |
| 渲染层 | **React 19** + Vite 8 | 四栏布局状态多，需要细粒度更新 |
| 样式 | **Tailwind CSS 4** + CSS 变量 | 主题切换（浅色/深色/自定义背景）靠变量，不靠类名切换 |
| 编辑器 | **TipTap 3**（ProseMirror） | 章节编辑要能精确定位到段落，普通 textarea 做不到 |
| 存储 | **SQLite**（`node:sqlite`，Node 22 内置） | 单机应用不需要服务端；WAL 模式，崩溃可恢复 |
| 打包 | **electron-builder 26**（NSIS） | Windows 安装包 |
| 模型接入 | **OpenAI 兼容协议** + **Ollama 原生 `/api/chat`** | 一套代码接两家，靠 `engine` 字段分流 |

**没有后端服务。** 所有数据在 `app.getPath('userData')` 下的一个 SQLite 文件里。

---

## 快速开始

### 环境要求

- **Node.js ≥ 22**（用到内置的 `node:sqlite`，低版本会报错）
- Windows 10/11（当前只做了 Windows 打包）
- 如果要用本地模型：[Ollama](https://ollama.com/)（可选）

### 1. 安装依赖

```bash
cd app
npm install
```

### 2. 配置 API Key

**软件里配，不写在代码里**（代码里没有任何硬编码密钥）：

1. 启动后进 **设置 → 模型连接**
2. 点「＋ 新建连接」，选一家预置服务商或填自定义地址
3. 填入 API Key，点「保存并测试」

支持的服务商形态：

| 类型 | 填什么 base | 例子 |
|---|---|---|
| OpenAI 兼容（云端） | 各家自己的地址 | DeepSeek `https://api.deepseek.com`；硅基流动 `https://api.siliconflow.cn/v1` |
| 本地 Ollama | `http://127.0.0.1:11434` | 装好 Ollama 后跑 `ollama pull qwen3` |

> ⚠ Key 用 Electron 的 `safeStorage` 加密后存进本地 SQLite（走系统密钥链）。
> 不进日志、不上传、不写配置文件。

### 3. 启动

```bash
# 开发模式（Vite 热更新 + Electron）
npm run dev

# 或者打包
npm run package
```

### 4. 建项目

新建项目 → 选一个空文件夹 → 工具会生成标准结构：

```
设定/世界观.md
设定/人物库.md
卷纲/                 （空目录，等你填）
章节/章节摘要.md
```

---

## 目录结构

```
├── run-verify.js             本地模型 Tool Calling 可行性验证（需自备 world-bible.json）
├── test-mock.js              编排层离线自测：可编程假模型驱动，16 类异常分支
├── eval-retrieval.js         检索层离线评测：质量与上下文成本，改前/改后对比
│
├── app/                      桌面应用主体
│   ├── electron/             主进程（Node 环境，能碰文件和网络）
│   │   ├── main.js           入口 + 全部 IPC handler
│   │   ├── provider.js       模型接入层（OpenAI 兼容 / Ollama 归一）
│   │   ├── agent-loop.js     工具调用的多轮循环（含轮数上限）
│   │   ├── project-fs.js     项目文件的读写与模板
│   │   ├── scope-guard.js    范围守卫（拦越狱 / 改身份 / 越权请求）
│   │   └── test-*.js         主进程侧判据（每个 50~100 条断言）
│   ├── src/                  渲染层（React）
│   │   ├── App.jsx           顶层状态与 IPC 编排
│   │   ├── components/       四栏工作台的各个面板
│   │   └── index.css         主题变量与布局
│   ├── builtin-skills/       内置写作技能（纯 Markdown，用户可改）
│   └── shots/                界面截图
│
├── db/                       数据层（主进程和判据共用）
│   ├── schema.sql            表结构（带版本号，升级自动迁移）
│   └── store.js              SQLite 封装
│
├── memory/                   上下文工程
│   ├── context-budget.js     按模型真实窗口算预算、决定裁掉什么
│   └── check-outline-drift.js 长程一致性检查
│
└── editor/                   章节编辑器的流式接口（独立于 UI，可单测）
```

各模块另有独立 README：[`app/`](app/README.md)（打包流程、产物结构、换机器会踩的环境坑）· [`editor/`](editor/README.md)（流式写入层）· [`memory/`](memory/README.md)（上下文工程与状态回写）

---

## 怎么验证

判据不依赖测试框架：每个 `test-*.js` 自己打印「通过 N / 失败 M」，退出码非 0 即失败。

```bash
cd app
node test-agent-loop.js     # 工具循环：22 通过 / 0 失败
node test-auto-save.js      # 自动落盘：48 条
```

70 个判据文件里 **39 个零依赖**，clone 下来不装任何东西就能跑，覆盖工具协议、审批闸门、上下文预算、数据迁移、范围守卫、空响应处理这些核心逻辑。

其余 31 个分三类：

| 类别 | 数量 | 缺什么 |
|---|---|---|
| 要真窗口 | 19 | `npm install` 后起 Electron（主题、标题栏、IME、UI 像素扫描），或依赖 `@tiptap` / `playwright` |
| 要额外环境 | 5 | `dist/` 构建产物、`world-bible.json` 设定库、或联网下载字体 |
| 目前是红的 | 7 | 判据自身过时或断言没跟上代码改动，不是运行环境问题 |

**模型层与检索层的离线评测**在仓库根目录，三个脚本都需要自备 `world-bible.json`（设定库含作品正文，不进仓库）：

| 脚本 | 测什么 |
|---|---|
| `run-verify.js` | 本地模型能否稳定产出合法 tool call，按「合法率 ≥80% 通过」判定；`--probe` 只探服务、单次调用 |
| `test-mock.js` | 用可编程假模型驱动同一套清洗 / 校验 / 重试 / 降级逻辑，断言 16 类异常分支 |
| `eval-retrieval.js` | 检索层命中数与上下文占用，给出改前 / 改后的量化对比 |

`world-bible.json` 的结构见 `run-verify.js` 的 `loadWorld`：顶层 `{"entries": [...]}`，条目字段 `project / name / type / note / aliases`，`type` 取 `character|faction|technique|location|plot`。

---

## 几个值得说的设计

### ① 上下文是"预算"问题，不是"塞进去"问题

本地模型的实际窗口经常比标称小（Ollama 超出能力时静默压到模型自带上限，不报错）。所以先查真实能力，再按预算分配：设定库、最近章节、摘要、技能正文各有配额，超了按优先级裁，而不是盲目截断。

`memory/context-budget.js`

### ② 工具调用必须"有界"

模型会重复发同一个调用（8B 级别尤其明显），也可能无限索要工具。所以循环有硬上限：`max_steps`、同参数重复次数、墙钟超时、token 预算。超了不是在重试，而是停下来告诉用户。

`electron/agent-loop.js`

### ③ 危险操作走人工确认，而不是靠提示词约束

提示词能劝住模型，但劝不住被注入的模型。删除文件、执行命令、改项目外的路径——这些走主进程的审批通道，界面弹框，**超时 120 秒无响应按拒绝处理**。

`electron/main.js` 的 `approval` 模块

### ④ 判据是代码，不是"我试过了"

每个模块配一个 `test-*.js`，直接 `node test-xxx.js` 就能跑，不依赖测试框架。目前 **70 个判据文件、约 790 处断言**，覆盖数据迁移、自动落盘、范围守卫、工具协议、空响应处理等。

```bash
cd app
node test-schema-migration.js    # 库结构升级
node test-tools.js               # 工具链与安全
node test-scope-guard.js         # 范围守卫
```

---

## 已知限制

写清楚比藏着好：

- **只做了 Windows 打包**，macOS / Linux 没测过
- **没有代码签名证书**，安装时 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」
- **不做自动更新**（未签名 exe 会被 SmartScreen 拦在下载阶段，体验比"手动下载"更差）
- **多人协作、云同步**：不做，也不打算做
- 上下文压缩是启发式的（按段落 / 摘要裁），不是语义检索
- **判据不是全部即插即跑**：70 个里 39 个零依赖，其余要 npm 包、构建产物或本地设定库
- **7 个判据目前是红的**：属判据过时或断言未跟上代码，不是环境问题。绿灯数会随代码改动漂移，别当成「测试全过」的证据

---

## License

MIT

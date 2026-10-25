# WriteTool

[![verify](https://github.com/o48880751-code/writetool/actions/workflows/verify.yml/badge.svg)](https://github.com/o48880751-code/writetool/actions/workflows/verify.yml)

面向**长篇连载**（十万字到数百万字）的本地优先写作工具。把一个能读能写的大模型，放进一个**受控**的工作台里：它能查设定、读章节、改文件，但每一次动你的稿子都要你点头。

> 数据全部留在本机。模型可以接云端 API，也可以接本地 Ollama。

<!-- 截图放在 app/shots/ 下 -->
![主界面：左侧对话，右侧章节编辑器](app/shots/main-ui.png)

**169** 个源码文件 · **6.6 万** 行代码 · **70** 个判据文件（50 个零依赖，clone 下来直接跑） · 无后端服务

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
├── verify.js                 判据批量运行器：自动跳过需要 npm 的，跑剩下的零依赖判据
├── run-verify.js             本地模型 Tool Calling 可行性验证（需本地 Ollama）
├── test-mock.js              编排层离线自测：可编程假模型驱动，27 个用例覆盖 16 类异常分支
├── eval-retrieval.js         检索层离线评测：质量与上下文成本，改前/改后对比
├── samples/
│   └── world-bible.sample.json  示例设定库（2 个项目 / 20 条合成条目，离线脚本默认用它）
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

判据不依赖测试框架：每个 `test-*.js` 自己打印「通过 N / 失败 M」，退出码非 0 即失败。跑全部零依赖判据只要一条命令：

```bash
node verify.js           # 逐项跑，末尾汇总
node verify.js --ci      # 只跑核心集 17 个（GitHub Actions 每次提交跑的就是这个）
node verify.js --list    # 列清单，标注每个判据缺哪个 npm 包
```

它先静态扫每个判据的 `require`，需要 Electron / TipTap / Playwright 的自动跳过，剩下 50 个只用 Node 内置模块的直接跑，不装任何东西。当前 **42 通过 / 8 未通过**：

| 类别 | 数量 | 说明 |
|---|---|---|
| 要额外环境 | 3 | 联网拉字体、本地 Ollama 服务、`dist/` 构建产物 |
| 判据或代码没跟上 | 5 | `test-distill` 指向已下线的组件、`test-tdz`（App.jsx 的 TDZ）、`test-skill-content`（内置技能正文超预算 98 字）、`test-main-boot`、`test-packaging` |

另有 **20 个需要 `npm install`**：Electron 真窗口 17 个（主题、标题栏、IME、菜单、UI 像素扫描）、`@tiptap/pm/model` 2 个、`playwright` 1 个。这些跑的是真界面，不在 CI 范围内。

单个判据也能直接跑：

```bash
cd app
node test-agent-loop.js     # 工具循环：22 通过 / 0 失败
node test-auto-save.js      # 自动落盘：48 条
```

**模型层、检索层、数据层的离线评测**不需要模型，也不需要你准备数据——仓库带了一份示例设定库 [`samples/world-bible.sample.json`](samples/world-bible.sample.json)，脚本找不到真实设定库时自动回落到它：

```bash
node test-mock.js        # 编排层 27 个用例
node eval-retrieval.js   # 检索层改前/改后对比表
node db/test-db.js       # 数据层 58 项（Node 22 内置 node:sqlite，不用装包）
```

| 脚本 | 依赖 | 测什么 |
|---|---|---|
| `test-mock.js` | 无 | 用可编程假模型驱动同一套清洗 / 校验 / 重试 / 降级逻辑，断言 16 类异常分支 |
| `eval-retrieval.js` | 无 | 检索层命中数与上下文占用，给出改前 / 改后的量化对比 |
| `db/test-db.js` | 无 | SQLite 版检索行为必须与内存版逐项一致，否则前面所有实测数据作废 |
| `run-verify.js` | Ollama | 本地模型能否稳定产出合法 tool call，按「合法率 ≥80% 通过」判定；`--probe` 只探服务、单次调用 |

**换成自己的设定库**：在仓库根目录放一个 `world-bible.json` 即可，脚本优先用它（这个文件名已在 `.gitignore` 里，不会误传）。结构见 `run-verify.js` 的 `resolveWorldPath`：顶层 `{"entries": [...]}`，条目字段 `project / name / type / note / aliases`，`type` 取 `character|faction|technique|location|plot`。示例库刻意保留了两处检索层需要的行为——`乱葬岗` 带别名「岗子」用来测别名命中，`novel-demo-02` 的 `悬风钟` 带别名「铜钟」用来测 `青铜钟` 这类陌生词会不会被子串误命中。

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

每个模块配一个 `test-*.js`，直接 `node test-xxx.js` 就能跑，不依赖测试框架。目前 **70 个判据文件、1249 个用例、789 处断言**，覆盖数据迁移、自动落盘、范围守卫、工具协议、空响应处理等。

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
- **判据不是全部即插即跑**：70 个里 50 个零依赖，其余要 npm 包或构建产物
- **8 个判据目前没通过**：3 个缺外部环境（联网 / Ollama / dist），5 个属判据过时或断言未跟上代码。绿灯数会随代码改动漂移，别当成「测试全过」的证据

---

## License

MIT

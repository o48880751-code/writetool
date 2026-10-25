# WriteTool

本地长篇小说写作工具。TipTap 编辑器 + 本地模型（Ollama），数据全部留在本机。

---

## 快速开始

```powershell
cd app
npm install

# 开发模式（热更新）
npm run dev

# 生产模式
npm start

# 打包成 Windows 安装包
npm run package
# 或者双击 打包.bat
```

**前置条件**：本机装了 [Ollama](https://ollama.com) 并已 `ollama serve`。
应用启动后右栏会显示连接状态；没连上也能编辑，只是不能生成。

---

## 打包产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `release/WriteTool-0.1.0-setup.exe` | 108 MB | 安装包，可选安装目录 |
| `release/win-unpacked/WriteTool.exe` | 383 MB | 便携版，免安装 |

已实测：**打包后的 exe 独立启动正常**，模块加载、SQLite 建库、
渲染、IPC 全链路可用（不只是"能打开"）。

### 打包相关的两个坑

**1. `files` 白名单漏目录**

最早只写了 `dist/**/*`、`dist-electron/**/*`、`package.json`，
结果 `electron/main.js` 没进 asar，报：

```
Application entry file "electron\main.js" ... is corrupted:
"electron\main.js" was not found in this archive
```

`dist-electron/` 那条是早期架构残留——主进程已改回原生 CJS（在 asar 外），
不再需要打包。

**2. 主进程 require 的模块在项目根，不在 app/ 内**

`main.js` 要 `../db/store.js` 与 `../memory/*`。开发态没问题，
打包后这两个目录不在 asar 里。解法是 `extraResources` 复制到
`resources/modules/`，主进程用 `app.isPackaged` 分流：

```js
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'modules')
  : path.join(__dirname, '..', '..');
```

**顺带做的清理**：`memory/state-writer.js` 原本 `require('../run-verify.js')`
只为拿两个纯函数（`norm` / `suffixVariants`）——那是个 65KB 的验证脚本，
带工具执行和文件落盘副作用。已抽成 `memory/text-util.js`，
**7/7 行为逐位一致**，`memory/` 与 `db/` 现在完全自足。

### NSIS 工具链下载

首次打包要单独下 NSIS（约 10MB），国内直连大概率失败：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

`打包.bat` 里已经设好。

---

## 环境踩过的坑（换机器时会再遇到）

### 1. `ELECTRON_RUN_AS_NODE=1` 会让 Electron 变成纯 Node

**症状**：`require('electron')` 返回一个字符串，`app` 是 `undefined`，
报 `TypeError: Cannot read properties of undefined (reading 'getPath')`。

**原因**：这个环境变量存在时，Electron 不初始化 GUI 运行时，
所有 Electron API 都拿不到。

**解法**：`env -u ELECTRON_RUN_AS_NODE npm start`（Windows PowerShell 用
`Remove-Item Env:ELECTRON_RUN_AS_NODE`）。

### 2. 无显示器/沙箱环境下渲染进程起不来

**症状**：窗口永远不显示，`did-finish-load` 与 `did-fail-load` 都不触发。

**原因**：Chromium 的 GPU 独立进程在无图形上下文时崩溃。

**解法**：已在 `electron/main.js` 里加了 4 个开关，其中 `in-process-gpu` 是关键：

```js
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
```

### 3. Electron 二进制下载失败

**症状**：`Error: Electron failed to install correctly`。

**解法**：用国内镜像（见 `.npmrc`）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install electron --no-audit --no-fund
```

如果 `npm install` 的 postinstall 没跑，手动执行一次：

```powershell
cd node_modules/electron
node install.js
```

### 4. Windows 上 stdout 不可见

Electron 是 GUI 子系统，`console.log` 在终端里看不到。
调试日志写在：`%TEMP%\writetool-debug.log`。

### 5. `npx electron .` 在中文路径下 spawn 失败

报 `Error: spawn ...\node_modules\electron\dist\electron.exe ENOENT`。
**解法**：直接调 exe：

```powershell
.\node_modules\electron\dist\electron.exe .
```

---

## 架构

```
app/
├── electron/
│   ├── main.js          主进程：唯一能碰文件系统与 SQLite 的地方
│   └── preload.js       contextBridge 白名单，渲染进程唯一的对外通道
├── src/
│   ├── App.jsx          三栏布局 + 生成流程编排
│   ├── components/
│   │   ├── Sidebar.jsx       项目/章节/设定/状态/伏笔
│   │   ├── EditorSurface.jsx TipTap + 流式写入
│   │   └── SettingsPanel.jsx 模型/上下文/外观/设定库导入
│   └── index.css
└── run-app-e2e.js      端到端自检（不开界面，跑完整链路）
```

### 安全边界

渲染进程**不给 node 集成**（`nodeIntegration: false` + `contextIsolation: true`）。
模型生成的正文会进编辑器，如果渲染进程有文件权限，
一段恶意正文就可能读走用户硬盘。所以一切文件操作都必须在主进程。

### 复用的既有模块

主进程直接 `require` 了前几步写好并测过的模块，没有重写：

| 模块 | 位置 | 作用 |
|---|---|---|
| 数据层 | `../db/store.js` | SQLite 读写，11 张表 |
| 设定摘要 | `../memory/context-budget.js` | 打分制 + 每类保底名额 |
| 状态回写 | `../memory/state-writer.js` | commit 后强制回写 |
| 上下文治理 | `../memory/loop-guard.js` | 超预算自动压缩，保配对完整 |

这些模块有 **174 个用例**守着（`node ../test-mock.js` 等）。

---

## 端到端自检

```powershell
# 基础链路（不需要模型）
.\node_modules\electron\dist\electron.exe run-app-e2e.js

# 含真实模型生成
$env:WRITETOOL_GEN="1"
.\node_modules\electron\dist\electron.exe run-app-e2e.js
```

覆盖：建项目 → 导设定 → 摘要 → 检索 → 建章 → 存章 → 状态回写 → 上下文压缩 → 流式生成。

---

## 设定库导入

格式：

```json
{
  "entries": [
    {
      "project": "modianditu",
      "type": "character",
      "name": "夜枫",
      "note": "赤霄宗外门弟子，左掌心烙有「残剑印」",
      "aliases": ["小九"]
    }
  ]
}
```

`type` 只能是：`character` / `location` / `technique` / `faction` / `plot`。

现成的：`../墨染仙途-设定库.json`（347 条，从 `AI写小说/墨染仙途/小说资料/` 导入）。

---

## 三条不能破的设计约束

改代码前先读 `../editor/probe-report.md` 与 `../memory/README.md`。

### 1. 插入点每次重算，绝不缓存绝对位置

用户中途编辑会改变 `doc.content.size`，缓存的位置会把模型文字写进段落中间。

### 2. 程序写入走 `view.updateState`，不走 `dispatch`

实测 `updateState` 触发 **0 个 transaction**，所以 transaction 事件必然只来自用户操作——
不需要任何 meta 判断来区分来源。（实测：`transaction.getMeta('uiEvent')` 真实键盘输入下也是空的。）

### 3. 落盘前用 3-gram 存活率校验，阈值 0.75

精确匹配会误伤用户的合法改写；字符集合覆盖率会漏检
（实测「第二句完整内容。」整句删掉，剩余句覆盖率仍高达 0.875）。
阈值 0.75 来自标定：丢稿类 ≤ 0.67，合法改写类 ≥ 0.88。
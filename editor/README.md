# editor/ —— 流式写入层（第 1 步 · 前半）

承载「流式输出 + 用户插队修改」的逻辑。**不依赖DOM，可在 Node 里跑测试。**

## 文件

| 文件 | 作用 |
|---|---|
| `streaming-writer.js` | 核心：`StreamingWriter` 状态机 + `verifyBeforeCommit` 落盘校验 + `sentenceSurvived` 句存活判定 |
| `ollama-stream.js` | Ollama 流式客户端：NDJSON 解析、tool call 碎片重组、首字节超时、AbortSignal 中止 |
| `test-streaming.js` | 23 个验收用例（含阈值标定） |
| `test-stream-client.js` | 流式客户端验收：协议解析 6 条 + 真实模型 3 条（`--live`） |
| `test-ime-browser.js` | IME 与流式写入冲突验证（Chromium 真实浏览器，6 条） |
| `probe-report.md` | TipTap v3 API 实测报告：设计假设的验证过程与踩坑记录 |
| `README.md` | 设计约束与待验项 |

## 运行

```powershell
# 首次需要装依赖
npm install
npx playwright install chromium      # IME 测试用

# 验收测试（不调模型、不需浏览器，秒级）
node test-streaming.js

# 流式客户端：仅协议解析
node test-stream-client.js
# 流式客户端：含真实模型（需 Ollama 在线）
node test-stream-client.js --live

# IME 冲突验证（需真实浏览器）
node test-ime-browser.js
```

## 四条不可动摇的设计约束

以下每条都有实测依据（见 `probe-report.md`），改代码前先读那份报告。

### 1. 插入点每次重算，绝不缓存绝对位置

用户中途编辑会改变 `doc.content.size`，缓存的位置会把模型文字写进段落中间。

### 2. 用户删除已生成的内容，不恢复

实测：用户删掉 `DEF` 后模型继续输出 `XYZ`，结果是 `AEFXYZ`。
**不做 diff 合并**——需要维护逐字符来源映射，复杂度高，且会产生
「用户删了但又被写回来」的诡异体验。写作工具里用户意图优先于模型输出。

### 3. 零段文档非法，删空要能兜住

ProseMirror 的 `doc` 是 `block+`，零段会让后续所有 transaction 抛
`Invalid content for node doc: <>`。`StreamingWriter` 检测到删空后停止消费流，
由 `verifyBeforeCommit` 判定「生成内容缺失」并拒绝落盘。**不强行改文档。**

### 4. 区分用户编辑不靠 meta，靠「谁调用的」（实测推翻原假设）

原方案用 `transaction.getMeta('uiEvent')` 判断用户编辑。**实测不成立**：
Playwright 真实键盘输入 2 字产生 3 个事务，`uiEvent` **全为空**。

可靠做法：

| 方式 | transaction 事件 | 用途 |
|---|---|---|
| `view.updateState(state)` | **不触发**（实测 0 次） | 程序灌回 StreamingWriter 的 state |
| `view.dispatch(tr)` | 触发 | —— |
| `commands.insertContent(text)` | 触发，且**跟随光标插入** | 流式写入禁用 |

程序写入全部走 `updateState` → transaction 事件必然只来自用户操作，
无需任何 meta 判断。

## 落盘校验（防静默丢稿）

模型输出可能被工具层丢弃、或用户删了一大段——落盘内容就会与模型承诺的不一致。
这与底稿 §3.4 丢稿实验是同一类问题，只是发生在写入侧。

**难点**：必须区分「用户合法改写」与「真的丢稿」，否则用户改个字就被拦。

实测两个失败方案后选定 **3-gram 存活率 ≥ 0.75**：

| 类别 | 存活率区间 |
|---|---|
| 丢稿（删整句/删半句/换实体） | ≤ 0.67 |
| 合法改写（加字/加标点/完全一致） | ≥ 0.88 |

阈值标定用例已固化为测试组，防止后人改阈值时无声退化。

## 与数据层的关系

```
StreamingWriter.finish()  →  纯读取当前正文（不改状态）
        ↓
verifyBeforeCommit()      →  3-gram 校验，不通过则拒绝
        ↓
Store.createChapter / updateChapterContent   （db/store.js）
```

`finish()` 刻意不改状态：**落盘校验失败时用户要能继续编辑再验一次。**

## 待验项

1. **真机拼音输入法** —— 候选窗遮挡、词频、软键盘布局。DOM 事件模拟测不出这些，
   需人工过一遍。
2. **Ollama 流式接入 Agent 循环** —— `ollama-stream.js` 已就绪（9/9 通过，
   含真实模型 tool call 碎片重组），但还没接进 `run-verify.js` 的 Agent 循环。
   当前循环仍用 `stream: false`。接进去后要验证清洗层对「流式半截 JSON」的处理。

## 已知的技术债

`test-ime-browser.js` 里的 import map 生成逻辑（`buildImportMap`）是为
「不装打包器直接吃 node_modules ESM」写的，映射了 26+ 条路径。
**生产构建时应该换成正常打包**（vite/rollup），这套只为测试服务。

# TipTap v3 流式写入 —— API 实测报告

> 探测时间：2026-10-11　环境：Node 22.22.2 / @tiptap 3.31.4
> 结论先行：**六条设计假设全部成立，性能 0.018ms/次，可以直接进入实现。**

## 一、依赖与版本

```
@tiptap/core@3.31.4
@tiptap/pm@3
@tiptap/extensions@3.31.4
```

零UI 框架依赖（React/Vue 绑定是可选的 `@tiptap/react`），核心层可直接在 Node 里跑测试。

## 二、与官方迁移文档不一致的地方（重要）

| 文档写 | 实际 | 处理 |
|---|---|---|
| `import { undoRedo } from '@tiptap/extensions'` | **不存在该导出**，实际是 `UndoRedo`（首字母大写） | 按实际写 `UndoRedo` |
| `StarterKit.configure({ history: false })` | v3 已改名为 `undoRedo` | 本项目未用 StarterKit，用自定义 schema，不受影响 |

**教训**：官方迁移指南也有笔误。涉及导入名的部分必须实测 `Object.keys()` 确认，不能照文档抄。

## 三、六条实测结论

### 1. 分段流式插入能拼成连续文本

```
写入 ['秋雨','打在','青石板上。'] → "第一段已有内容。秋雨打在青石板上。"
```
✅ 成立。ProseMirror 的 `tr.insertText(pos)` 每次追加到同一文本块，不会产生碎片。

### 2. **插入点必须每次重算，不能缓存绝对位置**

```
用户插队后: "AXYZAA\n" doc.size = 10
模型写入后: "AXYZAA\n模型输出"   ← 正确
```

若缓存 `insertPos` 常量，用户在前面插入后会把模型文字写进段落中间。
✅ 这是本模块最重要的设计约束，已落进 `StreamingWriter` 的注释。

### 3. 用户删除已生成内容后，**不会自动恢复**

```
生成中：ABCDEF → 用户删掉 DEF → 模型继续输出 XYZ
结果:  "生成中：AEFXYZ"      ← DEF 没有复活
```
✅ 符合预期。这是**刻意取舍**：做 diff 合并需要维护逐字符来源映射，
复杂度高且会产生「用户删了但又被写回来」的诡异体验。写作工具里用户意图优先。

### 4. 跨段落写入正常

```
两段文档 → 插入新段 → "第一段。\n插入第二段"
再 split + 写入 → 段落数 3，内容正确
```
✅ 成立。`tr.split(doc.content.size - 1)` 在段落边界处分割可靠。

### 5. **零段文档是非法的**

```
schema.node('doc', null, []) → Invalid content for node doc: <>
```

ProseMirror 的 `doc` 声明为 `block+`，**至少要有一个块节点**。
这影响两处写法：
- 初始状态必须是「一个空段落」而不是「零段落」；
- 用户把内容全删光后，任何后续 transaction 都会抛错。

`StreamingWriter` 的处理：`sync()` 检测到 `childCount === 0` 时置 `emptied` 标记，
`write()` 返回 false 停止消费流，真正的拦截交给 `verifyBeforeCommit`。
**不强行改文档**——那是篡改用户操作。

### 6. 性能充裕

```
450 字，每 2 字一次事务 = 225 次插入
耗时 4ms，平均 0.018ms/次
```

✅ 远低于 5ms/次的预算。按每段 700 字估算，单段生成约 350 次事务 = 6ms，可忽略。

## 四、落盘校验的阈值标定

「用户改写」与「丢稿」必须区分开，否则用户改个字就被拦，工具没法用。

### 先说两个失败方案

**方案 A：精确匹配 `finalText.includes(sentence)`**
误伤所有合法改写（用户加个字、换个标点）。

**方案 B：字符集合覆盖率**
实测漏检：
```
句子: 第二句完整内容。   剩余: 第一句完整内容。
字符集合覆盖率: 0.875  →  判定"存活"   ❌ 丢稿被放过
```
中文模板化写作里两句共享"完整内容"四字，字符集合完全不可用。

### 采用：3-gram 存活率

滑窗取 3 字片段，逐个检查是否还在最终文本里。

| 类别 | 用例 | 存活率 | 判定 |
|---|---|---|---|
| 丢稿 | 删整句（模板化） | 0.67 | 丢稿 ✅ |
| 丢稿 | 删半句 | 0.21 | 丢稿 ✅ |
| 丢稿 | 换成别的实体 | 0.33 | 丢稿 ✅ |
| 合法 | 完全一致 | 1.00 | 存活 ✅ |
| 合法 | 加一个字 | 0.88 | 存活 ✅ |
| 合法 | 加两个字 | 0.88 | 存活 ✅ |
| 合法 | 加/改标点 | 0.88 | 存活 ✅ |

**两类分离度**：丢稿侧 ≤0.67，合法侧 ≥0.88，中间有0.21 的空隙。
阈值取 **0.75**（0.7 / 0.75 / 0.8 三档均 0 误判，取中位留余量）。

标定用例已固化为 `test-streaming.js` 的「四之二、阈值标定」组，防止后人改阈值时无声退化。

## 五、语义约定

| 方法 | 是否改状态 | 说明 |
|---|---|---|
| `beginGeneration()` | 是 | 建生成段，进入 STREAMING |
| `write(chunk)` | 是 | 写入一个流式分片 |
| `sync(state, meta)` | 是 | 接收外部编辑（UI 层 onTransaction 调用） |
| `cancel()` | 是 | 中止，拒绝后续分片 |
| `end()` | 是 | 结束会话，进入 DONE |
| **`finish()`** | **否** | **纯读取当前正文** |

`finish()` 刻意不改状态——落盘校验失败时用户要能继续编辑再验一次。
这个设计最初写成「finish 即结束」，测试直接报出语义冲突，已修正。

## 六、接入 UI 的方式

### 6.1 先核实两件事（2026-10-11 实测）

原方案里的接入示例假设用 `transaction.getMeta('uiEvent')` 区分用户操作与程序写入。实测发现**这个假设不成立**，连带发现两个会崩的坑。

#### 发现 1：`transaction.getMeta()` 不带参数会抛异常

```
tr.getMeta()          → TypeError: Cannot read properties of undefined (reading 'key')
tr.getMeta('uiEvent') → undefined
```

**程序写入的事务 meta 完全是空的**：
```
editor.commands.insertContent('x')
→ transaction: { docChanged: true, steps: 1 }    // meta 只有这两个字段
```

所以 `getMeta('uiEvent')` 永远返回 `undefined`——**靠它区分不了用户操作**。

#### 发现 2：`view.updateState` 不产生事务（关键）

| 方式 | 触发 transaction 事件 | 适用场景 |
|---|---|---|
| `editor.view.updateState(state)` | **0 次** | 把外部 state 灌回编辑器 |
| `editor.view.dispatch(tr)` | 1 次 | 正常的事务提交 |

**这是本项目的关键结论**：`StreamingWriter` 维护自己的 state 后，
灌回编辑器用 `updateState` ——**不产生 transaction 事件，
所以 writer 自己触发的 `sync()` 不会被计入 `userEditsDuringStream`**。

用 `commands.insertContent()` 替代会产生额外事务，
且它**跟随光标插入而非追加末尾**（实测插到了第二段中间）——流式写入绝对不能用它。

#### 发现 3：meta 必须在事件内当场读

```js
let captured = null
editor.on('transaction', ({ transaction }) => { captured = transaction.getMeta('uiEvent') })
tr.setMeta('uiEvent', {...})
editor.view.dispatch(tr)
// → captured 拿到了值
```

事后从 `editor.state` 取不到。`transaction` 是历史对象，不是编辑器当前状态。

#### 发现 4：`StarterKit` v3 默认含 link / listKeymap / underline

```
已注册: link, paragraph, ..., listKeymap, ..., underline, undoRedo, ...
含 link: true | 含 listKeymap: true | 含 underline: true
```

另注意：**`undoRedo` 是注册名**（不是 `history`），
与 `@tiptap/extensions` 导出的 `UndoRedo` 组件名对应。

### 6.2 用户编辑的识别方式（原方案已推翻）

**实测结论：不能用 meta 区分用户操作。**

用 Playwright 真实键盘（`page.keyboard.type('秋雨')`）输入，
在 transaction 事件里读 `transaction.getMeta('uiEvent')`：

```
输入 2 个字 → 产生 3 个事务 → 带 uiEvent 的：0 个
type=无  inputType=无
```

**ProseMirror 的输入管线不给事务打 `uiEvent` 标记。** 原方案里
`transaction.getMeta('uiEvent')` 判定用户编辑永远返回 `undefined`。

另一个坑：**派发 `InputEvent` 模拟输入也不产生 meta**。
我最初就是这么测的，得出「没有 uiEvent」的结论后以为是 TipTap 的行为；
换成真实键盘重测，结论一致 —— 说明这条路确实不通，两种方式都验证过了。

#### 可靠方案：靠「谁调用的」而非「meta说了什么」

既然 meta 不可靠，就不靠它。**用 `view.updateState` 与 `view.dispatch` 的区别**：

| 方式 | transaction 事件 | 谁调用 |
|---|---|---|
| `view.updateState(state)` | **不触发** | 程序（我们灌回 StreamingWriter 的 state） |
| `view.dispatch(tr)` | 触发 | 用户操作（ProseMirror 内部派发） |

实测：程序用 `updateState` 灌入 → transaction 事件 **0 次**。
所以**只要我们的写入路径全部走 `updateState`，收到的 transaction 就必然来自用户**。

```js
// 正确：不需要任何 meta 判断
editor.on('transaction', ({ transaction }) => {
  if (!transaction.docChanged) return
  // 能走到这里 = 一定是用户操作（程序写入走 updateState，不产生事件）
  writer.sync(editor.state, { userEdit: true })
})

// 写入用这个，它不产生事件
editor.view.updateState(writer.state)

// 千万不要用这个：它跟随光标插入而非追加末尾，且产生事务
editor.commands.insertContent(text)
```

`insertContent` 跟随光标的实测：

```
两段文档，光标在开头 → insertContent('插到光标处')
结果: "第一段\n第二段插到光标处"← 插到了第二段中间
```

### 6.3 IME 冲突：实测无致命问题

Chromium 156 + TipTap 3.31.4，真实浏览器验证：

| 场景 | 结果 |
|---|---|
| IME 组合输入进行中插入模型文本 | ✅ 模型文本保留，未被打断 |
| 模型追加一段 → 用户真实按键 → 模型再追加 | ✅ `"模型第一段。【用户插队】模型第二段。"` 顺序正确 |

**结论：流式写入不破坏 IME 组合，用户可以在模型生成时正常打字插队。**

技术要点：组合输入期间编辑器里并没有"未提交的候选词文本"——
候选词在输入法（浏览器外）里，选中后才以 `insertText` 进入文档。
所以模型写入碰不到候选词。

**边界**：以上用 `CompositionEvent` 模拟组合流程，**未覆盖真实拼音候选窗**的
行为差异（候选窗遮挡、词频学习、软键盘布局）。真机还需人工过一遍。

```jsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { StreamingWriter, verifyBeforeCommit } from './streaming-writer.js'
import { chatStream } from './ollama-stream.js'

function ChapterEditor({ onSave }) {
  const editor = useEditor({ extensions: [StarterKit], content: '<p></p>' })
  const writerRef = useRef(null)

  useEffect(() => {
    if (!editor) return
    const w = new StreamingWriter(editor.state)
    writerRef.current = w
    const onTx = () => {
      // 不需要判断 meta：程序写入走 updateState 不产生事务，
      // 能走到这里的一定是用户操作（实测结论，见 6.2）
      w.sync(editor.state, { userEdit: true })
    }
    editor.on('transaction', onTx)
    return () => editor.off('transaction', onTx)
  }, [editor])

  async function generate(prompt, model) {
    const w = writerRef.current
    w.beginGeneration()
    editor.view.updateState(w.state)

    for await (const chunk of streamText(model, prompt)) {
      if (!w.write(chunk)) break              // 用户中止或文档被清空
      editor.view.updateState(w.state)        // 灌回，不产生事务
    }

    const v = verifyBeforeCommit(w)
    if (!v.ok) {
      // 不落盘，让用户决定：接受当前内容 or 重新生成
      return { ok: false, ...v }
    }
    w.end()
    editor.view.updateState(w.state)
    await onSave(w.finish())
    return { ok: true }
  }

  return (
    <>
      <EditorContent editor={editor} />
      <button onClick={() => generate('写下一段', 'qwen3:latest')}>续写</button>
    </>
  )
}
```

### 6.4 仍然待验（需真实输入法）

1. **真机拼音输入法** —— 候选窗遮挡、词频、软键盘布局差异。DOM 事件模拟测不出这些。
2. **与 Ollama 真流式的完整对接** —— `ollama-stream.js` 已就绪并通过 9/9 测试
   （含真实模型 tool call 碎片重组），但**还没接进 `run-verify.js` 的 Agent 循环**。
   当前 Agent 循环仍用 `stream: false` 一次性拿全文。
   流式下 `write_segment` 的正文会逐字到达，需要确认清洗层对「半截 JSON」的处理。

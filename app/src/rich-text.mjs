/**
 * 消息正文的标记解析（纯函数，不依赖 React / DOM）。
 *
 * ## 为什么单独成文件
 *
 * 解析逻辑写在 `RichText.jsx` 里就只能靠"渲染完再看 DOM"来验证 ——
 * 那需要一整套 Electron 夹具（窗口、IPC 桩、消息数据），
 * 而真正要守的规则只有三条正则。
 * 抽出来之后 node 直接跑，判据快、也不受界面改动影响。
 *
 * ## 只认三种标记
 *
 * | 写法 | 结果 |
 * |---|---|
 * | 整行 `**……**`（末尾可带冒号） | `key` —— 重点句，渲染时放大 |
 * | 行内 `**……**` | `bold` |
 * | 行内 `` `……` `` | `code` |
 *
 * 不做完整 markdown：正文来自模型，走 innerHTML 有注入面；
 * 而这里需要的只是"把星号藏起来、让重点跳出来"。
 */

/**
 * 整行加粗 → 重点句。
 * ⚠ 必须整行只有这一处加粗：中间还夹着别的字（`**结构**：9 节…`）
 *   属于"行内加粗"，放大就乱了行的节奏。
 * ⚠ 允许结尾带一个中/英冒号 —— 「**要你拍板的三点**：」是最常见的写法。
 */
export const KEY_LINE = /^\*\*([^*]+)\*\*(\s*[：:])?\s*$/;

/** 行内标记（带捕获组，split 后分隔符会留在数组里） */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/**
 * 解析一行。
 *
 * @param {string} line
 * @returns {{ type: 'key', text: string }
 *          | { type: 'text', parts: Array<{kind:'text'|'bold'|'code', text:string}> }}
 */
export function parseLine(line) {
  const s = String(line == null ? '' : line);

  const key = KEY_LINE.exec(s.trim());
  if (key) {
    // 保留冒号（它是句子的一部分，不该被吃掉）
    return { type: 'key', text: key[1] + (key[2] || '') };
  }

  const parts = s.split(INLINE);
  if (parts.length === 1) {
    return { type: 'text', parts: [{ kind: 'text', text: s }] };
  }

  return {
    type: 'text',
    /**
     * ⚠ 过滤空串：`split` 遇到"行首就是标记"或"两个标记相邻"时会产生空元素，
     *   留着会渲染成一堆空 <span>。
     */
    parts: parts.filter((p) => p !== '').map((p) => {
      if (/^\*\*[^*]+\*\*$/.test(p)) return { kind: 'bold', text: p.slice(2, -2) };
      if (/^`[^`]+`$/.test(p)) return { kind: 'code', text: p.slice(1, -1) };
      return { kind: 'text', text: p };
    }),
  };
}

/**
 * 解析整段（按行）。
 * 空行保留为 `{ type: 'blank' }` —— 渲染层要拿它换行，
 * 丢掉的话模型输出里的分段就全糊在一起了。
 */
export function parseText(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map((line) => (line === '' ? { type: 'blank' } : parseLine(line)));
}

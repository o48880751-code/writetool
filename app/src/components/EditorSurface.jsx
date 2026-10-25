import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { makeStreamApi } from '@editor/editor-stream-api.js';

/**
 * 编辑器表面（React 包装层）。
 *
 * ## 只做三件事
 *
 *   1. 创建 TipTap 实例
 *   2. 把 editor 包装成 getState/setState/setHTML 适配器
 *   3. 通过 onReady 把流式 API 交给 App
 *
 * ## 写入逻辑为什么不放在这里
 *
 * 之前三段写入逻辑（setText / beginStream / write）直接写在这个组件里，
 * 测试只能**复刻**一份到 editor/test-editor-surface.js。
 * 结果复刻版和真实现漂移了——真实现修好了一个 bug，
 * 测试里的旧复刻版没改，测试报的是**已经不存在的病**。
 *
 * 现在逻辑抽到 `editor/editor-stream-api.js`（纯函数，不碰 DOM），
 * 组件与测试 require 同一个文件。**漂移在结构上不可能发生。**
 *
 * 三个历史 bug（详见 editor-stream-api.js 内的注释）：
 *   A. setText 把整章压成单段 → 段落结构永久丢失
 *   B. beginStream 无守卫 → 每次生成多出两个空段落
 *   C. write 不处理换行 → 模型段落结构丢失
 *
 * ## 四条核心约束（实测结论，见 editor/probe-report.md）
 *
 * 1. **插入点每次重算**，绝不缓存绝对位置
 * 2. **用户删除已生成的内容不恢复**——写作工具里用户意图优先
 * 3. **程序写入走 view.updateState**，不触发 transaction 事件
 * 4. **文档被删空时中止写入**，不强行改文档
 */
export default function EditorSurface({
  content,
  onChange,
  onReady,
  fontSize,
  fontFamily,
  generating,
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    editorProps: {
      attributes: { class: 'editor-surface', spellcheck: 'false' },
    },
    // 只在用户编辑时触发；程序写入走 view.updateState，不进这里
    onUpdate: ({ editor: e }) => onChangeRef.current(e.getText()),
  });

  useEffect(() => {
    if (!editor || !onReady) return;

    /**
     * 把 TipTap 实例适配成 editor-stream-api.js 需要的形状。
     *
     * 注意 getState 必须返回**当前** state 而不是闭包里的快照——
     * 用户在生成过程中编辑文档，闭包快照会一直是旧状态。
     */
    const adapter = {
      getState: () => editor.view.state,
      setState: (s) => editor.view.updateState(s),
      setHTML: (html) => editor.commands.setContent(html),
    };
    const api = makeStreamApi(adapter);
    onReady(api);

    // 初次内容在 onReady 之后灌，避免 TipTap 未就绪
    if (content) api.setText(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onReady]);

  return (
    <div
      /**
       * ⚠⚠ `editor-surface` 这个 class **不能少**（2026-10-15 找到的）。
       *
       * index.css 里编辑器**全部**排版样式都挂在它上面：
       *   .editor-surface p / h1 / h2 / h3 / ul / ol / blockquote / code …
       * 这个 div 原来只有 `h-full overflow-y-auto`，
       * 于是那些规则**一条都没匹配上** —— 段落没有间距、标题是浏览器默认大小、
       * 引用和代码块没有样式。
       *
       * ⚠ 而且它让「修改编辑器字号」看起来像失效：
       * 字号（inline）确实变了，但周围**排版全是默认的**，
       * 视觉上几乎看不出差别，只会觉得"滑块没反应"。
       */
      className="editor-surface h-full overflow-y-auto"
      style={{ fontSize: `${fontSize || 16}px`, fontFamily: fontFamily || 'system-ui' }}
    >
      <EditorContent editor={editor} />
      {generating && (
        <div className="sticky bottom-0 h-0.5 bg-[var(--accent)] animate-pulse" />
      )}
    </div>
  );
}
/**
 * 流式写入的编辑器逻辑（不依赖 DOM / React）。
 *
 * ## 为什么要从 EditorSurface.jsx 里抽出来
 *
 * 之前这段逻辑写在 React 组件里，测试只能**复刻**一份。
 * 结果复刻版和真实现漂移了——真实现修好了「段落分隔造出多余空段」的 bug，
 * 测试里的复刻版没改，于是测试报的是**旧代码的病**。
 *
 * 这与「把结论抄进注释 ≠ 落实了结论」是同一类错误：
 * **看起来测了，实际测的不是那件事。**
 *
 * 抽出来后测试直接 require 本文件，改这里两边同时变，
 * 漂移在结构上就不可能发生。
 *
 * 组件侧（EditorSurface.jsx）通过闭包把 view/state 操作注入进来，
 * 所以本文件仍不碰 DOM，浏览器与 Node 都能跑。
 */

/** 段落分隔哨兵：不可能出现在正文里的字符序列 */
const PARA_SEP = '\u0000PARA\u0000';

/** 纯文本 → 多段落 HTML。按空行切段，段内单换行转 <br> */
function textToHtml(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '<p></p>';
  const paras = raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/**
 * 把一个流式分片切成「行序列」，其中段落分隔用哨兵表示。
 *
 * ⚠ 关键：`"甲\n\n乙".split('\n')` 返回 **3 个** 元素（["甲","","乙"]）。
 * 若按元素数逐个 split，一个段落间隔会产生 **2 个空段落**
 * （实测写三个分段，文档里出现五段）。
 * 段落分隔在语义上是「连续的若干换行」，必须先折叠成单个分隔符再切。
 */
function chunkToLines(text) {
  return String(text).replace(/\n{2,}/g, PARA_SEP).split('\n');
}

/**
 * 在编辑器实例上挂流式写入能力。
 * @param {object} ed 需提供 getState() / setState()
 * @returns {{getText:Function, setText:Function, beginStream:Function}}
 */
function makeStreamApi(ed) {
  const getState = () => ed.getState();
  const setState = (s) => ed.setState(s);

  /** 追加一个新段落。文档被删空时返回 false 表示无法继续。 */
  function splitPara() {
    const st = getState();
    if (st.doc.childCount === 0) return false;
    setState(st.apply(st.tr.split(st.doc.content.size - 1)));
    return true;
  }

  /** 往最后一段追加文本。文档被删空时返回 false。 */
  function insertParaText(text) {
    const st = getState();
    if (st.doc.childCount === 0) return false;
    setState(st.apply(st.tr.insertText(text, st.doc.content.size - 1)));
    return true;
  }

  return {
    getText: () => {
      const st = getState();
      return st.doc.textBetween(0, st.doc.content.size, '\n\n').replace(/\n+$/, '');
    },

    /**
     * 写入整章正文。
     *
     * ⚠ 修复 A：原来把全文塞进一个 `<p>`，实测三段正文打开后变一段，
     * 段落结构在「打开 → 保存」这一轮里被永久抹掉。
     */
    setText(text) {
      ed.setHTML(textToHtml(text));
    },

    /**
     * 开始一次生成：追加新段落作为写入目标。
     *
     * ⚠ 修复 B：原来无条件 split。EditorState 的初始态就是「一个空段落」，
     * 此时再 split 就造出一个空段；紧接着 write() 里还有一次 split，
     * 于是**每次生成多出两个空段落**（实测两次生成累积到六段）。
     */
    beginStream() {
      const st = getState();
      const onlyOneEmptyPara =
        st.doc.childCount === 1 && st.doc.child(0).content.size === 0;
      if (!onlyOneEmptyPara) {
        const pos = st.doc.content.size - 1;
        setState(st.apply(st.tr.split(pos)));
      }

      let chars = 0;
      return {
        /**
         * 写入一个流式分片，返回是否成功。
         *
         * ⚠ 修复 C：原来整块 insertText，分片里的换行变成正文字面量，
         * 模型输出的段落结构完全反映不到编辑器上。
         *
         * @returns {boolean} false 表示文档已被删空，调用方应停止消费流
         */
        write(chunk) {
          const text = String(chunk || '');
          if (!text) return false;
          // 文档被用户删空：无法再写入。中止并返回 false，
          // 让调用方停止消费流，真正的判定交给落盘校验。
          if (getState().doc.childCount === 0) return false;

          const lines = chunkToLines(text);
          for (let i = 0; i < lines.length; i++) {
            if (i > 0 && !splitPara()) return false;

            const line = lines[i];
            if (!line) continue;

            if (!line.includes(PARA_SEP)) {
              if (!insertParaText(line)) return false;
              continue;
            }
            // 一个分片里含多个段落间隔：逐段处理，段间隔处开新段
            const parts = line.split(PARA_SEP);
            for (let k = 0; k < parts.length; k++) {
              if (k > 0 && !splitPara()) return false;
              if (parts[k] && !insertParaText(parts[k])) return false;
            }
          }
          chars += text.length;
          return true;
        },
        /** 本次生成已写入的字数 */
        chars: () => chars,
        /** 读取当前全文（纯读，不改状态） */
        finish: () => {
          const st = getState();
          return st.doc.textBetween(0, st.doc.content.size, '\n\n').replace(/\n+$/, '');
        },
      };
    },
  };
}

module.exports = { makeStreamApi, textToHtml, chunkToLines, PARA_SEP };
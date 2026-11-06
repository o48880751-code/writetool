import { Fragment } from 'react';
import { parseLine } from '../rich-text.mjs';

/**
 * 消息正文的轻量渲染（2026-11-03）。
 *
 * ## 为什么会有它
 *
 * 之前正文是 `{m.content}` 直接渲染 —— 纯文本，于是模型输出里的
 * `**加粗**` 原样带着星号，`` `设定/世界观.md` `` 带着反引号。
 *
 * 羽毛菌的原话是：「模式吐字生成的重点，字需要专门放大」。
 * 注意他要的**不是"把星号藏起来"**，是"重点那句要跳出来"——
 * 所以整行加粗会被当成小标题放大（样式见 index.css 的 `.msg-key`）。
 *
 * ## 为什么不上 markdown 库
 *
 * 1. 正文来自模型，走 `dangerouslySetInnerHTML` 会开一个注入面；
 * 2. 完整 markdown 会接管 `<div>`、表格、标题，跟气泡上
 *    `white-space: pre-wrap` 的既有排版打架。
 *
 * 解析规则全部在 `rich-text.mjs`（纯函数，node 直接测），这里只负责画。
 */

export default function RichText({ text }) {
  const lines = String(text == null ? '' : text).split('\n');

  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {/**
            * ⚠ 先出 <br> 再出内容：这样空行（line === ''）就是一个纯 <br>，
            *   高度等于一行；和原来 pre-wrap 的观感一致。
            *   （不能靠 `line ? … : null` 保留空行 —— 空字符串什么都不会渲染，
            *     分段之间的空行会全部塌掉。）
            */}
          {i > 0 && <br />}
          {renderLine(line)}
        </Fragment>
      ))}
    </>
  );
}

function renderLine(line) {
  const parsed = parseLine(line);
  if (parsed.type === 'key') {
    return <span className="msg-key">{parsed.text}</span>;
  }
  return parsed.parts.map((p, j) => {
    if (p.kind === 'bold') return <strong key={j}>{p.text}</strong>;
    if (p.kind === 'code') return <code key={j} className="msg-code">{p.text}</code>;
    return <Fragment key={j}>{p.text}</Fragment>;
  });
}

import { Fragment } from 'react';
import {
  parseLine, isTableRow, isTableSeparator, splitTableCells, parseCell,
} from '../rich-text.mjs';

/**
 * 消息正文的轻量渲染（2026-11-03，2026-11-07 加表格）。
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
 * 2. 完整 markdown 会接管 `<div>`、标题，跟气泡上
 *    `white-space: pre-wrap` 的既有排版打架。
 *
 * ## 表格（2026-11-07）
 *
 * 羽毛菌截图：模型写了个两列对照表，界面上原样打出 `| 名字暗示 | 现在的设定 |`
 * 和 `|---|---|` —— 看着像乱码。聊天气泡走的是这个组件，
 * 而它当时只认行内格式，不认块级结构。
 *
 * ⚠ 表格必须是**块级**处理：一行一行渲染的话，`<table>` 会被拆进 `<br>` 之间，
 *   浏览器会把它们重新排成一堆空表格。
 * ⚠ 识别靠"首行表格 + 第二行分隔行"这个组合，缺一不可。
 *   只判"含竖线"会把正文里 `A | B` 误判成表格。
 */

export default function RichText({ text }) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = groupBlocks(lines);

  return (
    <>
      {blocks.map((b, i) => (
        <Fragment key={i}>
          {/**
            * ⚠ 先出 <br> 再出内容：这样空行（line === ''）就是一个纯 <br>，
            *   高度等于一行；和原来 pre-wrap 的观感一致。
            */}
          {i > 0 && <br />}
          {b.type === 'table'
            ? <MsgTable header={b.header} rows={b.rows} />
            : renderLine(b.line)}
        </Fragment>
      ))}
    </>
  );
}

/** 把行分成「普通行」和「表格块」两类 */
function groupBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    const isTableStart = isTableRow(lines[i])
      && i + 1 < lines.length
      && isTableSeparator(lines[i + 1]);
    if (!isTableStart) {
      out.push({ type: 'line', line: lines[i] });
      i += 1;
      continue;
    }
    const header = splitTableCells(lines[i]);
    const rows = [];
    let j = i + 2;
    // 表格一直吃到第一行不是表格为止（模型常在表后空一行再接着说话）
    while (j < lines.length && isTableRow(lines[j])) {
      rows.push(splitTableCells(lines[j]));
      j += 1;
    }
    out.push({ type: 'table', header, rows });
    i = j;
  }
  return out;
}

function MsgTable({ header, rows }) {
  // 列数以最宽的那一行为准：模型偶尔会漏一格，少的那行补空单元格，
  // 不然表格会缺角
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const pad = (arr) => Array.from({ length: cols }, (_, c) => arr[c] || '');
  return (
    <div className="msg-table-wrap">
      <table className="msg-table">
        <thead>
          <tr>{pad(header).map((t, c) => <th key={c}>{cell(t)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>{pad(r).map((t, c) => <td key={c}>{cell(t)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 一格里的行内格式 */
function cell(text) {
  if (!text) return null;
  return parseCell(text).map((p, i) => {
    if (p.kind === 'bold') return <strong key={i}>{p.text}</strong>;
    if (p.kind === 'code') return <code key={i} className="msg-code">{p.text}</code>;
    return <Fragment key={i}>{p.text}</Fragment>;
  });
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

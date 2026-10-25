/**
 * 造一条指定长度的提示词，供 e2e-real-chat.js 用。
 *
 * ## 为什么需要它
 *
 * 2026-10-15 羽毛菌的日志：
 *   [chat] 发出 … 消息=7 正文=78463字节
 *   [chat] socket 超时（已 5081ms 没收到任何字节）
 *
 * 要判断"大请求体到底会让首字节慢多少"，就得能**复现那个量级**。
 * 而合成请求的实验不可靠（我自己那次因为解密姿势不对全部 401，
 * 差点误判成 key 失效）—— 所以走**完全真实的代码路径**：
 * 真 main.js、真 provider、真请求体构造、真模型。
 *
 * 用法：
 *   node make-big-prompt.js 20000 out.txt
 *   E2E_PROMPT="$(cat out.txt)" .\electron-run.cmd e2e-real-chat.js
 */

const fs = require('node:fs');

const want = Number(process.argv[2] || 20000);
const out = process.argv[3] || 'big-prompt.txt';

// ⚠ 内容必须是**正常中文散文**。用重复的同一个字会让服务端分词器
//   异常快（退化成单字符 token），测出来的首字节会偏乐观。
const CORPUS = [
  '大雍王朝立国四十余年，皇权渐衰，门阀世族把持朝政，地方节度使拥兵自重。',
  '江湖并非朝堂的对立面，而是同一套秩序在明处与暗处的两副面孔。',
  '天工院掌���冶铁、水利与火药之术，武库收纳历代兵器与图谱，两者皆为各方争夺。',
  '男主李长乐，字无忧，生于江南沈家，自幼由养父抚养，不知身世。',
  '春闱舞弊案牵出江南数十名官员，也牵出二十年前的一桩旧案。',
];

let body = '请用两句话回答：什么是江湖。\n\n【以下是与本题无关的背景资料，读完即可丢弃】\n';
let i = 0;
while (body.length < want) {
  body += CORPUS[i % CORPUS.length] + '\n';
  i++;
}

fs.writeFileSync(out, body, 'utf8');
console.log(`已写 ${out}：${body.length} 字（约 ${Buffer.byteLength(body, 'utf8')} 字节，${i} 段）`);
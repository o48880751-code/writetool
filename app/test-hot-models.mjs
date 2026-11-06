/**
 * 判据：模型列表的挑选逻辑（纯函数，node 直接跑）。
 *
 * 运行：node test-hot-models.mjs
 *
 * ## 在防什么
 *
 * 羽毛菌：「183 个模型太多了……要展示的话，展示主流的二十个就够了」。
 *
 * 三条底线：
 *   1. **不能把语音/向量/OCR 这些列出来** —— 点了就报错，白试一次。
 *   2. **主流要排前面** —— 如果挑出来的 20 个全是冷门实验模型，
 *      等于没解决"看不懂"的问题。
 *   3. **不能漏** —— 排序只是建议，被排在后面的模型依然可以手填；
 *      但挑选函数本身不能把名字改掉或去重掉。
 */
import { pickHotModels } from './src/lib/hot-models.mjs';

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fails.push(name); console.log('  ✗', name, '\n     ', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

console.log('模型列表挑选');

/** 造一批"像百炼那样"的返回：大量非对话模型 + 少量主流 */
const MIXED = [
  'qwen-audio-3.1-realtime-flash',
  'text-embedding-v4',
  'gte-rerank-v2',
  'qwen-ocr',
  'wanx2.1-t2i',
  'paraformer-v2',
  'cosyvoice-v2',
  'qwen3-max-2026',
  'qwen3.8-omni-flash',
  'deepseek-r1',
  'glm-5.3',
  'antdigital/Ling-3.1-flash',
];

console.log('\n=== 一、剔除非对话模型 ===');
t('语音 / 向量 / 重排 / OCR / 生图 都不出现', () => {
  const { hot } = pickHotModels(MIXED, 20);
  const bad = hot.filter((m) => /(audio|realtime|embed|rerank|ocr|t2i|paraformer|cosyvoice)/i.test(m));
  assert(bad.length === 0, `混进了非对话模型：${bad.join(', ')}`);
});
t('总数按"能聊天的"算，不是原始条数', () => {
  const r = pickHotModels(MIXED, 20);
  assert(r.total === 5, `total 应为 5（12 条里 7 条不能聊天），实际 ${r.total}`);
});
t('hidden 反映"没展示几个"', () => {
  const r = pickHotModels(MIXED, 3);
  assert(r.hot.length === 3, `hot ${r.hot.length}`);
  assert(r.hidden === 2, `hidden 应为 2，实际 ${r.hidden}`);
});

console.log('\n=== 二、主流排前面 ===');
t('★ 前几个里有 qwen / deepseek（不是冷门模型霸榜）', () => {
  const { hot } = pickHotModels(MIXED, 3);
  const s = hot.join(' ');
  assert(/qwen3-max|omni|deepseek/i.test(s), `前 3 个是：${s}`);
});
t('全量排序时，主流排在"名字不认识"的前面', () => {
  const r = pickHotModels(MIXED, 5);
  const idxQwen = r.hot.findIndex((m) => /qwen3-max/.test(m));
  const idxAnt = r.hot.findIndex((m) => /antdigital/.test(m));
  assert(idxQwen >= 0, 'qwen3-max 没进前 5');
  if (idxAnt >= 0) assert(idxQwen < idxAnt, 'qwen3-max 排在了 antdigital 后面');
});

console.log('\n=== 三、边界与稳定性 ===');
t('limit 比总数大时不报错，也不会重复', () => {
  const { hot } = pickHotModels(MIXED, 99);
  assert(hot.length === 5, hot.length);
  assert(new Set(hot).size === hot.length, '有重复');
});
t('空数组 / null / 非字符串都安全', () => {
  assert(pickHotModels([], 20).hot.length === 0);
  assert(pickHotModels(null, 20).hot.length === 0);
  assert(pickHotModels(['a', null, 3, 'b'], 20).hot.every((x) => typeof x === 'string'));
});
t('★ 同分保持服务端原顺序（否则每次刷新列表都在跳）', () => {
  const same = ['model-c', 'model-b', 'model-a'];
  const a = pickHotModels(same, 3).hot;
  const b = pickHotModels(same, 3).hot;
  assert(a.join() === same.join(), `顺序被改：${a.join()}`);
  assert(a.join() === b.join(), '两次结果不一致');
});
t('挑出来的名字原样返回（不改大小写、不截断）', () => {
  const { hot } = pickHotModels(['Qwen3-Max-2026'], 20);
  assert(hot[0] === 'Qwen3-Max-2026', hot[0]);
});
t('只展示 20 个时，第 21 个仍然"可用"（只是没展示）', () => {
  const many = Array.from({ length: 30 }, (_, i) => `qwen3-test-${i}`);
  const r = pickHotModels(many, 20);
  assert(r.hot.length === 20);
  assert(r.total === 30);
  assert(r.hidden === 10);
});

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗', f));
  process.exitCode = 1;
}

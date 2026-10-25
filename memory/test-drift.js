/**
 * 漂移规则验收测试。
 *
 * 背景：上一版把「location 变化」一律当冲突，实测这会让状态表在长篇里
 * 第 2 章就卡死——角色移动位置是正常剧情，不是 bug。
 * 这组用例把「正常演化」与「真漂移」逐条钉死，防止改回去。
 *
 * 判定基准来自 drift-rules.js 的分类，不是拍脑袋。
 */

const assert = require('assert');
const { detectDrift, ORDINALS, parseRealm } = require('./drift-rules.js');
const { resolveWorldPath } = require('../run-verify.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('一、正常演化：绝不误报（误报会让长篇状态表卡死）');

check('角色换地点且有移动动词 → 不报', () => {
  const d = detectDrift(
    { location: '洛阳', alive: true },
    { location: '剑冢', alive: true },
    { text: '谢九离开洛阳，一路向北赶往剑冢。' }
  );
  assert.strictEqual(d.conflict, false, `移动剧情被误报：${JSON.stringify(d)}`);
});

check('无移动动词的单次位移 → 不报（可能只是漏更新，不该阻断）', () => {
  const d = detectDrift(
    { location: '洛阳', alive: true },
    { location: '剑冢', alive: true },
    { text: '剑冢封门三十一年。谢九站在冢前。' }
  );
  assert.strictEqual(d.conflict, false, `单次位移被误报：${JSON.stringify(d)}`);
});

check('角色死亡（alive true→false）→ 不报，那是剧情', () => {
  const d = detectDrift({ alive: true }, { alive: false }, { text: '谢九死了。' });
  assert.strictEqual(d.conflict, false, `死亡被误报：${JSON.stringify(d)}`);
});

check('境界提升 → 不报', () => {
  const d = detectDrift({ 境界: '筑基', alive: true }, { 境界: '金丹', alive: true });
  assert.strictEqual(d.conflict, false);
});

check('出现次数等统计字段变化 → 永不参与判定', () => {
  const d = detectDrift({ 出现次数: 3 }, { 出现次数: 12 });
  assert.strictEqual(d.conflict, false);
});

check('提及方式从字面变简称 → 不报', () => {
  const d = detectDrift({ 提及方式: '字面' }, { 提及方式: '简称(谢九)' });
  assert.strictEqual(d.conflict, false);
});

console.log('\n二、真漂移：必须报出来（漏报会让真相源被污染）');

check('已死角色复活 → 报 resurrection', () => {
  const d = detectDrift(
    { alive: false, location: '乱葬岗' },
    { alive: true, location: '乱葬岗' },
    { text: '谢九睁开了眼。' }
  );
  assert.strictEqual(d.conflict, true, '复活未被检出');
  assert.strictEqual(d.kind, 'resurrection');
  assert.ok(d.hint.includes('显式证据'), '提示应说明复活需要证据');
});

check('境界倒退（金丹→筑基）→ 报 ordinal-regression', () => {
  const d = detectDrift({ 境界: '金丹' }, { 境界: '筑基' });
  assert.strictEqual(d.conflict, true, '境界倒退未被检出');
  assert.strictEqual(d.kind, 'ordinal-regression');
  assert.ok(d.hint.includes('不可逆'), '提示应说明境界不可逆');
});

check('数值字段回落（年龄 30→28）→ 报 numeric-regression', () => {
  const d = detectDrift({ 年龄: 30 }, { 年龄: 28 });
  assert.strictEqual(d.conflict, true, '数值回落未被检出');
  assert.strictEqual(d.kind, 'numeric-regression');
});

check('位置往返不报冲突（长篇常态：进城出城再进城）', () => {
  // 这一条锁死早期错误：曾用「位置来回跳」做漂移判据，
  // 结果往返剧情被大量误报。往返在长篇里是常态，不是 bug。
  const d = detectDrift(
    { location: '剑冢', locationHistory: ['洛阳', '剑冢'] },
    { location: '洛阳' },
    { text: '洛阳。谢九在原地。' }
  );
  assert.strictEqual(d.conflict, false, `往返被误报：${JSON.stringify(d)}`);
});

check('单次无证据位移不报（可能只是漏更新，不该阻断）', () => {
  const d = detectDrift(
    { location: '洛阳', unverifiedMoves: 0 },
    { location: '剑冢' },
    { text: '剑冢封门三十一年。谢九站在冢前。' }
  );
  assert.strictEqual(d.conflict, false, `单次位移被误报：${JSON.stringify(d)}`);
});

check('连续两章都无移动证据 → 报 unverified-move-chain', () => {
  const d = detectDrift(
    { location: '洛阳', unverifiedMoves: 1 },
    { location: '剑冢' },
    { text: '剑冢。谢九在此。' }
  );
  assert.strictEqual(d.conflict, true, '连续无证据跳变未被检出');
  assert.strictEqual(d.kind, 'unverified-move-chain');
  assert.ok(d.hint.includes('状态回写'), '提示应指向状态回写问题');
});

console.log('\n三、边界情况');

check('无历史状态 → 不报', () => {
  assert.strictEqual(detectDrift(null, { location: '洛阳', alive: true }).conflict, false);
  assert.strictEqual(detectDrift({}, { location: '洛阳' }).conflict, false);
});

check('相同值 → 不报', () => {
  assert.strictEqual(detectDrift({ location: '洛阳' }, { location: '洛阳' }).conflict, false);
});

check('新字段（旧状态没有）→ 不报', () => {
  assert.strictEqual(detectDrift({ alive: true }, { alive: true, 境界: '金丹' }).conflict, false);
});

check('null 值 → 跳过不判定', () => {
  assert.strictEqual(detectDrift({ location: '洛阳' }, { location: null }).conflict, false);
});

check('境界序表含《墨染仙途》真实体系（含结丹/金丹两阶）', () => {
  // 校准依据：AI写小说/墨染仙途/小说资料/ 下的真实设定库
  for (const r of ['凝气', '筑基', '结丹', '金丹', '元婴', '化神', '炼虚', '合体', '大乘']) {
    assert.ok(ORDINALS.境界.includes(r), `序表缺 ${r}`);
  }
  // 通用修仙里「结丹= 金丹」，但本书两者都用作独立阶
  assert.ok(ORDINALS.境界.indexOf('结丹') < ORDINALS.境界.indexOf('金丹'),
    '结丹应排在金丹之前');
  assert.ok(ORDINALS.境界.indexOf('金丹') < ORDINALS.境界.indexOf('元婴'),
    '金丹应排在元婴之前');
});

console.log('\n二·五、境界小层：真实设定库同时用「元婴」与「元婴初期/中期/后期」');

check('parseRealm 能解析大阶与小层两维', () => {
  const cases = [
    ['元婴后期', 7, 2], ['元婴中期', 7, 1], ['元婴初期', 7, 0],
    ['元婴期', 7, 0], ['元婴', 7, 0],
    ['筑基期', 4, 0], ['结丹', 5, 0], ['金丹期', 6, 0],
    ['大乘期', 11, 0], ['合体期', 10, 0], ['凡人', 0, 0],
  ];
  for (const [v, tier, sub] of cases) {
    const r = parseRealm(v);
    assert.ok(r, `${v} 解析失败`);
    assert.strictEqual(r.tier, tier, `${v} 大阶错：${r.tier}≠${tier}`);
    assert.strictEqual(r.sub, sub, `${v} 小层错：${r.sub}≠${sub}`);
  }
});

check('「元婴后期」不被结尾「期」切坏小层（曾静默漏判）', () => {
  // 真实 bug：先 replace(/期$/) 把「元婴后期」切成「元婴后」，
  // 「后期」子串匹配失败 → sub 恒为 0 → 所有「XX期」写法的倒退全漏判。
  const r = parseRealm('元婴后期');
  assert.strictEqual(r.sub, 2, `小层应为 2（后期），实际 ${r.sub}`);
});

check('无法解析的境界表述不参与判定（宁可判不出不可判错）', () => {
  assert.strictEqual(parseRealm('不确定'), null);
  assert.strictEqual(parseRealm(''), null);
  assert.strictEqual(parseRealm(null), null);
  const d = detectDrift({ 境界: '不确定' }, { 境界: '元婴后期' });
  assert.strictEqual(d.conflict, false, '解析不出的值不该报冲突');
});

check('同阶小层倒退要报（真实设定库 41 处「元婴后期」不是摆设）', () => {
  const down = detectDrift({ 境界: '元婴后期' }, { 境界: '元婴中期' });
  assert.strictEqual(down.conflict, true, '同阶小层倒退未检出');
  assert.strictEqual(down.kind, 'ordinal-regression');

  const up = detectDrift({ 境界: '元婴中期' }, { 境界: '元婴后期' });
  assert.strictEqual(up.conflict, false, '晋升被误报');
});

check('跨阶晋升不报（结丹 → 金丹是两阶晋升不是跳级异常）', () => {
  assert.strictEqual(detectDrift({ 境界: '结丹' }, { 境界: '金丹期' }).conflict, false);
  assert.strictEqual(detectDrift({ 境界: '筑基期' }, { 境界: '结丹' }).conflict, false);
  assert.strictEqual(detectDrift({ 境界: '凡人' }, { 境界: '筑基期' }).conflict, false);
});

check('模糊写法「元婴」按该阶最低层算（不误报初期→元婴）', () => {
  // 真实设定库里「元婴期」出现 11 次、「元婴初期」10 次，两种写法并存。
  // 模糊写法不参与小层比较，否则「初期→元婴」会被误判成倒退。
  assert.strictEqual(detectDrift({ 境界: '元婴初期' }, { 境界: '元婴' }).conflict, false);
  // 但从「后期」退到模糊的「元婴」仍应报——小层 2→0 是倒退
  assert.strictEqual(detectDrift({ 境界: '元婴后期' }, { 境界: '元婴' }).conflict, true);
});

console.log('\n四、长篇连续性：状态轨迹可累积（这是回答「他去过哪儿」的唯一数据）');

check('位置轨迹累积且去重连续重复', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Store } = require('../db/store.js');
  const { applyStateAfterCommit } = require('./state-writer.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-hist-'));
  const store = new Store(path.join(tmp, 'h.db'));
  store.importWorldBible(resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');

  // 连续三章：洛阳 → 剑冢 → 洛阳，每章都有移动动词
  const chapters = [
    { id: 'h1', text: '谢九站在洛阳的城门口。' },
    { id: 'h2', text: '谢九离开洛阳，前往剑冢。' },
    { id: 'h3', text: '谢九回到洛阳，站在城门口。' },
  ];
  for (const c of chapters) {
    store.createChapter({ id: c.id, projectId: 'novel-demo-01', title: c.id, content: '' });
    const r = applyStateAfterCommit({
      store, projectId: 'novel-demo-01', chapterId: c.id, text: c.text, settings,
    });
    assert.strictEqual(r.conflicts.length, 0, `${c.id} 误报冲突：${JSON.stringify(r.conflicts)}`);
  }

  const st = store.getEntityState('novel-demo-01', '谢九');
  assert.ok(st, '谢九状态未落库');
  assert.ok(Array.isArray(st.state.locationHistory), '位置轨迹未记录');
  assert.ok(st.state.locationHistory.length >= 2,
    `轨迹应累积多个位置，实际 ${JSON.stringify(st.state.locationHistory)}`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('轨迹有上限，不会无限增长（2700 章的硬需求）', () => {
  const { deriveStateChanges } = require('./state-writer.js');
  const settings = [
    { name: '谢九', type: 'character', aliases: [], note: '' },
    { name: '洛阳', type: 'location', aliases: [], note: '' },
    { name: '剑冢', type: 'location', aliases: [], note: '' },
  ];
  // 伪造 30 章的历史
  const longHistory = Array.from({ length: 30 }, (_, i) => `地点${i}`);
  const r = deriveStateChanges({
    text: '谢九在洛阳。',
    settings,
    chapterId: 'x',
    prevStates: { 谢九: { alive: true, location: '剑冢', locationHistory: longHistory } },
  });
  const u = r.updates.find((x) => x.entityName === '谢九');
  assert.ok(u, '未产生更新');
  assert.ok(u.mergedState.locationHistory.length <= 12,
    `轨迹未截断：${u.mergedState.locationHistory.length} 条`);
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`漂移规则：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
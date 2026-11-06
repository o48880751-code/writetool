/**
 * 参数怎么填 —— 面板上的那份说明。
 *
 * ## 它是干什么的
 *
 * 参数页上要填「上下文窗口 / 单次输出 / 输出预留 / 温度」四个数，
 * 而这四个数**每家不一样、每个模型也不一样**。用户第一次进来一定不知道填什么。
 *
 * ## 2026-11-03 改版（羽毛菌：「这个解释是不是改改，改的正式一点，像说明书」）
 *
 * 上一版的问题是**在向用户解释我自己的纠结**：
 * 满屏"待核实"标记（那是我写代码时的自用记号，不是给用户看的）、
 * 「标了待核实的几家确实要按模型页再核一遍」、
 * 「本地模型那一栏是故意留空的……给一个通用数字只会让你照抄之后卡死」。
 *
 * 现在改成三段式说明书：
 *   一、这些值从哪来（去哪看）
 *   二、常见值（快速起步用，不承诺）
 *   三、查不到时怎么定（自己试的三个判据）
 *
 * ⚠ **不给具体网址**：各家控制台的路径一年能改三次，写死一条链接
 *   等于半年后给用户一个 404。给"看哪个页面"比给 URL 活得久。
 * ⚠ 数字只写"常见值"，不写"建议值"—— 前者承认会变，后者像是在保证。
 */

import React from 'react';

/**
 * 每家的常见值。窗口单位是 token。
 *
 * ⚠ 这些数字**不是承诺**：上下文长度与最大输出是服务商随时会调的参数。
 *   所以界面上不写"标准值"，写"常见值"，并且明确"以模型页为准"。
 *   `source` 说明这个值从哪来（能给出处的就说出处）。
 */
export const PROVIDER_GUIDE = [
  {
    match: /deepseek/i,
    name: 'DeepSeek（api.deepseek.com）',
    source: '官方模型页标注',
    rows: [
      ['上下文窗口', '128K（131072）', 'deepseek-chat / deepseek-reasoner 的常见值'],
      ['单次输出上限', '8K（8192）', '填更大服务端会直接拒绝'],
      ['输出预留', '4K', '取输出上限的一半，一般不用改'],
    ],
    temp: '0.3 ~ 0.5。写正文超过 0.5 会开始不按设定走。',
    tip: '免费额度经常排队；单轮写超过 4000 字容易被限流。',
  },
  {
    match: /siliconflow|硅基流动/i,
    name: '硅基流动 SiliconFlow',
    source: '按模型页填',
    rows: [
      ['上下文窗口', '32K ~ 128K', '同一家里不同模型差很多，页面写多少填多少'],
      ['单次输出上限', '8K（8192）', '保守值；Qwen3 系列按模型页'],
      ['输出预留', '4K', '一般不用改'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: '聚合平台：同一个「窗口」数字对不同模型含义不同，以该模型自己的页面为准。',
  },
  {
    match: /glm|zhipu|智谱/i,
    name: '智谱 GLM（open.bigmodel.cn）',
    source: '以模型页为准',
    rows: [
      ['上下文窗口', '128K（131072）', 'GLM-4 及之后的长文本型号；更早的小型号低得多'],
      ['单次输出上限', '8K', '保守值'],
      ['输出预留', '4K', '一般不用改'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: '接口地址是 https://open.bigmodel.cn/api/paas/v4，路径少写一段会返回 404。',
  },
  {
    match: /dashscope|百炼|通义|qwen/i,
    name: '阿里云百炼 / 通义千问',
    source: '以模型页为准',
    rows: [
      ['上下文窗口', '128K ~ 256K', 'qwen-plus / qwen-max 这类长文本型号'],
      ['单次输出上限', '8K ~ 32K', '按型号差别很大'],
      ['输出预留', '4K ~ 8K', '长章节写到一半被截断就调这一项'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: '接口地址是 https://dashscope.aliyuncs.com/compatible-mode/v1，compatible-mode 这一段不能省。',
  },
  {
    match: /openrouter/i,
    name: 'OpenRouter',
    source: '逐个模型页看',
    rows: [
      ['上下文窗口', '按模型', '聚合平台，从 8K 到 200K 都有'],
      ['单次输出上限', '按模型', ''],
      ['输出预留', '输出的 1/4 ~ 1/3', ''],
    ],
    temp: '0.3 ~ 0.6。',
    tip: '',
  },
  {
    match: /ollama|本地|127\.0\.0\.1/i,
    name: '本地模型（Ollama）',
    source: '按显存与模型参数量决定',
    rows: [
      ['上下文窗口', '按显存', '8G 显存跑 8B 模型一般是 4K ~ 8K'],
      ['单次输出上限', '窗口的一半', ''],
      ['输出预留', '输出的 1/3', ''],
    ],
    temp: '0.3 ~ 0.7。',
    tip: '本地没有通用值：能开多大由显存和模型参数量决定，同一个数字在不同机器上结果完全不同。'
      + '从 4K 开始往上试，报显存错误就调小。',
  },
];

/** 按连接名 / 服务商挑一家；挑不到返回 null（界面会给通用说明）。 */
export function guideFor(name = '', base = '') {
  const hay = `${name} ${base}`;
  return PROVIDER_GUIDE.find((g) => g.match.test(hay)) || null;
}

/** 说明弹层。参数页那个按钮调它。 */
export default function ParamGuide({ connName = '', connBase = '', onClose }) {
  const g = guideFor(connName, connBase);
  React.useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const th = { color: 'var(--ink)', background: 'var(--paper)' };
  const td = { color: 'var(--ink-soft)' };
  const h2 = { color: 'var(--ink)', fontWeight: 600 };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,.35)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-lg max-w-2xl w-full max-h-[86vh] overflow-y-auto"
        style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
        data-testid="param-guide"
      >
        <div
          className="flex items-center justify-between px-4 py-2.5 sticky top-0"
          style={{ borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}
        >
          <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            参数怎么填
          </div>
          <button onClick={onClose} className="text-[12px] px-2 py-1 rounded"
                  style={{ color: 'var(--ink-soft)' }}>关闭</button>
        </div>

        <div className="px-4 py-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          <p style={{ color: 'var(--ink)' }}>
            当前连接：<b>{connName || '（未选择连接）'}</b>
          </p>

          {/* ---------- 一、这些值从哪来 ---------- */}
          <h3 className="mt-4 mb-1 text-[13px]" style={h2}>一、这些值从哪来</h3>
          <p>
            在各服务商控制台的「模型广场 / 模型列表」里，每个模型都标了
            <b style={{ color: 'var(--ink)' }}>上下文长度</b>与
            <b style={{ color: 'var(--ink)' }}>最大输出</b>。
            填写时以那个页面的数字为准。
          </p>
          <p className="mt-1">
            下面给的是<b style={{ color: 'var(--ink)' }}>常见值</b>，用于快速起步。
            服务商会调整这些参数，所以它不构成保证。
          </p>
          {/*
            ⚠ 2026-11-05 加（羽毛菌：「加一句话，主流云端大模型推荐，128k，16k，8k」）。
            ⚠ 只说"推荐配置"，不说"标准值" —— 各家真实上限不同，写死会被当成保证。
          */}
          <p className="mt-2" data-testid="param-recommend">
            <b style={{ color: 'var(--ink)' }}>主流云端大模型推荐</b>：
            上下文窗口 <b style={{ color: 'var(--ink)' }}>128K</b>、
            单次输出 <b style={{ color: 'var(--ink)' }}>16K</b>、
            输出预留 <b style={{ color: 'var(--ink)' }}>8K</b>。
            按实际模型能力与章节长度调整。
          </p>

          {/* ---------- 二、常见值 ---------- */}
          <h3 className="mt-4 mb-1 text-[13px]" style={h2}>二、常见值</h3>
          {g ? (
            <>
              <div className="text-[12.5px] mb-1" style={{ color: 'var(--ink)' }}>
                {g.name}　
                <span style={{ color: 'var(--ink-soft)' }}>来源：{g.source}</span>
              </div>
              <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['项', '常见值', '说明'].map((h) => (
                      <th key={h} className="text-left py-1 px-2" style={{ ...th, borderBottom: '1px solid var(--line)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map(([k, v, why]) => (
                    <tr key={k}>
                      <td className="py-1 px-2" style={{ ...td, borderBottom: '1px solid var(--line)' }}>{k}</td>
                      <td className="py-1 px-2 font-semibold" style={{ color: 'var(--ink)', borderBottom: '1px solid var(--line)' }}>
                        {v}
                      </td>
                      <td className="py-1 px-2" style={{ ...td, borderBottom: '1px solid var(--line)' }}>{why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2"><b style={{ color: 'var(--ink)' }}>温度</b>：{g.temp}</p>
              {g.tip && <p className="mt-1">{g.tip}</p>}
            </>
          ) : (
            <p>
              这条连接不在常见名单里。起步值：
              <b style={{ color: 'var(--ink)' }}>窗口 32K、输出 8K、预留 4K、温度 0.4</b>，
              之后按模型的官方页面调整。
            </p>
          )}

          {/* ---------- 三、查不到怎么办 ---------- */}
          <h3 className="mt-4 mb-1 text-[13px]" style={h2}>三、查不到时怎么定</h3>
          <p>按顺序做三步：</p>
          <ol className="mt-1 pl-4" style={{ listStyle: 'decimal' }}>
            <li>
              先填保守值：窗口 <b style={{ color: 'var(--ink)' }}>32K</b>、
              输出 <b style={{ color: 'var(--ink)' }}>8K</b>、
              预留 <b style={{ color: 'var(--ink)' }}>4K</b>。
            </li>
            <li>写一段两三千字的正文试一次。</li>
            <li>根据现象只改一项，改完再试：</li>
          </ol>
          <ul className="mt-1 pl-4" style={{ listStyle: 'disc' }}>
            <li>写到一半被截断 → 输出上限或预留太小，调大预留。</li>
            <li>读得进去但写着写着忘了前面的设定 → 窗口不够，调大窗口。</li>
            <li>本地模型报显存错误或长时间不出字 → 窗口太大，调小。</li>
          </ul>

          <p className="mt-3 pt-3 text-[11.5px]" style={{ borderTop: '1px solid var(--line)' }}>
            一次只改一项。同时改两个数，出了问题分不清是哪一个造成的。
          </p>
        </div>
      </div>
    </div>
  );
}

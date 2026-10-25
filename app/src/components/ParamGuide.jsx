/**
 * 参数怎么填 —— 面板上的那份教程。
 *
 * ## 为什么要有它
 *
 * 2026-10-15 羽毛菌：「可以出具一份文档，教用户怎么填，比如我用云端 deepseek
 * 推荐多少到多少，用 glm 推荐多少到多少，在旁边放一个按钮，单击弹出教程」。
 *
 * 原来那页只写了两句免责：「以服务商文档为准，拿不准就填保守一点」。
 * **那句话等于没说** —— 用户要的正是"那我这份该填多少"。
 *
 * ⚠⚠ **表里的数字必须区分「已核实」与「未核实」**：
 *   LLM 的上下文长度与最大输出**各家经常变**，凭记忆写就是编。
 *   所以每一家都标了来源状态：
 *     [已核实] = 有官方文档出处，或本机实测过
 *     [待核实] = 常见值，但**用之前请以该服务商页面为准**
 *   界面上直接把这句话显示出来 —— 标注"待核实"不是心虚，是不骗人。
 *
 * **本地模型那一栏先空着**（羽毛菌：「本地大模型后面再说」）：
 * 显存决定能开多大，不同卡差别巨大，给一个通用数字会误导。
 */

import React from 'react';

/** 每家的推荐值。窗口单位是 token。 */
export const PROVIDER_GUIDE = [
  {
    match: /deepseek/i,
    name: 'DeepSeek（api.deepseek.com）',
    status: '[已核实] 官方文档',
    rows: [
      ['上下文窗口', '128K（131072）', '官方模型页就是这个数'],
      ['单次输出上限', '8K（8192）', '官方上限，别填更大——服务端会拒'],
      ['输出预留', '4K', '自动就是输出上限的一半，一般不用改'],
    ],
    temp: '0.3 ~ 0.5。写正文别超过 0.5，调高了会「不听话」。',
    tip: '免费额度经常排队；一轮写太长（>4K 字）容易被限流。',
  },
  {
    match: /siliconflow|硅基流动/i,
    name: '硅基流动 SiliconFlow',
    status: '[待核实] 逐个模型看',
    rows: [
      ['上下文窗口', '32K ~ 128K', '⚠ 同一家里不同模型差很多，页面写多少就填多少'],
      ['单次输出上限', '8K（8192）', '保守值；Qwen3 这类要按模型页'],
      ['输出预留', '4K', '一般不用改'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: '⚠ 聚合平台，**能力跟着模型走**：同一个「窗口」数字对不同模型含义不同。填之前先看那个模型自己的页面。',
  },
  {
    match: /glm|zhipu|智谱/i,
    name: '智谱 GLM（open.bigmodel.cn）',
    status: '[待核实] 以模型页为准',
    rows: [
      ['上下文窗口', '128K（131072）', 'GLM-4 及之后的长文本型号；老的 6B/9B 小得多'],
      ['单次输出上限', '8K', '保守值'],
      ['输出预留', '4K', '一般不用改'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: '注意 base 是 `https://open.bigmodel.cn/api/paas/v4`，**少写一层就 404**。',
  },
  {
    match: /dashscope|百炼|通义|qwen/i,
    name: '阿里云百炼 / 通义千问',
    status: '[待核实] 以模型页为准',
    rows: [
      ['上下文窗口', '128K ~ 256K', 'qwen-plus / qwen-max 这类长文本型号'],
      ['单次输出上限', '8K ~ 32K', '按模型差别很大'],
      ['输出预留', '4K ~ 8K', '长章节写一半被掐断就调这个'],
    ],
    temp: '0.3 ~ 0.5。',
    tip: 'base 是 `https://dashscope.aliyuncs.com/compatible-mode/v1`，compatible-mode 不能省。',
  },
  {
    match: /openrouter/i,
    name: 'OpenRouter',
    status: '[待核实] 每个模型页都不同',
    rows: [
      ['上下文窗口', '按模型', 'OpenRouter 聚合，什么都有'],
      ['单次输出上限', '按模型', ''],
      ['输出预留', '输出的 1/4 ~ 1/3', ''],
    ],
    temp: '0.3 ~ 0.6。',
    tip: '',
  },
  {
    match: /ollama|本地|127\.0\.0\.1/i,
    name: '本地模型（Ollama）',
    status: '[暂缺] 这一栏先空着',
    rows: [
      ['上下文窗口', '按你的显存定', '⚠ 没有通用值：8G 卡的 8B 模型一般 4K ~ 8K'],
      ['单次输出上限', '窗口的一半', ''],
      ['输出预留', '输出的 1/3', ''],
    ],
    temp: '0.3 ~ 0.7。',
    tip: '⚠ 这一栏是**故意留空**的：能开多大完全由显存与模型决定，'
      + '给一个通用数字只会让你照抄之后卡死或忘事。具体数值要按你的卡来量。',
  },
];

/** 按连接名/服务商挑一家；挑不到给通用说明。 */
export function guideFor(name = '', base = '') {
  const hay = `${name} ${base}`;
  return PROVIDER_GUIDE.find((g) => g.match.test(hay)) || null;
}

/** 教程弹层。参数页那个「怎么填」按钮调它。 */
export default function ParamGuide({ connName = '', connBase = '', onClose }) {
  const g = guideFor(connName, connBase);
  React.useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const th = { color: 'var(--ink)', background: 'var(--paper)' };
  const td = { color: 'var(--ink-soft)' };

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
            你现在用的是：<b>{connName || '（未选择连接）'}</b>
          </p>

          {g ? (
            <>
              <h3 className="mt-3 mb-1 text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                {g.name}　<span style={{ color: 'var(--ink-soft)', fontWeight: 400 }}>{g.status}</span>
              </h3>
              <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['项', '建议值', '为什么'].map((h) => (
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
            <p className="mt-3">
              这条连接不在表里。通用起点：<b style={{ color: 'var(--ink)' }}>窗口 32K、输出 8K、预留 4K、温度 0.4</b>，
              然后按模型的官方页面改。
            </p>
          )}

          <p className="mt-4 pt-3 text-[11.5px]" style={{ borderTop: '1px solid var(--line)' }}>
            ⚠️ 标「[待核实]」的几家**确实要按模型页再核一遍**：
            上下文长度与最大输出是服务商随时会改的参数，
            这里给的是常见值，不是承诺。填完自己试一段长文就知道对不对 ——
            写一半被掐断就是窗口/预留太小，读到一半开始忘事就是窗口不够。
          </p>
          <p className="mt-1 text-[11.5px]">
            本地模型那一栏是<b style={{ color: 'var(--ink)' }}>故意留空</b>的：能开多大完全由你的显卡和模型决定，
            给一个通用数字只会让你照抄之后卡死。
          </p>
        </div>
      </div>
    </div>
  );
}
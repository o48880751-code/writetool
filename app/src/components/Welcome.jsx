import { useEffect } from 'react';

/**
 * 欢迎页与「使用教程」弹窗（2026-11-05）。
 *
 * 羽毛菌要的是两套入口，各三个按钮，不多不少：
 *   第一次进来（这个项目还没有对话）：新书启航 / 搭建大纲 / 使用教程
 *   第二次从书架进来（已经有对话）  ：继续写作 / 规划章纲 / 查询冲突
 *
 * ⚠ 文案只说「点了这个会发生什么」，不写「开启你的创作之旅」这类话。
 *   按钮名字是他点名给的，一个字都不许改。
 *
 * ⚠ 六个动作全部由 App 接到现有通道上（send / selectConversation / 文件树），
 *   这个组件只负责显示与回调，**不碰任何 IPC**。
 */

const FIRST = [
  { key: 'newbook', label: '新书启航', desc: '先问你想写什么，再给一版基础大纲' },
  { key: 'build', label: '搭建大纲', desc: '已有想法或草稿，一起把它补完整' },
  { key: 'guide', label: '使用教程', desc: '配置 API、下载技能、认识文件夹' },
];

const RETURNING = [
  { key: 'continue', label: '继续写作', desc: '打开上次那段对话' },
  { key: 'outline', label: '规划章纲', desc: '展开卷纲，先商量下一章怎么写' },
  { key: 'conflict', label: '查询冲突', desc: '对照世界观、人物库和最新卷纲' },
];

/** 空对话时占住聊天栏的中间。mode: 'first' | 'returning' */
export function WelcomePanel({ mode, onAction }) {
  const items = mode === 'returning' ? RETURNING : FIRST;
  return (
    <div
      className="min-h-full flex items-center justify-center px-2 py-6"
      data-testid="welcome-panel"
      data-welcome-mode={mode}
    >
      <div className="w-full" style={{ maxWidth: 380 }}>
        <div className="text-[12px] mb-4 text-center" style={{ color: 'var(--ink-soft)' }}>
          {mode === 'returning' ? '选一个继续方式' : '选一个开始方式'}
        </div>
        <div className="flex flex-col gap-2.5">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              data-welcome={it.key}
              className="welcome-card"
              onClick={() => onAction && onAction(it.key)}
            >
              <span className="welcome-card-title">{it.label}</span>
              <span className="welcome-card-desc">{it.desc}</span>
              <span className="welcome-card-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 教程弹窗。
 *
 * ⚠ 要能「随时按按钮关闭」：右上角 ✕、底部「知道了」、点遮罩、Esc，四条路都在。
 * ⚠ 里面写的入口必须是软件里真有的：设置页类目键 provider / skill，
 *   文件夹 设定 / 卷纲 / 章节，对话栏快捷工具。别写不存在的按钮。
 */
export function GuideModal({ onClose, onOpenSettings }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const jump = (cat) => {
    onClose();
    if (onOpenSettings) onOpenSettings(cat);
  };

  return (
    <div className="guide-mask modal-mask" onClick={onClose} data-testid="guide-modal">
      <div
        className="guide-card modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="使用教程"
      >
        <div className="guide-head">
          <span className="guide-title">使用教程</span>
          <button
            type="button"
            className="guide-close"
            onClick={onClose}
            data-testid="guide-close"
            aria-label="关闭教程"
            title="关闭"
          >✕</button>
        </div>

        <div className="guide-body">
          <section className="guide-section">
            <h4>1. 连上 AI</h4>
            <p>设置 →「AI 提供商」→ 选一家服务商，填 API Key 或本机 Ollama 地址 →「保存并测试」。没连上之前发消息不会有回应。</p>
            <button type="button" className="guide-link" data-guide-jump="provider" onClick={() => jump('provider')}>去配置</button>
          </section>

          <section className="guide-section">
            <h4>2. 下载技能</h4>
            <p>设置 →「Skill」→「广场」→ 下载要用的写作技能。技能是给 AI 看的方法说明，不装也能聊，只是没那么顺手。</p>
            <button type="button" className="guide-link" data-guide-jump="skill" onClick={() => jump('skill')}>去广场</button>
          </section>

          <section className="guide-section">
            <h4>3. 认识文件夹</h4>
            <p>「设定」放世界观、人物库；「卷纲」放分卷大纲；「章节」放正文和章节摘要。第 4 栏右键可以新建、改名、删除，拖动能排序。短篇是根目录下几个 md，短剧是「剧集」目录。</p>
          </section>

          <section className="guide-section">
            <h4>4. 把资料带进这一轮</h4>
            <p>输入框旁的「技能」带一个技能，「文件」带一份设定或章节原文。写正文时把人物库带上，名字和设定才不容易写错。</p>
          </section>

          <section className="guide-section">
            <h4>5. 快捷功能</h4>
            <p>对话栏顶部那一排：备忘录、起名、脑洞、灵感碎片、文风蒸馏、简介。点一下开一个专门的小工具，用完回到对话。</p>
          </section>

          <section className="guide-section">
            <h4>6. 数据与安全</h4>
            <p>稿子是你电脑上的 md 文件，不上传。终端和联网默认全关，需要时在输入框上方逐轮放行；API Key 存在系统加密区里。</p>
          </section>
        </div>

        <div className="guide-foot">
          <button type="button" className="guide-done" onClick={onClose} data-testid="guide-done">知道了</button>
        </div>
      </div>
    </div>
  );
}

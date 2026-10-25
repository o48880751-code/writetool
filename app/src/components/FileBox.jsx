import { useState } from 'react';

/**
 * 文件框（右栏）。
 *
 * ## 为什么用 Tab 收纳而不是堆在一起
 *
 * 章节列表、设定库、状态表、伏笔表、编辑器、文风检测、设置——
 * 七块内容。全部展开的话右栏会比屏幕还长，
 * 而对话界面里右栏是辅助位，不该抢主位。
 * Tab 的好处是**切换成本低且状态可见**，用户知道自己在哪里。
 *
 * 各 Tab 的内容复用既有组件（Sidebar 的检索逻辑、StylePanel、SettingsPanel、
 * EditorSurface），不重复实现。
 */
export default function FileBox({
  tab, onTab,
  /**
   * 隐藏自带的 tab 条。
   *
   * 第四栏布局之后，FileBox 不再是"右栏容器"而是**主标签的内容面板**——
   * 切标签由 MainWorkspace 统一管，FileBox 只负责画内容。
   * 不加这个 prop 就会出现两层标签栏（外层主标签 + 内层 FileBox tab），
   * 界面上像多了一层没用的东西。
   */
  hideTabs = false,
  // 章节
  chapters, activeChapterId, onSelectChapter, onCreateChapter,
  newTitle, setNewTitle,
  // 设定
  settings, states, threads,
  onRefreshAll, refreshToken,
  // 检索 / 状态编辑
  searchHits, searching, query, setQuery, onSearch, onFilter,
  adding, setAdding, newItem, setNewItem, onAddSetting, onAddThread,
  editingState, setEditingState, editForm, setEditForm, onSaveState,
  fontSize, generating,
  // 文风 / 设置
  styleProfile, styleResult, styleBusy, onRefreshStyle, onCheckStyle, styleDirectiveText,
  config, onConfigChange,
  projectId,
  children,          // 正文页签里的编辑器由外部注入
}) {
  const [editingTitle, setEditingTitle] = useState(null);
  const [titleText, setTitleText] = useState('');

  const TABS = [
    { key: 'chapters', label: '章节' },
    { key: 'settings', label: '设定' },
    { key: 'state', label: '状态' },
    { key: 'threads', label: '伏笔' },
    { key: 'text', label: '正文' },
    { key: 'style', label: '文风' },
  ];

  return (
    /* flex-1 + min-h-0：与 siblings（编辑器）分高度。
       用 h-full 会撑满整个右栏，把编辑器挤成 0 高度。 */
    <aside className="flex flex-col min-h-0 flex-1"
           style={{ background: 'var(--paper)' }}>
      {/* Tab（hideTabs 时不渲染——切换交给主标签） */}
      {!hideTabs && (
      <div className="flex shrink-0 overflow-x-auto" style={{ borderBottom: '1px solid var(--line)' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => onTab(t.key)}
            className="px-2.5 py-2 text-[12px] whitespace-nowrap"
            style={{
              color: tab === t.key ? 'var(--ink)' : 'var(--ink-soft)',
              background: tab === t.key ? 'var(--paper-2)' : 'transparent',
              fontWeight: tab === t.key ? 600 : 400,
              borderBottom: '2px solid ' + (tab === t.key ? 'var(--accent)' : 'transparent'),
            }}
          >
            {t.label}
            {t.key === 'chapters' && chapters?.length > 0 && (
              <span className="ml-0.5 text-[10px] opacity-60">{chapters.length}</span>
            )}
            {t.key === 'settings' && settings?.length > 0 && (
              <span className="ml-0.5 text-[10px] opacity-60">{settings.length}</span>
            )}
          </button>
        ))}
      </div>
      )}

      {/* ---------- 章节 ---------- */}
      {tab === 'chapters' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2 flex gap-1.5 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onCreateChapter(); }}
              placeholder="新章节标题"
              className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none min-w-0"
              style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
            />
            <button
              onClick={onCreateChapter}
              disabled={!newTitle.trim()}
              className="px-2.5 py-1.5 rounded text-[12px] disabled:opacity-40 shrink-0"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              新建
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 min-h-0">
            {!chapters?.length && (
              <Empty text="还没有章节。在上方输入标题新建一个。" />
            )}
            {chapters?.map((c) => (
              <div key={c.id}
                   className="mx-1 px-2 py-1.5 rounded"
                   style={{ background: c.id === activeChapterId ? 'var(--accent-soft)' : 'transparent' }}>
                {editingTitle === c.id ? (
                  <input
                    autoFocus
                    value={titleText}
                    onChange={(e) => setTitleText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setEditingTitle(null); } if (e.key === 'Escape') setEditingTitle(null); }}
                    onBlur={() => setEditingTitle(null)}
                    className="w-full px-1 py-0.5 rounded text-[12.5px] outline-none"
                    style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                  />
                ) : (
                  <>
                    <button onClick={() => onSelectChapter(c.id)} className="w-full text-left group">
                      <div className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{c.title}</div>
                      <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
                        {c.word_count || 0} 字 · {c.origin === 'agent' ? 'AI' : c.origin === 'human' ? '手写' : '规则'}
                      </div>
                    </button>
                    <button
                      onClick={() => { setEditingTitle(c.id); setTitleText(c.title); }}
                      className="text-[10px] mt-0.5 hidden group-hover:inline"
                      style={{ color: 'var(--accent)' }}
                    >
                      重命名
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 设定 ---------- */}
      {tab === 'settings' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2 space-y-1.5 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="flex gap-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onSearch(); }}
                placeholder="检索设定…（Enter）"
                className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none min-w-0"
                style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
              />
              <button
                onClick={() => onSearch()}
                disabled={!query.trim() || searching}
                className="px-2 py-1.5 rounded text-[12px] disabled:opacity-40 shrink-0"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                {searching ? '…' : '检索'}
              </button>
            </div>
            <div className="flex gap-1 flex-wrap items-center">
              {[['全部', ''], ['角色', 'character'], ['地点', 'location'], ['功法', 'technique'], ['势力', 'faction']].map(([lbl, v]) => (
                <button
                  key={lbl}
                  onClick={() => onFilter(v)}
                  disabled={!query.trim()}
                  className="px-1.5 py-0.5 rounded text-[11px] disabled:opacity-40"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
                >
                  {lbl}
                </button>
              ))}
              <div className="flex-1" />
              <button
                onClick={() => setAdding(adding === 'setting' ? null : 'setting')}
                className="px-2 py-0.5 rounded text-[11px]"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {adding === 'setting' ? '取消' : '+ 设定'}
              </button>
              {searchHits && (
                <button onClick={() => onSearch(null)} className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                  返回全量
                </button>
              )}
            </div>
            {adding === 'setting' && (
              <div className="space-y-1.5 pt-1">
                <div className="flex gap-1.5">
                  <select value={newItem.type} onChange={(e) => setNewItem({ ...newItem, type: e.target.value })}
                          className="px-1.5 py-1 rounded text-[12px] outline-none"
                          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>
                    <option value="character">角色</option>
                    <option value="location">地点</option>
                    <option value="technique">功法</option>
                    <option value="faction">势力</option>
                    <option value="plot">伏笔</option>
                  </select>
                  <input
                    value={newItem.name}
                    onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') onAddSetting(); }}
                    placeholder="名称"
                    className="flex-1 px-2 py-1 rounded text-[12px] outline-none min-w-0"
                    style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                  />
                </div>
                <textarea
                  value={newItem.note}
                  onChange={(e) => setNewItem({ ...newItem, note: e.target.value })}
                  placeholder="说明（可选）" rows={2}
                  className="w-full px-2 py-1 rounded text-[12px] outline-none resize-none"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                />
                <button onClick={onAddSetting} disabled={!newItem.name.trim()}
                        className="w-full py-1 rounded text-[12px] disabled:opacity-40"
                        style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                  保存
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {searchHits ? (
              <>
                <SectionTitle text={`检索「${query}」（${searchHits.length}）`} />
                {!searchHits.length && <Empty text={`没找到与「${query}」相关的设定`} />}
                {searchHits.map((s) => (
                  <div key={s.id || s.name} className="px-3 py-1.5" style={{ borderBottom: '1px solid var(--line)' }}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{s.name}</span>
                      <span className="text-[10px] px-1 rounded shrink-0"
                            style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
                        {{ character: '角色', location: '地点', technique: '功法', faction: '势力', plot: '伏笔' }[s.type] || s.type}
                      </span>
                    </div>
                    {s.note && <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>{s.note.slice(0, 100)}</div>}
                  </div>
                ))}
              </>
            ) : (
              <>
                {!settings?.length && <Empty text="设定库是空的。到「设置」导入，或用上方「+ 设定」添加。" />}
                {groupByType(settings).map(([type, list]) => (
                  <div key={type}>
                    <SectionTitle text={`${TYPE_LABEL[type] || type}（${list.length}）`} />
                    {list.map((s) => (
                      <div key={s.id || s.name} className="px-3 py-1">
                        <div className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{s.name}</div>
                        {s.note && <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--ink-soft)' }}>{s.note.slice(0, 60)}</div>}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- 状态 ---------- */}
      {tab === 'state' && (
        <div className="flex-1 overflow-y-auto">
          {!states?.length && <Empty text="还没有状态。保存章节后会自动回写。" />}
          {states?.map((s) => (
            <div key={s.entity_name} className="px-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
              {editingState === s.entity_name ? (
                <div className="space-y-1.5">
                  <div className="text-[12.5px] font-medium" style={{ color: 'var(--ink)' }}>{s.entity_name}</div>
                  <input
                    value={editForm.location}
                    onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                    placeholder="当前位置"
                    className="w-full px-2 py-1 rounded text-[12px] outline-none"
                    style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                  />
                  <input
                    value={editForm.境界}
                    onChange={(e) => setEditForm({ ...editForm, 境界: e.target.value })}
                    placeholder="境界"
                    className="w-full px-2 py-1 rounded text-[12px] outline-none"
                    style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                  />
                  <div className="flex gap-1.5">
                    <button onClick={() => onSaveState(s.entity_name)}
                            className="flex-1 py-1 rounded text-[12px]"
                            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>保存</button>
                    <button onClick={() => setEditingState(null)}
                            className="px-3 py-1 rounded text-[12px]"
                            style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium flex-1 truncate" style={{ color: 'var(--ink)' }}>{s.entity_name}</span>
                    <button
                      onClick={() => {
                        setEditingState(s.entity_name);
                        setEditForm({ location: s.state?.location || '', 境界: s.state?.境界 || '' });
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
                    >
                      改
                    </button>
                  </div>
                  <div className="text-[11px] mt-1 space-y-0.5" style={{ color: 'var(--ink-soft)' }}>
                    {s.state?.location && <div>位置：{s.state.location}</div>}
                    {s.state?.境界 && <div>境界：{s.state.境界}</div>}
                    {Array.isArray(s.state?.locationHistory) && s.state.locationHistory.length > 1 &&
                      <div>轨迹：{s.state.locationHistory.join(' → ')}</div>}
                    {s.state?.unverifiedMoves > 0 &&
                      <div style={{ color: 'var(--danger)' }}>⚠ 连续 {s.state.unverifiedMoves} 章位置无移动证据</div>}
                    {!s.state?.location && !s.state?.境界 && <div className="opacity-50">未记录</div>}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------- 伏笔 ---------- */}
      {tab === 'threads' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2 shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
            <button
              onClick={() => setAdding(adding === 'thread' ? null : 'thread')}
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {adding === 'thread' ? '取消' : '+ 伏笔'}
            </button>
            {adding === 'thread' && (
              <div className="mt-1.5 space-y-1.5">
                <input
                  value={newItem.name}
                  onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') onAddThread(); }}
                  placeholder="伏笔名"
                  className="w-full px-2 py-1 rounded text-[12px] outline-none"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                />
                <textarea
                  value={newItem.summary}
                  onChange={(e) => setNewItem({ ...newItem, summary: e.target.value })}
                  placeholder="埋在哪里、打算怎么回收" rows={2}
                  className="w-full px-2 py-1 rounded text-[12px] outline-none resize-none"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
                />
                <button onClick={onAddThread} disabled={!newItem.name.trim()}
                        className="w-full py-1 rounded text-[12px] disabled:opacity-40"
                        style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                  保存
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {!threads?.length && <Empty text="没有未回收的伏笔。" />}
            {threads?.map((t) => (
              <div key={t.id} className="px-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] truncate flex-1" style={{ color: 'var(--ink)' }}>{t.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>重要 {t.importance}</span>
                </div>
                {t.summary && <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>{t.summary.slice(0, 80)}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 正文（编辑器）---------- */}
      {tab === 'text' && !activeChapterId && (
        <Empty text="先在「章节」里选一章，或新建一章。" />
      )}

      {/* ---------- 文风 ---------- */}
      {tab === 'style' && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-2 text-[12px] font-medium" style={{ color: 'var(--ink)', borderBottom: '1px solid var(--line)' }}>
            文风
          </div>
          {!projectId ? (
            <Empty text="先选一个项目" />
          ) : !styleProfile || styleProfile.available === false ? (
            <>
              <Empty text={styleProfile?.reason || '还没有已保存的章节，风格基准只能来自你自己的历史正文'} />
              <div className="px-3 pb-3">
                <button onClick={onRefreshStyle}
                        className="w-full py-1.5 rounded text-[12px]"
                        style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>重新检查</button>
              </div>
            </>
          ) : (
            <>
              <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                基准取自你已保存的 <b style={{ color: 'var(--ink)' }}>{styleProfile.sampleCount}</b> 章
                （{styleProfile.totalChars} 字）
              </div>
              {styleResult && (
                <div className="px-3 pb-2">
                  <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>{styleResult.summary}</div>
                  {styleResult.deviations?.map((d) => (
                    <div key={d.metric} className="text-[11.5px] mb-1.5 p-1.5 rounded"
                         style={{ background: 'var(--paper-2)' }}>
                      <span style={{ color: 'var(--accent)' }}>
                        {d.label}{d.direction === 'high' ? '偏高' : '偏低'}
                      </span>
                      <span style={{ color: 'var(--ink-soft)' }}> 实测 {d.value}／基准 {d.baseline} —— {d.advice}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="px-3 pb-2">
                <button onClick={onCheckStyle} disabled={styleBusy}
                        className="w-full py-1.5 rounded text-[12px] disabled:opacity-40"
                        style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>
                  检查当前章节
                </button>
              </div>
              {styleDirectiveText && (
                <div className="px-3 pb-4">
                  <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>已注入给模型的文风要求</div>
                  <pre className="text-[10.5px] leading-relaxed whitespace-pre-wrap p-2 rounded"
                       style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
                    {styleDirectiveText}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {children}
    </aside>
  );
}

const TYPE_LABEL = { character: '角色', location: '地点', technique: '功法', faction: '势力', plot: '伏笔' };

function groupByType(list) {
  const acc = {};
  for (const s of list || []) (acc[s.type] = acc[s.type] || []).push(s);
  return Object.entries(acc);
}

function SectionTitle({ text }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold sticky top-0"
         style={{ color: 'var(--ink-soft)', background: 'var(--paper)' }}>
      {text}
    </div>
  );
}

function Empty({ text }) {
  return (
    <div className="px-4 py-8 text-[12px] text-center leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
      {text}
    </div>
  );
}
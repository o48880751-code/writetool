-- WriteTool 设定库schema（SQLite）
-- 设计原则：
--   1. 检索层行为必须与 run-verify.js 的内存实现一致（scoreEntry 排序 + top_k 截断）
--   2. 伏笔必须是一等公民（plot_threads 表），否则「检查伏笔是否矛盾」无法实现
--   3. 所有项目级数据都带 project_id，支撑隔离闸门
-- 依赖：Node 22.22 内置 node:sqlite（实验特性），零第三方包

PRAGMA journal_mode = WAL;      -- 读写并发：生成正文时仍在读设定
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;     -- 锁等待 5s，避免瞬时并发直接抛 SQLITE_BUSY

-- ============================================================
-- 项目与章节
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cover_path   TEXT,
  -- 全局配置 JSON：主题、背景图、字号、提示方式、默认模型地址等
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 章节用邻接表表达 卷/篇/章 三级：parent_chapter_id 自引用
-- depth 由应用层计算，不落库（避免与树结构不一致）
CREATE TABLE IF NOT EXISTS chapters (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  word_count        INTEGER NOT NULL DEFAULT 0,
  parent_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  -- 生成方式：agent=模型链路产出；rule=规则链降级产出；human=人工撰写
  origin            TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent','rule','human')),
  -- 每次覆盖前自动备份，落盘到同目录 .bak，保留最近 N 次由应用层控制
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, parent_chapter_id);
CREATE INDEX IF NOT EXISTS idx_chapters_updated ON chapters(project_id, updated_at DESC);

-- ============================================================
-- 设定库（World Bible）
-- 检索层读这张表；type 枚举与 query_world_bible 的 entity_type 严格一致
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- character / location / technique / faction / plot
  type        TEXT NOT NULL CHECK (type IN ('character','location','technique','faction','plot')),
  name        TEXT NOT NULL,
  -- 别名走独立子表：检索层需要「别名精确命中=70 分」这一档，存JSON 无法高效匹配
  note        TEXT NOT NULL DEFAULT '',
  -- 状态：active=当前有效；retired=已退场/废弃，检索默认过滤
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, type, name)
);
CREATE INDEX IF NOT EXISTS idx_settings_project ON settings(project_id, status);
CREATE INDEX IF NOT EXISTS idx_settings_name    ON settings(project_id, name);

CREATE TABLE IF NOT EXISTS setting_aliases (
  setting_id TEXT NOT NULL REFERENCES settings(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  PRIMARY KEY (setting_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_alias_alias ON setting_aliases(alias);

-- ============================================================
-- 伏笔（新增：前版规划缺失，导致「检查伏笔是否矛盾」无法实现）
-- 埋设章节与回收章节都是 chapters.id；未回收时 resolved_in 为 NULL
-- ============================================================

CREATE TABLE IF NOT EXISTS plot_threads (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- 一句话说明这个伏笔是什么，检索时作为 note 参与打分
  summary      TEXT NOT NULL DEFAULT '',
  -- planted_in 埋设章节；resolved_in 回收章节（NULL = 未回收）
  planted_in   TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  resolved_in  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','resolved','abandoned')),
  -- 重要度 1~5：5 = 主线级伏笔，检索与一致性检查时优先保证不被矛盾
  importance   INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON plot_threads(project_id, status);
CREATE INDEX IF NOT EXISTS idx_threads_open    ON plot_threads(project_id, importance DESC) WHERE status = 'open';

-- ============================================================
-- 写作技能与风格蒸馏
-- ============================================================

CREATE TABLE IF NOT EXISTS skills (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 全局内置
  name           TEXT NOT NULL,
  prompt_content TEXT NOT NULL DEFAULT '',
  -- built-in=内置；custom=用户自建
  type           TEXT NOT NULL DEFAULT 'custom' CHECK (type IN ('built-in','custom')),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id, enabled);

CREATE TABLE IF NOT EXISTS style_samples (
  id            TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  -- 用户上传的原文片段
  sample_text   TEXT NOT NULL,
  -- 提取的文风特征（句长分布/用词偏好等），JSON
  text_features TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_samples_skill ON style_samples(skill_id);

-- ============================================================
-- 对话历史
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '新对话',
  -- 这一条对话的思考强度档位：off / low / medium / high / on
  --
  -- ⚠ 为什么档位跟着**对话**走而不是全局一个值：
  --   羽毛菌的原话是「简单文字修改问答用低或者关闭，创意框架用高」——
  --   档位取决于**这一轮要干什么**，而一个对话通常就是一个任务。
  --   全局一个值的后果：他为创意框架调了「高」，接着去改错别字时忘了调回来，
  --   白烧 token 还慢；反过来更糟——用「关」去写框架，出来的东西没脑子。
  --
  -- 空串 = 没设过，跟随 config.thinkLevel（设置页的「默认思考强度」）。
  -- 用空串而不是 NULL：SQLite 的 ALTER TABLE ADD COLUMN 加 NOT NULL 时
  -- 必须给默认值，空串省掉一处 undefined/null 的分支。
  think_level TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- user / assistant / system / tool
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL DEFAULT '',
  -- 思考内容（2026-10-21 加）。
  -- ⚠ DeepSeek 的推理模型要求：上一轮 assistant 用过思考，下一轮必须把
  --   reasoning_content 原样带回去，否则整轮 400：
  --   "The `reasoning_content` in the thinking mode must be passed back to the API."
  --   所以它不能只留在内存里，必须随消息落库。
  -- 其它厂商留空（NULL）—— 无脑塞给不支持的模型会换来另一个 400。
  reasoning_content TEXT,
  -- 工具调用的可观测性字段：哪次调用、什么工具、成没成、耗时多少
  tool_name       TEXT,
  tool_ok         INTEGER CHECK (tool_ok IN (0,1)),
  -- 本次消息消耗的 token（Ollama 返回 prompt_eval_count / eval_count）
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  ms              INTEGER NOT NULL DEFAULT 0,
  trace_id        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- ============================================================
-- 角色状态表（记忆工程的核心：唯一真相源）
-- Agent 每写完一章必须回写，否则下一章的上下文会与状态漂移
--
-- 实测发现（2026-10-11，见 db/verify-e2e.js）：
--   已知实体组 20 个样本里，模型 20/20 只查了 location（地名「乱葬岗」），
--   写改组 10/10 只查 character。**模型按题目需要选实体类型，不是随机。**
--   推论：不能指望「模型自己会查角色」来维护状态表——状态回写必须由编排层
--   在 commit_chapter 之后强制触发（扫本章出场角色 → upsert 状态），而不是
--   依赖模型调用 query_world_bible 的行为。这条留到第 2 步实现。
-- ============================================================

CREATE TABLE IF NOT EXISTS entity_states (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 对应 settings.id（character/location/faction 等）
  setting_id  TEXT REFERENCES settings(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  -- 位置/ 归属 / 存活 / 修为等结构化状态，JSON
  state_json  TEXT NOT NULL DEFAULT '{}',
  -- 状态在第几章被最后更新，用于「状态漂移」检测
  updated_in_chapter TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, entity_name)
);
CREATE INDEX IF NOT EXISTS idx_state_project ON entity_states(project_id);

-- ============================================================
-- AI 连接（多连接）
-- ============================================================
--
-- 为什么独立成表而不是塞进 config.json：
--   用户会同时有「公司内网代理」「硅基流动」「本地 Ollama」
--   三条连接，按场景切换。config 是单值结构，塞不下。
--
-- protocol 是三种真实存在的协议，不是"换个地址"：
--   ollama     /api/chat，裸 JSON 行流
--   openai     /v1/chat/completions，SSE data: 行 + [DONE]
--   anthropic  /v1/messages，SSE event:+data: 双行，无 [DONE]
--
-- provider_key 指向内置量表里的某一项（deepseek/zhipu/...），
-- 自定义接入时为 'custom'。用它是为了让界面上能带出
-- 该服务商的思考参数形态与模型列表路径。

CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,
  -- 用户自己起的名字，如「公司代理」「硅基流动」
  name          TEXT NOT NULL,
  -- ollama | openai | anthropic
  protocol      TEXT NOT NULL CHECK (protocol IN ('ollama','openai','anthropic')),
  -- 内置量表项；自定义接入为 'custom'
  provider_key  TEXT NOT NULL DEFAULT 'custom',
  -- 到接口之前的根地址
  base          TEXT NOT NULL DEFAULT '',
  -- 选中的模型（可以空，界面上能从服务端拉列表）
  model         TEXT NOT NULL DEFAULT '',
  -- 该服务商是否需要密钥。Ollama 本地不需要，vLLM 看启动参数。
  need_key      INTEGER NOT NULL DEFAULT 1 CHECK (need_key IN (0,1)),
  -- 内置量表自动生成的那几条，用户可以改也可以删
  is_preset     INTEGER NOT NULL DEFAULT 0 CHECK (is_preset IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 密钥单独一张表，且**只有密文**。
--
-- ⚠ 为什么不在 connections 表里放 key_enc 列：
--   那样每次 listConnections 都要把密文带出来，
--   而这份数据会经过 IPC 到渲染进程。独立表的唯一用途是
--   按 id 取，取的时候也只给主进程。密文不过 IPC。
CREATE TABLE IF NOT EXISTS connection_secrets (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  -- safeStorage 加密后的 base64。**永远不是明文。**
  key_enc       TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============================================================
-- 服务级密钥（联网搜索等，不属于任何一条「连接」）
-- ============================================================
--
-- 2026-10-14 新增。
--
-- ## 为什么必须单独一张表
--
-- 联网搜索的 Key 原来存在 connection_secrets 里，connection_id 写死
-- `__web_search__`。而那张表的外键是
--   `REFERENCES connections(id) ON DELETE CASCADE`
-- —— `__web_search__` 压根不在 connections 表里，于是每次 INSERT
-- 都被数据库拒绝：
--
--   加密失败：FOREIGN KEY constraint failed
--
-- 而这个错误被 secret-store 包成了「加密失败」，界面收到 ok:false，
-- 用户看到的就是「填了 Key 但保存不成功」。
--
-- **联网搜索的 Key 不是「某条连接的密钥」** —— 它属于服务本身，
-- 与你连哪个模型无关。硬塞进 connections 是设计错误，
-- 现在改正：单开一张表，不带外键。
--
-- ⚠ 顺带说明：这个错误能潜伏这么久，是因为它**四处都看不出来**——
--   加密可用（safeStorage 是 true）、格式合法（base64 能解）、
--   单测全绿（没有一条用例真的往真库里写这条 id）。
--   最后是「静默安装后查真实数据库的 connection_secrets 表」才露出来的。
--
-- 一行一条：provider（'serper' / 'bing'）是主键。
CREATE TABLE IF NOT EXISTS service_secrets (
  provider    TEXT PRIMARY KEY,
  -- safeStorage 加密后的 base64。**永远不是明文。**
  key_enc     TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============================================================
-- Skill 配套文件（目录式 Skill）
-- ============================================================
--
-- 2026-10-12：原来 skills.prompt_content 是一整条纯文本。
-- 但真实的 Skill 是**一个目录**：
--     novel-writer/
--     ├── SKILL.md          正文（含 YAML frontmatter）
--     └── references/
--         └── templates.md  按需读取的模板
-- 装不下配套文件，就只能把 references 的内容全塞进正文——
-- 那会让每次对话都白带几百字用不上的模板。
--
-- 配套资源**不自动内联**（与 Claude 的 Skill 同一套思路）：
-- 只把文件名列表给模型，它需要时自己来读。
-- 所以这里存的是"一个文件的内容"，不是"文件在磁盘哪"。

CREATE TABLE IF NOT EXISTS skill_files (
  id         TEXT PRIMARY KEY,
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  -- 相对 Skill 根目录的路径，如 'references/templates.md'
  -- ⚠ 存的是**文件名**，不是磁盘路径。绝对路径不能进库：
  --   用户把项目文件夹挪个位置，全部配套文件就都失效了。
  path       TEXT NOT NULL,
  -- 'reference' | 'script' | 'asset'
  kind       TEXT NOT NULL DEFAULT 'reference'
             CHECK (kind IN ('reference','script','asset')),
  content    TEXT NOT NULL DEFAULT '',
  -- scripts/ 下的文件是否可执行。默认为 0——
  -- ⚠ 导入一个带可执行脚本的 Skill 等于让别人的代码在你的机器上跑，
  --   默认关闭且界面上要说明，让用户自己开。
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (skill_id, path)
);
CREATE INDEX IF NOT EXISTS idx_skillfiles_skill ON skill_files(skill_id);

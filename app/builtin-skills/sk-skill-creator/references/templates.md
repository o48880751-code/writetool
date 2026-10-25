# SKILL.md 模板参考

## 基础模板

```markdown
---
name: my-skill
description: 简要说明技能做什么、何时触发。覆盖触发关键词和场景。
---

# 技能名称

说明这个技能的目的和工作方式。

## 工作流程

### Step 1: [步骤名称]
[说明这一步做什么，解释为什么重要]

### Step 2: [步骤名称]
[说明这一步做什么]

## 输出格式
[明确的输出格式和模板]

## 重要规则
- [规则和原因]

## References
- **[references/xxx.md](references/xxx.md)** — 说明何时读取此文件
```

## 示例：带多个配套资源的技能

```markdown
---
name: code-reviewer
description: 代码审查助手。当用户要求审查代码、检查PR、review代码、代码质量检查时使用。
---

# 代码审查助手

审查代码变更，检查代码质量、安全问题和最佳实践。

## 工作流程

### Step 1: 了解审查范围
确定要审查的文件和变更范围。

### Step 2: 加载审查标准
读取 `references/审查规则.md` 了解详细的审查标准和检查项。

### Step 3: 执行审查
逐文件检查，对照审查标准标记问题。

### Step 4: 生成报告
使用 `assets/review-report.md` 模板格式，生成审查报告。

## References
- **[references/审查规则.md](references/审查规则.md)** — 代码审查标准，开始审查前必须读取
- **[assets/review-report.md](assets/review-report.md)** — 审查报告输出模板
```

## 关键原则

1. **渐进式加载**：元数据 → SKILL.md 正文 → 配套资源，不让上下文一次膨胀
2. **配套资源不自动内联**：每个 references/ 文件的使用时机必须在 SKILL.md 中明确写出
3. **末尾加 References 索引**：让 AI 一眼看到有哪些配套文件可用
4. **解释为什么**：告诉 AI 原因，比命令式 MUST/ALWAYS 更有效
5. **名称不用中文**：避免路径编码问题，用英文小写 + 连字符

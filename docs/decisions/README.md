# 架构决策记录

本目录记录会长期影响技术栈、服务边界、敏感数据处理、外部契约或部署方式的决定。

## 状态

- `proposed`：已提出，尚未确认，不得作为生产实现依据。
- `accepted`：已确认，可以进入实现。
- `superseded`：已被后续 ADR 替代。
- `deprecated`：仍可能存在兼容实现，但不再用于新增功能。

## 命名

```text
ADR-001-简短中文标题.md
```

## 模板

```markdown
# ADR-NNN：标题

- 状态：proposed
- 日期：YYYY-MM-DD
- 决策人：

## 背景

需要解决的问题、约束和不能忽略的事实。

## 决策

明确选择什么，以及适用边界。

## 备选方案

至少列出一个可行替代方案及未选择原因。

## 后果

说明收益、成本、风险、迁移与回滚方式。

## 重新评估触发条件

哪些变化发生时必须重新检查本决定。

## 相关规范

列出受影响的权威文档。
```

首份 ADR 应裁决 MVP 的应用框架、API 组织、数据库、ORM、任务执行方式和本地/生产部署基线。

## 索引

- [ADR-001：MVP 应用与开发基线](ADR-001-mvp-application-baseline.md)（accepted）
- [ADR-002：PostgreSQL 与容器开发基线](ADR-002-postgresql-and-container-baseline.md)（accepted）
- [ADR-003：身份、部署区域与数据存储基线](ADR-003-identity-region-and-data-storage.md)（accepted）
- [ADR-004：自有账号口令登录](ADR-004-self-managed-login.md)（accepted）
- [ADR-005：授权网页采集与本地可复算匹配](ADR-005-authorized-web-collection-and-local-matching.md)（accepted）
- [ADR-006：落地页意向反馈实时通知（飞书）](ADR-006-landing-intent-notifier.md)（proposed）

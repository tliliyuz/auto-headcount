# 系统架构

## 1. 设计原则

- 单体优先：MVP 使用模块化单体，降低部署和运维成本。
- 供应商隔离：MCP、采集、LLM、消息网关均通过端口/适配器接入。
- 人工把关：匹配与触达之间必须存在人工审核状态。
- 原始与规范化分离：原始响应便于追溯，规范化模型支撑业务。
- 默认保护数据：最小化采集、页面脱敏、日志脱敏和按角色授权。

## 2. 逻辑架构

```text
┌──────────────── 外部系统 ────────────────┐
│ 招聘网站/MCP │ 浏览器插件 │ LLM │ SMS/Email │
└───────────────┬──────────────────────────┘
                │ adapters
┌───────────────▼──────────────────────────┐
│              Web/API 应用                │
│                                          │
│ 数据同步 │ 摘要 │ 匹配 │ 审核 │ 活动/文案 │
│ 落地页   │ 意向 │ 推荐 │ 漏斗 │ 权限/审计 │
└───────────────┬──────────────────────────┘
                │
┌───────────────▼──────────────────────────┐
│ PostgreSQL：业务数据、任务、事件、审计   │
└──────────────────────────────────────────┘
```

## 3. 模块边界

| 模块 | 责任 |
|---|---|
| `identity` | 登录、角色、组织和权限 |
| `sources` | MCP/文件/浏览器采集适配与同步游标 |
| `jobs` | 职位标准化、分类、沉睡规则和状态 |
| `candidates` | 候选人标准化、去重、敏感字段保护 |
| `summaries` | 150 字摘要生成、版本和审核 |
| `matching` | 过滤、评分、解释、规则版本和审核 |
| `campaigns` | 受众、文案、审批、频控和发送任务 |
| `landing` | 脱敏页面、访问令牌和意向提交 |
| `tracking` | 行为事件、聚合指标和漏斗看板 |
| `recommendations` | 人工跟进和外部推荐回写 |
| `audit` | 外部调用、数据访问和管理操作审计 |

## 4. 外部能力接口

业务层只依赖内部接口，例如：

```ts
interface RecruitmentSource {
  listUnderServedJobs(input: UnderServedJobQuery): Promise<JobPage>;
  findCandidates(input: CandidateSearchQuery): Promise<CandidatePage>;
  matchCandidates?(input: MatchRequest): Promise<ExternalMatchResult>;
  recommendCandidate?(input: RecommendRequest): Promise<RecommendResult>;
}
```

MCP 只是该接口的一种实现。浏览器插件导入、CSV 导入或未来其他供应商可以实现相同接口。

## 5. 异步任务与可靠性

MVP 使用数据库任务表处理同步、摘要、匹配和发送：

- 状态：`pending/running/succeeded/failed/dead`。
- 同一业务操作使用唯一幂等键。
- 网络类错误采用指数退避，业务校验错误不自动重试。
- 失败超过阈值进入人工处理队列。
- 外部请求和响应只保存必要字段，敏感内容需加密或脱敏。

当任务量或并发超过单体承载能力后，再拆分 Worker 并引入专用消息队列。

## 6. 部署形态

建议分为开发、测试、生产三个环境。每个环境使用独立数据库、MCP 凭证和消息渠道配置。部署平台需满足：

- Node.js 容器或 Serverless 运行时。
- PostgreSQL 或兼容数据库。
- HTTPS、自定义域名和密钥管理。
- 定时任务、后台 Worker 和可检索日志。
- 中国大陆短信、域名和数据存储相关要求由业务方确认。


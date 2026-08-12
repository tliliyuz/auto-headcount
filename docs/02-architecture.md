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

开发、测试、生产分为三个环境。PostgreSQL 与容器基线以
[`ADR-002`](decisions/ADR-002-postgresql-and-container-baseline.md) 为准：

- 开发环境通过 Docker Compose 运行 Web、PostgreSQL 与迁移服务。
- 测试和生产运行同一 OCI 应用镜像，并使用相同 PostgreSQL 大版本与迁移。
- 测试和生产各自使用独立网络、数据库、MCP 凭证、Secret 和消息渠道。
- 生产优先使用托管 PostgreSQL，Docker Compose 不作为生产编排方案。

身份、区域和敏感数据存储基线见
[`ADR-003`](decisions/ADR-003-identity-region-and-data-storage.md)。真实数据上线仍受数据授权与最终保留期限门禁约束。

部署平台需满足：

- Node.js 容器或 Serverless 运行时。
- PostgreSQL 17 数据库。
- HTTPS、自定义域名和密钥管理。
- 定时任务、后台 Worker 和可检索日志。
- 中国大陆短信、域名和数据存储相关要求由业务方确认。

## 7. 身份与授权边界

- 管理端认证通过 `IdentityProvider` 端口接入自有账号口令体系（`ADR-004`）；业务模块不依赖供应商身份字段。
- 认证只建立主体身份，授权由本地用户状态、角色和权限策略决定。
- 页面、Route Handler、后台任务和数据导出复用同一权限判定服务，禁止只在前端隐藏按钮。
- 候选人落地页不属于管理端身份域，只接受令牌哈希校验后生成的最小白名单投影。
- 身份与权限方案以 `ADR-004`（登录）与 `ADR-003`（权限/角色）为准。

## 8. 数据存储分层

```text
MCP 响应
  → 加密原始快照（追加写、短期保留）
  → 映射/校验记录
  → PostgreSQL 规范化业务表
  → 白名单公开投影

管理与系统操作
  → 追加写审计日志（不含敏感正文）
```

- 原始快照用于追溯和受控重放，不是页面或业务规则的查询模型。
- 规范化表保存来源、外部 ID、原始记录和映射版本的追溯关系。
- 联系方式与原始载荷使用应用层信封加密；密钥由环境 Secret/密钥服务管理。
- 审计日志与普通应用日志分离，应用日志不得承担审计证据职责。

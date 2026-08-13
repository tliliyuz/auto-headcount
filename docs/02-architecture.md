# 系统架构

## 1. 设计原则

- 单体优先：MVP 使用模块化单体，降低部署和运维成本。
- 供应商隔离：MCP、采集、LLM、消息网关均通过端口/适配器接入。
- 人工把关：匹配与触达之间必须存在人工审核状态。
- 原始与规范化分离：原始响应便于追溯，规范化模型支撑业务。
- 默认保护数据：最小化采集、页面脱敏、日志脱敏和按角色授权。

## 2. 逻辑架构

```text
┌──────────────────── 外部系统 ────────────────────┐
│ 招聘网站/MCP │ CSDN-Agent 浏览器执行端 │ LLM │ SMS/Email │
└──────────────────────┬──────────────────────────┘
                       │ adapters / restricted ingestion
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
  collectJobDetails?(input: JobCollectionQuery): Promise<CollectionReceipt>;
  findCandidates(input: CandidateSearchQuery): Promise<CandidatePage>;
  matchCandidates?(input: MatchRequest): Promise<ExternalMatchResult>;
  recommendCandidate?(input: RecommendRequest): Promise<RecommendResult>;
}
```

MCP 只是该接口的一种实现。根据 `ADR-005`，CSDN-Agent 浏览器插件是授权 Web 数据源的执行端，CSV 导入或未来其他供应商也可以实现相同接口。

### 4.1 CSDN-Agent 浏览器采集边界（specified）

```text
auto-headcount async_tasks
  → CSDN-Agent Relay（userId + deviceId + browserSessionId）
  → 员工 Chrome/Edge（既有供应方登录态）
  → 版本化只读提取契约
  ├─ 最小化结构化结果 → Relay 回执
  └─ 完整简历/联系方式 → 短期 ingestion ticket → auto-headcount HTTPS 采集入口
  → 加密原始区 → 规范化 → 脱敏评分投影
```

- CSDN-Agent 只拥有浏览器执行与设备路由，不拥有招聘业务状态；auto-headcount 是任务、数据、评分和审核的唯一业务系统。
- 生产采集不得下发任意 JavaScript、选择器或 URL，只能选择预审核的 `contract_id`；通用 `csdn_*` 工具只用于探索和契约开发。
- Cookie、密码、验证码、原始 Authorization 和可复用浏览器会话不得离开浏览器，也不得写入 PostgreSQL、Agent 上下文或任务载荷。
- 完整简历与联系方式不经过 Agent/MCP 返回值；浏览器使用短期单次 ticket 直传采集入口，Relay 只返回计数、哈希、游标和机器错误码。
- 浏览器离线或登录失效属于可恢复等待状态，不静默切换到其他用户、设备或平台账号。
- 本节是目标契约；受限提取工具、直传入口和浏览器数据源适配器尚未实现，不得描述为已接入。

## 5. 异步任务与可靠性

MVP 使用数据库任务表（`async_tasks`，已落库迁移 `0004`）处理同步，后续摘要/匹配/发送复用同表：

- 状态：`pending/running/succeeded/failed/dead`。
- 同一业务操作使用唯一幂等键（`idempotency_key`，如 `under-served-sync:<provider>:<周期槽>`），重复入队 `ON CONFLICT DO NOTHING`。
- 网络类错误（MCP 连接/限流/超时，`McpDiscoveryError.retryable`）指数退避重试（`next_attempt_at` 门控），业务校验错误不自动重试。
- 失败超过阈值进入 `dead`，后续转人工处理队列。
- `payload` 为白名单 jsonb，不存敏感字段；外部请求和响应只保存必要字段，敏感内容需加密或脱敏。
- Web 采集任务后续复用同表，规划 kind 包括 `browser_job_collect`、`browser_candidate_discovery`、`browser_candidate_collect`、`browser_ingestion_normalize` 和 `browser_candidate_sanitize`；载荷只含来源/外部 ID、用户/设备、契约版本、游标和批量，不含浏览器 Session、页面正文或联系方式。
- **手动触发去重（2026-08-13）**：同一 kind 至多一个活跃（`pending/running`）任务。手动触发经 `enqueueTaskIfIdle` 原子入队（`INSERT … WHERE NOT EXISTS (活跃)`），活跃被拦截时返回既有任务 id（前端跟踪其进度，`deduplicated:true`）。此前多次点击会堆积多个并发同步任务同时打 MCP 触发限流/假死。
- **任务看门狗（2026-08-13）**：每个调度 tick 先回收 `running` 超过 30 分钟的任务（`failed + TASK_STALE_TIMEOUT`），与同步运行看门狗（`failStaleRunningSyncRuns`）对称。进程崩溃/假死导致任务永久卡 `running` 时，若无回收，手动同步去重会被卡死任务永久锁死。
- **同步串行化（2026-08-13，fix3）**：`claimDueTasks` 按 kind 每类至多认领 1 条（`not exists running` + `not exists earlier` 行比较，取 `(scheduled_at,id)` 最早），同一 kind 同时只跑一个同步——避免多个同 kind 任务并发打 MCP（此前多次点击 + 周期/手动叠加 = 多任务并发）。EXISTS 子查询可被 `FOR UPDATE SKIP LOCKED` 加锁且跨进程原子（窗口函数/DISTINCT 不可加锁，PG 0A000）。

触发方式：由运行环境按 cron（默认每 15 分钟）触发 tick——先按周期幂等入队同步任务（默认 6 小时一个槽位），再认领到期任务执行（`FOR UPDATE SKIP LOCKED` 防并发重复）并落 `sync.run` 系统审计。自托管 Node 容器由 docker compose `scheduler` 服务跑 `node scripts/run-scheduled-tick.mjs --loop`（每 15 分钟，见 §6）触发；服务器级定时器（systemd timer / PM2 cron）为可选替代。Cloudflare Worker 部署则用 `scheduled` 处理器（可选路径，见 §6）。运维直连路径（`npm run sync:under-served`）保持 CLI 直接执行（携带真实 MCP 凭证）。

当任务量或并发超过单体承载能力后，再拆分 Worker 并引入专用消息队列。

## 6. 部署形态

开发、测试、生产分为三个环境。PostgreSQL 与容器基线以
[`ADR-002`](decisions/ADR-002-postgresql-and-container-baseline.md) 为准：

- 开发环境通过 Docker Compose 运行 Web、PostgreSQL 与迁移服务。
- 测试和生产运行同一 OCI 应用镜像，并使用相同 PostgreSQL 大版本与迁移。
- 测试和生产各自使用独立网络、数据库、MCP 凭证、Secret 和消息渠道。
- MVP 生产用 docker compose 编排（`docker-compose.prod.yml`：`web` + `db` + `scheduler`，用户 2026-08-12 决定）；托管 PostgreSQL 为扩容选项（`DATABASE_URL` 指向外部实例）。

身份、区域和敏感数据存储基线见
[`ADR-003`](decisions/ADR-003-identity-region-and-data-storage.md)。真实数据上线仍受数据授权与最终保留期限门禁约束。

**工程投影（2026-08-12 基线修正：生产平台为自托管 Node 容器，Cloudflare Worker 降为可选路径）**：

- 应用以 OCI 容器镜像部署（`apps/web/Dockerfile` 生产 target，`node:22` + `npm run start`），运行于自有云服务器；`DATABASE_URL` 指向 compose 内 PostgreSQL（或托管实例）。部署入口：`docker compose -f docker-compose.prod.yml up -d --build`（已落地，见 [README 部署章节](../README.md)）。
- dev/prod 配置分离：开发经 Docker Compose 运行，Worker 运行时由 Miniflare 本地模拟并连接 Docker Postgres；生产容器**不烘焙开发数据库凭证**，Secret（MCP 凭证、`APP_ENCRYPTION_KEY` 等）经容器环境变量注入，不进镜像与构建产物。
- 生产环境必须显式注入 `APP_ENV=production`（缺失时生产管理员 TOTP 强制与 Secure Cookie 会静默失效，`getRuntimeEnv` 会告警）；`.env.production` 模板强制该值，seed/init-admin 门禁兜底。
- 定时任务由 docker compose `scheduler` 服务跑 `node scripts/run-scheduled-tick.mjs --loop`（每 15 分钟处理 §5 任务表调度器）触发；服务器级定时器（systemd timer / PM2 cron）为可选替代。日志走服务器进程日志 + `audit_logs` 审计。
- 可选路径：Cloudflare Worker（`vinext build` → `wrangler deploy`，需 Hyperdrive 与 `scheduled` cron）作为备选 Serverless 方案，**不构成生产平台承诺**（ADR-001）。

部署平台需满足：

- Node.js 容器（自托管云服务器，`apps/web/Dockerfile` 生产 target）。
- PostgreSQL 17 数据库（服务器本地或托管 PostgreSQL）。
- HTTPS、自定义域名和密钥管理。
- 定时任务、后台任务和可检索日志。
- 中国大陆短信、域名和数据存储相关要求由业务方确认。

## 7. 身份与授权边界

- 管理端认证通过 `IdentityProvider` 端口接入自有账号口令体系（`ADR-004`）；业务模块不依赖供应商身份字段。
- 认证只建立主体身份，授权由本地用户状态、角色和权限策略决定。
- 页面、Route Handler、后台任务和数据导出复用同一权限判定服务，禁止只在前端隐藏按钮。
- 候选人落地页不属于管理端身份域，只接受令牌哈希校验后生成的最小白名单投影。
- 身份与权限方案以 `ADR-004`（登录）与 `ADR-003`（权限/角色）为准。
- 内部 API 契约以 [`09-api-contract.md`](09-api-contract.md) 为准；认证端点契约已迁入该文档。

## 8. 数据存储分层

```text
MCP 响应 / 授权 Web 提取
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
- Web 来源的完整简历与联系方式经独立 ingestion 边界进入；匹配模块只读取脱敏评分投影，不能查询联系方式保险箱。
- 审计日志与普通应用日志分离，应用日志不得承担审计证据职责。

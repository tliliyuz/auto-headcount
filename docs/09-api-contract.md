# 内部 API 契约

本文档是系统内部 API（管理后台 Web/API 应用对外端点）的唯一权威契约。产品行为以 [`01-mvp-requirements.md`](01-mvp-requirements.md)、可执行验收以 [`07-acceptance-criteria.md`](07-acceptance-criteria.md)、模块边界以 [`02-architecture.md`](02-architecture.md) 为准；外部 MCP 接入见 [`04-mcp-integration.md`](04-mcp-integration.md)。

## 1. 通用约定

- 基路径：`/api`；响应统一为 JSON。
- 鉴权：管理端端点要求有效会话（`HttpOnly`/`Secure`/`SameSite=Lax` 会话 Cookie）；未登录返回 `401`。
- 授权：由服务端按角色判定（`operations`/`recruiter`/`admin`），前端隐藏入口不作为授权措施。
- 错误响应：统一 `{ "code": "<机器码>", "message": "<人读文案>" }`，HTTP 状态码表示类别（400/401/403/404/409/429/500）。
- 分页：请求 `page`（从 1 起）与 `page_size`；响应 `{ total, page, page_size, total_pages, list }`，与 MCP 响应包络保持一致。
- 幂等：写操作使用服务端幂等键，重复提交不产生重复数据。
- 审计：登录、登出、数据导出、角色变更、触达、推荐、删除等记录审计事件，且不含口令、口令哈希、手机号、邮箱、简历正文或令牌；`audit_logs` 为追加写（数据库层触发器强制，普通应用角色不能更新，删除仅保留任务在事务内带 `app.audit_retention=on` 时放行），并记录尽力捕获的客户端 IP（`ip_address`，可为空）。
- 脱敏：对外响应经白名单投影，禁止回显口令/口令哈希、联系方式、完整简历、Secret；候选人落地页另有独立白名单 DTO，见产品规则。

## 2. 已确认端点

### 2.1 认证（M1 · `identity` 模块）

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `/api/auth/login` | POST | 匿名 | `{ username, password, totpCode? }` | `200 { user, roles, passwordChangeRequired }` + `Set-Cookie`；失败统一 `401`，锁定 `429` |
| `/api/auth/logout` | POST | 会话 | 会话 Cookie | `204`，清除会话 Cookie |
| `/api/auth/me` | GET | 会话 | 会话 Cookie | `200 { user, roles, passwordChangeRequired }` / `401` |
| `/api/auth/password` | POST | 会话 | `{ currentPassword, newPassword }` | `200 { ok: true }`；当前口令错误 `401`，策略不合 `400` |

- 口令校验使用 bcrypt（成本 12）；生产管理员须绑定并校验 TOTP（`totp_required` 未绑定时拒绝登录）。
- 登录失败返回统一文案，不区分账号是否存在；连续失败（5 次）后临时锁定（15 分钟）返回 `429`。
- 首次登录或口令重置后 `passwordChangeRequired=true`，改密成功清除且旧口令立即失效。
- 会话标识只存服务端，数据库只保存会话令牌哈希；`HttpOnly`/`Secure`（生产）/`SameSite=Lax` Cookie，空闲 30 分钟与最长 12 小时双过期。
- 登录、登出、锁定、改密均写审计；审计不包含口令、口令哈希、手机号、邮箱、令牌等敏感字段。
- 三个 POST 写路由（`login`/`logout`/`password`）执行同源校验（`Origin` 与请求自身 origin 一致）：跨源返回 `403 { code:"forbidden" }`，缺失 `Origin`（同源导航/非浏览器客户端）放行；主防线为 `SameSite=Lax` Cookie，本检查覆盖同站子域/代理残余边界（CSRF 防护，ADR-003/004）。

### 2.2 业务只读（M1 · jobs / sources 模块）

统一要求：会话 + RBAC `operations|admin`（`recruiter` 拒绝 → `403 { code:"forbidden", message:"没有权限访问该资源" }`）；会话 `passwordChangeRequired=true`（首登/重置后未改密）→ `403 { code:"password_change_required" }`，改密前不能使用业务功能；每次访问写数据审计（`jobs.list` / `sources.list` / `sync-runs.list`，成功元数据仅计数与分页，角色/改密门禁拒绝记 `result:"denied"`）；分页包络 `{ total, page, page_size, total_pages, list }`；非法分页参数 → `400 { code:"invalid_request" }`。

| 接口 | 方法 | 鉴权 | 请求 Query | 响应 |
|---|---|---|---|---|
| `/api/jobs/under-served` | GET | 会话 + `operations\|admin` | `category?`（精确）、`q?`（title/city 子串，大小写不敏感）、`page`、`page_size` | `200` 分页包络，`list[]` 为职位投影 |
| `/api/jobs/:id` | GET | 会话 + `operations\|admin` | 路径参数 `id`（UUID） | `200` 职位详情投影（含 `jobDescription`，可空）；非 UUID `400 invalid_request`；查无 `404 not_found` |
| `/api/sources` | GET | 会话 + `operations\|admin` | `page`、`page_size` | `200` 分页包络，`list[]` 含连接信息与最新同步摘要 |
| `/api/sync-runs` | GET | 会话 + `operations\|admin` | `status?`（`pending`/`running`/`succeeded`/`failed`）、`page`、`page_size` | `200` 分页包络，`list[]` 含来源展示名 |

**职位投影（`/api/jobs/under-served` `list[]`）**：`id`、`externalId`、`mappingVersion`、`title`、`companyName`、`category`、`city`、`detailedLocation`、`salaryMin`/`salaryMax`、`status`、`ageDays`（=`days_without_recommendation`）、`recommendationCount`（空视为 0）、`sourceConnectionId`、`rawRecordId`、`publishedAt`、`sourceUpdatedAt`、`createdAt`、`updatedAt`。

**职位详情投影（`/api/jobs/:id`）**：职位投影全部字段 + `jobDescription`（完整 JD，可空）。含 `companyName`/`detailedLocation`（内部运营边界）；**不含** `portal_url`（docs/04 §6 不返回 `portal_*`）与 `raw_records.payload_*`。审计动作 `jobs.detail`，元数据白名单仅 `found`，**绝不包含 JD 正文**。

**数据源投影（`/api/sources` `list[]`）**：`id`、`provider`、`environment`、`status`、`displayName`、`createdAt`/`updatedAt`、`lastRunId`、`lastRunSyncType`、`lastRunStatus`、`lastRunStartedAt`、`lastRunFinishedAt`、`lastRunErrorCode`、`lastRunStats`。

**同步批次投影（`/api/sync-runs` `list[]`）**：`id`、`sourceConnectionId`、`sourceDisplayName`、`sourceProvider`、`syncType`、`status`、`stats`（仅计数）、`errorCode`、`startedAt`、`finishedAt`、`createdAt`。

**规则与敏感边界**：
- 沉睡规则（发布 7/30 天含边界、`active`、零有效推荐）在仓储 SQL 权威执行，`/api/jobs/under-served` 只返回合格职位。
- 内部 API 允许返回 `company_name`/`detailed_location`（内部运营边界；候选人落地页白名单 DTO 另行剥离）。**永不**返回 `raw_records.payload_*`（原始载荷密文）与 `sync_runs.cursor`（供应方游标令牌）。
- `sync_runs.error_code` 为机器可读码（如 `RATE_LIMITED`），不映射为散文文案。
- 未登录 → `401 { code:"unauthorized" }`；角色无权 → `403 { code:"forbidden" }`。

### 2.3 审计查询（M1 · `audit_logs`）

统一要求：会话 + RBAC `operations|admin`（`recruiter` 拒绝 → `403`）；每次访问写数据审计（`audit-logs.list`，成功元数据仅计数与分页）；分页包络 `{ total, page, page_size, total_pages, list }`；非法分页或过滤参数 → `400 { code:"invalid_request" }`。

| 接口 | 方法 | 鉴权 | 请求 Query | 响应 |
|---|---|---|---|---|
| `/api/audit-logs` | GET | 会话 + `operations\|admin` | `action?`（精确）、`actor_type?`（`user`/`system`）、`result?`（`success`/`failure`/`denied`）、`q?`（模糊：匹配 `action`/`actor_id`/`request_id`/`resource_id` 子串）、`page`、`page_size` | `200` 分页包络，`list[]` 为审计投影 |

**审计投影（`/api/audit-logs` `list[]`）**：`id`、`occurredAt`、`actorType`、`actorId`（对 `users` 为无外键语义引用）、`action`、`resourceType`、`resourceId`、`result`、`requestId`、`metadata`、`ipAddress`。

**规则与敏感边界**：
- 元数据在写入时已按动作白名单收敛（`lib/server/audit.mjs` 的 `pickMetadata`），读回不含 Secret、Cookie、令牌、手机号、邮箱、简历正文或完整外部响应。
- `audit_logs` 追加写由数据库触发器强制：`UPDATE` 无条件拒绝；`DELETE` 仅保留任务在事务内设 `app.audit_retention=on` 时放行。未登录 → `401`；角色无权 → `403`。

### 2.4 业务写：同步触发（M1 · `async_tasks`）

统一要求：会话 + RBAC `operations|admin`；写路由执行 CSRF 同源校验（跨源 `403 { code:"forbidden" }`）；每次触发写审计（`sync.trigger`，成功元数据仅 `taskId`/`deduplicated`）。**不执行长请求内同步**——入队 `async_tasks` 任务后立即返回，由调度 tick（dev `scheduler` / 生产 `scheduler` 服务）异步认领执行。

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `/api/sync/under-served` | POST | 会话 + `operations\|admin` | 空 body | `202 { accepted: true, taskId }`；`202 { accepted: false, taskId, deduplicated: true }`（已有活跃任务被拦截）；未登录 `401`；角色无权 `403`；跨源 `403` |

- 每次点击入队一个幂等键唯一（`under-served-sync:manual:<uuid>`）的 `under_served_sync` 任务，`scheduled_at=now`，调度 tick 下轮认领执行；任务结果落 `sync_runs` 与 `async_tasks` 状态，可在数据源页 / 审计日志页观察。
- **手动触发去重**：`enqueueTaskIfIdle` 原子保证同 kind 至多一个活跃（`pending/running`）任务，重复点击/并发触发不重复入队，返回既有活跃任务 id（`deduplicated:true`）供前端跟踪进度；活跃任务由调度 tick 的任务看门狗（见 02-architecture §5）在超时后回收，避免卡死任务永久锁死同步。

### 2.5 业务写/读：匹配（M3 · 数据集成与匹配）

`ADR-005` 两阶段权威路径由后台自动编排：消费不可变职位/候选人投影与硬过滤结果，调用脱敏详情评分适配器，再由本地固定权重汇总；供应方 `match_candidates` 仅存 `matches.external_*` 外部对照。正常路径不提供“勾选职位并创建匹配任务”的写接口；旧 `/api/match-tasks` 对已登录授权调用固定返回 `410 { code:"manual_match_disabled", message:"正常匹配已改为系统自动编排" }`，且不得入队。统一要求：会话 + RBAC `operations|admin`；写路由 CSRF 同源；每次访问写审计（`matches.list` / `matches.detail` / `matches.review` / `match-exceptions.list`，元数据白名单仅计数/决策/状态）。

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `/api/matches` | GET | 会话 + `operations\|admin` | `job_id?`/`band?`/`status?`/`page`/`page_size` | `200` 分页包络，`list[]` 匹配投影 |
| `/api/matches/:id` | GET | 会话 + `operations\|admin` | 路径 `id`（UUID） | `200` 匹配详情（含维度分）；非 UUID `400`；查无 `404` |
| `/api/matches/:id/review` | POST | 会话 + `operations\|admin` | `{ decision: "approve"\|"reject" }` | `200 { id, status }`；已审核 `409` |
| `/api/match-exceptions` | GET | 会话 + `operations\|admin` | `type?`（`all`/`filter`/`scoring`）、`page`/`page_size` | `200` 分页包络；只返回白名单 `errorCode`、状态和 `retryable`，不返回供应商错误正文 |

**当前匹配投影（`list[]`/详情）**：`id`、`jobId`、`jobTitle`、`jobExternalId`、`candidateId`、`candidateName`（打码）、`candidateSummary`、`score`、`band`、`status`、`ruleVersion`、`inputHash`、`scoreStatus`、`externalScore`/`externalTier`/`externalScoreStatus`（外部对照，可空）、`evidence`/`missing`/`risk`、`createdAt`/`updatedAt`；详情含 `dimensions[]`。

**两阶段响应扩展**：列表/详情增加 `jobProjectionId`、`candidateProjectionId`、`filterResult`（`passed/reasonCodes`）、`llmScoreRunId`、`aggregationRuleVersion`、`modelId`、`modelRevision`、`promptVersion`、`schemaVersion`、`outputHash`；`dimensions[]` 增加 `assessable` 和 `confidence`。失败运行只返回白名单 `errorCode`，不返回供应商错误正文。**永不返回** `portal_url`、联系方式、未脱敏简历、LLM 原始请求/响应或 `raw_records.payload_*`。内部结构化契约见 [匹配契约](10-matching-contracts.md)。

**自动编排内部状态模型**：`filter_rejected` 为硬过滤终态且不调用 LLM；通过后依次为 `scoring_pending → scoring_running → pending_review`，评分失败转 `scoring_failed`，人工审核后转 `approved` 或 `rejected`。相同版本组合由请求哈希和运行版本幂等；周期任务只消费缺少成功运行的组合。该状态模型是 API 投影，不要求所有状态写入同一数据库列。

## 3. 规划端点（随里程碑补充）

以下按页面模块列出规划端点，**路径为草案**，契约须在对应里程碑实现前完成并回写本文档：

| 模块（里程碑） | 规划端点（草案） | 状态 |
|---|---|---|
| 职位巡检（M1） | `GET /api/jobs/under-served`、`GET /api/jobs/:id` | 已设计（见 §2.2；`/api/jobs` 全列表另行设计） |
| 数据源/同步（M1） | `GET /api/sources`、`GET /api/sync-runs` | 已设计（见 §2.2） |
| 审计（M1） | `GET /api/audit-logs` | 已设计（见 §2.3） |
| 匹配（M3） | `GET /api/matches`、`GET /api/matches/:id`、`POST /api/matches/:id/review`、`GET /api/match-exceptions` | 已设计（见 §2.5；正常匹配由后台自动编排） |
| 浏览器采集控制（M2） | `POST /api/browser-collections` | 批量发现任务为运营主入口；兼容单职位任务仅供诊断/受控重跑 |
| 浏览器候选人采集（M2） | `POST /api/candidate-collections`、`GET /api/candidate-batches` | 人才池「互联网技术其他」候选人画像批次采集（见 §3.2） |
| 浏览器受控直传（M2） | `POST /api/browser-ingestion/:ticket` | `ADR-005` 已指定边界，路径/Schema 待 RED 前定稿 |
| 触达活动（M4） | `GET/POST /api/campaigns`、`POST /api/campaigns/:id/approve` | 待设计 |
| 跟进任务（M5） | `GET/POST /api/followups` | 待设计 |
| 漏斗（M5） | `GET /api/funnel` | 待设计 |

> 候选人落地页端点属于独立身份域，只接受令牌哈希校验，契约在 M4 另行定义，不并入本管理端契约。

### 3.1 浏览器职位采集任务（实现切片）

- 职位详情 Relay 适配器协议已经由 [`liebide-job-detail.request.v1`](contracts/liebide-job-detail.request.v1.schema.json) 和 [`liebide-job-detail.receipt.v1`](contracts/liebide-job-detail.receipt.v1.schema.json) 固定，并按 [`浏览器采集 Runbook`](runbooks/browser-collection.md) 做单职位只读验证。该协议不是管理端 HTTP API，也不代表下述任务、ingestion 或入库端点已经实现。
- `POST /api/browser-collections` 由管理端会话 + `operations|admin` 创建单职位 `browser_job_collect` 任务，请求体严格使用 [`browser-job-collect.task.v1`](contracts/browser-job-collect.task.v1.schema.json)。成功返回 `202 { accepted:true, taskId }`；同一来源、设备、契约和职位的活跃任务重复提交返回 `202 { accepted:false, taskId, deduplicated:true }`。写路由执行同源 CSRF 和 `browser.collection.trigger` 审计，审计只保存 task ID、是否去重、契约 ID，不保存用户/设备/职位完整值。
- 任务载荷不保存 `browserSessionId`。执行时 Relay 只可在 `userId + deviceId` 所有权范围内选择当前活跃页面，并以目标 external ID 做 `READY` 预检；无唯一可用页面或实体不匹配时失败关闭，不切换其他设备。
- 批量 HTTP 请求只接受 `sourceConnectionId`、固定 `contractId=liebide-filtered-job-list-v2`、`batchSize`、`maxPages` 和可选数字断点；服务端生成 `batchId`，并从 `BROWSER_RELAY_USER_ID`、`BROWSER_RELAY_DEVICE_ID` 注入 [`browser-job-batch-discover.task.v2`](contracts/browser-job-batch-discover.task.v2.schema.json) 所需路由。缺少服务端路由配置返回 `503 browser_route_config_required` 且不入队；请求体中的 `userId/deviceId` 不得覆盖部署绑定。成功返回 `202 { accepted:true, batchId, taskId }`；同一路由已有活跃发现批次时返回其 ID 并标记 `deduplicated:true`。`batchSize` 为差分目标：发现任务读取该来源已入库职位集合，跳过已入库且标题未变的职位，按合同断点向后翻页直到凑满 `batchSize` 个「新增 + 标题变化」职位或结果末尾，再为这些职位创建 `browser_job_collect` 详情任务。
- 列表请求/回执分别由 [`liebide-filtered-job-list.request.v2`](contracts/liebide-filtered-job-list.request.v2.schema.json) 与 [`liebide-filtered-job-list.receipt.v2`](contracts/liebide-filtered-job-list.receipt.v2.schema.json) 固定。v2 只接受“推荐 0 人、发布时间最近 30 天”的页面筛选证据；回执条目只含 `externalId/title/pageNumber/position`，断点只含页码与停止原因。Consumer 持久化批次/条目后按条目创建 `browser_job_collect`，详情任务再独立复核 7～30 天规则，0～6 天项只记跳过。批量发现创建的详情任务把列表卡片标题写入可选 `expectedTitle`，详情合同据此校验渲染内容确为目标岗位（详见 [`browser-collect.task.v1`](contracts/browser-job-collect.task.v1.schema.json) 与 [`liebide-job-detail.request.v1`](contracts/liebide-job-detail.request.v1.schema.json)），不一致失败关闭。
- 服务端为单个任务签发短期、高熵、单次消费 ingestion ticket；数据库只保存 token 哈希、任务/契约绑定、到期时间和大小上限，明文 ticket 不写日志或审计。
- `POST /api/browser-ingestion/:ticket` 不接受管理端 Cookie，以 ticket 作为独立身份域；必须校验 HTTPS、到期/撤销/已消费、任务、契约版本、来源域/设备声明、内容类型、载荷大小、Schema 和内容哈希后，先加密再持久化。
- 成功响应只返回 receipt ID、接受/拒绝计数、内容哈希和下一游标；错误只返回机器码。任何响应、审计或普通日志都不得回显 ticket、Cookie、完整简历或联系方式。
- 具体请求/响应 Schema、签名/重放防护和来源证明必须在实现前补齐并以失败测试锁定；本节不得作为“端点已可用”的声明。

### 3.2 浏览器候选人采集任务（实现切片）

- 候选人数源锚定猎必得人才池页（`#/candidates/firmCandidate`，运营预置「互联网技术其他」分类筛选，2026-08-14 确认真实分类名），发现/详情合同见 [`10-candidate-collection.md`](10-candidate-collection.md) §3：`liebide-talent-pool-list-v1`（人才池发现，固定分类证据 + 数字断点）与 `liebide-candidate-detail-v1`（画像详情，**新标签页**确定性导航 → 提取 → 关闭回列表）。
- `POST /api/candidate-collections` 由管理端会话 + `operations|admin` 创建人才池候选人**批次发现**任务。批量请求只接受 `sourceConnectionId`、固定 `contractId=liebide-talent-pool-list-v1`、`batchSize`、`maxPages` 和可选数字断点；服务端生成 `batchId`，并从 `BROWSER_RELAY_USER_ID`/`BROWSER_RELAY_DEVICE_ID` 注入路由。缺少服务端路由配置返回 `503 browser_route_config_required` 且不入队；请求体 `userId/deviceId` 不得覆盖部署绑定。成功返回 `202 { accepted:true, batchId, taskId }`；同一路由已有活跃发现批次时返回其 ID 并标记 `deduplicated:true`。`batchSize` 为差分目标：发现任务读取该来源已入库候选人集合，跳过已入库且 `current_title` 未变的候选人，按合同断点向后翻页直到凑满 `batchSize` 个「新增 + 画像变化」候选人或结果末尾，再为这些候选人创建 `browser_candidate_collect` 详情任务。写路由执行同源 CSRF 和 `candidate.collection.trigger` 审计，审计只保存 batch/task ID、是否去重、契约 ID，不保存用户/设备/候选人完整值。
- `GET /api/candidate-batches` 由管理端会话 + `operations|admin` 只读返回 `browser_candidate_batches` 批次列表（`page/page_size` 分页），结构与 `GET /api/browser-batches` 一致；审计 `candidate-batches.list` 只保存页码/条数/总数。
- 候选人详情回执含**真实姓名**（内部 `candidates`，RBAC + 加密 + 审计保护），但**联系方式/简历正文白名单外键失败关闭**，绝不进 HTTP 响应、任务载荷、审计或日志；`candidate-match-projection.v1` 的脱敏职责在匹配侧另行保证（见 [10-matching-contracts](10-matching-contracts.md)）。

### 3.3 落地页与意向（M4 切片）

落地页公开端点属于**独立身份域**（[`ADR-006`](decisions/ADR-006-landing-intent-notifier.md)）：只接受随机令牌哈希校验，不并入管理端会话/RBAC；仅运营侧建链端点走会话 + `operations|admin`。

**运营侧建链**（管理端）：

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `/api/landing-links` | POST | 会话 + `operations\|admin` | `{ jobId, candidateId, expiresInDays? }` | `201 { linkId, url }`（`url` 含明文令牌，**仅此一次**返回给创建者）；查无职位/候选人 `404` |

- 令牌为高熵随机（≥32 字节 → base64url），数据库只存 SHA-256 哈希；`expires_at` 默认 30 天；支持撤销。
- 审计 `landing.link.create` 只存 `linkId/jobId/candidateId`，不含明文令牌。
- **生产门禁注记**：完整 M4 中建链仅对「人工审核通过的匹配」开放；本切片为可测试核心机制，先按职位+候选人直接建链，审核门禁随活动流程（`campaigns`）收口。

**公开侧意向**（独立身份域，无会话；令牌即能力凭证）：

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `GET /api/landing/:token` | GET | 令牌哈希 | 无 | `200` 脱敏职位 DTO；令牌不存在/已过期/已撤销 `404 { code: "landing_link_unavailable" }` |
| `POST /api/landing/:token/intent` | POST | 令牌哈希 | `{ option, phone?, email?, consentSnapshot? }` | `200 { responseId, option, deduplicated? }`；无效令牌 `404`；option 非法/无联系方式 `400` |

- 公开侧响应（页面/DTO）只含白名单字段：职位标题、类别、城市、薪资范围、去标识化职责摘要、意向操作；**永不包含**公司名称/简称、内部职位编号、客户联系人、招聘负责人、详细地址或原始 JD（见 [`03-data-model.md`](03-data-model.md) §10）。职责摘要由**模板 + 白名单词库**自动生成（`lib/landing/landing-summary.mjs`）：大类桶模板 + 从 JD 命中的通用能力词/行业词变量，公司/产品专名结构性无法进入；确定性纯函数，LLM 改写留作增强路径。
- 薪资只展示上下限范围；边界缺失时安全降级文案，不推断精确薪资。
- 意向 `option ∈ { A, B, C, opt_out }`；同一 `landing_link_id` 唯一，重复提交返回既有记录并标记 `deduplicated:true`（不产生冲突数据）。
- 联系方式 `phone`/`email` 至少一个，应用层加密入库；明文不落日志/审计/审计元数据。
- 落库成功后经 notifier 适配器（首实现飞书群机器人 webhook）**直接尽力投递**（有界超时，`NOTIFIER_NOT_CONFIGURED`/非 2xx/不可达均记 `notify_status=failed` + `notify_error_code`，不阻塞意向真源，失败可重试）；payload 最小化（联系方式+意向+职位+时间）；同一意向回复仅投递一次，触发/成功/失败写审计（`landing.intent.submit` 元数据白名单 responseId/deduplicated/notifyStatus），审计元数据不含联系方式正文。
- CSRF：公开侧无会话，令牌为请求能力；重复提交幂等（返回既有记录 + `deduplicated:true`）。

### 3.4 候选人池列表（M3 候选人采集切片）

| 接口 | 方法 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| `/api/candidates` | GET | 会话 + `operations\|admin` | `page`/`page_size`/`q`（姓名/职位/公司/城市/学校/专业）/`status`（待匹配/已匹配/已审核） | `200 { total, page, page_size, total_pages, list }` |

- 候选人画像属**敏感业务**（docs/06 §敏感业务）：真实姓名（`display_name`）仅在 RBAC `operations|admin` 会话下返回；响应**永不包含**联系方式/简历正文（raw_records payload_* 信封加密不外发）；审计 `candidates.list` 元数据只存页码/条数/总数。
- 列表字段白名单：姓名、当前职位（`current_title ?? seniority`）、公司、城市、经验年限、学历、学校、专业、职级、行业、摘要、`consent_status`、匹配状态、匹配数、入库时间。
- **匹配状态由 `matches` 推导**：已审核（存在 approved/rejected）→ 已匹配（存在 generated）→ 待匹配（无匹配）。M3 匹配流水线未跑时全为待匹配。
- 只列出有画像内容的候选人（`current_title` 或经验非空），排除落地页预览产生的空画像夹具。

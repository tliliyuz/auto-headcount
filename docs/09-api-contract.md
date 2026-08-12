# 内部 API 契约

本文档是系统内部 API（管理后台 Web/API 应用对外端点）的唯一权威契约。产品行为以 [`01-mvp-requirements.md`](01-mvp-requirements.md)、可执行验收以 [`07-acceptance-criteria.md`](07-acceptance-criteria.md)、模块边界以 [`02-architecture.md`](02-architecture.md) 为准；外部 MCP 接入见 [`04-mcp-integration.md`](04-mcp-integration.md)。

## 1. 通用约定

- 基路径：`/api`；响应统一为 JSON。
- 鉴权：管理端端点要求有效会话（`HttpOnly`/`Secure`/`SameSite=Lax` 会话 Cookie）；未登录返回 `401`。
- 授权：由服务端按角色判定（`operations`/`recruiter`/`admin`），前端隐藏入口不作为授权措施。
- 错误响应：统一 `{ "code": "<机器码>", "message": "<人读文案>" }`，HTTP 状态码表示类别（400/401/403/404/409/429/500）。
- 分页：请求 `page`（从 1 起）与 `page_size`；响应 `{ total, page, page_size, total_pages, list }`，与 MCP 响应包络保持一致。
- 幂等：写操作使用服务端幂等键，重复提交不产生重复数据。
- 审计：登录、登出、数据导出、角色变更、触达、推荐、删除等记录审计事件，且不含口令、口令哈希、手机号、邮箱、简历正文或令牌。
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

### 2.2 业务只读（M1 · jobs / sources 模块）

统一要求：会话 + RBAC `operations|admin`（`recruiter` 拒绝 → `403 { code:"forbidden", message:"没有权限访问该资源" }`）；每次访问写数据审计（`jobs.list` / `sources.list` / `sync-runs.list`，成功元数据仅计数与分页，角色拒绝记 `result:"denied"`）；分页包络 `{ total, page, page_size, total_pages, list }`；非法分页参数 → `400 { code:"invalid_request" }`。

| 接口 | 方法 | 鉴权 | 请求 Query | 响应 |
|---|---|---|---|---|
| `/api/jobs/under-served` | GET | 会话 + `operations\|admin` | `category?`（精确）、`q?`（title/city 子串，大小写不敏感）、`page`、`page_size` | `200` 分页包络，`list[]` 为职位投影 |
| `/api/sources` | GET | 会话 + `operations\|admin` | `page`、`page_size` | `200` 分页包络，`list[]` 含连接信息与最新同步摘要 |
| `/api/sync-runs` | GET | 会话 + `operations\|admin` | `status?`（`pending`/`running`/`succeeded`/`failed`）、`page`、`page_size` | `200` 分页包络，`list[]` 含来源展示名 |

**职位投影（`/api/jobs/under-served` `list[]`）**：`id`、`externalId`、`mappingVersion`、`title`、`companyName`、`category`、`city`、`detailedLocation`、`salaryMin`/`salaryMax`、`status`、`ageDays`（=`days_without_recommendation`）、`recommendationCount`（空视为 0）、`sourceConnectionId`、`rawRecordId`、`publishedAt`、`sourceUpdatedAt`、`createdAt`、`updatedAt`。

**数据源投影（`/api/sources` `list[]`）**：`id`、`provider`、`environment`、`status`、`displayName`、`createdAt`/`updatedAt`、`lastRunId`、`lastRunSyncType`、`lastRunStatus`、`lastRunStartedAt`、`lastRunFinishedAt`、`lastRunErrorCode`、`lastRunStats`。

**同步批次投影（`/api/sync-runs` `list[]`）**：`id`、`sourceConnectionId`、`sourceDisplayName`、`sourceProvider`、`syncType`、`status`、`stats`（仅计数）、`errorCode`、`startedAt`、`finishedAt`、`createdAt`。

**规则与敏感边界**：
- 沉睡规则（发布 7/30 天含边界、`active`、零有效推荐）在仓储 SQL 权威执行，`/api/jobs/under-served` 只返回合格职位。
- 内部 API 允许返回 `company_name`/`detailed_location`（内部运营边界；候选人落地页白名单 DTO 另行剥离）。**永不**返回 `raw_records.payload_*`（原始载荷密文）与 `sync_runs.cursor`（供应方游标令牌）。
- `sync_runs.error_code` 为机器可读码（如 `RATE_LIMITED`），不映射为散文文案。
- 未登录 → `401 { code:"unauthorized" }`；角色无权 → `403 { code:"forbidden" }`。

## 3. 规划端点（随里程碑补充）

以下按页面模块列出规划端点，**路径为草案**，契约须在对应里程碑实现前完成并回写本文档：

| 模块（里程碑） | 规划端点（草案） | 状态 |
|---|---|---|
| 职位巡检（M1） | `GET /api/jobs/under-served`、`GET /api/jobs` | 已设计（under-served 见 §2.2；`/api/jobs` 待设计） |
| 数据源/同步（M1） | `GET /api/sources`、`GET /api/sync-runs` | 已设计（见 §2.2） |
| 审计（M1） | `GET /api/audit-logs` | 待设计 |
| 匹配（M2） | `POST /api/match-tasks`、`GET /api/matches` | 待设计 |
| 触达活动（M3） | `GET/POST /api/campaigns`、`POST /api/campaigns/:id/approve` | 待设计 |
| 跟进任务（M4） | `GET/POST /api/followups` | 待设计 |
| 漏斗（M4） | `GET /api/funnel` | 待设计 |

> 候选人落地页端点属于独立身份域，只接受令牌哈希校验，契约在 M3 另行定义，不并入本管理端契约。

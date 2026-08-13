# 前端地图（Frontend Map）

本文档是前端页面的**地图与接线状态**，不是业务规范。业务行为（沉睡规则、匹配分档、脱敏要求、触达门禁）以 [`docs/01-mvp-requirements.md`](../../../docs/01-mvp-requirements.md) 与 [`docs/07-acceptance-criteria.md`](../../../docs/07-acceptance-criteria.md) 为准；模块边界与数据所有权见 [`docs/02-architecture.md`](../../../docs/02-architecture.md)。

当前前端为**单文件静态原型**：`apps/web/app/operations-dashboard.tsx` 承载登录视图、全部页面与假数据，`apps/web/app/globals.css` 承载全部样式。按既定决策保留该 UI，随后就地接真实数据。

默认初始视图为**登录页**（`LoginPage`）；请求头 `x-prototype-view: app` 可强制初始进入工作台（供服务端渲染测试覆盖两个视图）。

## 1. 技术基线

- 框架：Vinext（React Server Components），文件顶部 `"use client"`，单页应用。
- 单文件现状：全部页面组件集中在 `operations-dashboard.tsx`；登录、沉睡职位巡检、数据源、审计日志四处已接真实 API，其余页面仍为静态原型。
- 已建 API 层：认证 `/api/auth/*`（§2.1）与业务只读 `/api/jobs/under-served`、`/api/sources`、`/api/sync-runs`（§2.2，会话 + RBAC `operations|admin`）。
- 样式：Tailwind 引入 + `globals.css` 自定义类 + `:root` 设计 token。

## 2. 页面清单与接线状态

| 页面 | 组件 | 数据来源 | 状态 |
|---|---|---|---|
| 沉睡职位巡检 | `OperationsDashboard` 内联 | 真实 [`GET /api/jobs/under-served`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（列表/洞察/脱敏预览；匹配池为 M2 占位） |
| 智能匹配 | `MatchingPage` | `candidates` 数组 | 静态原型 |
| 触达活动 | `CampaignsPage` | `campaignRows` 数组 | 静态原型 |
| 跟进任务 | `FollowupsPage` | `followupColumns` 数组 | 静态原型 |
| 转化漏斗 | `FunnelPage` | 内联 `bars` / `stages` / 转化表 | 静态原型 |
| 数据源 | `SourcesPage` | 真实 [`GET /api/sources`](../../../docs/09-api-contract.md) + [`GET /api/sync-runs`](../../../docs/09-api-contract.md) | 已接真实数据（连接卡片 / 同步批次 / 健康面板；「立即同步」disabled，同步由 CLI 或定时任务触发） |
| 审计日志 | `AuditPage` | 真实 [`GET /api/audit-logs`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（最新 50 条 + 上一页/下一页；筛选控件为占位禁用态） |

导航为 7 个页面（无独立工作台页，沉睡职位巡检为默认落地页）。

### 登录视图（已接线真实 API）

- 组件：`LoginPage`（`operations-dashboard.tsx` 内），默认初始视图；侧边栏资料菜单「退出登录」可返回登录页。
- **已接线**：登录/强制改密/登出/会话恢复均走 [`docs/09-api-contract.md`](../../../docs/09-api-contract.md) §2.1 的 `/api/auth/*`：
  - 登录表单 `POST /api/auth/login`（含 TOTP 校验位）；统一失败文案由服务端返回，连续失败锁定由后端 `429` 驱动（无本地计数）。
  - `passwordChangeRequired` 时进入「设置新口令」步，`POST /api/auth/password` 改密成功后进入工作台。
  - 侧边栏「退出登录」`POST /api/auth/logout` 后回登录页。
- **会话门禁分层**：SSR（`page.tsx`）按 `x-prototype-view: app` 请求头或 `session_token` Cookie 存在性渲染视图（不查库）；客户端挂载后无条件 `GET /api/auth/me` 核实会话——`200` 用真实用户刷新资料区，`401`（过期/撤销/禁用）退回登录页。会话 Cookie 为 HttpOnly，JS 无法探测，因此不能用 `document.cookie` 判断登录态。
- **客户端会话心跳**：工作台视图下每 5 分钟静默 `GET /api/auth/me` 续期服务端会话空闲窗口（服务端空闲 30 分钟/最长 12 小时，空闲窗口仅在 API 请求时刷新）；tab 开着即保持登录，会话真正失效（`401`）才回落登录页。心跳不产生审计。
- 客户端认证封装见 [`lib/auth-client.ts`](../lib/auth-client.ts)。

## 3. 假数据清单（接真数据时的替换点）

| 数据 | 位置 | 对应真实来源（路线图阶段） |
|---|---|---|
| `candidates`（4 个候选人） | 文件顶部 | MCP `candidates.search` → 候选人表（M1/M2） |
| `campaignRows`（4 个活动） | 文件顶部 | `campaigns` / `campaign_recipients` 表（M3） |
| `followupColumns`（看板列） | 文件顶部 | `follow_up_tasks` 表（M4） |
| 漏斗/转化数据（内联） | `FunnelPage` | `funnel_events` 聚合（M4） |
| 审计记录（内联） | ~~`AuditPage`~~ | `audit_logs` 表（M1，已接真实数据） |

> 已接真实数据：沉睡职位巡检页不再使用 Mock `jobs` 数组（已删除），数据来自 `/api/jobs/under-served`（规范化 `jobs` 表 + 真实沉睡规则）；数据源页不再使用内联同步批次/健康数组，数据来自 `/api/sources` + `/api/sync-runs`（`source_connections` / `sync_runs` 表）；审计日志页不再使用内联 mock 记录，数据来自 `/api/audit-logs`（`audit_logs` 表，元数据写入时已按动作白名单收敛，`ip_address` 尽力捕获可为空）。原始载荷密文与游标令牌永不进入响应。

> 安全提醒：`jobs` 数组含伪造的公司名、公司别名与详细地址。这些字段**只用于 Mock，禁止进入渲染输出或 Fixture**；对外展示必须经过 `toPublicJobView` 脱敏投影（渲染测试已守卫公司名/详细地址不泄漏）。接真实数据后，原始载荷与规范化数据的脱敏边界以 `03-data-model.md` 与 `04-mcp-integration.md` 为准。

## 4. 可复用组件

- `PageIntro`：页头（eyebrow / 标题 / 描述 / 主按钮）。
- `SummaryStrip`：KPI 指标卡行。
- 通用表格：`data-table` + `data-row` / `data-head` + `status-tag`；变体见 `globals.css` 的 campaign / performance / sync / audit 表。
- 候选人样式：`candidate-avatar`、`match-score`、`score-badge`。
- 跟进看板：`kanban` / `kanban-column`。
- 脱敏预览模态框：`preview-modal`（候选人对职位落地页的预览）。

## 5. 设计 Token（`globals.css` `:root`）

`--ink` `--muted` `--line` `--blue` `--blue-dark` `--blue-soft` `--surface` `--canvas` `--green` `--amber` `--violet`。新增颜色必须先登记到 `:root`，禁止在组件内硬编码色值。

## 6. 接数据重构路径（对应路线图 M1–M4）

1. 拆文件：每页组件从 `operations-dashboard.tsx` 拆到独立文件，按 `02-architecture.md` 的模块名组织。
2. 建 API 层：用 Vinext Route Handler 或独立模块提供数据，前端经适配器取数，不直连数据库。
3. 数据驱动：用数据加载替换硬编码数组；沉睡职位页保留 `job-rules` 真实规则。
4. 鉴权门禁：接入自有登录与角色权限（ADR-004 / ADR-003），未登录不渲染业务数据。
5. 每页接线完成后，在本表更新状态并记入 `CHANGELOG.md`。

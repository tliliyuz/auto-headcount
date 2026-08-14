# 前端地图（Frontend Map）

本文档是前端页面的**地图与接线状态**，不是业务规范。业务行为（沉睡规则、匹配分档、脱敏要求、触达门禁）以 [`docs/01-mvp-requirements.md`](../../../docs/01-mvp-requirements.md) 与 [`docs/07-acceptance-criteria.md`](../../../docs/07-acceptance-criteria.md) 为准；模块边界与数据所有权见 [`docs/02-architecture.md`](../../../docs/02-architecture.md)。

当前前端仍由 `apps/web/app/operations-dashboard.tsx` 集中承载登录视图和业务页面，`apps/web/app/globals.css` 承载全局样式；已接线页面通过 `lib/*-client.ts` 访问管理 API。

默认初始视图为**登录页**（`LoginPage`）；请求头 `x-prototype-view: app` 可强制初始进入工作台（供服务端渲染测试覆盖两个视图）。

## 1. 技术基线

- 框架：Vinext（React Server Components），文件顶部 `"use client"`，单页应用。
- 单文件现状：全部页面组件集中在 `operations-dashboard.tsx`；登录、沉睡职位巡检、智能匹配、数据源、审计日志五处已接真实 API；触达活动、跟进任务、转化漏斗、候选人仍为静态原型（假数据）。
- 已建 API 层：认证 `/api/auth/*`（§2.1）与业务只读 `/api/jobs/under-served`、`/api/sources`、`/api/sync-runs`（§2.2，会话 + RBAC `operations|admin`）。
- 样式：Tailwind 引入 + `globals.css` 自定义类 + `:root` 设计 token。

## 2. 页面清单与接线状态

| 页面 | 组件 | 数据来源 | 状态 |
|---|---|---|---|
| 沉睡职位巡检 | `OperationsDashboard` 内联 | 真实 [`GET /api/jobs/under-served`](../../../docs/09-api-contract.md) + [`GET /api/jobs/:id`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（列表/洞察/脱敏预览；洞察面板按选中职位拉取完整 JD 展示「职位详情」；匹配池为 M3 占位） |
| 智能匹配 | `MatchingPage` | 真实 `/api/matches`、`/api/matches/:id`、`/api/matches/:id/review`、`/api/match-exceptions` | 已接真实数据（待审核列表/详情/七维追溯/审核/异常；无 Mock 回落） |
| 触达活动 | `CampaignsPage` | `campaignRows` 数组 | 静态原型 |
| 跟进任务 | `FollowupsPage` | `followupColumns` 数组 | 静态原型 |
| 转化漏斗 | `FunnelPage` | 内联 `bars` / `stages` / 转化表 | 静态原型 |
| 数据源 | `SourcesPage` | 真实 [`GET /api/sources`](../../../docs/09-api-contract.md) + [`GET /api/sync-runs`](../../../docs/09-api-contract.md) + `POST /api/browser-collections` + `GET /api/browser-batches` | 已接真实数据（连接卡片 / 同步批次 / 浏览器职位批量采集「采集当前筛选结果」+ 最近采集批次面板 / 健康面板；「立即同步」经 [`POST /api/sync/under-served`](../../../docs/09-api-contract.md) 手动触发） |
| 审计日志 | `AuditPage` | 真实 [`GET /api/audit-logs`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（最新 50 条 + 上一页/下一页；筛选控件为占位禁用态） |
| 候选人 | `CandidatesPage` | `candidateRows` 数组（假数据） | 静态原型（列表 + 状态筛选 + 关键词搜索 + 分页 + 详情面板；M2 候选人采集落库后接真实 `GET /api/candidates`，见 [候选人采集规范](../../../docs/10-candidate-collection.md)） |

导航当前为 8 个页面（无独立工作台页，沉睡职位巡检为默认落地页）；「候选人」页已上线静态原型（假数据），M2 采集落库后接真实数据。

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
| ~~`candidates`（4 个候选人）~~ | ~~文件顶部~~ | M3 接线时删除，改读匹配 API |
| `campaignRows`（4 个活动） | 文件顶部 | `campaigns` / `campaign_recipients` 表（M4） |
| `followupColumns`（看板列） | 文件顶部 | `follow_up_tasks` 表（M5） |
| 漏斗/转化数据（内联） | `FunnelPage` | `funnel_events` 聚合（M5） |
| 审计记录（内联） | ~~`AuditPage`~~ | `audit_logs` 表（M1，已接真实数据） |

> 已接真实数据：沉睡职位巡检页不再使用 Mock `jobs` 数组（已删除），数据来自 `/api/jobs/under-served`（规范化 `jobs` 表 + 真实沉睡规则；当前 MCP 投影只返回 `operability_status='actionable'` 的可操作沉睡职位）。数据源页已接 `liebide-filtered-job-list-v2 → browser_job_collect × N` 批次触发：列表页要求“推荐 0 人、发布时间最近 30 天”，详情页再复核 7～30 天，0～6 天项只记跳过。设备路由由服务端 `BROWSER_RELAY_USER_ID/BROWSER_RELAY_DEVICE_ID` 固定配置，页面不读取 Secret、不要求运营重复填写，日常只选择批量并点击“采集当前筛选结果”。列表/详情 Provider Fixture 已实现，但尚未用真实筛选页做整批复验，因此页面不能宣称生产批量采集已验证。数据源页和审计日志页分别读取真实 `/api/sources` + `/api/sync-runs` 与 `/api/audit-logs`；原始载荷密文、简历正文、联系方式和浏览器 session 永不进入这些响应。

### 智能匹配目标交互（M3）

- 沉睡职位页只负责查看职位列表、JD 详情、沉睡时长与同步状态；删除职位复选框和“创建匹配任务”，不得从前端拼装正常匹配任务。
- 智能匹配页默认进入“待审核”，读取匹配列表；点击一条结果后读取详情，展示七维评分、可评估性、置信度、证据、缺失项、风险和版本追踪信息。
- 审核按钮只在 `pending_review` 显示，提交后原地刷新列表与详情；`approved/rejected` 为只读终态。
- “异常”视图读取异常 API，区分硬过滤异常与评分失败，展示白名单错误码、发生时间及是否可重试；普通业务不匹配不是运营异常，不进入待审核。
- 页面必须具备 loading、空列表、请求失败和会话失效状态；`401` 复用全局退出登录回调，禁止回落到 Mock 数据。
- 自动编排状态以只读摘要呈现，运营不选择职位或候选人启动任务。未来如增加“重试”，按钮只能针对后端明确标记 `retryable=true` 的失败运行。

### 同步触发状态机（2026-08-13，入口 2026-08-14 调整）

同步状态机跟踪真实同步状态（[`POST /api/sync/under-served`](../../../docs/09-api-contract.md) 入队后轮询 [`GET /api/sync-runs`](../../../docs/09-api-contract.md)）。**入口在「数据源」页**（主数据源卡片的「立即同步」按钮）；沉睡职位巡检页不再放置同步按钮，仅展示「最近同步」时间与同步进行中/结果的状态提示（同一状态机驱动）。2026-08-14 UI 调整：同步时间以 `<strong>` 加粗黑色展示。

- 状态：`idle → triggering → queued（已入队，等待调度 tick，最长约 15 分钟）→ syncing（执行中）→ succeeded / failed`；终态显示结果文本（`同步完成：{persisted} 个职位` / `同步失败：{errorCode}`），按钮可再次触发。
- **去重**：活跃窗口（queued/syncing）内按钮禁用；服务端 `enqueueTaskIfIdle` 保证同 kind 至多一个活跃任务，重复触发返回 `deduplicated:true`（前端显示「已有同步任务在执行中，正在跟踪进度」）。
- **自动刷新**：终态检测后 bump `reloadSeq` 重跑业务数据加载 effect，列表与「最近同步」时间戳自动更新。
- 轮询仅活跃窗口内进行（`SYNC_POLL_MS`，终态即停）；基线为触发瞬间的最新 `under_served_jobs` 批次 id，新批次即本次进度（`sync_runs` 原地更新状态，running → succeeded/failed）。

### 沉睡职位列表 UI（2026-08-14 调整）

- 移除「只看有详情」勾选与职位名旁的「有详情」标记：当前源采集均保证有完整 JD，不再强调详情有无（`hasDescription` 仍用于列表「自动排队/待补详情」状态列）。
- 工具栏不再放「发布时间」「负责人」两个假筛选按钮，并入右侧「≡ 筛选」下拉面板展示当前值；下拉内注明待数据源补齐后开放（发布时间/负责人非当前可筛字段）。
- 列表固定贴合容器宽度：`.table-wrap` 移除 `overflow-x:auto`，改用 `table-layout:fixed` + 各列显式宽度 + 表头 `nowrap`，移动端 `min-width` 一并移除，不再出现横向滚动条。「职位」列「ID · 更新于 时间」行为 flex 单行：ID 过长时省略号截断（`title` 悬浮可看全量），时间始终同行；右侧洞察面板 314→296px 为表格让宽。
- **类别 tabs 与标题推断**：源 `category` 为空（MCP 同步源 `item.category` 实测空串、浏览器采集合同未定义该字段）时，按职位标题关键词推断粗桶（`lib/job-category.mjs` 的 `inferCoarseBucketFromTitle` / `jobCoarseBucket`，源有真实细分类时优先权威映射）。推断为启发式非权威，若后续数据侧提供权威 category，`jobCoarseBucket` 自动切回权威值。

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

## 6. 接数据重构路径（对应路线图 M1–M5）

1. 拆文件：每页组件从 `operations-dashboard.tsx` 拆到独立文件，按 `02-architecture.md` 的模块名组织。
2. 建 API 层：用 Vinext Route Handler 或独立模块提供数据，前端经适配器取数，不直连数据库。
3. 数据驱动：用数据加载替换硬编码数组；沉睡职位页保留 `job-rules` 真实规则。
4. 鉴权门禁：接入自有登录与角色权限（ADR-004 / ADR-003），未登录不渲染业务数据。
5. 每页接线完成后，在本表更新状态并记入 `CHANGELOG.md`。

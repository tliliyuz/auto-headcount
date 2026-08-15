# 前端地图（Frontend Map）

本文档是前端页面的**地图与接线状态**，不是业务规范。业务行为（沉睡规则、匹配分档、脱敏要求、触达门禁）以 [`docs/01-mvp-requirements.md`](../../../docs/01-mvp-requirements.md) 与 [`docs/07-acceptance-criteria.md`](../../../docs/07-acceptance-criteria.md) 为准；模块边界与数据所有权见 [`docs/02-architecture.md`](../../../docs/02-architecture.md)。

当前前端仍由 `apps/web/app/operations-dashboard.tsx` 集中承载登录视图和业务页面，`apps/web/app/globals.css` 承载全局样式；已接线页面通过 `lib/*-client.ts` 访问管理 API。沉睡职位详情页为独立路由 `app/jobs/[id]/`（不在管理端 SPA 内），服务端 `prototypeView` 门禁 + 客户端 `job-detail-page.tsx` 经 `/api/jobs/:id` 拉取详情。

默认初始视图为**登录页**（`LoginPage`）；请求头 `x-prototype-view: app` 可强制初始进入工作台（供服务端渲染测试覆盖两个视图）。

## 1. 技术基线

- 框架：Vinext（React Server Components），文件顶部 `"use client"`，单页应用。
- 单文件现状：全部管理端页面组件集中在 `operations-dashboard.tsx`；登录、沉睡职位巡检、智能匹配、数据源、审计日志五处已接真实 API；触达活动、跟进任务、转化漏斗、候选人仍为静态原型（假数据）。
- 独立路由：`app/jobs/[id]/` 为沉睡职位详情页（非工作台内嵌），服务端 `prototypeView` 门禁 + 客户端经 `/api/jobs/:id` 拉详情。
- **公开落地页（M4 切片）**：`app/landing/[token]/page.tsx` 是**独立公开路由**（不在管理端 SPA 内、无会话），令牌门禁 + 脱敏职位页 + A/B/C/退订 + 联系方式提交，走公开 API `GET /api/landing/:token`、`POST /api/landing/:token/intent`（独立身份域，见 [API 契约](../../../docs/09-api-contract.md) §3.3 与 [ADR-006](../../../docs/decisions/ADR-006-landing-intent-notifier.md)）。
- 已建 API 层：认证 `/api/auth/*`（§2.1）与业务只读 `/api/jobs/under-served`、`/api/sources`、`/api/sync-runs`（§2.2，会话 + RBAC `operations|admin`）。
- 样式：Tailwind 引入 + `globals.css` 自定义类 + `:root` 设计 token。

## 2. 页面清单与接线状态

| 页面 | 组件 | 数据来源 | 状态 |
|---|---|---|---|
| 沉睡职位巡检 | `OperationsDashboard` 内联 | 真实 [`GET /api/jobs/under-served`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（列表/分页/类别 tabs/同步状态；行点击切换右侧面板选中；职位标题/`›` 跳独立详情页；右侧面板保留匹配与公开预览卡片；匹配池为 M3 占位） |
| 职位详情 | `app/jobs/[id]/job-detail-page.tsx`（独立路由 `app/jobs/[id]/page.tsx`） | 真实 [`GET /api/jobs/:id`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（头部岗位/公司/分类·城市、标签、完整 JD；未登录重定向 `/`） |
| 智能匹配 | `MatchingPage` | 真实 `/api/matches`、`/api/matches/:id`、`/api/matches/:id/review`、`/api/match-exceptions` | 已接真实数据（待审核列表/详情/七维追溯/审核/异常；无 Mock 回落） |
| 触达活动 | `CampaignsPage` | `campaignRows` 数组 | 静态原型 |
| 跟进任务 | `FollowupsPage` | `followupColumns` 数组 | 静态原型 |
| 转化漏斗 | `FunnelPage` | 内联 `bars` / `stages` / 转化表 | 静态原型 |
| 数据源 | `SourcesPage` | 真实 [`GET /api/sources`](../../../docs/09-api-contract.md) + [`GET /api/sync-runs`](../../../docs/09-api-contract.md) + `POST /api/browser-collections` + `GET /api/browser-batches` | 已接真实数据（连接卡片 / 浏览器职位批量采集「采集当前筛选结果」/ **统一批次列表**：采集批次与同步批次合并，类型 tabs + 搜索 + 分页 + 右侧详情面板 / 健康条；「立即同步」经 [`POST /api/sync/under-served`](../../../docs/09-api-contract.md) 手动触发） |
| 审计日志 | `AuditPage` | 真实 [`GET /api/audit-logs`](../../../docs/09-api-contract.md)（会话 + RBAC `operations\|admin`） | 已接真实数据（结果 tabs 全部/成功/失败/已拒绝 + 事件类型/操作人筛选下拉 + 关键词搜索（`q`）+ 每页 10 条 page-jump 分页；写入已按动作白名单收敛，不含敏感正文） |
| 候选人 | `CandidatesPage` | `candidateRows` 数组（假数据） | 静态原型（列表 + 状态筛选 + 关键词搜索 + 分页 + 详情面板；M2 候选人采集落库后接真实 `GET /api/candidates`，见 [候选人采集规范](../../../docs/10-candidate-collection.md)） |

导航当前为 8 个页面（无独立工作台页，沉睡职位巡检为默认落地页）；「候选人」页已上线静态原型（假数据），M2 采集落库后接真实数据。

### 登录视图（已接线真实 API）

- 组件：`LoginPage`（`operations-dashboard.tsx` 内），默认初始视图；侧边栏资料菜单「退出登录」可返回登录页。
- **已接线**：登录/强制改密/登出/会话恢复均走 [`docs/09-api-contract.md`](../../../docs/09-api-contract.md) §2.1 的 `/api/auth/*`：
  - 登录表单 `POST /api/auth/login`（含 TOTP 校验位）；统一失败文案由服务端返回，连续失败锁定由后端 `429` 驱动（无本地计数）。
  - `passwordChangeRequired` 时进入「设置新口令」步，`POST /api/auth/password` 改密成功后进入工作台。
  - 侧边栏「退出登录」`POST /api/auth/logout` 后回登录页。
- **会话门禁分层**：SSR 按 `x-prototype-view: app` 请求头或 `session_token` Cookie 存在性渲染视图（不查库）；门禁函数 `prototypeView()` 位于 `lib/server/prototype-view.ts`（`/` 与 `/jobs/[id]` 共用）。客户端挂载后无条件 `GET /api/auth/me` 核实会话——`200` 用真实用户刷新资料区，`401`（过期/撤销/禁用）退回登录页。会话 Cookie 为 HttpOnly，JS 无法探测，因此不能用 `document.cookie` 判断登录态。
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

### 沉睡职位详情独立页（2026-08-16）

- **右侧「职位详情（完整 JD）」卡片迁出**：完整 JD 不再在工作台右侧内联展示，迁到独立详情页 `/jobs/[id]`；右侧 `insight-panel` **保留**「自动匹配状态」与「候选人看到的内容」卡片及预览弹窗，选中态 `selectedId` 维持——列表行点击切换右侧面板选中职位，职位标题（`.job-detail-link`）与行尾 `›` 按钮用 `useRouter` 跳转详情页。
- **独立路由**：`app/jobs/[id]/page.tsx`（服务端，复用 `lib/server/prototype-view.ts` 的 `prototypeView` SSR 门禁，未登录 `redirect("/")`）+ `app/jobs/[id]/job-detail-page.tsx`（客户端，挂载后 `GET /api/auth/me` 核实会话 + `GET /api/jobs/:id` 拉详情；`401`/改密回落登录，`403` 无权限，`404` 已下架）。
- **页面布局**：头部卡片（岗位名称、公司名称、`jobCoarseBucket` 粗桶·城市、状态 pill）；`.jd-tags` 标签区（职位分类、城市、薪资范围、沉睡时长，≥27 天高亮）；复用 `.sleeping-alert` 展示沉睡上下文；主体 `.jd-main` 完整 JD，缺省显示「暂无详情」。
- **标签仅用现有接口字段**（`companyName` 属内部投影，RBAC operations/admin 可见）；`job_requirements`（期望候选人条件结构化数据）无读接口且生产无写入方，暂不暴露，待其有生产数据后再补。

### 数据源页：统一批次列表与审计日志（2026-08-14）

- **批次列表不再两个容器平铺**：原「最近采集批次」与「最近同步批次」两个面板合并为一个列表（`workspace-grid` 左列表 + 右侧详情面板，复用沉睡职位样式）。类型 tabs（全部/采集批次/同步批次，带计数）+ 关键词搜索（批次 ID / 来源）+ 每页 10 条 page-jump 分页；行点击后右侧 `insight-panel` 展示该批次的运行统计（采集：发现/入库/失败/跳过；同步：入库/跳过/失败/查询）与批次信息（本批数量/上限页数 或 同步类型/错误码、创建/完成时间、耗时）。列表数据来源不变：`/api/browser-batches` + `/api/sync-runs`（各取最近 100 条，每 10 秒轮询合并刷新）；连接健康改为列表下方的 `health-strip`。
- **审计日志改为 jobs 风格列表**：原 `data-table` 网格改为 `.table-wrap` 表格 + 结果分类 tabs（全部/成功/失败/已拒绝，走 `result` 过滤）+ 搜索框（`q` 模糊匹配事件/操作人/关联 ID，350ms 防抖）+ 「≡ 筛选」下拉（事件类型 `action`、操作人 `actor_type`）+ **每页 10 条** page-jump 分页（与批次列表/沉睡职位统一）。`q` 为 [`/api/audit-logs`](../../../docs/09-api-contract.md) 新增参数（匹配 `action`/`actor_id`/`request_id`/`resource_id` 子串）。
- **数据源卡片撑满容器**：`.source-card` 改 flex 纵向排布（按钮 `margin-top:auto` 贴底）、`min-height` 提升，按钮等高 42px 并 `flex:1` 等分填充整行，h2/meta/描述/浏览器采集下拉全部放大字号，消除卡片底部留白。

### 公开落地页（M4 切片，2026-08-15；多屏叙事 2026-08-16）

- 路由 `app/landing/[token]/page.tsx`（客户端组件）：从 URL 解析令牌 → `GET /api/landing/:token` 取脱敏职位 DTO → 渲染 **6 屏整屏 hero 叙事流**：开场（候选人个性化称呼 + 标题「正在寻找 X方向 的人才」 + 岗位大类/城市/招聘中 tags）→ 薪酬（月薪 k 大号展示）→ 关于雇主（公司档案隐性信息，缺失时安全占位）→ 岗位内容（白名单职责摘要）→ AI 匹配分析（已审核匹配维度分，缺失/未审核时安全占位）→ 意向填写（A/B/C/退订 + 手机号/邮箱表单；**2026-08-16 放开联系方式：仅选项 A 必填，B/C/退订可选，选 A 未留联系方式时提示并禁用提交**）。右侧进度导航高亮当前屏（IntersectionObserver + 实时布局判定，不依赖 scroll 事件）。失效令牌显示「链接不可用」；提交后显示成功态（重复提交显示「你已经提交过意向，无需重复提交」）。
- 公开 API 走独立身份域（无会话，令牌即能力凭证）：`POST /api/landing/:token/intent` 提交后意向落库（联系方式信封加密），notifier 尽力投递（飞书/假/未配置），提交与通知结果写审计。脱敏边界见 [ADR-006](../../../docs/decisions/ADR-006-landing-intent-notifier.md)。
- AI 匹配评价数据路径：`GET /api/landing/:token` 的 DTO 含 `aiEvaluation`，由 `landing-intent-service.getLandingJobView` 经 `findApprovedMatchForJobCandidate`（`matches.status='approved'`）+ `toAiEvaluation`（白名单维度标签，`lib/landing/landing-mask.mjs`）投影；evidence/风险原文不进入 DTO。薪资 k 展示见 `formatMonthlySalaryK`（脏值降级「薪资面议」）。
- 运营侧建链端点为 `POST /api/landing-links`（会话 + RBAC `operations|admin`，返回含明文令牌的 URL，仅此一次）；管理端建链 UI 属后续接线（当前可经 API/脚本触发）。

> 安全提醒：`jobs` 数组含伪造的公司名、公司别名与详细地址。这些字段**只用于 Mock，禁止进入渲染输出或 Fixture**；对外展示必须经过 `toPublicJobView` 脱敏投影（渲染测试已守卫公司名/详细地址不泄漏）。接真实数据后，原始载荷与规范化数据的脱敏边界以 `03-data-model.md` 与 `04-mcp-integration.md` 为准。

## 4. 可复用组件

- `PageIntro`：页头（eyebrow / 标题 / 描述 / 主按钮）。
- `SummaryStrip`：KPI 指标卡行。
- 通用表格：`data-table` + `data-row` / `data-head` + `status-tag`；变体见 `globals.css` 的 campaign / performance / sync / audit 表。
- 候选人样式：`candidate-avatar`、`match-score`、`score-badge`。
- 跟进看板：`kanban` / `kanban-column`。
- 职位详情页：`job-detail-page` / `job-detail-header` / `jd-tags` / `jd-tag` / `jd-section` / `jd-main`（`/jobs/[id]` 独立页样式，复用 `role-icon` / `status-pill` / `section-title` / `internal-label` / `sleeping-alert`）。

## 5. 设计 Token（`globals.css` `:root`）

`--ink` `--muted` `--line` `--blue` `--blue-dark` `--blue-soft` `--surface` `--canvas` `--green` `--amber` `--violet`。新增颜色必须先登记到 `:root`，禁止在组件内硬编码色值。

## 6. 接数据重构路径（对应路线图 M1–M5）

1. 拆文件：每页组件从 `operations-dashboard.tsx` 拆到独立文件，按 `02-architecture.md` 的模块名组织。
2. 建 API 层：用 Vinext Route Handler 或独立模块提供数据，前端经适配器取数，不直连数据库。
3. 数据驱动：用数据加载替换硬编码数组；沉睡职位页保留 `job-rules` 真实规则。
4. 鉴权门禁：接入自有登录与角色权限（ADR-004 / ADR-003），未登录不渲染业务数据。
5. 每页接线完成后，在本表更新状态并记入 `CHANGELOG.md`。

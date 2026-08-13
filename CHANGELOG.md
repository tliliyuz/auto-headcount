# Changelog

本文件记录用户可观察行为、架构决策、数据契约和验证状态。状态含义遵循 `AGENTS.md`：

- `specified`：规范和验收条件已确认。
- `implemented`：代码已实现但尚未完成全部验证。
- `verified`：已实际运行规定命令并通过。

格式采用 Keep a Changelog：`## [区域或版本] - 日期` 分组，每条记录标注状态归属。`Unreleased` 记录尚未纳入版本号的近期变更。

## [Unreleased]

### 2026-08-13 — 浏览器采集流程与 Liebide 契约标准化

> 状态：`specified`。本切片只固化开发、连接、真实联调、故障恢复和证据留存流程，不新增采集入库能力；既有单职位只读协议验证证据单独归档为 `verified`。

- 新增授权浏览器采集 Runbook，明确授权前置、插件连接顺序、“网页未连接”等恢复矩阵、真实 smoke test 输出边界、结束清理和跨仓库版本要求。
- 新增 `liebide-job-detail-v1` 请求/回执 JSON Schema，以 `additionalProperties:false` 固定身份路由、来源域名、职位白名单字段和 SHA-256 回执。
- 将 2026-08-13 的单职位真实验证整理为脱敏证据：只保存字段存在性、类型、长度和结果区间，不保存真实 JD、完整职位/会话标识或凭证；明确 CSDN-Agent 未版本化是不可复现发布偏差。
- 开发流程、验收标准和 API 规划文档增加 Runbook/Schema 投影；统一根命令、双端 Schema 哈希、连接诊断和 `browser_job_collect` 仍属后续切片。

### 2026-08-13 — 两阶段混合匹配规范与 v1 契约

> 状态：`specified`。已修订决策、产品口径、持久化草案、安全门禁和验收标准；三份 JSON Schema 已建立但尚未接入生产校验，版本化投影表、LLM 适配器和新匹配主路径均未实现。

- 修订 `ADR-005`：将旧的「本地确定性加权评分为权威分」改为「本地确定性硬过滤 → LLM 脱敏详情七维评分 → 本地固定权重汇总」；供应方分数仍仅作外部对照。
- 新增 `docs/10-matching-contracts.md` 与三份 v1 JSON Schema：职位要求投影、候选人画像/简历脱敏投影、LLM 详情维度评分。
- 明确展示摘要不是匹配真源；现有 `candidates.summary` 降为迁移期缓存。规划 `job_match_projections`、`candidate_match_projections`、`match_filter_results`、`llm_score_runs` 四表及 `matches`/`match_dimensions` 追溯扩展。
- 固化 `match-detail-prompt/v1`、模型/修订、Prompt/Schema、请求/输出哈希和汇总规则版本语义。LLM 不输出总分或审核结论；给定已保存结构化输出时，本地汇总才承诺确定性复算。
- 固化超时/限流有限重试与 Schema 无效、输入超限、残留 PII、安全拒绝失败关闭；失败不伪造分数、不回退供应商分数、不自动触达。

### 2026-08-13 — 路线图分层与连续编号重构

> 状态：`specified`。本次只重构阶段边界、编号和当前状态投影，不宣称新功能已实现或验证。

- 路线图改为连续编号：M2「数据获取与适配」、M3「数据集成与匹配」、M4「落地页与触达」、M5「漏斗与推荐」，不使用 M2-A/M2-B/M2-C 子阶段。
- M2 统一 MCP/Web 数据源、受限采集、入库与来源追溯；M3 统一展示摘要、过滤画像、详情匹配和人工审核。
- M2/M3 允许并行开发：M3 先用完全虚构 Fixture 验证，真实数据集成验收依赖 M2 的 2 个职位×每职位 5～10 个候选人垂直切片。
- 现有本地确定性匹配 Fixture 闭环重分类为 M3 已验证能力；二阶段 LLM 详情评分需先修订 `ADR-005`、Schema 和验收标准，尚未实现。

### 2026-08-13 — CSDN-Agent 职位详情受限提取协议（第一条实现切片）

> 状态：协议切片 `verified`，入库切片未实现。auto-headcount 固定参数、结构化回执和 Relay 客户端已通过本机 CSDN-Agent Bridge + Chrome 扩展 + 猎必得真实登录态单职位验证；`async_tasks`、职位入库与管理端触发尚未接线，不能描述为数据闭环完成。

- 业务侧只发送 `userId + deviceId + browserSessionId + expectedExternalId`，适配器自动固定 contract ID；拒绝脚本、选择器、任意 URL 和额外字段。
- CSDN-Agent 只在 `https://portal.liebide.com` 执行内置职位提取函数；按真实页面验证的 `/#/Job/{UUID}` 路由和 `.job-description-show` 详情区域解析，并强制页面职位 ID 与任务期望值一致。
- 回执只允许职位白名单、来源/采集时间、契约版本与 SHA-256；Cookie、Authorization、token、联系方式等敏感键递归拒绝，HTTP 错误不回显上游正文。
- 自动验证：auto-headcount `npm run test:unit` 124/124、`npm run lint`、Markdown 相对链接检查通过；CSDN-Agent `npm run check` 与插件全量测试 66/66 通过。
- 真实 Relay：身份路由归属校验通过；列表只读提取 UUID → 详情导航 → `.job-description-show` 等待 → `liebide-job-detail-v1` → auto-headcount `relay-client` 白名单解析完整闭环通过。回执摘要为 UUID 匹配、`active`、城市存在、薪资 30000–60000、发布时间存在、推荐数为 number、JD 1190 字、SHA-256 合法；未打印或落盘真实 JD。
- 真实联调修复：猎必得把 `30K-60K` 与后续文字直接拼接，原薪资正则错误要求尾部空白，首次回执薪资为 null。先将无空白 DOM 写入虚构测试并确认 RED，再放宽边界，插件 66/66 GREEN，重载扩展后的真实回执薪资恢复为 30000–60000。
- 已知边界：真实页面仅用于单职位只读协议验证，未把真实 JD 写入 Fixture；验证职位不满足 7–30 天且零推荐，不能作为沉睡职位入库样本。下一步接 `browser_job_collect` 任务时必须重新校验 `active + 7–30 天 + 推荐数 0`，不合格只记跳过，不写 `jobs`。

### 2026-08-13 — M2 本地评分引擎 + 匹配池（Fixture 闭环，ADR-005 主路径）

> 状态速览：本地确定性硬过滤 + 版本化加权评分（`lib/matching/score.mjs` 纯函数，可复算输入哈希）成为权威分；`match_rules`/`job_requirements`/`candidates`/`candidate_profiles`/`matches`/`match_dimensions` 六表落库（迁移 0007）；`match_sync` 任务对可操作职位跑本地评分并把供应方 `match_candidates` 结果写入 `external_*` 外部对照（非权威分）；匹配列表/详情/审核 API；摘要服务（≤150 字确定性）。虚构 Fixture 闭环跑通，开发不阻塞于供应商。

#### 已实现（implemented）

- 评分引擎：`lib/matching/score.mjs` `hardFilter`（地点/技能/年限/学历）+ 7 维加权评分（技能/行业/职级/经历/地点/薪资/活跃度）+ `classifyMatch` 分带 + `computeInputHash`（SHA-256 规范化输入，同版本同输入同结果）。
- 数据模型：`db/schema.ts` 六张匹配表（迁移 0007）；`matches.score` 本地权威分 + `external_*` 外部对照 + `input_hash` 可复算。
- 任务流：`lib/jobs/match-sync.mjs` `runMatchSync`——对选定可操作职位加载 requirements + 候选池 → 逐个 `scoreMatch` → 落库（本地分/维度/证据/风险/哈希）；提供 `mcp` 时把 `match_candidates` 结果写 `external_*`；单职位失败跳过。调度 `match_candidates_sync` kind 分发。
- API：`POST /api/match-tasks`（去重触发）、`GET /api/matches`、`GET /api/matches/:id`、`POST /api/matches/:id/review`（approve/reject）；`match-read-repository` 白名单投影（打码名、无联系方式）。
- 摘要服务：`lib/summaries/summary.mjs` `summarizeJob`/`summarizeCandidate`（≤150 字、无联系方式）。

#### 已验证（verified）

- `npm run lint` 0 问题；`npm run build` 通过（新路由注册）。
- `npm run test:unit` 124 通过（含评分引擎硬过滤/可复算/分带边界/哈希、摘要服务）。
- `npm run test:integration` 33 通过（match-sync 本地分落库/硬过滤不入池/可复算/外部对照 external_*、读仓储投影无联系方式、审核状态流转、调度分发、HTTP 匿名 401）。

> 已知边界：本地评分权重/阈值是 version 1 默认（`match_rules` 版本化可调）；真实候选人接入（match_candidates 摘要 → candidate_profiles、Web 采集 ADR-005）与人工审核页 UI 属后续切片。

### 2026-08-13 — 授权 Web 采集与本地匹配架构决策

> 状态：`specified`。接受 `ADR-005`：供应方 Web 平台成为与 MCP 并列的正式数据源；复用现有 CSDN-Agent 浏览器插件作为登录态与设备路由执行端；本地版本化、可复算规则评分成为业务主路径，供应方 `match_candidates` 降为外部对照。仅完成规范，未实现浏览器采集适配器、受限提取工具、ingestion ticket、候选人直传/脱敏或本地评分。

- 数据边界：Cookie、密码、验证码和 Authorization 留在员工浏览器；生产任务只能选择预审核的只读提取契约，不下发任意脚本/选择器/域名。
- 敏感传输：完整简历和联系方式不得通过 Agent 对话或通用 MCP 结果中转；规划使用短期、单任务、单次消费 ticket 从浏览器直传 auto-headcount 受控入口，Relay 只返回计数、哈希、游标和机器错误码。
- 开发数据：真实 Web/MCP 数据只用于有界集成验证；Git/CI 使用完全虚构 Fixture，不能提交真实简历的打码版本。
- 同步文档：项目章程、MVP 需求、架构、数据模型、MCP 关系、安全、验收、路线图、README 与前端地图。

### 2026-08-13 — 同步串行化 + MCP 只入库可操作∩沉睡（operability_status + jobs.get 补 JD）

> 状态速览：`claimDueTasks` 按 kind 单飞（同一 kind 同时只跑一个，EXISTS 原子加锁）· MCP 同步只入库「账号可操作（`wb.jobs.list` 24 个）∩ 沉睡」，`under_served` page_size 提到 200（100 页→14 页，拉取减 7 倍）· `jobs` 新增 `operability_status`（迁移 0006：actionable / not_in_access_scope / match_unavailable / source_incomplete）· 不可操作的上游仍沉睡职位标记 `not_in_access_scope`（**非 closed**），closeStale 只关闭真正未见的 · `job_details_jobs` 改为 DB 驱动 + `wb.jobs.get` 补 JD（只对可操作∩沉睡缺 JD 职位调用）。**真实同步实测：771 个沉睡收敛到 2 个可操作**（767 标记不可操作，2 个关闭）。

#### 已实现（implemented）

- 串行化：`async-task-repository.claimDueTasks` 加 per-kind cap（`not exists running` + `not exists earlier` 行比较取最早，`FOR UPDATE SKIP LOCKED` 跨进程原子）；`.d.mts` 更新。
- 可操作收敛：`under-served-sync.runUnderServedSync` 先 `wb.jobs.list` 拉可操作集（page_size 200 拉 under_served），只持久化可操作∩7-30 天；`markOperabilityStatus` 批量标记 seen 不可操作职位为 `not_in_access_scope`；closeStale 改用完整 seen 集（不误标不可操作为 closed）；stats 加 `operable`/`inoperableSeen`（审计白名单同步）。
- JD 补全：`job-details-sync` 改为 DB 驱动——查询可操作∩沉睡缺 JD 职位，逐个 `wb.jobs.get(job_id)` 补全（单职位失败计数 `failed` 跳过，不毒化整轮）；白名单收紧到 `[wb.jobs.get]`；新增 `parseJobsGetResult` 契约（含权限边界码）。
- 数据模型：`schema.ts` `jobs` 加可空 `operability_status`（迁移 0006）；读仓储 `listUnderServedJobs` 只展示 `actionable`（null 兼容迁移过渡）。

#### 已验证（verified）

- `npm run lint` 0 问题；`npm run build` 通过。
- `npm run test:unit` 109 通过；`npm run test:integration` 28 通过（新增串行化认领 3 场景、可操作过滤/不可操作标记/沉睡视图收敛、DB 驱动 JD 补全命中幂等 null 安全单职位失败）。
- **真实 MCP 同步**（2026-08-13）：eligible 769 / operable 24 / persisted 2 / inoperableSeen 767 / closedStale 2；`operability_status` 分布 2 actionable + 767 not_in_access_scope；沉睡视图 771 → 2（搜推算法leader / 搜推架构leader）。
- **受控能力验证**：`wb.jobs.get` 对沉睡职位（含非可操作）均 Code=0 + JD；`match_candidates` 对交集职位 Code=0（score_status cached/pending 均正常态），`score_status=pending` 为 LLM 打分中非失败；可操作边界 = `wb.jobs.list`（match_candidates 成功）。

> 已知边界：`match_unavailable`/`source_incomplete` 状态为未来匹配工作流预留，当前同步只写 `actionable`/`not_in_access_scope`；宽口径由 `ADR-005` 已确认的授权 Web 数据源承接，适配器尚未实现。

### 2026-08-13 — 手动同步去重 + 同步状态反馈与自动刷新

> 状态速览：`/api/sync/under-served` 手动触发去重（`enqueueTaskIfIdle` 原子保证同 kind 至多一个活跃任务，重复点击/并发触发返回 `deduplicated:true` + 既有任务 id）· 调度 tick 加任务看门狗（回收 running 超 30 分钟的任务为 `TASK_STALE_TIMEOUT`，防止卡死任务永久锁死去重守卫）· 前端「同步职位」按钮不再只显示「已触发」，改为完整状态机：已入队（等待调度 tick）→ 同步中 → 同步完成：{persisted} 个职位 / 同步失败：{errorCode}，终态后自动刷新列表与「最近同步」时间戳。根因：此前 5 次点击 = 5 个并发同步任务同时打 MCP 触发限流/假死（「点完无事发生」）；同步拉不全（maxPages 截断）+ 从不清洗陈旧职位导致 DB 沉睡数堆积 771 vs 真实约 366（后者属 maxPages 修复范畴，见 docs/05 后续）。

#### 已实现（implemented）

- `async-task-repository.mjs` 加 `enqueueTaskIfIdle`（原子活跃守卫）、`findActiveTask`、`failStaleRunningTasks`（任务看门狗）+ `.d.mts`。
- `app/api/sync/under-served/route.ts` 改用 `enqueueTaskIfIdle`，活跃拦截返回 `{ accepted:false, taskId, deduplicated:true }`（202）；审计元数据加 `deduplicated`。
- `sync-scheduler.mjs` `processDueTasks`/`runScheduledTick` 加任务看门狗（默认 30 分钟阈值）+ `staleReclaimed` 计数 + `.d.mts`。
- 前端 `operations-dashboard.tsx`：同步状态机（`SyncTriggerState`）+ 轮询 `/api/sync-runs`（活跃窗口每 10s，终态即停，基线 = 触发瞬间最新批次 id）+ 终态 `reloadSeq` 自动刷新列表 + 状态 chip（已入队/同步中/完成/失败）；`ops-client.ts` `triggerSync` 返回类型加 `deduplicated`；`globals.css` 加 `.sync-live`（ok/warn/fail）。

#### 已验证（verified）

- `npm run lint` 0 问题；`npm run build` 通过。
- `npm run test:unit` 109 通过；`npm run test:integration` 26 通过（新增手动同步去重 5 场景 + 任务看门狗回收/去重守卫释放 + tick 级 staleReclaimed；HTTP 触发匿名 401）。
- 真实 E2E（host `vinext start` + 真实 MCP）：点击同步 → 「已入队，等待调度执行」→（调度认领）「同步中…」→「✓ 同步完成：366 个职位」+ 列表/最近同步自动刷新；重复点击只入队 1 个任务。
- 遗留清理：回收了此前 7 个卡死 running 任务（多次点击 + 假死）——去重 + 看门狗上线后不再复现。

> 已知取舍：轮询走已审计端点 `/api/sync-runs`，活跃窗口内每次轮询落一条审计（约 100+ 条/次同步），属既有审计量级内，若需收敛可加非审计轻量状态端点（后续讨论）。

### 2026-08-13 — 职位详情（完整 JD）入库 + 管理端查看

> 状态速览：`jobs` 新增 `job_description` 列（迁移 0005）· 新增独立 `job_details_jobs` 同步（`wb.jobs.list` 分页拉取 → 按 external_id 补全 JD，独立 `job_details_sync` 任务 kind，与 dormant 同步互不毒化）· `GET /api/jobs/:id` 详情端点（会话 + RBAC operations/admin，审计元数据白名单不含 JD 正文）· 前端洞察面板按选中职位拉取并展示「职位详情（完整 JD）」（loading/错误/空态，`›` 按钮接线）· docs/04 决策反转：`wb.jobs.list` 从「不纳入 MVP 数据源」改为「内部 JD 补全」。两层匹配不做（继续 `match_candidates`），`matching` 模块零改动。

#### 已实现（implemented）

- 数据模型：`schema.ts` `jobs` 加可空 `job_description` 列，`drizzle/0005_charming_magneto.sql`（`ALTER TABLE jobs ADD COLUMN job_description text`）。
- 契约：`mcp-under-served-contract.mjs` 加 `parseJobsListResult`（job_id 必填、job_description 可空、403/1003/1004 权限边界码复用）；新虚构化 fixture `wb-jobs-list-response-2026-08-13.json`（忠实保留 salary/customer_name/department_path/created_by/status 形状，内容虚构化）。
- 同步补全：新 `lib/jobs/job-details-sync.mjs` `runJobDetailsSync`（独立 `job_details_jobs` sync_run、`wb.jobs.list` 白名单收紧）；`job-sync-repository` 加 `updateJobDescriptions`（逐行 UPDATE，null 安全不抹既有 JD、`IS DISTINCT FROM` 幂等、不 bump `updated_at`）；`sync-scheduler` 加 `job_details_sync` 任务 kind + 幂等入队 + `runSyncForTask` 按 kind 分发 + 审计键 `detailsSeen/detailsMatched/detailsMissing`；`createDefaultCallTool` 支持 `allowedTools` 覆盖。
- 读仓储/API：`job-read-repository` 加 `getJobById`（详情投影含 `jobDescription`，不含 `portal_url`）；新 `app/api/jobs/[id]/route.ts`（withAudit、URL 解析 UUID、400/404）。
- 前端：`ops-client.ts` 加 `JobDetail` 类型 + `fetchJobDetail`；`operations-dashboard.tsx` 洞察面板加「职位详情（完整 JD）」区（loading/错误/空态），`›` 按钮接线，请求序号 ref 防竞态。
- CLI：`scripts/run-job-details-sync.mjs` + `npm run sync:job-details`（手动首轮回填）。

#### 已验证（verified）

- `npm run lint` 0 问题；`npm run build` 通过（路由表含 `/api/jobs/:id`，静态 `under-served` 优先不被 `[id]` 遮蔽）。
- `npm run test:unit` 109 通过（含 parseJobsListResult + fixture 虚构化守卫、job-id 解析、jobs.detail 审计元数据不含 JD）。
- `npm run test:integration` 23 通过（含 job-details-sync 入库/幂等/NULL 安全/失败路径、getJobById 投影/未知 404、async-task-sync 双 kind 调度）。
- `rendered-html` + `http-read` 4 通过（动态详情路由匿名 401、源 marker「职位详情（完整 JD）」/「暂无详情」）。
- `make db-migrate` 幂等复验（0005 重复应用安全跳过）。

> 已知边界：真实 `wb.jobs.list` 补全未在本轮做受控联调（fixture 驱动 + 上游已验证）；若 under_served 部分职位不在 `wb.jobs.list`，详情显示「暂无详情」——数据缺口不改变口径。raw_records 不对 `wb.jobs.list` 载荷做原始快照（属规范化字段补全，非新实体），已记录于 docs/04。

### 2026-08-13 — 客户端会话心跳（tab 开着不因静默掉线）

> 状态速览：前端每 5 分钟静默调 `/api/auth/me` 续期服务端会话空闲窗口（空闲 30 分钟窗口多次续期），tab 开着即保持登录；会话真正失效（401 / 12h 上限）才回落登录。会话逻辑本身验证无误（空闲 30min / 最长 12h，触碰随每次 API 请求刷新），此前「静默被踢」是前端无轮询、空闲窗口到期所致。

#### 已实现（implemented）

- `operations-dashboard.tsx` 新增会话心跳 effect：`view=app` 时 `setInterval` 每 5 分钟调 `meRequest()`（服务端 `getSessionUser` 触碰续期），401 时 `handleAuthExpired` 回落登录；登出/切视图时 `clearInterval`。
- 心跳走 `/api/auth/me`（无 withAudit），不产生审计噪音。

#### 已验证（verified）

- 会话逻辑复验：登录后 `idle_expires_at=+30min`，业务请求后刷新（curl 实测）；cookie `Max-Age=43200`；主机/容器/db 时钟一致。
- `npm run build` 通过；`eslint` 0 问题。

### 2026-08-13 — 本地真实职位数据 + 页面手动同步按钮 + dev 定时调度

> 状态速览：真实 MCP 数据本地入库（全量 2799 看到 / 771 条沉睡职位，6 条示例已关闭）· `POST /api/sync/under-served` 手动同步端点（入队 async_tasks）· 页面「同步职位」按钮解禁接线 · dev compose 增 `scheduler` 服务 + 本地 `sync:tick --loop` · 契约放宽 category 空值（真实数据 category 为空致 `MCP_CONTRACT_INVALID`）· 单元 11 契约通过 + 构建注册新路由

#### 已实现（implemented）

- 契约修复：`mcp-under-served-contract.mjs` 的 `category` 放宽为可空（真实供应商数据 category 为空串），`requireCompanyOrCityString` 更名为通用 `requireStringOrEmpty`（公司/城市/类别共用），补空值用例。
- 本地真实数据：`.env.local` 补齐 `APP_ENCRYPTION_KEY`/`KEY_VERSION`/`DATABASE_URL`；`npm run sync:under-served` 全量拉取真实 `wb.jobs.under_served`（2799 看到 → 771 条 7–30 天沉睡入库，6 条旧示例职位被 `closeStaleUnderServedJobs` 关闭）；页面沉睡职位列表现为真实公司数据（阿里巴巴/小红书/蚂蚁金服等 + 部分空公司名）。
- 手动同步端点：新增 `POST /api/sync/under-served`（会话 + RBAC operations/admin + withAudit 审计 + CSRF 同源校验）——入队 `under_served_sync` 任务（`scheduled_at=now`，幂等键唯一）立即返回 `202 { accepted, taskId }`，由调度 tick 异步认领执行，不在请求内长同步。
- 前端接线：`ops-client.ts` 增 `triggerSync()`；jobs 页「同步职位」与 sources 页「立即同步」按钮解禁，触发后显示「同步中…/已触发」，401 回落登录。
- dev 定时调度：`docker-compose.yml` 增 `scheduler` 服务（同一 development 镜像 + `.env.local` env_file + `node scripts/run-scheduled-tick.mjs --loop`，每 15 分钟 tick）；本地亦可用 `npm run sync:tick -- --loop` 起循环。
- 契约文档：`docs/09-api-contract.md` 增 §2.4「业务写：同步触发」。

#### 已验证（verified）

- 真实数据：`npm run sync:under-served` 全量成功（pages 94 / seen 2799 / persisted 771 / closedStale 6）；DB 校验 active 771 / closed 6，真实公司名可见。
- 闭环：手动入队任务（模拟按钮）→ `npm run sync:tick` 认领执行 → 新 `sync_runs` running + `async_tasks` succeeded，链路通。
- `npm run build`：通过，路由表含 `/api/sync/under-served`。
- 契约单测：`mcp-under-served-contract.test.mjs` 11 通过（含 category 空值）。
- 说明：docker web 容器当前未运行（并发部署工作/环境变动所致，数据在 DB 不受影响）；本地调度先以 `npm run sync:tick -- --loop`（host）验证，docker `scheduler` 服务待镜像重建网络恢复后生效。

### 2026-08-12 — 路线图变更：M1 生产部署门禁顺延，M2 正式启动

> 状态速览：项目负责人决策「服务器实际部署」不构成 M1 退出阻塞，随开发推进到对应里程碑时执行（开发到哪就部署）· M1 其余 9 条退出门禁逐条对照本日志 verified 证据后勾选 · M1 标记已完成、M2 标记进行中 · 纯文档/路线图变更，不宣称新功能实现

#### 规范已确认（specified）

- M1 退出门禁移除实际部署要求：云服务器 `docker compose up -d`、域名/HTTPS 不构成 M1 退出阻塞，顺延至开发推进到对应里程碑时执行；配置层面分离已就绪（`.env.production` gitignored、生产 compose 独立 env_file、生产镜像 target、生产 compose 用 postgres:17-alpine 与同一迁移），作为部署时的验收依据（验收标准 §6 范围注记）。
- M1 其余退出门禁逐条核对（依据既有 verified 记录）：标准根目录 compose 拉起 Web/PostgreSQL/迁移 + 健康检查（2026-08-11 数据底座）；开发/测试同套 PostgreSQL 17 迁移幂等（`make db-migrate` 复验）；测试 MCP 分页同步 + 重复同步不重复（M0 真实联调 + under-served-sync 集成测试）；Fixture 登录 fail-closed（seed-dev-gate + prototype-view 非生产门禁）+ 未知账号/已禁用用户/无权限角色服务端拒绝（identity-service 登录与会话双路径）；三角色服务端授权测试（authz/identity-service 单测 + HTTP 层测试）；加密落库可追溯 + 重复同步不覆盖原始快照（集成测试 + `jobs.mapping_version`）；审计无敏感字段 + 追加写触发器（敏感边界复验 + guard 集成测试）；保留清理任务可配置 TTL + `retention.run` 审计（retention 集成测试）；验证证据已入本日志。
- 备份/恢复演练（验收标准 §6「删除流程覆盖可恢复备份的生命周期」与 §5 演练）随 M4 退出门禁执行，不属 M1。
- 遗留依赖：M0 卡点「供应方对 `wb.jobs.match_candidates` 评分/超时口径确认」仍开放，作为 M2 匹配分实现与验收的已知前置。

#### 已验证（verified）

- 纯文档/路线图变更，无业务 RED；执行 `git diff --check` 与受改 markdown 相对链接检查通过。

### 2026-08-12 — M1 测试/生产部署基线（云服务器 · docker compose 编排）

> 状态速览：`docker-compose.prod.yml`（web + db + scheduler）`docker compose up -d` 拉起 · `npm run sync:tick` CLI（含 `--loop`，scheduler 服务每 15 分钟触发任务表）· `.env.production.example` + Dockerfile HEALTHCHECK · 单元 93 + 集成 18 + 渲染 3 通过 · 修复 audit-guard 测试激进 cutoff 的并发删除 bug

#### 已实现（implemented）

- 新增 `docker-compose.prod.yml`（仓库根，生产编排）：`db`（postgres:17-alpine + 持久卷 + healthcheck）、`web`（`build: {context: ./apps/web, target: production}` + `env_file: .env.production` + 端口 3000 + depends_on db healthy）、`scheduler`（同一生产镜像 + `command: node scripts/run-scheduled-tick.mjs --loop`）。项目为 Next.js 式全栈单进程，一个应用镜像 + 一个 PostgreSQL，无前后端分离双镜像。
- 新增 `scripts/run-scheduled-tick.mjs` + `npm run sync:tick`：Node CLI 调 `runScheduledTick`（任务表调度器），单次模式（DATABASE_URL/加密 key 预检、JSON 输出、异常非零退出）+ `--loop --interval-minutes`（默认 15，setTimeout 链避免重叠，供 scheduler 容器常驻）；配置从 `process.env`（容器 `env_file` 注入）读取，缺 MCP 凭证时任务失败安全。
- 新增 `.env.production.example`：`POSTGRES_*`、`DATABASE_URL`（`@db:5432`）、`APP_ENV=production`、加密 key、MCP 凭证、`SYNC_*`；`.env.production` 已被 `.gitignore` 排除。
- `apps/web/Dockerfile` production target 加 `HEALTHCHECK`（node fetch 探活，容器内无 curl）。
- 文档：README「部署（云服务器）」章节 + 当前阶段；`02-architecture.md` §6 修正（MVP 生产用 docker compose 编排，替换「Docker Compose 不作为生产编排」）+ §5 定时器口径对齐；`05-roadmap.md` 勾选。
- 修复 `tests/audit-guard.integration.test.mjs` 的并发删除 bug：`deleteExpiredAuditLogs({ cutoff: new Date() })` 会全删并发其他测试的新审计行，改为 200 天前 cutoff（只删 400 天旧夹具行）；同步把 `audit-read` 测试的 result 过滤改为夹具范围（action + result 双条件）。

#### 已验证（verified）

- 新 `tests/scripts/sync-tick-cli.unit.test.mjs`（4 用例）：缺 `DATABASE_URL`/加密 key → exit 2 + 明确 stderr；`--interval-minutes` 非法/0 → exit 2。RED = 脚本缺失。
- `docker compose -f docker-compose.prod.yml config` 语法校验通过（web/db/scheduler + production target + env_file 注入）。
- `node scripts/run-scheduled-tick.mjs`（容器内）冒烟：缺加密 key → `ENCRYPTION_CONFIG_REQUIRED` fail-safe 退出；tick 逻辑由 `async-task-sync` 集成测试（假 MCP + 真实 DB）权威覆盖。
- 回归实际运行：`npm run test:unit`（93，含新增 4）、`npm test`（构建 + rendered-html 3）、`npm run test:integration`（18，连跑 10 次稳定）、`npm run lint`、`make db-migrate`（幂等）、`git diff --check`、受改 markdown 相对链接检查。
- `vinext start` 作为独立 Node 生产服务器已实测（端口 3999 HTTP 200 + 登录页）；Docker production 镜像构建受本机 Docker Desktop registry 网络阻断（`docker/dockerfile:1.7` EOF，环境问题），以宿主机 `vinext start` 路径 + compose config 校验为凭据。

> 说明：实际部署到云服务器（上传 `docker-compose.prod.yml` + `.env.production`、`docker compose up -d`、域名/HTTPS）需用户基础设施就绪后按 README「部署（云服务器）」执行；Cloudflare Worker 部署保留为可选路径（不构成生产承诺）。M1 实现项已全部勾选，剩外部部署与退出门禁验证证据整理。

### 2026-08-12 — 引入持续集成（GitHub Actions + make ci）

> 状态速览：`.github/workflows/ci.yml` 分层流水线（静态 → 单元/契约 → 迁移 → 集成 → 构建/渲染/HTTP）· `make ci` 本地同路径 · markdown 相对链接检查脚本 · 修复 2 处既有断链 · 兑现 ADR-002 §44「迁移必须在 CI 中验证」

#### 已实现（implemented）

- 新增 `.github/workflows/ci.yml`：push（`main`/`dev`）与 PR 触发；Node 22 + `npm ci`（不走 compose 镜像，避免烘焙陈旧 package.json）；PostgreSQL 17 服务容器 + `node db/migrate.mjs` 后跑集成测试；分层：空白门禁 → markdown 链接 → ESLint → `test:unit` → 迁移 → `test:integration` → 构建 + rendered-html + http-read。
- `Makefile` 新增 `make ci`：与 CI 同路径的本地流水线（`docker compose build web` 重建镜像解决非挂载文件陈旧 → 迁移 → lint/unit/integration → 构建 + 渲染 + HTTP → md 链接检查）。
- 新增 `scripts/check-md-links.mjs`：全仓 markdown 相对链接检查，纳入 CI 与 `make ci`；修复 `.claude/commands/review.md` 既有断链（`../docs` → `../../docs`）。`docs/02` 部署基线改写中新引入的 README 链接已校正为 `../README.md`（随该改写一并入库，不在本批）。
- 文档同步：`docs/08-development-workflow.md` §4 增「CI 实现（GitHub Actions）」小节。
- ADR 检查：GitHub Actions 对 GitHub 仓库属局部可替换工具链实现（同既有 git hooks），不构成长期平台绑定，无需新 ADR。

#### 已验证（verified）

- `node scripts/check-md-links.mjs`：通过（26 个文件，0 断链）。
- `make ci` 等价流水线实跑：lint / `test:unit`（89）/ 迁移（幂等）/ `test:integration`（18）/ 构建 + rendered-html（3）+ http-read（容器内）/ md 链接 —— 全绿，见下条验证记录。
- workflow YAML 语法与本地流水线各步骤逐一对应；实际 GitHub Actions 运行需推送到远程后观察（本批未执行远程触发）。

### 2026-08-12 — 部署基线方向修正：自托管 Node 容器（文档）

> 状态速览：生产平台由「已选 Cloudflare Workers」拨回「自托管 Node 容器于自有云服务器」· Cloudflare Worker 降为可选路径 · 同步触发方式中立化（服务器级定时器 / Worker scheduled）· 纯文档变更，不宣称部署已实现或验证

#### 已实现（implemented）

- 权威文档修正：`docs/02-architecture.md` §5/§6（生产基线改为自有云服务器 Node 容器，CF 降为可选路径）、`docs/05-roadmap.md`（M1 部署基线条目由 `[x]` 拨回 `[ ]`）、`docs/08-development-workflow.md` §3（worker 描述中立化）、`README.md`（当前阶段与「部署」章节改为自托管容器步骤）、`.env.example`（Secret 注入改容器环境变量，HYPERDRIVE/wrangler 注释降为可选）。
- 对齐 ADR-001「不构成生产平台承诺」：保留 dev/prod 构建分离与产物守卫等安全实践作为构建块，生产平台决定权回归项目负责人。
- 后续实现项（未做，已在路线图登记）：`apps/web/Dockerfile` 生产 target 起容器、Secret 经容器环境变量注入、服务器级定时器（systemd timer / PM2 cron / node-cron）触发同步 tick、自托管路径端到端验证。

#### 已验证（verified）

- 纯文档/配置变更，无业务 RED；执行 `git diff --check` 与受改 markdown 相对链接检查通过。
- 本批不宣称自托管部署已实现或验证；M1 部署基线条目保持未勾选，待实现与验证后回填。

### 2026-08-12 — 审查改进建议修复（I1–I16）

> 状态速览：base32 padding 兼容 · 加密已知向量 + 按 key_version 选钥 · 同步看门狗 · 分页 page 上限 · 触发器 schema 注释 · 前端分页上限/AbortController/dead 态/数据源错误态 · salaryUnit 死字段清理 · 脱敏守卫强化 · HTTP 层鉴权测试 · Fixture 手机号/邮箱守卫 · outputSchema 形状校验 · portal_url 边界固化 · 文档一致性 · 单元 89 + 集成 18 + 渲染 3 通过，HTTP 层测试容器内通过

#### 已实现（implemented）

- I1：`lib/identity/totp.mjs` `decodeBase32` 兼容标准 base32 尾部 padding，带 padding 的 TOTP secret 校验不再抛 `TypeError`。
- I2：`encryptJsonPayload` 支持注入 `nonce`（测试已知向量），新增 AES-256-GCM 固定 key/nonce 密文与哈希回归断言。
- I3：`decryptJsonPayload` 支持按 `keyVersion` 从 `keys` 映射选钥（多版本须带版本、单版本无歧义回落、未知版本明确报错），密钥轮换就绪。
- I4：`job-sync-repository.mjs` 新增 `failStaleRunningSyncRuns` 看门狗，`runUnderServedSync` 开跑前回收崩溃残留的 `running` 运行为 `failed` + `RUN_STALE_TIMEOUT`。
- I5：`db/schema.ts` `audit_logs` 处注明追加写触发器 `guard_audit_logs` 由迁移 0003 维护、drizzle-kit 不重建但持久生效。
- I6：`lib/server/pagination.mjs` 增加 `maxPage`（默认 100 万）上限，超大 page 明确拒绝而非 offset 溢出 500。
- I7：沉睡职位客户端分页拉取加页数上限（50 页）与 `AbortController` 卸载中断；`fetchDormantJobs` 支持 `signal`。
- I8：`SYNC_STATUS_VIEW` 补 `dead` 态（失败（超限）），与 async_tasks 5 态一致。
- I9：数据源页 fetch 失败显示明确错误态，与空库区分（401 仍回落登录）。
- I10：`toPublicJobView` 移除死字段 `salaryUnit`（数据路径从不填充），同步清理 `job-rules.d.mts`。
- I11：`rendered-html` 守卫定位注释明确（SSR 无业务数据，属名义性烟雾检查）；权威脱敏断言在 `job-rules.test.mjs`（序列化后不残留公司/详细地址）。
- I12：新增 `tests/http-read.integration.test.mjs` HTTP 层测试（构建后 Worker：无会话 401、空/畸形 Cookie 401、跨源写 CSRF 403、坏请求 400），接 `npm test` 构建后执行；带 DB 的 HTTP 用例受 postgres workerd 编译限制（`cloudflare:` socket）在 Node 不可跑，由逻辑层测试覆盖并记录。
- I13：`match-candidates` 与 `under-served` 脱敏 Fixture 守卫补手机号/邮箱/真实域名模式扫描。
- I14：`mcp-discovery` 对 `outputSchema` 做运行时形状校验（非对象拒绝、null 视为未声明），`.d.mts` 允许 null。
- I15：docs/04 固化 `portal_url` 边界——仅加密存于 `raw_records.payload_ciphertext` 与 `jobs.portal_url`，业务只读 API 投影不返回任何 `portal_*`/`raw_records` 字段，作可触达令牌前须单独确认。
- I16：`docs/decisions/README` 补 ADR-004 索引；roadmap M0 勾选与「已由项目负责人确认」口径对齐；docs/08 §3 仓库结构更新为实际布局；docs/03 §12 异常响应保留补「问题关闭后 30 天，最长 90 天」投影。

#### 已验证（verified）

- 实际运行命令：
  - `npm run test:unit`：89 通过（本批新增 7：totp padding、加密已知向量/版本选钥、分页上限、Fixture 守卫 2、outputSchema 校验）。
  - `docker compose run --rm web npm run test:integration`：18 通过（本批新增 1：同步看门狗）。
  - `npm test`（build + rendered-html 3 + http-read 容器内）：退出 0。
  - 本批改动文件 `npx eslint`：0 问题。
- 已知限制（I12 记录）：构建后 Worker 的 `postgres` 为 workerd 专用编译，Node 中带 DB 的 HTTP 用例无法运行；DB-free 的 HTTP 鉴权/CSRF/包络用例容器内通过。

### 2026-08-12 — M1 真实定时调度：数据库任务表同步调度器

> 状态速览：`async_tasks` 表 + 同步调度器（周期幂等入队 / `FOR UPDATE SKIP LOCKED` 认领 / 退避重试 / 超阈值 dead）+ Worker `scheduled` 处理器（cron 每 15 分钟 tick）+ `sync.run` 系统审计 · 单元 75 + 集成 17 通过 · 调度路径由集成测试（假 MCP + 真实 DB）权威验证

#### 已实现（implemented）

- 新增 `async_tasks` 表（迁移 `0004_chilly_zaladane`）：`kind`/`idempotency_key`（唯一）/`status`（`pending/running/succeeded/failed/dead`）/`payload`（白名单 jsonb，同步任务只含 source 身份）/`attempts`/`scheduled_at`/`started_at`/`finished_at`/`last_error_code`/`next_attempt_at` + `(status, scheduled_at)` 调度索引。
- 新增 `lib/jobs/async-task-repository.mjs`：幂等入队（`ON CONFLICT DO NOTHING`）、原子认领（`FOR UPDATE SKIP LOCKED`）、终态/退避状态流转。
- 新增 `lib/jobs/sync-scheduler.mjs`：纯函数 `syncPeriodKey`/`buildSyncIdempotencyKey`/`decideTaskOutcome`/`nextRetryDelayMs`；`runScheduledTick` 先按周期幂等入队同步任务（默认 6 小时一个槽位）再处理到期任务——网络类错误（`McpDiscoveryError.retryable`，限流/超时/连接）指数退避重试、业务/配置错误不重试、超阈值 `dead`；每个任务完成写 `sync.run` 系统审计（`actor_type=system`、`request_id=task.id`、metadata 仅计数/`errorCode`）。
- `worker/index.ts` 增 `scheduled` 处理器：`runWithEnv` 包裹 + `getDb().client` 显式建一次并关闭；配置（加密/MCP/同步源）从 Worker env 绑定解析；`vite.config.ts` 声明 cron（`triggers.crons = ["*/15 * * * *"]`，部署后生效）。dev 缺省无凭证时按失败安全处理（机器可读错误码）。
- `runUnderServedSync` 失败结果追加 `retryable`（读 `McpDiscoveryError.retryable`）；`createDefaultCallTool` 导出并支持 `{ env }`（MCP 配置从 Worker 绑定解析，兼容旧字符串 actorId 调用）。
- 前端数据源页「立即同步」tooltip 更新为「同步由 CLI 或定时任务触发」；`.env.example` 增 `SYNC_SOURCE_PROVIDER`/`SYNC_SOURCE_DISPLAY_NAME`/`SYNC_INTERVAL_HOURS`（非密钥）。
- 新增 `tests/jobs/sync-scheduler.unit.test.mjs`（4）与 `tests/async-task-sync.integration.test.mjs`（6：成功/网络退避重跑/业务失败不重试/超阈值 dead/幂等入队/配置缺失）。

#### 已验证（verified）

- RED：单元测试因 `sync-scheduler.mjs` 缺失 `ERR_MODULE_NOT_FOUND`；集成测试因 `async_tasks` 表不存在正确 RED。
- 实际运行命令：
  - `docker compose run --rm web npm run test:unit`：75 通过（含新增 sync-scheduler 4）。
  - `docker compose run --rm web npm test`：Vinext 构建完成（含 `scheduled` 处理器 + cron 声明）、rendered-html 3 通过。
  - `docker compose run --rm web npm run test:integration`：17 通过（含新增 async-task-sync 6；audit-read 分页断言改为夹具范围，规避共享 DB 并发脆弱性）。
  - `docker compose run --rm web npm run lint` 通过；`git diff --check` 通过；受改 markdown 相对链接检查通过。
  - `make db-migrate`：迁移幂等复验通过（`0004` 安全跳过）。
- 调度路径验证：集成测试为权威证明——假 MCP + 真实 PostgreSQL：enqueue→process 成功（task `succeeded`、职位入库、`sync.run` 审计 system actor + 计数 metadata）、网络错误退避回 `pending`（attempts+1、`next_attempt_at` 门控）到期重跑成功、业务错误 `failed` 不重试、超阈值 `dead`、同周期重复入队幂等、配置缺失 `ENCRYPTION_CONFIG_REQUIRED` 失败安全且不写 `sync_runs`。
- dev server 未暴露 wrangler `--test-scheduled` 路径（`POST /__scheduled` → 404），cron 触发待部署后生效；`scheduled` 处理器接线由构建（worker 编译含 scheduled 导出）+ 集成测试（`runScheduledTick` 即处理器调用函数）覆盖。
- 敏感边界复验：`async_tasks.payload` 仅 source 身份；`sync.run` 审计 metadata 仅计数/`errorCode`，无凭证、原始载荷、简历正文；测试后 DB 无 `async_tasks`/`sync.run` 残留。

> 说明：运维直连路径 `npm run sync:under-served` 保持 CLI 直接执行（携带真实 MCP 凭证）；自动化定时路径配置从 Worker env 绑定解析（加密/MCP 凭证在部署基线条目配置，真实数据上线仍以 M0 授权门禁为准）。`async_tasks` 扩展到摘要/匹配/发送（M2+）复用同表。

### 2026-08-12 — 审查规范问题修复（N1–N12）

> 状态速览：首登强制改密服务端强制 · 种子脚本 fail-closed · 运行时环境判定接线 Worker 绑定并回落告警 · 写路由 CSRF 同源校验 · 同步后关闭陈旧沉睡职位 · 推荐计数 NULL/0 同义 · MCP 公司/城市可为空 + 权限边界错误码 · prototype 头非生产门禁 · 业务请求 401 回落登录 / 403 明确无权限 · 单元 82 通过（本批新增 14）+ 集成 17 通过 · 本批此前记录的两处偏差（rendered-html title 失配、ops-read 真值 0）已修复

#### 已实现（implemented）

- 首登强制改密服务端强制（审查 N1）：`lib/server/with-audit-gate.mjs` 新增纯函数判定，`lib/server/with-audit.ts` 在 `allowedRoles` 业务只读端点校验 `passwordChangeRequired`，未改密返回 403 `password_change_required`（denied 审计）；登录/改密/me/logout 认证路由不受影响。
- 种子脚本门禁 fail-closed（审查 N2）：`scripts/seed-dev-users.mjs` 不再缺省 development 放行，须显式 `APP_ENV=development`/`NODE_ENV=development`，防止误对生产 `DATABASE_URL` 用公开 fixture 凭据建号。
- 运行时环境判定（审查 N3）：`lib/server/runtime-env.ts` 优先读 Worker `env.APP_ENV` 绑定（生产经 wrangler vars 注入是权威来源），再回落 `process.env`；两者均未声明时回落 development 并**显式告警**，避免生产漏配时静默关闭 TOTP 强制与 Secure Cookie。
- 写操作 CSRF 防护（审查 N4）：新增 `lib/identity/csrf.mjs` 同源校验（Origin vs 请求自身 origin），`login`/`logout`/`password` 三个 POST 写路由入口执行，补齐 ADR-003/004 与 docs 已登记的缺口。
- 同步后关闭陈旧沉睡职位（审查 N5）：`lib/jobs/job-sync-repository.mjs` 新增 `closeStaleUnderServedJobs`，`under-served-sync.mjs` 在全量同步成功后关闭本次未出现的 active 7–30 天职位（`maxPages` 截断时跳过），退出沉睡列表；`stats.closedStale` 记数。
- 推荐计数 NULL/0 口径（审查 N6）：`job-read-repository.mjs` 沉睡查询同时纳入 `NULL` 与真值 `0`；`job-sync-repository.mjs` upsert 不再用 `NULL` 覆盖既有 `valid_recommendation_count`。
- MCP 契约放宽 + 权限边界错误码（审查 N7/N8）：`mcp-under-served-contract.mjs` 公司/城市接受空/null（归一空串入库，满足 NOT NULL），非字符串仍拒绝；新增 `MCP_PERMISSION_BOUNDARY`（403/1003/1004）与 `MCP_UPSTREAM_ERROR` 区分，供调用方按「不重试/不换身份」处理。
- `x-prototype-view` 非生产门禁（审查 N9）：`app/page.tsx` 仅在非生产环境放行 prototype 头，`tests/rendered-html.test.mjs` 显式声明 `APP_ENV=development`（vite 构建会把 NODE_ENV 烘焙为 production）。
- 审计 await 与前端会话/权限处理（审查 N10/N11/N12）：`password` 路由失败分支补 `await writeAudit`；`operations-dashboard.tsx` 业务请求 401/`password_change_required` 统一回落登录、403 显示「无权限访问该数据」，`handleAuthExpired` 经 `useCallback` 稳定透传子页面。
- 新增测试：`tests/identity/csrf.test.mjs`、`tests/server/with-audit-gate.test.mjs`；扩展 `tests/identity/seed-dev-gate.test.mjs`（未声明环境拒绝）、`tests/mcp-under-served-contract.test.mjs`（空公司/城市、权限边界码）、`tests/ops-read.integration.test.mjs`（真值 0 纳入 + 重同步不覆盖）、`tests/under-served-sync.integration.test.mjs`（陈旧关闭）；`package.json` test:unit 清单同步。

#### 已验证（verified）

- RED：本批新增用例在对应行为缺失时先失败（seed 未声明环境放行、契约拒绝空公司/城市、单码折叠、沉睡忽略真值 0、陈旧职位不关闭）。
- 实际运行命令（本批范围）：
  - `node --test`（tests/identity/csrf + tests/server/with-audit-gate）：7 通过。
  - `npm run test:unit`：82 通过（本批新增 14；含并发在途 sync-scheduler 用例）。
  - `docker compose run --rm web npm run test:integration`：17 通过（本批新增 2：陈旧关闭、真值 0/不覆盖）。
  - `docker compose run --rm web npm test`：退出 0，rendered-html 3/3。
  - 本批改动文件 `npx eslint`：0 问题。
- 已知偏差（非本批引入，来自并发参与者在途改动）：工作区 `make check` 仍因 `lib/jobs/sync-scheduler.mjs`（`now` 未用）与 `worker/index.ts`（`ctx` 未用）报 2 个 lint error，文件不在本批范围，交由并发参与者收尾。

### 2026-08-12 — 登录安全加固：TOTP 计入锁定 + 生产首管理员 TOTP 预置

> 状态速览：TOTP 校验失败计入连续失败锁定（堵 MFA 无限爆破）· `init-admin` 预置随机 TOTP 密钥并输出 otpauth URI（解首管理员登录死锁）· 单元 70 通过 · 全量套件受并发在途改动阻塞，见「已知偏差」

#### 已实现（implemented）

- 修复 TOTP 无节流（审查 S1）：`lib/identity/identity-service.mjs` 登录流程调整——TOTP 校验失败同样 `recordLoginFailure`（阈值 5 次/锁定 15 分钟），仅口令 + TOTP 全部通过后 `resetLoginFailures`；杜绝正确口令下对 6 位动态码的无限爆破。
- 修复生产首管理员引导死锁（审查 S2）：`lib/identity/totp.mjs` 新增 `generateTOTPSecret`（20 字节 base32）与 `totpProvisioningUri`（标准 otpauth URI）；`scripts/init-admin.mjs` 创建管理员时生成并预置 TOTP 密钥（`totp_enabled=true`），一次性输出密钥与配置 URI，操作者录入认证器后首登即用「口令 + 动态码」，不再依赖后续绑定端点。
- 新增测试：`tests/identity/init-admin.test.mjs`（非 production 拒绝、缺 `ADMIN_INIT_PASSWORD` 拒绝）；`tests/identity/totp.test.mjs` 增加密钥生成/provisioning URI/round-trip；`tests/identity/identity-service.test.mjs` 增加 TOTP 计入锁定与成功后清零用例。
- 文档同步：`docs/01` 登录方案、`docs/06` §4.1 更新锁定口径（口令或 TOTP 失败均计入）与首管理员 TOTP 预置流程；`init-admin.mjs` 头注释同步。

#### 已验证（verified）

- RED：TOTP 计入锁定 2 用例因目标行为缺失失败（错误 TOTP 未累计失败计数）；`generateTOTPSecret` 缺失导出致 `ERR_MODULE_NOT_FOUND` 正确 RED。
- 实际运行命令（本变更范围）：
  - `docker compose run --rm web node --test tests/identity/identity-service.test.mjs`：15 通过。
  - `docker compose run --rm web node --test tests/identity/totp.test.mjs tests/identity/init-admin.test.mjs`：7 通过。
  - `docker compose run --rm web npm run test:unit`：70 通过（含本变更新增 7）。
  - 本变更 6 个文件 `npx eslint`：0 问题。
  - `init-admin` 端到端冒烟（dev DB，production 门禁 + 一次性口令）：输出 32 字符 base32 密钥与 `otpauth://totp/...` URI，落库 `totp_enabled=true`/`totp_secret` 32 字符；测试管理员已清理。
- 已知偏差（非本变更引入，来自并发参与者在途改动）：工作区 `make check` 因 `lib/jobs/sync-scheduler.mjs`（`now` 未用）与 `worker/index.ts`（`ctx` 未用）报 2 个 lint error；`npm test` 中 rendered-html「服务端渲染运营后台」断言锚点（`<title>`）失配；`test:integration` 中 `ops-read.integration.test.mjs:195`「valid_recommendation_count 真值 0」RED。上述文件均不在本变更范围。

### 2026-08-12 — 开发工具链：提交门禁与代码审查命令

> 状态速览：pre-commit/commit-msg 钩子 + `make hooks` 引导 · `.claude` 代码审查基础设施（`/review` 命令 + eslint 报告钩子）· 两道门禁已实测通过

#### 已实现（implemented）

- 新增 `.githooks/pre-commit`：提交前跑 `git diff --cached --check`（空白）与容器内 `npm run lint`（ESLint，与 `make check` 同执行路径）；`SKIP_GIT_HOOKS=1` 可临时放行。
- 新增 `.githooks/commit-msg`：Conventional Commits 格式门禁（`feat/fix/docs/chore/refactor/test/build/ci/perf/revert` + 可选 scope；Merge 与空信息放行）。
- `Makefile` 新增 `make hooks`：`git config core.hooksPath .githooks` 并赋可执行位（本地配置，不入库）。
- 引入 `.claude/` 代码审查基础设施（借鉴 evidsight，适配本仓库）：`commands/review.md` 审查命令（对照权威文档矩阵与规范门禁）、`hooks/web-lint-report.sh`（PostToolUse 编辑/写入后报告 eslint `--fix-dry-run` 改动预览，适配 npm、覆盖 `.mjs/.mts`）、`settings.json` 挂载钩子与 eslint `--fix` 权限弹窗。

#### 已验证（verified）

- commit-msg 门禁：历史提交风格（`feat:`/`docs:`/`chore:`/`fix(ops):`）PASS，无前缀/仅 type/缩进注释 REJECT，`Merge` 提交放行。
- pre-commit 门禁端到端：暂存交付文件后实际运行钩子，`git diff --cached --check` 通过 + `docker compose run --rm web npm run lint` 退出 0。
- 钩子脚本 `bash -n` 语法检查通过；`.githooks` 已由 `make hooks` 激活（`core.hooksPath` 指向 `.githooks`）。
- 说明：完整 `npm test` 不进入提交门禁（保留给 pre-push/CI），pre-commit 仅跑静态门禁控制提交噪音。

### 2026-08-12 — M1 通用审计中间件 + 审计查询端点与页面

> 状态速览：`withAudit` 收口只读端点审计（request_id/IP/actor 统一、未预期异常也写审计、元数据动作白名单）· DB 触发器强制追加写（UPDATE 拒、DELETE 需保留标记）· `GET /api/audit-logs` + 审计日志页接真实数据 · 单元 61 + 集成 9 通过 · 浏览器实测审计落库含 IP 与计数元数据

#### 已实现（implemented）

- 新增通用审计中间件 `lib/server/with-audit.ts` 与纯逻辑 `lib/server/audit.mjs`（`planAudit`/`pickMetadata`）：统一 `request_id`/IP/actor 解析与结果推导（`success`/`denied`/`failure` 白名单，`unauthorized` 不审计避免扫描器洪泛）；成功审计元数据只保留动作白名单键（`auditMetadataKeys`，防误记敏感正文）；未预期异常也写 `failure` 审计（收口原 500 无审计缺口）；IP 尽力捕获（`cf-connecting-ip` → `x-forwarded-for` 首段 → null）。
- 3 只读端点（`/api/jobs/under-served`、`/api/sources`、`/api/sync-runs`）收口到 `withAudit`：401 不审计、403 `denied` 审计、成功带计数审计、400 直接返回不审计；行为与既有契约一致。
- `audit_logs` 增加 `ip_address` 列（可空）与追加写触发器 `guard_audit_logs`（迁移 `0003_complete_wallop`）：`UPDATE` 无条件拒绝；`DELETE` 仅保留任务在事务内设 `app.audit_retention=on` 时放行（触发器放行路径返回 `OLD`，`BEFORE DELETE` 返回 `NULL` 会静默跳过删除）；`insertAudit` 写入 `ip_address`。
- 保留任务 `deleteExpiredAuditLogs` 改为事务内 `set local app.audit_retention=on`，兑现「保留任务按策略删除」豁免。
- 新增审计查询端点 `GET /api/audit-logs`（RBAC `operations|admin`，`action?`/`actor_type?`/`result?` 过滤 + 分页包络 + 数据访问审计 `audit-logs.list`）与只读仓储 `lib/identity/audit-read-repository.mjs`（投影含 `ipAddress`；元数据写入时已按动作白名单收敛）。
- 前端审计日志页 `AuditPage` 接真实 `/api/audit-logs`：最新 50 条 + 上一页/下一页，`result`→`status-tag`（成功/失败/已拒绝），展示动作/操作人/对象/关联 ID/来源 IP，含加载/错误/空态；筛选控件为占位禁用态。
- 新增 `tests/server/audit.test.mjs`、`tests/audit-guard.integration.test.mjs`、`tests/audit-read.integration.test.mjs`；适配既有保留/身份集成测试清理（触发器下审计删除需带保留标记）。

#### 已验证（verified）

- RED：单元测试因 `audit.mjs` 缺失 `ERR_MODULE_NOT_FOUND`；守卫集成测试因触发器不存在（`UPDATE` 未拒绝）正确 RED；审计查询集成测试因仓储缺失正确 RED。
- 实际运行命令：
  - `docker compose run --rm web npm run test:unit`：61 通过（新增 audit 7）。
  - `docker compose run --rm web npm test`：Vinext 构建完成（含 4 个只读端点）、rendered-html 3 通过。
  - `docker compose run --rm web npm run test:integration`：9 通过（新增追加写守卫 + 审计查询；保留/身份清理适配后仍绿）。
  - `docker compose run --rm web npm run lint` 通过；`git diff --check` 通过；受改 markdown 相对链接检查通过。
  - `make db-migrate`：迁移幂等复验通过（`0003` 安全跳过）。
- dev server 浏览器实测（真实 Worker + Hyperdrive → Postgres）：ops 登录后审计日志页渲染真实记录（登录/沉睡职位访问/同步批次访问/审计日志访问，含结果、关联 ID、来源 IP）；中间件路由审计落库含 `ip_address`（127.0.0.1）与白名单计数元数据（`page`/`pageSize`/`total`），`auth.login` 未走中间件故无 IP；`GET /api/audit-logs` 与 `GET /api/jobs/under-served` 未登录均 `401 { code:"unauthorized" }`。
- DB 追加写守卫：`UPDATE audit_logs` 拒绝、`DELETE` 无保留标记拒绝、事务内 `set local app.audit_retention=on` 放行、保留仓储路径可用（集成测试覆盖）。
- 敏感边界复验：审计元数据仅计数/分页，不含 Secret、Cookie、令牌、手机号、邮箱、简历正文。

> 说明：认证路由（login/logout/password）actor 语义特殊（匿名登录失败、登出无会话），保留显式写入；审计页筛选控件为占位禁用态（过滤查询端点已就绪，筛选 UI 接线留后续）。

### 2026-08-12 — M1 业务页面接真实数据（只读 API）

> 状态速览：沉睡职位巡检 + 数据源页接真实 `jobs`/`source_connections`/`sync_runs` · 3 个只读端点（会话 + RBAC operations/admin + 数据访问审计）· 单元 54 + 集成 7 通过 · 浏览器实测两页渲染真实数据

#### 已实现（implemented）

- 新增只读仓储 `apps/web/lib/jobs/job-read-repository.mjs`（`listUnderServedJobs`：沉睡规则 SQL 投影 `active + 7–30 天 + 零推荐`，命中 `jobs_under_served_idx`，`category`/`q`/分页过滤）与 `apps/web/lib/sources/source-read-repository.mjs`（`listSources` 用 `left join lateral` 取最新同步摘要、`listSyncRuns` 关联来源展示名，`status` 过滤）。
- 新增 3 个只读 Route Handler：`GET /api/jobs/under-served`、`GET /api/sources`、`GET /api/sync-runs`——会话 + RBAC `["operations","admin"]`（`authorize` 首个真实调用者，recruiter 拒绝 `403`）、分页包络 `{ total, page, page_size, total_pages, list }`、数据访问审计（`jobs.list`/`sources.list`/`sync-runs.list`，成功元数据仅计数/分页，角色拒绝记 `denied`）。
- 新增共享纯函数 `apps/web/lib/identity/authz.mjs`（`authorizeOrForbidden`）与 `apps/web/lib/server/pagination.mjs`（`parsePagination`）。
- 前端接线：删除 Mock `jobs` 数组；沉睡职位巡检页从 `/api/jobs/under-served` 拉真实职位（加载/错误/空态、`isUnderServedJob` 客户端安全网、匹配池为 M2 占位、脱敏预览沿用 `toPublicJobView` 隐藏公司）；数据源页从 `/api/sources`+`/api/sync-runs` 渲染连接卡片/同步批次（status→`status-tag` 成功/失败/运行中/排队中、耗时由起止推导、异常列显示机器码 `error_code`）/连接健康面板；「同步职位/立即同步」改为 disabled + CLI 提示（真实定时调度为后续项）。`apps/web/lib/ops-client.ts` 新增客户端封装，复用 `AuthResult` 判别类型。
- 修正既有 jsonb 双重编码 bug：`finishSyncRun`/`failSyncRun`/`persistUnderServedJob` 由 `JSON.stringify(...)::jsonb` 改为直接传对象（此前写库为 jsonb 字符串、`stats->>'x'` 为 null，只读层作为首个消费者暴露此问题）。
- 新增 `tests/ops-read.integration.test.mjs`（沉睡边界 7/30 含入、6/31/失效/非零推荐排除、`category`/`q`/分页、投影无 `payload_*`、`listSources` 最新摘要、`listSyncRuns` status 过滤）、`tests/identity/authz.test.mjs`、`tests/server/pagination.test.mjs`。

#### 已验证（verified）

- RED：单元测试因 `authz.mjs`/`pagination.mjs` 缺失以 `ERR_MODULE_NOT_FOUND` 正确 RED。
- 实际运行命令：
  - `docker compose run --rm web npm run test:unit`：54 通过（新增 authz/pagination 7 个）。
  - `docker compose run --rm web npm test`：Vinext 构建完成（含 3 个新路由）、rendered-html 3 通过（app 视图锚点改为加载态 `正在加载职位…`，泄漏守卫保留）。
  - `docker compose run --rm web npm run test:integration`：7 通过（含新增只读用例；共享 dev DB 下按夹具范围断言、全局只做下限）。
  - `docker compose run --rm web npm run lint` 通过；`git diff --check` 通过。
- dev server 浏览器实测（真实 Worker + Hyperdrive → Postgres）：ops 登录后沉睡职位页渲染真实职位（侧边栏/指标卡计数、最近同步、匹配池 M2 占位、脱敏预览隐藏公司）；数据源页渲染连接卡片 + 同步批次（成功/失败/`RATE_LIMITED` 状态标签与耗时）；未登录业务端点 `401`；临时 recruiter 访问业务端点 `403 forbidden`；审计落库 `jobs.list`/`sources.list`/`sync-runs.list` 含 `request_id`、元数据仅计数。
- 敏感边界复验：业务响应不含 `raw_records.payload_*` 与 `sync_runs.cursor`；`error_code` 仅机器码。

> 说明：真实定时调度（同步自动触发）、匹配池（M2）与通用审计中间件仍为后续项；本轮完成「同步任务接入页面（只读）」。

### 2026-08-12 — npm 依赖安全公告审计与升级

> 状态速览：20 条公告（1 low / 4 moderate / 15 high）→ 升级修复 14 条 → 剩余 6 条需破坏性降级、记录豁免

#### 已实现（implemented）

- 非破坏性升级：`@cloudflare/vite-plugin 1.37.1→1.51.3`（级联修复 wrangler/miniflare/undici/sharp/ws）、`vite 8.0.13→8.2.1`、`react/react-dom/react-server-dom-webpack 19.2.6→19.2.8`、`wrangler 4.92.0→4.121.0`；应用 `npm audit fix` 修复 `@babel/core`/`brace-expansion`/`fast-uri`/`js-yaml` 等传递依赖。package.json 与 lock 已更新。
- 豁免记录（修复需破坏性降级，不可行）：`drizzle-kit`/`esbuild`/`@esbuild-kit`（fix 指向降到 0.18.1，moderate，仅 dev 迁移工具）；`vinext`/`image-size`（fix 指向降到 0.0.45，与当前 `1.0.0-beta.2` 冲突，high）。

#### 已验证（verified）

- `npm audit`：20 条（1 low / 4 moderate / 15 high）→ 升级后 6 条（4 moderate / 2 high），全部为需降级的豁免项。
- 升级后实际运行命令：`make check`（lint）、`docker compose run --rm web npm test`（unit 47 + 构建 + rendered-html 3）、`docker compose run --rm web npm run test:integration`（6）、`make db-migrate`（幂等）——升级后的 vite/cloudflare/wrangler 工具链无回归。
- 注意：node_modules 卷已刷新，运行中的 dev server 需重启生效。

### 2026-08-12 — M1 数据底座 · 保留清理任务

> 状态速览：可配置 TTL 清理过期原始快照/关闭职位/过期会话/过期审计，并写入 `retention.run` 审计 · CLI `npm run retention` · 单元 47 + 集成 6 通过

#### 已实现（implemented）

- 新增 `apps/web/lib/jobs/retention-repository.mjs`：`createRetentionRepository(sql)` 按 TTL 删除过期 `raw_records`（成功 `captured|normalized` 30 天 / 异常 `invalid` 90 天）、关闭职位（非 active，180 天）、过期会话（`expires_at`/`idle_expires_at` 双过期任一到点）、过期 `audit_logs`（365 天）；复用身份模块审计写入（`createAuthRepository(sql).insertAudit`）。
- 新增 `apps/web/lib/jobs/retention.mjs`：`runRetention({ sql, ttl?, now?, requestId?, repo? })` 编排清理并写一条 `retention.run` 审计（`actor_type=system`，元数据仅计数与 TTL，无敏感正文）；失败尽力记录 failure 审计并返回机器可读错误码，不泄露原始错误正文。
- 新增 CLI `npm run retention`（`apps/web/scripts/run-retention.mjs`）：读 `DATABASE_URL` 与 `RETENTION_*` TTL，输出 JSON 结果，失败退出非零。
- `.env.example` 增加 `RETENTION_RAW_SUCCESS_DAYS=30` / `RETENTION_RAW_EXCEPTION_DAYS=90` / `RETENTION_JOB_CLOSED_DAYS=180` / `RETENTION_AUDIT_DAYS=365`。
- 新增单元测试 `tests/retention.unit.test.mjs` 与集成测试 `tests/retention.integration.test.mjs`。

#### 已验证（verified）

- RED：`retention.mjs` 不存在导致单元/集成测试 `ERR_MODULE_NOT_FOUND` 正确 RED。
- GREEN 后实际运行命令：
  - `make check`（lint 通过）。
  - `docker compose run --rm web npm test`：unit 47 通过、Vinext 构建完成、rendered-html 3 通过。
  - `docker compose run --rm web npm run test:integration`：6 个集成用例通过，含新增保留清理用例。
  - `make db-migrate`：迁移幂等复验通过（PostgreSQL NOTICE 确认安全跳过）。
- 集成测试覆盖：旧成功/异常原始快照、关闭职位、过期会话、过期审计被删除；新数据保留；`retention.run` 审计落库含正确计数与 `request_id`，无敏感字段。
- 共享 dev DB 下全局计数按「至少删除夹具行」断言，夹具范围「旧删新留」按 source/user 精确查询验证。

### 2026-08-12 — 前端登录接线（两步交付完成）

> 状态速览：登录/强制改密/登出/会话恢复已接真实 `/api/auth/*` · SSR 按 Cookie 门禁 + 客户端 `me` 核实 · 浏览器实测 ops/admin/锁定/改密/登出/刷新全通过

#### 已实现（implemented）

- 新增客户端认证封装 [`lib/auth-client.ts`](apps/web/lib/auth-client.ts)：`login/me/logout/password` 纯 fetch，判别结果类型，无服务端依赖。
- `LoginPage` 接线：`POST /api/auth/login`（含 TOTP 校验位）、统一失败文案取自服务端、`passwordChangeRequired` 进「设置新口令」步、`POST /api/auth/password` 改密后进入工作台；移除本地失败计数与「重置演示」（锁定由后端 `429` 驱动）。
- 会话门禁分层：SSR `page.tsx` 按 `x-prototype-view: app` 请求头或 `session_token` Cookie 存在性渲染视图（不查库）；客户端挂载后无条件 `GET /api/auth/me` 核实——`200` 刷新真实用户、`401` 退回登录页。因 Cookie 为 HttpOnly，不能用 `document.cookie` 判断登录态。
- 侧边栏「退出登录」`POST /api/auth/logout` 后回登录页；dev 种子重跑时重置 `failed_attempts/locked_until` 便于解锁。

#### 已验证（verified）

- 单元 45、渲染回归 3（默认无 Cookie 渲染登录页、`x-prototype-view: app` 渲染工作台）、lint 通过。
- 浏览器实测（真实 Worker + Miniflare Hyperdrive → Postgres）：`ops` 登录进入工作台并显示「林然 / 招聘运营」；刷新后经 Cookie 门禁直达工作台且 `me` 核实返回 `200`；退出登录后刷新渲染登录页；错误口令显示统一「账号或口令不正确」；`admin` + TOTP 登录进入强制改密、设新口令后进入工作台并显示「系统管理员 / 管理员」；连续 5 次失败第 6 次返回 `429`「登录失败次数过多，账号已临时锁定」。

### 2026-08-12 — 自有登录后端实现（M1 · 后端优先）

> 状态速览：身份 schema 与迁移、身份模块（bcrypt/会话/TOTP/锁定/强制改密）、`/api/auth/*` 四端点、Worker 运行时 DB 接线（Hyperdrive）与 dev 种子均已实现并通过验证 · 前端登录页仍为 mock（后端优先，两步交付）· 生产管理员 TOTP 绑定 UI 随账号管理里程碑实现

#### 已实现（implemented）

- 新增身份相关表与迁移 `0002`：`organizations`、`users`（含 `username` 唯一、bcrypt 口令哈希、`must_change_password`、`totp_secret/totp_enabled`、`failed_attempts/locked_until`）、`role_assignments`、`sessions`（只存令牌哈希，空闲 30 分钟/最长 12 小时双过期）、`audit_logs`。
- 建立 `lib/identity/` 身份模块：bcrypt 口令哈希（成本 12，时间均匀化防账号枚举）、高熵会话令牌（仅哈希入库）、RFC 6238 TOTP 校验（±1 步窗口）、统一失败文案 + 5 次失败锁定 15 分钟、首登强制改密、`authorize` 服务端角色判定、口令策略（≥12 位含字母数字、拒绝常见弱口令）。
- 实现 `/api/auth/login|logout|me|password` 路由：统一 JSON 错误契约、会话 Cookie（生产 `Secure`）、登录/登出/改密审计且不含敏感字段。
- Worker 运行时 DB 接线：`lib/server/runtime-env.ts`（AsyncLocalStorage 透传 env）、`lib/server/db.ts`（`cacheForRequest` 每请求客户端，Workers 经 Hyperdrive / Node 回退 `DATABASE_URL`）、`worker/index.ts` 包裹 env、`vite.config.ts` 本地 Hyperdrive 绑定指向 Docker Postgres。
- dev 种子脚本 `scripts/seed-dev-users.mjs`（非 `development` 拒绝执行）与生产首 admin 初始化脚本骨架 `scripts/init-admin.mjs`。

#### 已验证（verified）

- 单元测试 45 通过（新增身份 23：口令哈希/会话令牌/TOTP 已知向量/认证服务统一失败·锁定·TOTP 强制·授权/种子门禁）；集成测试 5 通过（身份表迁移、用户/角色/会话唯一约束、审计写入）；`npm test` 渲染回归 3 通过；`npm run lint` 通过。
- dev server 运行时冒烟（真实 Worker + Miniflare Hyperdrive → Docker Postgres）：`ops` 登录 `200` 并下发会话 Cookie、`me` 带 Cookie `200` 返回用户与角色、错误口令统一 `401` 文案、`admin` 携带 TOTP 验证码登录 `200` 且 `passwordChangeRequired:true`、登出 `204` 后 `me` `401`。
- 审计落库核验：登录成功/失败、登出均产生记录且 `request_id` 完整，元数据不含口令与口令哈希；会话创建/撤销符合预期。

> 说明：前端登录页表单为纯 mock，按「后端优先」决策暂不接线；`/api/auth/*` 契约已就绪，接线为两步交付的第二步。生产管理员 TOTP 绑定入口属账号管理功能，后续里程碑实现。

### 2026-08-12 — M1 数据底座 · 可审计 CLI 同步任务（`wb.jobs.under_served` 分页）

> 范围：只做同步任务接线（登录/RBAC、审计+保留、部署基线、npm 安全审计留待后续）。真实 MCP 凭证未用于写库，验证使用注入的假 MCP 客户端 + 真实 PostgreSQL。

#### 已实现（implemented）

- 新增 `apps/web/lib/jobs/under-served-sync.mjs`：`runUnderServedSync` 分页拉取 `wb.jobs.under_served`（`days_without_rec=7`、`page_size` 可配、`max_pages` 安全上限），按本地规则（7–30 天）过滤，每个合格职位把**原始上游载荷加密追加写 `raw_records`** + 以 `(source_connection_id, external_id)` 幂等更新规范化 `jobs`；成功 `finishSyncRun`，失败仅把机器可读 `error_code` 写入 `sync_runs`（`failSyncRun`），不落原始错误正文或凭证。MCP 客户端可注入，缺省使用真实适配器且 MCP 配置在任何数据库写入前解析。
- 扩展 `apps/web/lib/adapters/mcp-under-served-contract.mjs`：`parseUnderServedJobsResult` 追加返回 `rawItems`（原始上游列表项）；新增 `selectEligibleUnderServedPairs`（按索引配对 + `jobs`/`rawItems` 长度守卫）。
- 新增 `failSyncRun`（`apps/web/lib/jobs/job-sync-repository.mjs`）：设置 `status='failed'`、`error_code`、`finished_at`。
- 新增 CLI `npm run sync:under-served`（`apps/web/scripts/run-under-served-sync.mjs`）：预检 `DATABASE_URL`/`APP_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY_VERSION`，可选 `--page-size`，输出 JSON 结果，失败退出非零。
- 新增集成测试 `apps/web/tests/under-served-sync.integration.test.mjs`。

#### 已验证（verified）

- RED：契约新增用例（`rawItems` 对齐、31 天剔除、长度不一致抛错）在实现前因 `selectEligibleUnderServedPairs` 导出缺失失败；新集成测试因 `under-served-sync.mjs` 不存在以 `ERR_MODULE_NOT_FOUND` 正确 RED。
- GREEN 后实际运行命令：
  - `make check`（lint 通过）。
  - `docker compose run --rm web npm test`：unit 45 用例通过、Vinext 构建完成、rendered-html 3 用例通过（覆盖登录页与运营后台脱敏）。
  - `docker compose run --rm web npm run test:integration`：4 个集成用例通过，含新增两页分页与限流失败用例。
  - `make db-migrate`：迁移幂等复验通过（PostgreSQL NOTICE 确认 `drizzle`/`__drizzle_migrations` 已存在时安全跳过）。
- 集成测试覆盖：两页分页（7/31/30）→ 成功、`jobs` 重跑不重复、`raw_records` 追加写不覆盖、密文不含明文标记；`RATE_LIMITED` → 失败运行仅存 `error_code`、无错误正文或凭据落库。
- 未使用真实 MCP 凭证写库：真实数据上线仍以 M0 书面授权门禁为准。

#### 未实现 / 已知缺口

- 页面/API 接入与真实定时调度仍未接线（依赖登录/RBAC，见路线图 M1）。
- `max_pages` 截断时以 `stats.maxPagesReached = 1` 标记，仍视为成功。
- 供应商 `page_size` 上限未确认：循环靠 `total_pages`/`total` 自适应，若服务端硬性拒绝当前页大小则以分类错误码失败（可操作）。

### 2026-08-12 — MCP 候选人数据链路确认 + 权威文档更新

> 状态速览：职位侧已验证（`under_served`/`jobs.list` 有真实数据）· 候选人列表/搜索对当前账号为空（权限边界）· `match_candidates` 已验证可用且姓名打码 · 项目负责人确认脱敏候选人数据可入库、暂不设保留期限上限 · 匹配分采用供应方 MCP · 浏览器采集确认不需要

#### 已验证（verified）

- 真实只读调用 `wb.jobs.match_candidates` 成功：返回 219 条匹配摘要，姓名打码、无手机/邮箱/完整简历正文；`current_company`/`resume_summary` 与顾问姓名未打码。`max_llm_score_count=1` 时返回 `score_status=pending`，本批未产生 LLM 评分结果。
- 真实只读调用 `wb.jobs.list` 成功：返回 24 个职位，含未脱敏的客户公司、顾问姓名与完整 JD（仅限内部）。
- `wb.candidates.list/search/stats` 对当前账号返回空（90 天窗口 `total` 为 0），按权限边界处理，不作为扩大权限理由。
- 对 `under_served` 返回的运营账号职位调用 `match_candidates` 返回业务错误 `1003`，对 `jobs.list` 职位调用成功。
- 候选人脱敏 Fixture 一致性测试通过（2 个）：`match-candidates-response-2026-08-12.json` 虚构化、无真实 Portal 域名、保留评分 `pending` 边界；完整 `npm run test:unit` 19 个用例通过。

#### 规范已确认（specified）

- 在 [`04-mcp-integration.md`](docs/04-mcp-integration.md) 固化已确认 MVP 读工具白名单与返回类型；匹配分采用供应方 MCP 评分（`wb.jobs.match_candidates`），不建自研评分引擎。
- 项目负责人确认脱敏候选人数据可入库、暂不设固定保留期限上限；收到数据提供方更严格要求时以更严格者为准。
- 浏览器采集确认不需要，MCP 为唯一主数据接入。
- 建立 `ADR-004`：自有账号口令登录替代企业 OIDC（无外部身份提供方），`users` 保存口令哈希、移除 OIDC 外部身份映射；生产区域确认中国大陆；`wb.candidates.get` 因画像回写 + LLM 副作用确认不调用。
- `wb.jobs.under_served` 已确认等价产品沉睡条件（active + 有效推荐数 0 + 发布时间），`wb.jobs.list` 不纳入 MVP 数据源。
- 确认登录方案规范：口令策略（argon2id/bcrypt、最小 12 位、连续失败限流锁定）、会话（HttpOnly Cookie、空闲 30 分钟/最长 12 小时、可撤销）、首个 admin 由初始化脚本创建、admin 手动重置并强制首改密、生产管理员强制 TOTP。
- 建立 [`docs/09-api-contract.md`](docs/09-api-contract.md) 作为内部 API 契约权威文档（通用约定 + 认证端点 + 按里程碑端点清单），认证契约从 `02-architecture.md` §7 迁入并登记权威矩阵。

#### 已实现（implemented）

- 归档候选人脱敏 Fixture `apps/web/fixtures/mcp/match-candidates-response-2026-08-12.json`，新增 `tests/match-candidates-fixture.test.mjs`，补足 M0「脱敏候选人样本」门禁。
- 新增候选人采样命令 `mcp:sample-candidates`（只读白名单 `wb.candidates.list`，输出至仓库外；当前账号范围返回空）。
- 登录页原型：双栏登录视图（品牌面板 + 表单），账号口令 + TOTP 占位、统一失败文案、连续 3 次锁定、`admin` 首登强制改密；侧边栏资料菜单「退出登录」；默认初始视图为登录页，`x-prototype-view: app` 请求头强制进入工作台；渲染测试双覆盖登录页与运营后台，`npm test` 通过。

### 2026-08-11 — M0 接口联调收口 + M1 数据底座起建

> 状态速览：M0 接口与样本验证基本完成（剩 OIDC/生产区域书面授权与候选人样本）· M1 数据底座骨架已建且容器内验证通过（登录/RBAC/审计/部署未做）· 真实 MCP 已联调

#### M0 · 接口与样本验证

##### 已验证（verified）

- 使用轮换后的测试凭证完成真实 MCP `initialize` 与 `tools/list`：协议版本 `2025-11-25`，发现 40 个工具。
- 真实只读调用 `wb.jobs.under_served` 成功：确认响应文本包络与列表字段，沉睡阈值 7 包含第 7 天，并生成不含真实职位、企业、负责人或 URL 的脱敏 Fixture。
- RED/GREEN 证据：`mcp-discovery` 测试因目标适配器不存在以 `ERR_MODULE_NOT_FOUND` 正确 RED；最小工具调用和空岗响应映射分别因目标导出/模块不存在正确 RED；GREEN 后 14 个单元测试和 lint 通过。适配器会在网络前拒绝非允许工具，并在字段类型漂移时阻止数据进入业务模型。

##### 规范已确认（specified）

- 固化 MVP 所需工具的版本化输入契约、字段字典和风险清单。已知缺口：40 个工具均未声明 `outputSchema`，正式推荐写工具未发现，最小 `tools/call` 矩阵尚待补全。
- 按项目负责人确认采用最低权限开发假设：只处理当前 Actor 可见数据，使用默认保留上限，不尝试管理员/跨团队能力，并将浏览器采集降级为非当前路径。

##### 已实现（implemented）

- 供应商隔离的 MCP Streamable HTTP 发现客户端，覆盖初始化、会话/协议头、`tools/list` 分页、JSON/SSE 响应和安全错误分类。
- 不覆盖旧文件的 MCP 契约快照命令与脱敏 Fixture 审核流程。
- 修正 MCP 发现命令的环境文件路径，以仓库根 `.env.local` 为标准，并兼容既有 `apps/web/.env.local`。

##### 验证边界

- 早前文档提交阶段仅执行 `git diff --check`、Markdown 相对链接和决策状态一致性检查；未宣称数据库、容器、登录或真实 MCP 已实现。真实 MCP 联调在凭证轮换后完成。
- 真实数据上线仍需取得数据授权并书面确认最终保留期限。

#### M1 · 数据底座（进行中）

##### 已实现（implemented）

- 建立 PostgreSQL 17 + Docker Compose 标准开发环境：数据库健康检查、一次性迁移服务、Web 开发容器和持久化开发卷；根 `Makefile` 提供 `dev/down/check/test/build/db-migrate` 命令（兑现 ADR-002）。
- 增加 PostgreSQL 首批表结构、AES-256-GCM 原始载荷加密、内容哈希去重和按来源/外部 ID 幂等更新的职位同步仓储骨架。尚未接入页面或真实定时同步。

##### 已验证（verified）

- RED 阶段：PostgreSQL 迁移契约因仍是 SQLite journal 而失败，加密模块测试因模块缺失而失败。
- GREEN 后容器内 17 个单元测试、Vinext 完整构建、1 个服务端渲染测试和 2 个 PostgreSQL 集成测试通过，Web 容器健康响应通过。
- 新增迁移首次复验暴露一次性迁移服务仍使用旧镜像；修正为挂载版本化迁移目录后，新批次追加原始快照、同批次内容去重和职位幂等更新的集成测试通过。

##### 未实现 / 已知缺口

- OIDC、本地 RBAC、审计日志表/中间件、保留清理任务和测试/生产部署仍未实现；不把数据底座完成描述为整条业务链路已完成。
- 依赖安装报告 20 条 npm 安全公告（1 low、4 moderate、15 high），本次未执行可能引入破坏性升级的自动修复，需单独审计和升级。

#### 公共基础设施

##### 规范已确认（specified）

- 接受 PostgreSQL 17、Drizzle 迁移和 Docker Compose 全容器本地开发基线（ADR-002）。
- 接受企业 OIDC、本地 RBAC、中国大陆测试/生产部署、原始载荷信封加密、规范化关系表、追加写审计及可配置保留上限方案（ADR-003）。
- 明确当前 Web 仅为单页交互演示，侧边栏多数模块和业务按钮尚未接线。

##### 已验证（verified）

- 修复候选人预览遮罩使用非交互元素监听鼠标导致的无障碍 lint 错误，并保留点击遮罩关闭行为。

## [0.1.0] - 2026-08-11

首个切片：项目文档基线 + 运营后台单页 Mock 演示。

> 说明：历史交付记录未保存实际命令结果，因此不追溯标记为 `verified`。

#### 规范已确认（specified）

- 建立项目章程、MVP 需求、架构、数据模型、MCP、安全、验收和开发流程文档基线。

#### 已实现（implemented）

- 建立 Vinext Web 骨架和沉睡职位单页 Mock 演示，包括类别/关键词筛选、行选择、详情联动及脱敏预览。
- 增加沉睡职位规则和脱敏投影测试。

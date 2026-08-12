# Changelog

本文件记录用户可观察行为、架构决策、数据契约和验证状态。状态含义遵循 `AGENTS.md`：

- `specified`：规范和验收条件已确认。
- `implemented`：代码已实现但尚未完成全部验证。
- `verified`：已实际运行规定命令并通过。

格式采用 Keep a Changelog：`## [区域或版本] - 日期` 分组，每条记录标注状态归属。`Unreleased` 记录尚未纳入版本号的近期变更。

## [Unreleased]

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

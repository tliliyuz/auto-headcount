# Changelog

本文件记录用户可观察行为、架构决策、数据契约和验证状态。状态含义遵循 `AGENTS.md`：

- `specified`：规范和验收条件已确认。
- `implemented`：代码已实现但尚未完成全部验证。
- `verified`：已实际运行规定命令并通过。

格式采用 Keep a Changelog：`## [区域或版本] - 日期` 分组，每条记录标注状态归属。`Unreleased` 记录尚未纳入版本号的近期变更。

## [Unreleased]

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

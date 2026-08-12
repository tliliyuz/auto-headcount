# Changelog

本文件记录用户可观察行为、架构决策、数据契约和验证状态。状态含义遵循 `AGENTS.md`：

- `specified`：规范和验收条件已确认。
- `implemented`：代码已实现但尚未完成全部验证。
- `verified`：已实际运行规定命令并通过。

格式采用 Keep a Changelog：`## [区域或版本] - 日期` 分组，每条记录标注状态归属。`Unreleased` 记录尚未纳入版本号的近期变更。

## [Unreleased]

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

#### 已实现（implemented）

- 归档候选人脱敏 Fixture `apps/web/fixtures/mcp/match-candidates-response-2026-08-12.json`，新增 `tests/match-candidates-fixture.test.mjs`，补足 M0「脱敏候选人样本」门禁。
- 新增候选人采样命令 `mcp:sample-candidates`（只读白名单 `wb.candidates.list`，输出至仓库外；当前账号范围返回空）。

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

# Changelog

本文件记录用户可观察行为、架构决策、数据契约和验证状态。状态含义遵循 `AGENTS.md`：

- `specified`：规范和验收条件已确认。
- `implemented`：代码已实现但尚未完成全部验证。
- `verified`：已实际运行规定命令并通过。

## Unreleased

### 2026-08-11

- `specified`：接受 PostgreSQL 17、Drizzle 迁移和 Docker Compose 全容器本地开发基线（ADR-002）。
- `specified`：接受企业 OIDC、本地 RBAC、中国大陆测试/生产部署、原始载荷信封加密、规范化关系表、追加写审计及可配置保留上限方案（ADR-003）。
- `specified`：明确当前 Web 仅为单页交互演示，侧边栏多数模块和业务按钮尚未接线。
- `verified`：本次仅执行 `git diff --check`、Markdown 相对链接和决策状态一致性检查；未宣称数据库、容器、登录或真实 MCP 已实现。
- `implemented`：增加供应商隔离的 MCP Streamable HTTP 发现客户端，覆盖初始化、会话/协议头、`tools/list` 分页、JSON/SSE 响应和安全错误分类。
- `implemented`：增加不覆盖旧文件的 MCP 契约快照命令与脱敏 Fixture 审核流程；尚未使用轮换后的真实测试凭证联调。
- `verified`：RED 阶段 `node --test tests/mcp-discovery.test.mjs` 因目标适配器不存在而以 `ERR_MODULE_NOT_FOUND` 失败；GREEN 后 `npm run lint` 与 `npm test` 通过（8 个单元测试、Vinext 完整构建、1 个服务端渲染测试）。
- `verified`：修复候选人预览遮罩使用非交互元素监听鼠标导致的无障碍 lint 错误，并保留点击遮罩关闭行为。
- `implemented`：修正 MCP 发现命令的环境文件路径，以仓库根目录 `.env.local` 为标准，并兼容既有 `apps/web/.env.local`。

## 0.1.0 - 2026-08-11

- `specified`：建立项目章程、MVP 需求、架构、数据模型、MCP、安全、验收和开发流程文档。
- `implemented`：建立 Vinext Web 骨架和沉睡职位单页 Mock 演示，包括类别/关键词筛选、行选择、详情联动及脱敏预览。
- `implemented`：增加沉睡职位规则和脱敏投影测试；历史交付记录未保存实际命令结果，因此不追溯标记为 `verified`。

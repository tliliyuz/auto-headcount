# PostgreSQL 与 Docker 开发基线验证记录

日期：2026-08-11

## 范围与默认假设

- 当前开发者只有普通测试账号能力；实现不得依赖管理员、团队负责人、跨团队查询或供应商写权限。
- 当前只持久化 `wb.jobs.under_served` 可见职位所需的最小字段和加密原始响应。
- 在业务方与数据提供方给出更严格口径前，开发实现采用 `ADR-003` 的保留上限；这不构成真实数据处理授权。
- 本记录只验证本地开发数据底座，不验证 OIDC、RBAC、触达、正式推荐或生产部署。

## RED 证据

- PostgreSQL 迁移契约首次运行时检测到 Drizzle journal 仍为 SQLite 方言，按预期失败。
- 原始载荷加密测试首次运行时因目标加密模块不存在，以 `ERR_MODULE_NOT_FOUND` 失败。

## 已验证结果

| 检查 | 结果 |
|---|---|
| `docker compose config --quiet` | 通过 |
| `docker compose run --rm migrate` | PostgreSQL 迁移成功 |
| `docker compose run --rm web npm test` | 17 个单元测试、完整构建、1 个 SSR 测试通过 |
| `docker compose run --rm web npm run test:integration` | 2 个 PostgreSQL 集成测试通过 |
| Web 容器内 HTTP 健康请求 | 通过 |

集成测试实际确认：首批表存在；原始载荷保存为不可读的 `bytea` 密文；相同来源和外部 ID 的职位重复同步只更新一条规范化记录；同一同步批次中的相同内容会去重，而新的同步批次会追加原始快照。

## 当前边界

- 页面仍读取脱敏 Mock，尚未触发真实 MCP 同步。
- 同步仓储是可测试骨架，尚未实现调度、重试、失败恢复和审计事件。
- 原始响应已加密，但生产密钥服务、密钥包装和轮换尚未实现。
- OIDC、本地角色映射、权限中间件、保留清理任务以及测试/生产基础设施尚未实现。
- `npm install` 报告 20 条依赖安全公告（1 low、4 moderate、15 high）；未执行自动强制升级，后续需按可达性和运行环境单独审计。

因此，本次状态为：规范 `specified`，数据底座代码 `implemented`，上述本地 Docker/PostgreSQL 检查 `verified`；完整产品链路不是 `verified`。

# ADR-002：PostgreSQL 与容器开发基线

- 状态：accepted
- 日期：2026-08-11
- 决策人：项目负责人（确认使用 PostgreSQL、Docker 数据库和 Docker 开发环境）

## 背景

首个页面切片来自 Vinext Starter，包含可选 D1 示例，但业务架构、数据模型、幂等同步、审计和任务表均以关系型数据库为前提。继续同时保留 D1 与 PostgreSQL 两种方向会造成迁移、测试和部署契约不一致。

项目需要让开发环境可重复启动，并避免依赖开发者机器上预装的 PostgreSQL 或特定 Node.js 版本。

## 决策

- MVP 唯一业务数据库为 PostgreSQL；D1 示例不作为业务实现依据，后续从生产工程中移除。
- ORM 与迁移工具使用 Drizzle ORM 和 Drizzle Kit；所有结构变更通过版本化迁移完成，禁止依赖手工改表。
- 本地开发使用 Docker Compose 启动 Web、PostgreSQL 和一次性迁移服务。除 Docker Engine 与 Compose 外，不要求宿主机安装 Node.js 或 PostgreSQL。
- Web 使用固定 Node.js 22 LTS 基础镜像构建 OCI 镜像；开发镜像支持源码挂载和热更新，生产镜像使用多阶段构建、非 root 用户和只读应用文件系统。
- PostgreSQL 大版本固定为 17，开发、测试和生产保持同一大版本；升级需先在测试环境执行迁移与恢复验证。
- 数据库不得暴露到公网。开发环境仅绑定本机回环地址；测试和生产通过私网连接。
- 测试和生产使用同一应用镜像及同一套迁移，不使用 Docker Compose 作为生产编排方案。
- MVP 异步任务继续使用 PostgreSQL 任务表；不引入 Redis、Kafka 或专用消息队列。
- 根目录应提供统一入口，至少覆盖 `dev`、`check`、`test`、`build`、`db-migrate` 和 `down`。

## 备选方案

### Cloudflare D1

与当前 Starter 集成便利，但会使本地、测试和预期生产数据能力产生分叉，并弱化现有 PostgreSQL 数据模型与运维约定，因此不采用。

### 宿主机直接运行 Node.js 与 PostgreSQL

启动更轻，但无法满足项目负责人确认的全 Docker 开发环境，也更容易产生版本漂移，因此不作为标准路径。

### 容器内自建 PostgreSQL 用于生产

可完全控制数据库，但单人 MVP 的备份、故障切换和升级风险过高。生产优先选择同区域托管 PostgreSQL；若未来必须自建，需另立 ADR。

## 后果

- 后续需新增 Dockerfile、Compose、健康检查、迁移入口和根目录统一命令。
- 当前 `apps/web` 中的 D1 空 Schema 和示例不再代表项目方向。
- 本地环境可被完整重建，但容器卷中的开发数据仍需显式迁移或清理。
- PostgreSQL 版本、扩展和迁移必须在 CI 中验证。

## 重新评估触发条件

- PostgreSQL 无法满足目标部署平台或区域要求。
- 数据规模或任务并发超过数据库任务表承载范围。
- 需要跨区域高可用、读写分离或独立分析仓库。

## 相关规范

- `docs/02-architecture.md`
- `docs/03-data-model.md`
- `docs/05-roadmap.md`
- `docs/08-development-workflow.md`


# 零推荐职位激活系统

面向企业 HR 与猎头的招聘交付工具：识别长期无推荐的职位，从授权人才库中匹配候选人，通过脱敏职位页和合规触达收集意向，最终形成可追踪的推荐闭环。

## 当前阶段

仓库处于项目启动阶段，已完成 MVP 范围、系统架构、数据模型、MCP 接入约定、安全要求和实施计划。

首版产品形态已确定为内部运营后台；候选人只访问带令牌的脱敏职位落地页，不提供企业客户自助门户。

首个可运行切片已完成：`apps/web/` 提供沉睡职位巡检、类别筛选、批量选择、匹配池概览和候选人脱敏页面预览。页面仍使用脱敏 Mock 数据；PostgreSQL 数据底座和只读 MCP 适配器已建立，但尚未把真实同步接到页面，登录和消息渠道也未接入。

当前切片是单页交互演示，不是完整产品原型。侧边栏多数模块、创建匹配任务、分页、触达和候选人意向提交仍是未接线占位。

当前里程碑 0 已完成 MCP 发现、最小只读调用以及 PostgreSQL + Docker 开发基线。2026-08-12 已验证职位数据链路（`wb.jobs.under_served`/`wb.jobs.list` 有真实数据）与 `wb.jobs.match_candidates` 匹配摘要（姓名打码、无联系方式）；候选人列表/搜索对当前账号返回空，属权限边界。项目负责人已确认脱敏候选人数据可入库、暂不设固定保留期限上限，匹配分采用供应方 MCP，浏览器采集确认不需要。M1 数据底座已把 `wb.jobs.under_served` 接入可审计 CLI 同步任务（`npm run sync:under-served`：分页拉取、原始快照加密入库、失败记录机器可读错误码）。M1 自有登录后端已实现并通过运行时冒烟：`users`/`sessions`/`role_assignments`/`audit_logs` 表与迁移、`/api/auth/login|logout|me|password`、bcrypt 口令、会话令牌、连续失败锁定、首登强制改密、RFC 6238 TOTP（生产管理员强制）、dev 种子（`npm run seed:dev-users`）。登录页前端已接线真实 API（登录/强制改密/登出/会话恢复），两步交付完成。M1 数据底座保留清理任务已接线（`npm run retention`：可配置 TTL 清理过期原始快照/关闭职位/过期会话/过期审计，并记录 `retention.run` 审计）。业务页面已接真实数据（只读）：沉睡职位巡检页读 `GET /api/jobs/under-served`（规范化 `jobs` 表 + 真实沉睡规则），数据源页读 `GET /api/sources` + `GET /api/sync-runs`（`source_connections`/`sync_runs` 表），审计日志页读 `GET /api/audit-logs`（`audit_logs` 表，元数据写入时已按动作白名单收敛）；四端点会话 + RBAC `operations|admin` + 数据访问审计。通用审计中间件已收口：`withAudit` 统一 request_id/IP/actor 解析、未预期异常也写审计、成功审计元数据只保留动作白名单键，`audit_logs` 由数据库触发器强制追加写（`UPDATE` 拒绝、`DELETE` 仅保留任务带 `app.audit_retention=on` 放行），审计日志页展示真实审计（含来源 IP）。`npm run sync:under-served` 后可即时看到职位与同步批次。真实定时调度已落地：数据库任务表 `async_tasks` + 同步调度器（周期幂等入队、`FOR UPDATE SKIP LOCKED` 认领、网络错误退避重试、超阈值 `dead`），定时触发（cron 每 15 分钟 tick）随部署环境生效（自托管用服务器级定时器；Cloudflare Worker 用 `scheduled` 处理器），每次任务完成落 `sync.run` 系统审计；运维直连路径仍可用 `npm run sync:under-served`。测试/生产部署基线方向为自托管 Node 容器（自有云服务器），Cloudflare Worker 降为可选路径（见下方「部署」章节），部署基线实现与验证为 M1 剩余项。匹配池（M2）为下一步。

各里程碑状态、门禁清单与卡点见 [实施路线图](docs/05-roadmap.md)。

## MVP 主链路

```text
沉睡职位发现 → 数据标准化/摘要 → 候选人匹配 → 人工审核
      → 脱敏落地页 → 短信/邮件触达 → 意向收集 → 人工推荐
```

## 已确认技术方案

- TypeScript 全栈单体应用，优先保证一人可维护和快速交付。
- Web：Next.js；API：Next.js Route Handlers 或独立 Fastify 模块。
- 数据库：PostgreSQL 17、Drizzle 迁移；标准本地环境通过 Docker Compose 运行 Web、迁移和数据库。
- ORM：Drizzle ORM。
- 异步任务：MVP 先使用数据库任务表，规模扩大后再引入队列。
- MCP、LLM、短信和邮件均通过适配器接入（浏览器采集已确认不需要）。
- 部署目标在完成基础设施确认后确定，不绑定 CloudBase/CloudStudio。

PostgreSQL 与容器基线已由 `ADR-002` 固化。自有账号口令登录由 `ADR-004` 固化；中国大陆测试/生产区域、数据加密分层和保留上限由 `ADR-003` 固化。真实数据上线仍需取得数据授权并书面确认最终保留期限。

## 文档索引

- [项目章程](docs/00-project-charter.md)
- [MVP 需求](docs/01-mvp-requirements.md)
- [系统架构](docs/02-architecture.md)
- [数据模型](docs/03-data-model.md)
- [MCP 接入](docs/04-mcp-integration.md)
- [实施路线图](docs/05-roadmap.md)
- [安全与合规](docs/06-security-compliance.md)
- [验收标准](docs/07-acceptance-criteria.md)
- [开发与交付流程](docs/08-development-workflow.md)
- [内部 API 契约](docs/09-api-contract.md)
- [架构决策记录](docs/decisions/README.md)

## 本地开发

1. 复制 `.env.example` 为 `.env.local`。
2. 填写本地 PostgreSQL 密码；需要 MCP 联调时，再通过密码管理器填写轮换后的测试凭证。
3. 使用 `openssl rand -base64 32` 生成本地 `APP_ENCRYPTION_KEY`，不要复用生产密钥。
4. 执行 `make dev`，等待数据库健康检查和迁移完成后访问 `http://localhost:3000`。
5. 执行 `make test` 运行容器内单元、构建、渲染和 PostgreSQL 集成测试；执行 `make down` 停止环境。

宿主机直接运行 Node.js 或 PostgreSQL 不作为标准验收路径。开发数据库使用命名卷持久化，`make down` 不删除数据；不得把真实 Access Key、Secret Key、手机号、邮箱或完整简历提交到 Git。

## 部署（自托管 Node 容器）

生产基线：以 OCI 容器镜像部署到自有云服务器，运行 Node 服务器并连接服务器上的 PostgreSQL（或托管 PostgreSQL）。Cloudflare Worker 为可选路径，不作为生产承诺。

1. **构建生产镜像**：`docker build -t auto-headcount-web:prod --target production apps/web/`（`apps/web/Dockerfile` 生产 target，`node:22` + `npm run start`）。
2. **起容器**：注入生产环境变量与 Secret（`APP_ENV=production` 必须显式设置——缺失时生产管理员 TOTP 强制与 Secure Cookie 会静默失效；`MCP_ACCESS_KEY`/`MCP_SECRET_KEY`/`APP_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY_VERSION`），`DATABASE_URL` 指向服务器上的 PostgreSQL；暴露端口并由反向代理（Nginx/Caddy）加 HTTPS。
3. **定时调度**：服务器级定时器（systemd timer / PM2 cron / node-cron）每 15 分钟触发同步 tick；调度核心为数据库任务表 `async_tasks`（幂等入队 / 退避重试 / 超阈值 dead），触发方式不绑定平台。
4. **生产首管理员**：`npm run init-admin`（`scripts/init-admin.mjs`，仅 production 环境，生成 TOTP 引导配置 URI）。
5. **可选路径：Cloudflare Worker**：`npm run deploy`（`scripts/check-deploy-env.mjs` 前置校验 + 产物守卫 + `wrangler deploy`）需 Cloudflare 凭证与生产 Hyperdrive/PostgreSQL，仅作备选 Serverless 方案，不作为生产承诺。
6. **中国大陆区域**：生产区域确认为中国大陆（ADR-003），域名备案、短信资质与 MCP 网络连通性等业务方确认项见 `docs/02-architecture.md` §6。

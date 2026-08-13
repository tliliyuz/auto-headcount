# 开发与交付流程

## 1. 复刻来源与取舍

本项目借鉴 EvidSight 的规范驱动开发、契约优先、测试门禁和统一验证入口，但按单人维护的招聘 MVP 做精简。

### 直接复用

- 产品、架构、数据、接口、验收分别维护唯一权威文档。
- 长期技术取舍用 ADR 记录背景、选择、后果和替代方案。
- 先从规范导出验收测试，观察正确 RED 后再写生产实现。
- 外部接口保存版本化 Schema 与脱敏 Fixture，并做 Provider/Consumer 契约测试。
- 数据库结构通过迁移管理，不依赖手工改表。
- 根目录提供统一的开发、检查、测试、构建和配置验证命令。
- CI 将静态检查、快速单元、契约、Web 构建和集成检查分开报告。
- 完成声明附实际执行的命令、结果和已知偏差。

### MVP 不复用

- 不拆 Knowledge/Research 式多服务，使用模块化单体。
- 不建立三套数据库、Celery 集群、向量库或三节点生产拓扑。
- 不把完整可观测平台、压测平台和机器人外呼作为首期门禁。
- 不为尚未取得的 MCP 能力预先编写供应商专用业务代码。

## 2. 每项功能的执行顺序

1. 在对应权威文档中确认业务规则、边界和失败语义。
2. 判断是否命中 ADR；命中时先完成并接受 ADR。
3. 写用户可观察的验收场景，以及 API/事件/外部适配器契约。
4. 用 Mock 或脱敏 Fixture 写测试并确认目标 RED。
5. 编写让当前场景通过的最小实现。
6. 在绿灯下消除重复、整理模块边界。
7. 执行受影响模块的完整验证，不用旧测试结果代替本次结果。
8. 同步规范状态、变更记录和实际验证结果。
9. 进行代码审查后再合并或部署。

## 3. 仓库结构（实际布局）

```text
auto-headcount/
├── apps/web/                 # 内部后台与候选人落地页（单应用 monorepo 子包）
│   ├── app/                  # Next.js App Router：页面（page.tsx / operations-dashboard.tsx）与 Route Handler（api/*/route.ts）
│   ├── lib/                  # 业务与领域逻辑（纯 .mjs + 配套 .d.mts）
│   │   ├── adapters/         # MCP 发现与 under_served 契约适配器
│   │   ├── identity/         # 登录/会话/TOTP/CSRF/审计
│   │   ├── jobs/             # 同步、调度、职位读写仓储
│   │   ├── security/         # 载荷加密
│   │   ├── server/           # 运行时环境、分页、withAudit、DB
│   │   ├── sources/          # 数据源/同步批次只读仓储
│   │   └── ops-client.ts     # 客户端业务只读 API 封装
│   ├── scripts/              # CLI：init-admin / seed-dev-users / sync / retention
│   ├── tests/                # 单元与集成测试（node:test，.mjs）
│   ├── fixtures/             # 脱敏 MCP 响应样本（仅虚构数据）
│   ├── db/ + drizzle/        # drizzle schema 与迁移（追加写触发器见 0003 注释）
│   ├── worker/               # 运行时入口（fetch + 定时触发；自托管 Node 容器与 Cloudflare Worker 可选）
│   └── package.json          # scripts：test / test:unit / test:integration / lint / db:*
├── docs/                     # 权威文档矩阵（00–09）+ decisions/ + validation/
├── docker-compose.yml        # db / migrate / web 本地编排
├── Makefile                  # dev / check / test / db-migrate / hooks
├── CLAUDE.md                 # 开发入口与规范驱动流程
└── CHANGELOG.md              # 变更记录与验证状态
```

应用框架边界以 `ADR-001` 为准，PostgreSQL、Drizzle 和容器开发基线以 `ADR-002` 为准。后续改变核心框架、数据库或生产编排方式时必须建立新 ADR，不得只修改实现。新增业务行为先在 `docs/` 权威文档确认口径，再写脱敏 Fixture 驱动的 RED 测试，最后实现。

## 4. 测试分层

| 层级 | 首期必须覆盖 |
|---|---|
| 单元测试 | 7～30 天边界、零推荐判定、评分、分层、去重、频控、脱敏 |
| 契约测试 | MCP Schema 映射、Web 提取契约/页面结构漂移、分页、错误分类、LLM 结构化输出、消息网关回执 |
| 集成测试 | 数据同步入库、浏览器采集回执/ingestion ticket 幂等、任务幂等、审核到活动、意向到跟进任务 |
| E2E | 登录、职位筛选、匹配审核、落地页 A/B/C、漏斗展示 |
| 安全测试 | 越权、令牌枚举/过期/撤销、Cookie/简历/联系方式跨边界泄漏、匹配模块读取隔离、退订拦截 |

真实 MCP、Web、LLM 和短信调用不进入每次提交的快速门禁；日常 CI 使用完全虚构 Fixture，候选版本再运行受控联调并记录授权范围、设备/环境、费用和结果。真实网页或简历打码副本不得成为 CI Fixture。

### 4.1 浏览器提取契约专项流程

浏览器采集除遵守 §2 通用门禁外，还必须执行 [`授权浏览器采集开发与联调 Runbook`](runbooks/browser-collection.md)：

1. 先确认并记录授权页面、字段、用途、频率、保存和删除范围；授权不完整时只运行虚构 Fixture。
2. 通用浏览器工具只用于单页探索；生产任务只能选择预审核的版本化只读契约。
3. 请求和回执先固化 JSON Schema，再分别完成 CSDN-Agent Provider 与 auto-headcount Consumer 契约测试。
4. 真实页面发现的新边界先转为完全虚构 Fixture 并确认 RED，再修改解析器；真实网页副本和打码简历不得进入仓库。
5. 候选版本只运行单实体受控 smoke test，输出限制为字段存在性、类型、长度、哈希、耗时和机器错误码。
6. 每次真实联调在 `docs/validation/` 保存脱敏证据并关联两端 commit/tag；任一执行端未版本化时必须登记偏差，不能声明可复现发布。

当前职位详情协议使用 [`liebide-job-detail.request.v1`](contracts/liebide-job-detail.request.v1.schema.json) 和 [`liebide-job-detail.receipt.v1`](contracts/liebide-job-detail.receipt.v1.schema.json)。`make check-browser-contract` 校验 Consumer 实现与本仓 Schema；设置 `CSDN_AGENT_REPO` 后运行 `make check-browser-contract-cross-repo`，还会比较 Provider/Consumer 的完整规范化 Schema 哈希。浏览器连接诊断仍属后续实现门禁，在落地前不得把人工联调描述为无人值守采集能力。

### CI 实现（GitHub Actions）

- `.github/workflows/ci.yml` 在 push（`main`/`dev`）与 PR 上运行，分层：静态（ESLint + 空白 + markdown 相对链接）→ 单元/契约（`test:unit`）→ 数据库迁移（`node db/migrate.mjs`，兑现 ADR-002 §44）→ 集成（`test:integration`，PostgreSQL 17 服务容器）→ 构建 + 服务端渲染 + HTTP 层。
- CI 直接 `npm ci` + Node 执行，不走 docker compose 镜像（避免镜像烘焙陈旧 `package.json`/`worker`/`vite.config`）；测试仅使用脱敏 Fixture 与测试加密 key，不注入真实 MCP/加密/数据库凭据。
- 本地用 `make ci` 跑同路径流水线：先 `docker compose build web`（重建镜像使烘焙文件新鲜）→ 迁移 → lint/unit/integration → 构建 + 渲染 + HTTP → markdown 链接检查。

## 5. 首批验收场景

- 发布时间恰好 7 天、推荐数为 0、状态有效的职位被纳入。
- 发布不足 7 天或超过 30 天的职位不被纳入。
- 发布 7～30 天但已有有效推荐的职位不被纳入。
- 候选人落地页不返回公司名称及其别名。
- 薪资只显示合法范围；单值、缺失或异常薪资使用安全降级文案。
- 工作地点只显示城市，不显示区、街道、楼宇或远程办公地址细节。
- 85 分进入高匹配，75～84 分进入中匹配，低于 75 分默认不可触达。
- 未经人工批准、已退订或超过频控的人选不能进入发送队列。
- 同一活动、候选人、渠道的重复发送请求保持幂等。

## 6. 交付记录模板

```text
变更范围：
对应规范：
ADR 检查：命中/未命中；理由：
RED 证据：
实现摘要：
实际验证命令：
通过/失败/跳过：
已知偏差：
```

每次可交付变更还需更新仓库根目录 `CHANGELOG.md` 的 `Unreleased` 区域。Git 提交历史不能替代交付记录；路线图和 ADR 也不能替代变更日志。

## 7. 标准本地环境

- 标准开发入口为根目录 Docker Compose，不以宿主机直接运行 Node.js 或 PostgreSQL 作为验收基线。
- Compose 至少包含 Web、PostgreSQL 和一次性迁移服务，并提供健康检查与持久化开发卷。
- 容器不得内置真实 Secret；本地 Secret 通过被 Git 忽略的环境文件注入。
- 单元测试可在独立测试容器中运行；数据库集成测试必须使用与生产相同 PostgreSQL 大版本的临时数据库。
- 标准命令与镜像约束以 `ADR-002` 为准。

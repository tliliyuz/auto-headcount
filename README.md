# 零推荐职位激活系统

面向企业 HR 与猎头的招聘交付工具：识别长期无推荐的职位，从授权人才库中匹配候选人，通过脱敏职位页和合规触达收集意向，最终形成可追踪的推荐闭环。

## 当前阶段

仓库处于项目启动阶段，已完成 MVP 范围、系统架构、数据模型、MCP 接入约定、安全要求和实施计划。

首版产品形态已确定为内部运营后台；候选人只访问带令牌的脱敏职位落地页，不提供企业客户自助门户。

首个可运行切片已完成：`apps/web/` 提供沉睡职位巡检、类别筛选、批量选择、匹配池概览和候选人脱敏页面预览。当前使用脱敏 Mock 数据，真实 MCP、数据库、登录和消息渠道尚未接入。

当前切片是单页交互演示，不是完整产品原型。侧边栏多数模块、创建匹配任务、分页、触达和候选人意向提交仍是未接线占位。

下一交付目标是里程碑 0：完成 MCP 接口/样本验证并接受身份、区域和数据生命周期方案；随后按 `ADR-002` 建立 PostgreSQL + Docker 开发环境和第一条真实同步链路。

## MVP 主链路

```text
沉睡职位发现 → 数据标准化/摘要 → 候选人匹配 → 人工审核
      → 脱敏落地页 → 短信/邮件触达 → 意向收集 → 人工推荐
```

## 已确认技术方案

- TypeScript 全栈单体应用，优先保证一人可维护和快速交付。
- Web：Next.js；API：Next.js Route Handlers 或独立 Fastify 模块。
- 数据库：已确认 PostgreSQL 17、Drizzle 迁移；标准本地环境将通过 Docker Compose 运行 Web 与数据库（尚未实现）。
- ORM：Drizzle ORM。
- 异步任务：MVP 先使用数据库任务表，规模扩大后再引入队列。
- MCP、浏览器采集、LLM、短信和邮件均通过适配器接入。
- 部署目标在完成基础设施确认后确定，不绑定 CloudBase/CloudStudio。

PostgreSQL 与容器基线已由 `ADR-002` 固化。OIDC 登录、中国大陆测试/生产区域、数据加密分层和保留上限由 `ADR-003` 固化。真实数据上线仍需取得数据授权并书面确认最终保留期限。

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
- [架构决策记录](docs/decisions/README.md)

## 本地配置

1. 复制 `.env.example` 为 `.env.local`。
2. 通过密码管理器或本地环境变量填写密钥。
3. 不得把真实 Access Key、Secret Key、手机号、邮箱或完整简历提交到 Git。

当前对话中曾出现过一组 MCP 明文凭证，应在正式联调前完成轮换。

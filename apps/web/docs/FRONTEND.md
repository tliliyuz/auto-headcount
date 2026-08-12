# 前端地图（Frontend Map）

本文档是前端页面的**地图与接线状态**，不是业务规范。业务行为（沉睡规则、匹配分档、脱敏要求、触达门禁）以 [`docs/01-mvp-requirements.md`](../../../docs/01-mvp-requirements.md) 与 [`docs/07-acceptance-criteria.md`](../../../docs/07-acceptance-criteria.md) 为准；模块边界与数据所有权见 [`docs/02-architecture.md`](../../../docs/02-architecture.md)。

当前前端为**单文件静态原型**：`apps/web/app/operations-dashboard.tsx` 承载登录视图、全部页面与假数据，`apps/web/app/globals.css` 承载全部样式。按既定决策保留该 UI，随后就地接真实数据。

默认初始视图为**登录页**（`LoginPage`）；请求头 `x-prototype-view: app` 可强制初始进入工作台（供服务端渲染测试覆盖两个视图）。

## 1. 技术基线

- 框架：Vinext（React Server Components），文件顶部 `"use client"`，单页应用。
- 单文件现状：全部页面组件 + 假数据集中在 `operations-dashboard.tsx`（约 530 行）。
- 尚无 API 层（无 Route Handler / 服务端数据获取），无鉴权（自有登录 / RBAC 未实现）。
- 样式：Tailwind 引入 + `globals.css` 自定义类 + `:root` 设计 token。

## 2. 页面清单与接线状态

| 页面 | 组件 | 数据来源 | 状态 |
|---|---|---|---|
| 沉睡职位巡检 | `OperationsDashboard` 内联 | `jobs` 数组（Mock）+ 真实 `job-rules` 筛选 | 规则真实，数据 Mock |
| 智能匹配 | `MatchingPage` | `candidates` 数组 | 静态原型 |
| 触达活动 | `CampaignsPage` | `campaignRows` 数组 | 静态原型 |
| 跟进任务 | `FollowupsPage` | `followupColumns` 数组 | 静态原型 |
| 转化漏斗 | `FunnelPage` | 内联 `bars` / `stages` / 转化表 | 静态原型 |
| 数据源 | `SourcesPage` | 内联同步批次 / 健康数组 | 静态原型 |
| 审计日志 | `AuditPage` | 内联审计记录数组 | 静态原型 |

导航为 7 个页面（无独立工作台页，沉睡职位巡检为默认落地页）。

### 登录视图（原型）

- 组件：`LoginPage`（`operations-dashboard.tsx` 内），默认初始视图；侧边栏资料菜单「退出登录」可返回登录页。
- Mock 流程：账号 `ops` 直接进入工作台；账号 `admin` 走「首次登录设置新口令」；其余账号返回统一失败文案，连续 3 次触发临时锁定（提供「重置演示」清除）。
- TOTP 字段为占位，展示生产管理员登录时的校验位。
- 无真实鉴权：表单校验与流程均为前端 mock；接真实数据时替换为 [`docs/09-api-contract.md`](../../../docs/09-api-contract.md) 的 `/api/auth/*` 契约。

## 3. 假数据清单（接真数据时的替换点）

| 数据 | 位置 | 对应真实来源（路线图阶段） |
|---|---|---|
| `jobs`（6 个职位，含公司名/详细地址） | `operations-dashboard.tsx` 顶部 | 职位同步仓储 → 规范化 `jobs` 表（M1） |
| `candidates`（4 个候选人） | 文件顶部 | MCP `candidates.search` → 候选人表（M1/M2） |
| `campaignRows`（4 个活动） | 文件顶部 | `campaigns` / `campaign_recipients` 表（M3） |
| `followupColumns`（看板列） | 文件顶部 | `follow_up_tasks` 表（M4） |
| 漏斗/转化数据（内联） | `FunnelPage` | `funnel_events` 聚合（M4） |
| 同步批次/健康数据（内联） | `SourcesPage` | `sync_runs` / `source_connections` 表（M1） |
| 审计记录（内联） | `AuditPage` | `audit_logs` 表（M1） |

> 安全提醒：`jobs` 数组含伪造的公司名、公司别名与详细地址。这些字段**只用于 Mock，禁止进入渲染输出或 Fixture**；对外展示必须经过 `toPublicJobView` 脱敏投影（渲染测试已守卫公司名/详细地址不泄漏）。接真实数据后，原始载荷与规范化数据的脱敏边界以 `03-data-model.md` 与 `04-mcp-integration.md` 为准。

## 4. 可复用组件

- `PageIntro`：页头（eyebrow / 标题 / 描述 / 主按钮）。
- `SummaryStrip`：KPI 指标卡行。
- 通用表格：`data-table` + `data-row` / `data-head` + `status-tag`；变体见 `globals.css` 的 campaign / performance / sync / audit 表。
- 候选人样式：`candidate-avatar`、`match-score`、`score-badge`。
- 跟进看板：`kanban` / `kanban-column`。
- 脱敏预览模态框：`preview-modal`（候选人对职位落地页的预览）。

## 5. 设计 Token（`globals.css` `:root`）

`--ink` `--muted` `--line` `--blue` `--blue-dark` `--blue-soft` `--surface` `--canvas` `--green` `--amber` `--violet`。新增颜色必须先登记到 `:root`，禁止在组件内硬编码色值。

## 6. 接数据重构路径（对应路线图 M1–M4）

1. 拆文件：每页组件从 `operations-dashboard.tsx` 拆到独立文件，按 `02-architecture.md` 的模块名组织。
2. 建 API 层：用 Vinext Route Handler 或独立模块提供数据，前端经适配器取数，不直连数据库。
3. 数据驱动：用数据加载替换硬编码数组；沉睡职位页保留 `job-rules` 真实规则。
4. 鉴权门禁：接入自有登录与角色权限（ADR-004 / ADR-003），未登录不渲染业务数据。
5. 每页接线完成后，在本表更新状态并记入 `CHANGELOG.md`。

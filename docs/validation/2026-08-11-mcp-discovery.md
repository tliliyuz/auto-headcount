# MCP 接口发现验证记录

- 日期：2026-08-11
- 环境：轮换后的测试凭证，本地受控发现命令
- 状态：部分通过；真实 `initialize`、`tools/list`、空岗最小 `tools/call` 及空岗运行时响应映射已验证，其他 MVP 工具响应映射待验证
- 权威规范：[`docs/04-mcp-integration.md`](../04-mcp-integration.md)

## 执行记录

```text
npm run mcp:discover -- --output /tmp/auto-headcount-mcp-discovery.json
```

结果：成功生成仓库外快照。未把 Access Key、Secret Key、请求头、真实职位、人选或联系方式写入仓库。

## 发现结果

| 项目 | 结果 |
|---|---|
| 协议版本 | `2025-11-25` |
| 服务 | `enterprise-mcp-server 1.0.0` |
| 工具数量 | 40 |
| 工具列表变化通知 | 不支持（`listChanged: false`） |
| `outputSchema` | 40 个工具均未声明 |
| 版本化 Fixture | `apps/web/fixtures/mcp/tools-2025-11-25-2026-08-11.json` |
| 原临时快照 SHA-256 | `1b4e66c5106a79bcc420ddb313c18de617dab82dd7bce0307ec1cfaa9d399bd0` |

## 最小只读调用结果

执行 `wb.jobs.under_served`，参数为 `days_without_rec=7, page=1, page_size=1`，原响应只保存于临时目录。调用成功，响应 `Code=0`，且返回记录的 `days_without_rec=7`，因此测试环境当前行为包含第 7 天边界。

响应没有 `structuredContent`，业务 JSON 位于首个 `content[type=text].text` 中，包络与字段如下：

```text
Code: number
Message: string
Data:
  filter: object | null
  total/page/page_size/total_pages: number
  list[]:
    job_id/job_title/client_company: string
    owner_id/owner_name: string
    days_without_rec: number
    last_rec_date: string | null
    category/city: string
    salary_min/salary_max: number
    portal_url: string
    created_at: string | null
```

本次真实样本的 `created_at` 与 `last_rec_date` 均为 `null`。仓库仅保存使用虚构 ID、企业、负责人和 URL 生成的脱敏响应 Fixture：`apps/web/fixtures/mcp/under-served-response-2026-08-11.json`。

运行时映射只接受经过校验的字段类型，并将状态与零推荐分别标记为 `provider_filter` 证据，不伪造成供应商显式响应字段。本地选择再次执行 `7 <= days_without_rec <= 30`；类型漂移会以 `MCP_CONTRACT_INVALID` 失败，不进入业务模型。

## MVP 能力映射

| 业务能力 | 已发现工具 | 结论 |
|---|---|---|
| 沉睡职位 | `wb.jobs.under_served` | 可作为召回来源，但仍须本地执行 7～30 天、有效、零推荐规则 |
| 候选人搜索 | `wb.candidates.search` | 输入契约已发现，响应字段待最小调用确认 |
| 职位匹配候选人 | `wb.jobs.match_candidates` | 输入契约已发现；建议超时 180 秒，与通用 60 秒基线不同，需独立策略 |
| 推荐查重 | `wb.recommendations.check` | 可用于推荐前全量查重 |
| 正式推荐 | 未发现写工具 | MVP 暂不能承诺自动回写；需对方确认新工具或采用受审计 Portal 记录 |
| 短信/邮件 | `sms_send_marketing_lbd` / `mail_send_common_lbd` | 已发现写工具，但人工审批、退订、频控和幂等完成前禁止调用 |

## 输入字段字典

### `wb.jobs.under_served`

| 外部字段 | 类型 | 内部含义/处理 |
|---|---|---|
| `days_without_rec` | integer | 供应商召回阈值；不能代替本地沉睡规则 |
| `page` / `page_size` | integer | 页码分页；`page_size` 最大 200 |
| `owner_id` | string | 可选负责人过滤；与 `team_id` 互斥 |
| `team_id` | string | 可选团队过滤；与 `owner_id` 互斥，依赖未发现于快照的团队解析流程 |

### `wb.candidates.search`

| 外部字段 | 类型 | 内部含义/处理 |
|---|---|---|
| `keyword` / `skills` / `current_company` | string | 搜索条件；不得直接进入日志 |
| `min_experience` / `max_experience` | integer | 工作年限范围 |
| `source` / `created_by` | string | 来源与创建者过滤，需保留权限错误语义 |
| `start_date` / `end_date` / `days` | string/integer | 时间窗口参数互斥关系需在适配器校验 |
| `page` / `page_size` | integer | 页码分页 |

### `wb.jobs.match_candidates`

| 外部字段 | 类型 | 内部含义/处理 |
|---|---|---|
| `job_id` | string | 必填外部职位 ID |
| `start_date` / `end_date` / `days` | string/integer | 候选人召回时间窗口 |
| `page` / `page_size` | integer | 页码分页，实际最大值需最小调用确认 |
| `min_score` | integer | 外部分数过滤，不能直接替代本地规则版本与可复算评分 |
| `max_llm_score_count` | integer | 外部 LLM 评分数量上限，涉及费用和 180 秒超时 |

## 风险与待确认

1. `wb.jobs.under_served` 文案是“超过 N 天”，真实调用确认阈值 7 会返回第 7 天，但接口没有 30 天上限。内部必须额外排除 `days_without_rec > 30`。
2. 所有工具缺少 `outputSchema`，不能仅凭工具描述建立生产映射；每个 MVP 工具都需要脱敏响应 Fixture 和运行时校验。
3. 若干 JSON Schema 出现类型与默认值不一致，例如 integer/array 字段默认 `""`。适配器不得把默认值当作合法类型。
4. `wb.jobs.get`、`wb.candidates.get` 建议 120 秒，匹配工具建议 180 秒；需把发现握手超时与业务调用超时分开。
5. 工具描述包含面向 Agent 的展示指令。业务系统只消费已批准字段，不执行供应商描述中的展示行为。
6. 发现了职位/简历批量创建、短信和邮件等写工具。MVP 适配器必须采用显式允许列表，禁止提供通用任意工具调用入口。
7. `wb.candidates.get` 描述表示读取可能触发画像生成并回写自我评价。该工具不是纯读，调用前需单独确认副作用和数据授权。
8. 未发现正式推荐写工具；需要供应方确认，或按产品规范走人工 Portal 并保存受审计操作记录。
9. 空岗响应没有职位状态和有效推荐数，只能追溯为“由供应商工具筛选”；不能伪造为上游显式返回字段。
10. `created_at` 可为 `null`，暂时无法证明 `days_without_rec` 与产品定义的“发布自然日数”完全等价，需供应方书面确认口径。

## 下一门禁

- 向供应方确认 `days_without_rec` 的起算点、自然日口径及 `created_at` 为空的语义。
- 获取 10～20 个经授权、脱敏的边界样本，覆盖第 30 天、分页、空列表和字段缺失。
- 在数据来源与落库授权书面确认前，不调用候选人详情、匹配、短信、邮件或批量创建工具。

# MCP 候选人/职位数据链路验证记录

- 日期：2026-08-12
- 环境：轮换后的测试凭证，本地受控调用
- 状态：部分通过；`wb.jobs.list` 与 `wb.jobs.match_candidates` 真实调用成功，`candidates.list/search/stats` 对当前账号返回空（权限边界）
- 权威规范：[`docs/04-mcp-integration.md`](../04-mcp-integration.md)

## 执行记录

本次调用均为只读最小参数，原始响应仅保存于仓库外 `/tmp`（0600 权限），未把真实职位、候选人、顾问姓名或 Portal URL 写入仓库。

| 工具 | 参数 | 结果 |
|---|---|---|
| `wb.jobs.list` | `page=1, page_size=3` | `Code=0`，`total=24`，返回职位列表 |
| `wb.jobs.match_candidates` | `job_id=<真实职位>, days=90, page_size=3, min_score=75, max_llm_score_count=1` | `Code=0`，`total=219`，返回匹配摘要 |
| `wb.candidates.list` | `page=1, page_size=3, days=90` | `Code=0`，`total=0` |
| `wb.candidates.search` | 关键词/时间窗多组最小参数 | `Code=0`，`total=0` |
| `wb.candidates.stats` | 今日与 90 天区间 | `Code=0`，`total_count=0` |
| `wb.jobs.match_candidates` | 对 `under_served` 返回的运营账号职位 | `Code=1003 Data not found` |

## 关键发现

1. `wb.jobs.list` 返回 24 个职位，字段完整（含 `client_company`/`customer_name`/`department_path`/`job_description`/`salary`/`city`/`created_by`），**未脱敏**，仅限内部。
2. `wb.jobs.match_candidates` 返回匹配摘要：姓名已打码（只保留姓）、无手机/邮箱/完整简历正文；但 `current_company`/`current_title`/`resume_summary` 与顾问姓名未打码。
3. `candidates.list/search/stats` 对当前账号均返回空（90 天窗口内 `total` 为 0），属权限边界，不作为扩大权限的理由。
4. 对 `under_served` 返回的运营账号职位调用 `match_candidates` 返回业务错误 `1003 Data not found`；对 `wb.jobs.list` 返回的其他职位调用成功，说明 `match_candidates` 对部分职位可能越界或无可匹配简历，需按工具返回的权限语义处理。
5. 传入 `max_llm_score_count=1` 时返回 `score_status=pending`、`total_score=null`，本批未实际产生 LLM 评分结果。

## 脱敏边界（实测）

| 数据 | 是否脱敏 |
|---|---|
| 候选人姓名 | ✅ 打码（保留姓） |
| 手机/邮箱/联系方式 | ✅ 返回中不存在 |
| 完整简历正文 | ✅ 返回中不存在（仅 `resume_summary`） |
| 候选人当前雇主/职位/简历摘要 | ⚠️ 未打码 |
| 顾问（owner/created_by）姓名 | ⚠️ 未打码 |
| 职位客户公司/JD/部门路径 | ⚠️ `wb.jobs.list` 未脱敏 |

## 结论

- 职位数据链路可用：`wb.jobs.under_served`（脱敏投影）与 `wb.jobs.list`（完整内部字段）均可真实拉取。
- 候选人数据链路：匹配摘要经 `wb.jobs.match_candidates` 可用且姓名已打码；候选人列表/搜索对当前账号为空。
- 浏览器采集确认不需要（2026-08-12 澄清流程偏差），MCP 为唯一主数据接入。
- 项目负责人确认脱敏候选人数据可入库，暂不设固定保留期限上限。

## 下一门禁

- 向供应方确认 `match_candidates` 建议 180s 超时与当前客户端 120s 上限的差异、LLM 评分费用口径与结果可用时机。
- 确认 `candidates.list/search/stats` 空结果原因与 team 范围授权。
- `wb.candidates.get` 已确认不调用（画像回写 + LLM 副作用）；完整简历正文不纳入 MVP。

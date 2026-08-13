# CSDN 企业服务 MCP 接入规范

## 1. 已知连接信息

- 传输类型：Streamable HTTP。
- 服务地址通过 `MCP_SERVER_URL` 注入。
- 请求超时：默认 60 秒。
- 鉴权请求头由 `MCP_ACCESS_KEY` 和 `MCP_SECRET_KEY` 映射。

仓库禁止保存真实 Access Key 或 Secret Key。

## 2. 首次联调顺序

1. 使用轮换后的测试凭证建立 MCP 会话并执行 `initialize`。
2. 保存服务端返回的协议版本与能力，不记录密钥。
3. 调用 `tools/list` 获取真实工具名称和输入 Schema。
4. 对每个所需工具使用最小测试参数执行一次 `tools/call`。
5. 根据响应建立字段映射、分页、错误分类和数据使用约束。
6. 将脱敏后的请求/响应样例保存为测试夹具。

发现工具使用 `apps/web` 中的受控命令：

```bash
npm run mcp:discover -- --output /tmp/auto-headcount-mcp-discovery.json
```

该命令执行 `initialize`、`notifications/initialized` 和支持游标的 `tools/list`，兼容 JSON 与 SSE 响应，只输出协议版本、服务信息、能力和工具 Schema。输出文件使用独占创建与仅当前用户读写权限，不覆盖旧文件。结果必须先写入仓库外并人工检查，禁止直接把真实响应保存到 Git。

不能仅依据口头名称假设工具一定叫 `wb.jobs.under_served`、`match_candidates` 或“推荐接口”；以 `tools/list` 返回值为准。

## 3. 已确认能力与工具（2026-08-12 更新）

以 `tools/list` 实测为准（协议 `2025-11-25`，共 40 个工具，均未声明 `outputSchema`）。MVP 白名单读工具及返回类型：

| 业务能力 | 已确认工具 | 返回类型要点 | 状态 |
|---|---|---|---|
| 沉睡职位 | `wb.jobs.under_served` | `Data.list[]`：job_id/job_title/client_company/owner_id/owner_name/days_without_rec/category/city/salary_min/salary_max/portal_url/created_at | ✅ 已验证；公司/薪资/城市为空；**跨账号作用域**（含非本账号可操作职位） |
| 职位列表 | `wb.jobs.list` | `Data.list[]`：job_id/job_title/category/client_company/customer_name/department_path/job_description/salary_min/salary_max/city/created_by/status 等 | ✅ 已接入；**账号自身作用域（可操作集边界）**：`runUnderServedSync` 拉取它与 `under_served` 取交集，只入库可操作∩沉睡；落地页白名单仍禁 JD |
| 职位详情 | `wb.jobs.get` | `Data` 单对象：job_id/job_title/category/client_company/job_description/salary_min/salary_max/city/created_by/status/portal_url 等 | ✅ 2026-08-13 受控验证：对沉睡职位（含非可操作）均返回 Code=0 + job_description；`job_details_jobs` 同步改为 DB 驱动 + `jobs.get` 补全（只对可操作∩沉睡缺 JD 职位调用）；**无 days_without_rec/推荐数** |
| 候选人匹配 | `wb.jobs.match_candidates` | `Data.matches[]`：candidate_id/is_own/owner_id/owner_name/score_status/total_score/dimension_scores/match_highlights/gap_analysis/risk_flags + candidate_summary{name 已打码, current_title, current_company, resume_summary, portal_url} | ✅ 已验证；建议超时 180s |
| 候选人搜索 | `wb.candidates.search` | `Data.list[]` | ✅ 发现已确认；当前账号返回空 |
| 候选人列表 | `wb.candidates.list` | `Data.list[]` | ✅ 发现已确认；当前账号返回空 |
| 候选人统计 | `wb.candidates.stats` | `Data.total_count/by_category/by_creator/by_source/trend` | ✅ 发现已确认；当前账号为 0 |
| 候选人详情 | `wb.candidates.get` | 含 AI 画像；可能触发画像回写与 LLM 调用 | 🚫 禁用 |
| 推荐查重 | `wb.recommendations.check` | 是否已推 `(candidate_id, job_id)` | ⏳ 待接线 |
| 简历批量创建 | `wb.resumes.batch_create` | 写工具 | 🚫 禁用 |
| 短信 | `sms_send_marketing_lbd` | 写工具 | 🚫 禁用 |
| 邮件 | `mail_send_common_lbd` | 写工具 | 🚫 禁用 |

真实发现记录见 [validation/2026-08-11-mcp-discovery.md](validation/2026-08-11-mcp-discovery.md)，2026-08-12 的最小调用验证见 [validation/2026-08-12-mcp-candidate-sync.md](validation/2026-08-12-mcp-candidate-sync.md)。`candidates.list/search/stats` 对当前账号返回空属 MCP 权限边界，不作为换身份或绕过权限的理由。根据 `ADR-005`，业务主匹配改为本地版本化、可复算规则；`wb.jobs.match_candidates` 保留为供应方评分对照和受控联调能力。

## 4. 内部适配要求

MCP 返回值不能直接进入页面或业务表，必须经过：

```text
响应校验 → 原始快照 → 字段映射 → 数据清洗
→ 去重 → 规范化实体 → 业务规则
```

每个适配器需要提供：

- 输入/输出运行时校验。
- 分页与游标处理。
- 60 秒总超时和有限重试；匹配类工具（`wb.jobs.match_candidates`、`wb.candidates.match_jobs`、`wb.jobs.recommended_candidates` 等）建议 180s，需独立超时策略（当前发现客户端上限 120s）。
- 请求关联 ID 与不含密钥的结构化日志。
- 401/403、429、5xx、超时和业务错误的分类处理。
- 对未知字段兼容，对缺失必填字段明确失败。
- 业务错误码按语义区分：权限边界（`403`/`1003`/`1004`）映射 `MCP_PERMISSION_BOUNDARY`（调用方不重试、不换身份）；其余瞬时上游错误映射 `MCP_UPSTREAM_ERROR`（可退避重试）。

## 5. 凭证管理

- 本地：仅写入被 Git 忽略的 `.env.local`，并限制文件权限。
- 测试/生产：使用部署平台 Secret Manager。
- 前端永远不能读取 MCP 凭证；所有 MCP 请求由服务端发起。
- 日志和错误上报需显式过滤 `X-Access-Key`、`X-Secret-Key` 和请求头。
- 建议每 90 天或发生暴露时立即轮换，并保留轮换记录。

## 5.1 最低权限运行基线

- 当前接入账号按普通实习/运营账号处理，只使用 MCP 服务端已经授予该 Actor 的可见范围，不假设拥有 Admin、TeamLeader、全公司或跨团队权限。
- `MCP_ACTOR_ID` 仅在供应商要求时由服务端适配器注入；业务输入不得任意指定其他 Actor。
- 403、业务错误 `1004` 或空结果按权限边界处理，不自动换用其他账号、扩大团队范围或尝试绕过。
- MVP 只允许显式列入适配器白名单的读工具。短信、邮件、批量创建、候选人详情及其他可能写入或触发画像回写的工具保持禁用，直到对应审批和数据授权门禁完成。
- MCP 与授权 Web 采集是并列数据源；MCP 适配器仍按当前 Actor 的最低权限运行，Web 数据由 `ADR-005` 的独立浏览器采集适配器处理，不在 MCP 适配器内模拟网页请求。
- 当前账号 `candidates.list/search/stats` 返回空属 MCP 权限边界；`wb.jobs.match_candidates` 可返回姓名打码、无联系方式的简历摘要，作为低敏候选人样本和外部评分对照，不再是唯一候选人路径。

## 5.2 与授权 Web 采集的关系（2026-08-13）

- CSDN-Agent 浏览器插件复用员工现有平台登录态，作为网页执行端；Cookie、密码、验证码和原始 Authorization 不得进入本系统或 MCP 返回值。
- 生产采集只调用预审核、版本化的提取契约。现有通用 `csdn_get_page_snapshot`、`csdn_fetch_with_cookie`、`csdn_evaluate_script` 等能力只用于受控探索和契约开发，不作为批量简历采集接口。
- 完整简历与联系方式不得经 Agent 对话或通用 MCP 工具结果中转；应使用短期单次 ingestion ticket 从浏览器直传 auto-headcount 采集入口。
- MCP 和 Web 对同一实体的字段不得无条件互相覆盖；规范化层保存字段来源、契约/映射版本、采集时间和内容哈希，并按已确认优先级生成业务投影。
- `days_without_rec` 等沉睡证据继续优先使用明确提供该语义的来源；仅在 Web 页面字段口径完成验证后，Web 记录才能独立证明 7～30 天、有效和零推荐。

## 6. 待向对方确认（2026-08-12 更新）

已确认：MCP 协议 `2025-11-25`、40 个工具清单、测试凭证联调、`wb.jobs.under_served`/`wb.jobs.list`/`wb.jobs.get`/`wb.jobs.match_candidates` 最小调用成功；项目负责人确认脱敏候选人数据可入库且暂不设固定保留期限上限、生产区域为中国大陆、登录采用自有账号（`ADR-004`）；`wb.jobs.under_served` 提供沉睡召回证据，`wb.jobs.get` 为 MCP 职位补 JD；`ADR-005` 已接受授权 Web 采集与本地匹配方向，但尚未实现。

**2026-08-13 供应方能力受控验证与可操作收敛（fix4 决策）**：
- `wb.jobs.get` 受控调用（3 个沉睡职位含 1 个非可操作）：**均返回 Code=0 + job_description**（此前文档「get 对 775 个返回 1003」是从 `match_candidates` 推断，实测 get 不受限）。**JD 补全路径 = `under_served + jobs.get`**（`job_details_jobs` 同步已改为 DB 驱动 + `jobs.get`，只对可操作∩沉睡缺 JD 职位调用，不给 771 个逐个补）。
- **「可操作」边界 = `wb.jobs.list` 账号自身作用域（24 个）**，判据 `match_candidates` 对该集合成功、对 under_served 非自身职位返回 `1003 Data not found`（validation 2026-08-12）。`match_candidates` 评分 `score_status=pending` 是**正常业务状态**（LLM 打分中），后续轮询/重读，不视为失败。
- **fix4 只入库可操作∩沉睡**：`under_served` page_size 提到 200（100 页→14 页，拉取减 7 倍）；`wb.jobs.list` 拉可操作集；只持久化两者交集；**不在交集的上游仍沉睡职位标记 `operability_status=not_in_access_scope`，不用 closeStale 标 closed**（「上游职位关闭」≠「当前账号无法匹配」）。closeStale 只关闭本次完整拉取真正未见的职位。
- 真实同步实测（2026-08-13）：eligible 769 / operable 24 / persisted 2 / inoperableSeen 767 / closedStale 2；沉睡视图从 771 收敛到 2 个可操作职位。宽口径由 `ADR-005` 已确认的授权 Web 数据源承接，适配器尚未实现。

仍待确认：

- 部署平台与具体中国大陆城市：生产区域已确认，具体云厂商与城市待域名备案、短信资质、MCP 网络连通性和成本确认后选择。
- `wb.jobs.match_candidates` 超时与评分口径：建议 180s，当前发现客户端上限 120s，需确认实际耗时上限与是否允许放宽；LLM 评分（`max_llm_score_count`）的费用承担方与评分结果可用时机（实测返回 `score_status=pending`）。
- `candidates.list/search/stats` 对当前账号返回空：是权限范围（self 无自建候选人）还是测试环境无数据；如需候选人列表而非仅匹配摘要，是否授予 team 范围。
- `portal_url` 使用边界：内部 Portal 链接的有效期、可打开性，是否属于「可使用的落地页令牌」需单独对待。
  - 现状决策（2026-08-12 固化）：`portal_url` 仅随原始载荷加密存于 `raw_records.payload_ciphertext` 与规范化 `jobs.portal_url` 列；**业务只读 API 投影不返回任何 `portal_*`/`raw_records` 字段**（`job-read-repository.mjs` 白名单投影），客户端与候选人落地页均不可见。将其作为可触达令牌使用前，须完成链接有效期、打开权限与审计的单独确认。
- 写工具授权：短信/邮件/简历批量创建/推荐写工具在 M3/M4 的模板、签名、退订、频控、人工审批与幂等要求。
- `days_without_rec` 起算点与自然日口径、`created_at` 为 null 的语义（见验证记录风险清单）。
- 正式推荐写工具：未发现，MVP 需确认采用受审计 Portal 记录或新增工具。

## 7. 原始响应保存契约

- 每次成功工具调用先校验传输层与响应包络，再将必要原始载荷加密写入 `raw_records`，随后执行字段映射；不得把供应商 JSON 直接写入业务表。
- 原始记录元数据至少包括工具名/能力标识、同步批次、Schema 或协议版本、外部 ID、采集时间、载荷哈希、映射版本、处理状态和请求关联 ID。
- 请求头、Access Key、Secret Key、会话 Cookie 和可直接使用的落地页令牌不得进入原始快照。
- 夹具从已授权样本脱敏生成，保存 Schema 形状和边界值，不保留真实姓名、联系方式、简历正文或可识别企业信息。
- 原始载荷的加密、访问和工程保留上限以 `ADR-003` 为准；项目负责人已确认（2026-08-12）脱敏候选人数据可入库且暂不设固定保留期限上限，收到数据提供方更严格要求时以更严格者为准，书面确认前 Fixture 仍须虚构化。

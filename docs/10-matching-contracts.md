# 匹配输入与 LLM 评分契约

本文档是 M3 数据集成与匹配输入/输出契约的唯一权威来源。业务流程与分档见 [MVP 需求](01-mvp-requirements.md)，持久化见 [数据模型](03-data-model.md)，长期取舍见 [ADR-005](decisions/ADR-005-authorized-web-collection-and-local-matching.md)。

## 1. 契约与版本

| 契约 | JSON Schema | 生产者 | 消费者 |
|:---|:---|:---|:---|
| 职位要求投影 `job-requirement-projection/v1` | [`contracts/job-requirement-projection.v1.schema.json`](contracts/job-requirement-projection.v1.schema.json) | 职位集成/提取服务 | 硬过滤、LLM 适配器 |
| 候选人脱敏匹配投影 `candidate-match-projection/v1` | [`contracts/candidate-match-projection.v1.schema.json`](contracts/candidate-match-projection.v1.schema.json) | 候选人集成/脱敏服务 | 硬过滤、LLM 适配器 |
| LLM 详情维度评分 `llm-detail-score/v1` | [`contracts/llm-detail-score.v1.schema.json`](contracts/llm-detail-score.v1.schema.json) | LLM 适配器 | 本地汇总器、审核页 |

契约版本使用不可变字符串；已发布的 Schema 不原地改变语义。增加必填字段、改变枚举/评分语义或放宽敏感数据边界时必须发布新版本；敏感边界变更还必须重新评估 ADR。

## 2. 公共约定

- `projection_id` 引用不可变投影记录；同一实体的源内容、映射规则或脱敏规则变更时新建投影，不覆盖旧记录。
- `input_hash` 为生成投影所用的规范化输入 SHA-256（完整 64 位 hex，`^[a-f0-9]{64}$`）；JSON 键排序、空值和时间格式必须由生成器版本固定。
- `source_snapshot_refs` 用于内部追溯，不传给 LLM。LLM 请求不包含数据库 UUID、供应商外部 ID、原始 URL 或可反推身份的稳定标识。
- 展示摘要仅用于列表和人工审核概览，最多 150 字符；硬过滤必须读取结构化画像，不得只依赖摘要文本。
- 实现必须在持久化与外部调用前执行 JSON Schema 校验；未知字段因 `additionalProperties:false` 被拒绝。

**实现状态（2026-08-13）**：三份 v1 Schema 运行时校验、职位/候选人投影生成器、残留 PII 拒绝和第一阶段确定性硬过滤已实现。第二阶段已实现统一评分端口、开发/CI 确定性 Fake、`llm_score_runs` 加密结构化输出、本地 `aggregation/v1` 汇总、匹配追溯写入和周期自动编排；批准的生产 LLM 适配器仍为 `specified`，未配置时失败关闭。

## 3. 职位要求结构化提取契约

### 3.1 输入与生成

输入来自规范化 `jobs` 字段、完整 JD 和字段级来源引用。生成器必须记录 `generator_type` 与 `generator_version`；若用 LLM 做特征提取，仍必须经过本 Schema 校验和人工可复核的来源片段检查。

> **实现状态（2026-08-16）**：`job_requirements` 现由确定性规则填充（`lib/jobs/job-requirements-extract.mjs`，`generator_type=rules`、`generator_version=rules/v1`），同步 `job_requirements_extract`（fill-when-missing）。薪资只解析显式月薪（k/万），年薪/面议/超界一律留空 + warning（不转成年薪、不推断）；技能/证书只来自白名单词库（结构去标识化）。

关键语义：

- `display_summary`：不超过 150 字符的展示文本，不含公司名、客户联系人、内部编号和详细地址。
- `hard_requirements`：只放置明确、不可妥协的条件。提取不确定时保留为缺失，不猜测为硬条件。
- `scoring_context`：可用于详情匹配的职责、优选经验和业务上下文；已移除公司名、客户名、联系人、内部 ID 和可使用私有 URL。
- `extraction_warnings`：记录冲突、模糊或缺失字段；存在关键警告时可进人工处理，不直接触达。

## 4. 候选人画像/简历脱敏投影契约

### 4.1 输入与敏感边界

输入来自经授权的候选人记录、加密简历快照和联系方式保险箱。脱敏服务与 LLM 适配器之间是强制边界；LLM 适配器只能读取通过 `residual_pii_scan:"passed"` 的投影。

必须移除或泛化：

- 姓名、头像、性别、精确年龄/出生日期、证件号码；
- 手机号、邮箱、微信/社交账号、个人网址；
- 家庭地址、街道/楼宇级位置、原始 Portal URL 和任何可使用令牌；
- 简历文件名、供应商候选人 ID、顾问/负责人姓名；
- 非匹配所必需的婚育、民族、宗教、健康等敏感信息。

城市、工作年限、教育层级、技能、证书、行业、职级、薪资期望和职业经历可保留，但职业经历中不得保留可直接识别个人的项目、客户或联系信息。公司名默认泛化为行业/规模；仅当公司名是已确认的必要匹配证据且模型区域/数据条款允许时，才能通过新契约版本放行；`v1` 不放行。

> **实现状态（2026-08-16）**：真实候选人输入桥已接线——`lib/jobs/candidate-redaction-loader.mjs` 解密采集的 `raw_records`（`entity_type='candidate'`）载荷，把 `workExperiences[{company,title}]` 组装成脱敏 `career_history`。因采集侧 `industry` 恒 null，公司名 v1 泛化为字面「某公司」（完全替换，真实公司名永不进入 career_history）；`project_highlights` 无数据源恒 `[]`。`match_projection_filter` 调度路径注入该 Map 后产出真实 (job, candidate) 匹配池（真实库 40 候选人全部产出消费态候选投影、0 PII 拒绝）。`detailed_address` 正则已修正（2026-08-16）：原 `(?:省|市|区|路|号|栋|单元|层)\s*[\dA-Za-z-]*` 的 `*` 允许零字符跟随，真实城市名「北京市」与常见 title「市场经理」「区域经理」被字符级误判为详细地址（38/40 误拒）；改 `+` 后仅关键字后跟 ASCII 数字/字母（真实街道/楼栋地址如「解放路5号」）才触发，真实街道级地址仍 fail-closed 拒绝（计 `piiRejected`，不进 LLM）。

### 4.2 摘要不是真源

`display_summary` 是版本化投影的一部分，不再直接相信供应方 `candidate_summary`。现有 `candidates.summary` 只作迁移期缓存/兼容字段，新匹配必须引用 `candidate_match_projections.projection_id`。

## 5. 第一阶段：确定性硬过滤

硬过滤输入是职位/候选人投影 ID 及其 `input_hash`、`filter_rule_version`。输出必须保存：

- `passed:boolean`；
- `reason_codes[]`，使用稳定机器码：`LOCATION_MISMATCH`、`REQUIRED_SKILL_MISSING`、`EXPERIENCE_BELOW_MINIMUM`、`EDUCATION_BELOW_MINIMUM`、`CERTIFICATE_MISSING`、`SALARY_NO_OVERLAP`、`REQUIRED_FIELD_MISSING`；
- 每个原因的职位要求值、候选人投影值和人类可读解释；
- 规则版本、组合输入哈希和生成时间。

`passed=false` 时不创建 LLM 评分运行。`REQUIRED_FIELD_MISSING` 默认不猜测通过；进入异常/人工补全队列。

> **成本上界（2026-08-13，默认机制已实现）**：硬过滤通过者按结构化技能命中与地点命中稳定预排序，再限制每职位 Top-K（默认 10）和每轮全局调用预算（默认 20）。预算外组合不标失败，由后续周期继续消费；参数可配置，真实通过量与费用到位后再校准。

> **实现状态**：`hardFilter`（`lib/matching/filter.mjs`）输出每条原因携带 `jobValue`/`candidateValue`/`explanation`（人类可读），`combined_input_hash` = 职位投影 hash + 候选人投影 hash + 规则版本组合 SHA-256；同输入同规则版本确定性复算（虚构 Fixture 已验证）。未通过硬过滤的组合不创建 LLM 运行。

> **规则 v3（2026-08-16）**：① 必备技能 `REQUIRED_SKILL_MISSING` 语义从「缺少任一必备技能」收紧为「**零命中**必备技能」——命中 ≥1 项即通过技能门槛，部分匹配交由阶段二评分维度；② **城市不再硬过滤**（全国招人/候选人可换城市，`LOCATION_MISMATCH` 不再由硬过滤发出，城市交阶段二 `location` 评分维度）。`DEFAULT_FILTER_RULE_VERSION` 升至 `v3`（新结果按 `filter_rule_version` 另起一行，不覆盖旧版本）。真实垂直切片（阶段一 + 阶段二 Fake）：5 个「知识图谱/Text2SQL」沉睡职位 × 207 候选人，v3 下 filterPassed **65**、阶段二 Top-K/全局预算内 scored **20**（deferred 45 留后续 tick）、真实 `matches` 跨城市产出（如深圳 8 条 score 74-80、上海 2 条）——匹配池从 0 收敛为真实 (job, candidate) 池。真实 LLM 评分仍受合规门禁关闭；候选 skills 为系统简历推断、覆盖随爬取提升（见 [05-roadmap](05-roadmap.md) 候选人侧缺口）。

## 6. 第二阶段：LLM 详情维度评分

### 6.1 调用包络与版本

LLM 适配器的持久化调用包络至少包含：

| 字段 | 语义 |
|:---|:---|
| `adapter_id` / `adapter_version` | 供应商隔离适配器及其版本 |
| `model_id` / `model_revision` | 模型标识和可得的固定修订；供应商不提供 revision 时显式为 `null` |
| `prompt_version` | 不可变 Prompt 模板版本，首版 `match-detail-prompt/v1` |
| `schema_version` | 输出契约版本，首版 `llm-detail-score/v1` |
| `job_projection_id` / `candidate_projection_id` | 本地投影引用，不发送给模型 |
| `request_hash` | 实际发给适配器的规范化脱敏请求 SHA-256 |
| `parameters` | 白名单参数；支持时使用最低随机性，但不把它当作结果确定性保证 |
| `started_at` / `finished_at` | 调用时间 |

发送给模型的 `request_item_id` 是单次调用随机关联值，不得由职位 ID、候选人 ID 或其哈希派生。

> **实现状态（2026-08-16）**：`match-detail-prompt/v1` 已随生产适配器实现（`lib/adapters/llm-detail-scoring-adapter.mjs` 的 `MATCH_DETAIL_PROMPT_V1` 常量）。**待办矛盾**：当前管线 `automatic-match-pipeline.mjs` 传 `item_${combinedInputHash 前 24 位}`（派生值），与本节「随机关联、不可派生」不符；本步保持管线现值、适配器回显归一化，随机化留待后续切分或 ADR。

`match-detail-prompt/v1` 的规范性行为是：只根据给定的脱敏投影评估；不推断姓名、性别、年龄、民族、婚育、健康等属性；不把缺失信息当作负面事实；对不可评估维度返回 `score:null`；不输出总分、分档、是否录用/触达或其他自动决策；只输出 `llm-detail-score/v1` JSON。Prompt 模板任何文字或排序变更都必须升级 `prompt_version`。

### 6.2 输出约束

- 维度固定为 `skills`、`industry`、`seniority`、`experience`、`location`、`salary`、`activity`，且每个维度必须恰好出现一次。JSON Schema 限制数量和枚举，适配器的语义校验器另行拒绝重复或缺失维度。
- 可评估维度输出 0～100 整数分；输入证据不足时必须 `assessable:false, score:null`，不允许猜分。
- `evidence` 必须同时指明候选人脱敏事实、对应职位要求和评估；不得凭空增加投影中不存在的经历。
- LLM 输出不包含 `total_score`、`band`、`approved`、`recommendation` 或触达决策；这些属于本地汇总和人工审核边界。

### 6.3 失败、重试和降级

| 情况 | 机器码 | 处理 |
|:---|:---|:---|
| 超时 | `LLM_TIMEOUT` | 指数退避有限重试；超阈值进人工队列 |
| 429/供应商临时不可用 | `LLM_RATE_LIMITED` / `LLM_UNAVAILABLE` | 有限重试，不换用未审批模型 |
| 认证失败（401/403） | `LLM_AUTH_FAILED` | terminal，进人工/运维排查，不重试 |
| JSON/Schema 无效 | `LLM_OUTPUT_SCHEMA_INVALID` | 仅允许同模型/同 Prompt 一次修复性重试；仍失败则关闭 |
| 输入超限 | `LLM_INPUT_TOO_LARGE` | 不静默截断；返回上游重做版本化压缩投影 |
| 脱敏/残留 PII 扫描失败 | `MATCH_PROJECTION_PII_DETECTED` | 不调用 LLM，进脱敏异常队列 |
| 内容安全策略拒绝 | `LLM_SAFETY_REFUSAL` | 不伪造分数，进人工队列 |

> **实现状态（2026-08-16）**：真实适配器经 `classifyScoreError`（`error.code` 优先 + 白名单）把 `LLM_TIMEOUT/RATE_LIMITED/UNAVAILABLE/INPUT_TOO_LARGE/SAFETY_REFUSAL/AUTH_FAILED/OUTPUT_SCHEMA_INVALID` 落 `llm_score_runs.error_code`。**terminal 分类**：SQL 的 retryable 白名单（`LLM_TIMEOUT/RATE_LIMITED/UNAVAILABLE/INTERNAL_ERROR`）之外的码天然 terminal——`LLM_AUTH_FAILED/INPUT_TOO_LARGE/SAFETY_REFUSAL/SCHEMA_INVALID` 均不重试。注：`LLM_OUTPUT_SCHEMA_INVALID` 文档语义「一次修复性重试」当前未实现（代码按 terminal），为已知偏差。

失败时 `matches.score`/`band` 不写入新权威值，不回退为供应商分数，不自动触达。旧的已审核匹配不被新失败运行覆盖。

## 7. 本地汇总与可复核性

- 汇总器只消费通过 Schema 校验并持久化的 LLM 输出；使用 `aggregation_rule_version` 中的固定权重、缺失维度处理和阈值。
- 默认分档仍为高匹配 85～100、中匹配 75～84、低匹配 0～74。
- 对同一份已保存 LLM 结构化输出和同一汇总规则，重算必须得到相同维度分、总分和分档。
- 新模型、新 Prompt、新 Schema、新投影或新汇总规则都生成新运行/匹配版本，不覆盖旧结果。

## 8. 开发与验收 Fixture

- Git/CI 只使用完全虚构的 JD、简历详情和联系方式；不得对真实简历简单打码后提交。
- Golden Dataset 至少覆盖：硬过滤通过/各原因剔除、关键字段缺失、PII 残留拒绝、七维评分、不可评估维度、Schema 无效、超时/限流、汇总复算和旧版本不覆盖。
- 真实数据只用于 M2 的 2 个职位×每职位 5～10 个候选人受控切片；验证记录只保留计数、哈希、状态和机器码，不输出真实正文。

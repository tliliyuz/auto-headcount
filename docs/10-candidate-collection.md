# 候选人采集规范（猎必得人才池 · 候选人画像）

> 状态：`specified` + 合同层 + 仓储/差分调度 `implemented`（2026-08-14）。范围：猎必得人才池「互联网技术」分类，采集**候选人画像**；内部 `candidates` 存**真实姓名**（候选人画像属敏感业务：RBAC + 应用层加密 + 审计保护），**脱敏只针对匹配 LLM 投影**（`candidate-match-projection.v1` 必须 `residual_pii_scan=passed`，不含真实姓名/联系方式）；联系方式与完整简历顺延至 ingestion ticket 阶段（见 §7）。合同层（§3）已实现并经虚构 Fixture 验证：Provider 两条合同（发现/画像详情，含新标签页编排）+ 参数白名单 + 回执解析（真实姓名入 `candidates`、联系方式/简历正文失败关闭）+ Provider↔Consumer Schema 对齐。仓储/差分调度（§5）已实现并经单测 + 集成验证：`browser_candidate_batches/items` 批次表（迁移 0010）、候选人仓储（真实姓名入 `candidates`、画像入 `candidate_profiles`、`raw_records` 加密）、`browser_candidate_discovery/collect` 差分调度（跳过已入库未变、详情事务 upsert 覆盖画像变化、断点续采凑满本批）。**尚未完成**：真实 DOM 选择器验证（Fixture 选择器为契约初始假设，待浏览器就绪后按职位合同同流程收敛）、管理端触发 API/前端入口。
> 唯一权威来源：本文件。职位采集见 [`runbooks/browser-collection.md`](runbooks/browser-collection.md)；数据模型见 [03-data-model](03-data-model.md)；匹配投影见 [10-matching-contracts](10-matching-contracts.md)。

## 1. 产品行为

猎必得 Web 端**没有职位→候选人关联**（职位详情无「推荐候选人」入口，运营实际是去人才池自己捞人）。因此候选人数源锚定**人才池**，职位↔候选人关系在 M3 匹配阶段建立。

- 运营在猎必得人才池页（`https://portal.liebide.com/#/candidates/firmCandidate`）设好**「互联网技术」分类筛选**，随后在管理端触发「采集人才池候选人」批次。
- 本批数量 = 本次要处理的候选人画像数（新增 + 画像变化的更新），差分语义与职位采集一致（跳过已入库未变、按断点续采凑满）。
- **候选人详情在新标签页打开**：采集流程 = 列表 → 逐条点开详情（新标签页）→ 提取候选人画像（含真实姓名，落库 RBAC + 加密 + 审计保护）→ 关闭新标签页 → 回列表。多标签页处理是候选人合同的硬性要求。
- 列表分页：20 条/页，页码断点，无滚动懒加载。
- 人才池列表卡片显示**真实姓名**；内部 `candidates` 存**真实姓名**（候选人画像属敏感业务，受 RBAC + 应用层加密 + 审计保护，见 [06-security-compliance](06-security-compliance.md) §敏感业务）。**脱敏的对象是匹配 LLM**：`candidate-match-projection.v1` 必须 `residual_pii_scan=passed`，不含姓名/联系方式。真实姓名不写日志、审计元数据或任务载荷。

## 2. 字段白名单与安全分层

候选人详情 API（`GET portalapi.liebide.com/ResumeDetail/{resumeId}`）字段分四类：

| 类别 | 来源字段 | 采集处理 |
|---|---|---|
| 标识 | `tbdResumeId`（详情 URL 用）、`id`/`talentId`（人才身份） | `candidates.external_id`；候选人与简历身份映射实现时定 |
| **候选人画像** | `realName`、`title`、`company`、`yearOfExperience`、`cityName`、`school`/`major`/`degree`、`age`/`gender`（列表卡片）、`completion`、`recommendationCount`、`workExperiences[].company/title` | 规范化入 `candidates` + `candidate_profiles`（敏感业务：RBAC + 加密 + 审计）；真实姓名**不进 LLM 投影**、不写日志/审计/任务载荷 |
| **本阶段不采集** | `mobile`/`email`/`wechat`、完整 `content` 简历正文、`workExperiences[].description`、`selfEvaluation`、`projectExperiences` | 顺延 ingestion ticket 阶段；联系方式平台自身打码 |

> 安全边界（2026-08-14 确认）：**脱敏的对象是匹配 LLM，不是内部运营**。内部 `candidates` 存真实姓名（候选人画像属敏感业务，RBAC operations/admin + 应用层加密 + 审计）；LLM 匹配投影（`candidate-match-projection.v1`）必须 `residual_pii_scan=passed`，不含真实姓名、联系方式或简历正文。完整简历/联系方式仍只走 ingestion ticket 直传加密、不经 Agent/MCP 结果。见 [06-security-compliance](06-security-compliance.md)。

## 3. 合同

两条固定受限合同均经 `csdn_run_extraction_contract` 执行，白名单字段、失败关闭语义与职位合同一致（未知字段/敏感键/ID 不一致 → `PAGE_CONTRACT_CHANGED` / `BROWSER_COLLECTION_CONTRACT_INVALID`）。

> 实现状态（2026-08-14）：两条合同已实现并经虚构 Fixture 验证。Provider（csdn-agent `0c66135`）：发现/详情提取表达式、参数白名单、连接状态/session 路由、详情新标签页编排（`chrome.tabs.create` → 等待 `tab.status=complete` → 提取 → 关闭回列表）。Consumer（auto-headcount `2aebe907`）：参数构造、回执解析（真实姓名入 `candidates`，联系方式/简历正文失败关闭）、Provider↔Consumer Schema 对齐。**真实 DOM 选择器尚未验证**——Fixture 选择器（`.candidate-item`、`.candidate-name` 等）为契约初始假设，需经真实页面按职位合同同流程收敛（`PAGE_CONTRACT_CHANGED` 失败关闭兜底）。

### 3.1 `liebide-talent-pool-list-v1`（发现）

- **输入**：`userId`、`deviceId`、`batchSize`（≤100）、`maxPages`（≤20）、可选 `startPage`/`startOffset`。
- **筛选证据**：人才池页 + 「互联网技术」分类选中（固定证据，与职位列表合同同款校验）。
- **回执条目**（白名单）：`candidateId`、`realName`、`title`、`company`、`yearOfExperience`、`age`、`gender`、`city`、`education`（最高学历）、`pageNumber`、`position`。
- **断点**：`page{startPage,startOffset,endPage,pagesVisited,nextPage,nextOffset,stopReason}` + `contentHash`。
- **分页**：20 条/页页码断点，`stopReason ∈ {batch_size, max_pages, end_of_results}`。

### 3.2 `liebide-candidate-detail-v1`（画像详情）

- **输入**：`expectedCandidateId`（+ 可选 `expectedTitle` 内容校验，与职位详情同款）。
- **导航**：从列表**新标签页**打开 `#/candidateDetail/{resumeId}` → 等页面就绪（URL 含目标 ID 且 `tab.status=complete`）→ 提取 → 关闭新标签页回列表。
- **回执**：版本化白名单，含 §2 候选人画像字段（`candidateId`、`realName`、`title`、`company`、`yearOfExperience`、`cityName`、`school`/`major`/`degree`、`completion`、`recommendationCount`、`workExperiences[].company/title`）。**不含联系方式、简历正文。**

## 4. 数据模型映射

- `candidates`：`external_id`=人才池 candidateId（唯一 `(source_connection_id, external_id)`，迁移 0010）；`source_connection_id`=来源追溯（对齐 jobs），`raw_record_id`=加密原始快照引用；`display_name`=**真实姓名**（候选人画像属敏感业务：RBAC operations/admin + 应用层加密 + 审计，不写日志/审计/任务载荷）；`summary`=派生摘要（≤150 字，用于展示，不含联系方式）。
- `candidate_profiles`：`experience_years`、`location`（city）、`education`（最高学历枚举映射）、`seniority`（由 title 或年限派生）、`industry`（分类来源，本阶段可空）、`activity_updated_at`（简历 `updated`）+ 近期工作 `current_title`/`current_company`（迁移 0010；匹配投影 `display_summary` 取 `currentTitle ?? seniority` 回退）。
- 原始快照：候选人画像按职位同款「加密原始区 → 内容哈希去重 → 幂等 upsert」入库 `raw_records`（`entity_type='candidate'`），存候选人画像（含姓名，加密 + RBAC）；**不落联系方式/简历正文**。

## 5. 任务与调度

> 实现状态（2026-08-14）：新 kind `browser_candidate_discovery`/`browser_candidate_collect` 已接入调度器（`sync-scheduler.mjs` 分发 + 批次/条目 outcome 守卫），差分语义与职位一致：跳过已入库未变（`current_title` 比较）、标题/画像变化详情事务 upsert 覆盖、断点续采凑满本批数量。仓储层（`browser-candidate-repository.mjs`）负责批次入队/`findKnownCandidates`/`persistDiscovery`/画像事务入库。

- 新 kind：`browser_candidate_discovery`、`browser_candidate_collect`，复用 `async_tasks` 表与突发认领/差分/退避机制（同 `browser_job_*`）。
- 载荷白名单：来源/候选人与批次 ID、用户/设备、契约版本、数字断点、批量上限；**不含浏览器 Session、真实姓名、联系方式或简历正文**（真实姓名只经 DB 写，不落任务载荷/审计/日志）。
- 管理端触发复用「采集当前筛选结果」的批次模式（数据源页「采集人才池候选人」入口 + 候选人批次表 + 详情任务 + 批次面板）。
- **前端候选人页面（排期随采集落地，见 [FRONTEND](../apps/web/docs/FRONTEND.md)）**：数据源页加入口与批次面板后，新增「候选人」页展示采集的候选人池（白名单投影；`display_name` 真实姓名按 RBAC operations/admin + 加密 + 审计保护，前端同样不越过白名单投影）。

## 6. M3 集成

- 由 `candidate_profiles` 生成 `candidate-match-projection.v1`（脱敏画像 → `profile` + `redacted_detail`），匹配模块读不到真实姓名/联系方式。
- `match_pipeline_v2` 消费候选人投影 + 职位投影；候选人源就绪后，`match_projection_filter` 从"只产职位投影的正确空跑"收敛为真实 (job, candidate) 匹配池。
- 垂直切片：人才池「互联网技术」抓 N 个候选人画像 → 用 2 个沉睡职位跑匹配，验证每个职位命中 5~10 个候选人。

## 7. 本阶段不做（顺延）

- ingestion ticket（完整简历/联系方式直传加密）——本轮采候选人画像（含真实姓名，RBAC 保护），闭环"候选人→匹配→审核"。
- 简历正文解析、技能标签抽取、期望薪资/城市。

## 8. 验收条件（RED 依据）

- 人才池发现合同只接受「人才池页 + 互联网技术分类」证据，返回候选人画像白名单条目与数字断点；重复发现不产生重复候选人。
- 候选人详情合同新标签页确定性导航、等待就绪、提取候选人画像、关闭新标签页；`expectedCandidateId`/`expectedTitle` 校验失败关闭。
- 规范化 `candidates`/`candidate_profiles` 含真实姓名（RBAC 保护），但 `candidate-match-projection.v1` 必须 `residual_pii_scan=passed`（**不含真实姓名/联系方式/简历正文**）；真实姓名不落日志、审计元数据或任务载荷。
- 差分采集：跳过已入库未变、标题/画像变化重新采集、断点续采凑满本批数量。
- 受控切片：人才池「互联网技术」抓 N 候选人，2 个沉睡职位各命中 5~10 个候选人。

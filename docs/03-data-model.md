# 数据模型

## 1. 核心实体

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `organizations` | `id, name, status` | 企业/团队边界，为多租户预留 |
| `users` | `id, organization_id, role` | 管理端用户 |
| `source_connections` | `id, provider, environment, status` | 外部连接元数据，不保存明文密钥 |
| `sync_runs` | `id, source_id, type, cursor, status, stats` | 同步批次和游标 |
| `raw_records` | `id, sync_run_id, entity_type, external_id, payload_encrypted, hash` | 原始数据快照 |
| `jobs` | `id, external_id, title, company_name, category, city, detailed_location, status, published_at, valid_recommendation_count` | 规范化职位；公司名和详细地址不进入公开视图 |
| `job_requirements` | `job_id, skills, seniority, education, salary_min, salary_max, salary_period, constraints` | 匹配条件；落地页仅投影薪资范围 |
| `candidates` | `id, external_id, display_name, summary, consent_status` | 候选人主体 |
| `candidate_profiles` | `candidate_id, skills, experience, location, education` | 可匹配画像 |
| `candidate_contacts` | `candidate_id, phone_encrypted, email_encrypted` | 单独加密与授权控制 |
| `match_rules` | `id, version, weights, thresholds, active_at` | 可复算的评分规则 |
| `matches` | `id, job_id, candidate_id, score, band, status, rule_version` | 匹配结果 |
| `match_dimensions` | `match_id, dimension, score, evidence, risk` | 分维度解释 |
| `campaigns` | `id, job_id, channel, status, approved_by` | 触达活动 |
| `campaign_recipients` | `campaign_id, candidate_id, status, idempotency_key` | 活动受众与发送状态 |
| `landing_links` | `id, recipient_id, token_hash, expires_at, revoked_at` | 不保存可直接使用的明文令牌 |
| `intent_responses` | `id, recipient_id, option, consent_snapshot, created_at` | A/B/C/退订选择 |
| `funnel_events` | `id, event_type, job_id, candidate_id, campaign_id, occurred_at` | 追加写行为事件 |
| `follow_up_tasks` | `id, candidate_id, job_id, owner_id, status, outcome` | 人工联系任务 |
| `recommendations` | `id, job_id, candidate_id, external_id, status` | 最终推荐记录 |
| `audit_logs` | `id, actor_id, action, resource_type, resource_id, metadata` | 操作审计 |

## 2. 状态约定

### 匹配状态

```text
generated → pending_review → approved/rejected
approved → queued_for_campaign → contacted → responded
```

### 活动状态

```text
draft → pending_approval → approved → scheduled → running
→ completed/cancelled
```

### 候选人触达许可

```text
unknown → permitted → opted_out
```

`opted_out` 是终止状态，除非存在经过记录的新授权，不得自动恢复。

## 3. 去重策略

- 同一数据源优先使用稳定 `external_id`。
- 外部 ID 缺失时，可使用标准化手机号/邮箱的不可逆哈希辅助识别。
- 跨来源合并不得仅凭姓名；必须有人工确认或足够强的联合证据。
- 职位匹配记录使用 `(job_id, candidate_id, rule_version)` 唯一约束。
- 推荐记录应对外部系统要求构建幂等键，避免重复提交。

## 4. 数据保留

保留期限需要业务、法务与数据提供方共同确认。实现时必须支持：

- 按候选人查找、导出和删除数据。
- 撤销落地页令牌。
- 对过期原始快照和联系信息执行清理。
- 保留不含敏感正文的必要审计证明。

## 5. 候选人落地页投影

落地页不得直接序列化 `jobs` 或 `job_requirements`。服务端必须生成独立的白名单 DTO，最多包含职位名称、类别、城市、薪资范围、职责摘要、要求摘要和候选人可执行操作。

以下字段始终禁止进入落地页响应和客户端埋点：公司名称及别名、详细地址、内部职位编号、客户联系人、招聘负责人、原始 JD 和供应商原始载荷。

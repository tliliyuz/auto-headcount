# 数据模型

## 1. 核心实体

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `organizations` | `id, name, status` | 企业/团队边界，为多租户预留 |
| `users` | `id, organization_id, username, status, display_name, password_hash, password_changed_at, must_change_password, totp_secret, totp_enabled, failed_attempts, locked_until` | 管理端本地授权主体，保存口令哈希（bcrypt，成本 12），不保存明文口令；`username` 唯一，`must_change_password` 标记首登强制改密，`failed_attempts`/`locked_until` 支撑失败锁定 |
| `role_assignments` | `id, user_id, role, granted_by, revoked_at` | `operations/recruiter/admin` 角色分配，`(user_id, role)` 唯一 |
| `sessions` | `id, user_id, token_hash, expires_at, idle_expires_at, revoked_at` | 服务端可撤销会话；数据库只存会话令牌哈希，空闲 30 分钟与最长 12 小时双过期 |
| `source_connections` | `id, provider, environment, status` | 外部连接元数据，不保存明文密钥 |
| `sync_runs` | `id, source_id, type, cursor, status, stats` | 同步批次和游标 |
| `raw_records` | `id, sync_run_id, entity_type, external_id, schema_version, payload_ciphertext, payload_nonce, key_version, payload_hash, processing_status, captured_at` | 应用层信封加密、追加写的原始数据快照 |
| `jobs` | `id, source_connection_id, external_id, raw_record_id, mapping_version, title, company_name, category, city, detailed_location, status, published_at, valid_recommendation_count` | 规范化职位；公司名和详细地址不进入公开视图 |
| `job_requirements` | `job_id, skills, seniority, education, salary_min, salary_max, salary_period, constraints` | 匹配条件；落地页仅投影薪资范围 |
| `candidates` | `id, external_id, display_name, summary, consent_status` | 候选人主体 |
| `candidate_profiles` | `candidate_id, skills, experience, location, education` | 可匹配画像 |
| `candidate_contacts` | `candidate_id, phone_ciphertext, email_ciphertext, phone_hmac, email_hmac, key_version` | 单独加密；HMAC 仅用于去重/抑制 |
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
| `audit_logs` | `id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, result, request_id, metadata` | 追加写操作审计；元数据采用字段白名单 |

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

在最终期限确认前，工程实现按 `ADR-003` 的上限设计为可配置 TTL：原始成功响应 30 天、异常响应最长 90 天、关闭职位和候选人业务数据 180 天、审计日志 365 天、备份 35 天。该上限不构成真实数据处理授权；书面授权未取得前只能使用脱敏 Fixture。

项目负责人已同意开发和测试按上述工程上限实现落库与自动清理。由于当前操作者只能代表低权限接入账号，该同意不扩大 MCP 服务端权限，也不替代数据提供方未来给出的更短期限、删除要求或禁止落库通知；收到更严格要求时以更严格者为准。

2026-08-12 项目负责人书面确认：供应方已脱敏（姓名打码、不含联系方式）的候选人数据可以入库，且暂不设定固定保留期限上限。该确认覆盖脱敏候选人数据的落库与保留；原始载荷加密、可配置 TTL 清理任务与「收到更严格要求以更严格者为准」基线保持不变。完整简历、联系方式与原始载荷在授权与期限明确前仍只允许脱敏 Fixture。

## 5. 原始、规范化与审计数据约束

- `raw_records` 只追加，不由业务更新覆盖；普通应用查询无解密权限。
- 原始载荷使用应用层 AES-256-GCM 信封加密，主密钥不得进入数据库。
- 规范化实体必须能追溯到数据源、原始记录及映射版本。
- `audit_logs` 不允许应用角色更新；保留任务按策略删除并记录自身审计事件。
- 审计元数据不得包含简历正文、手机号、邮箱、令牌、Cookie、Secret 或完整外部响应。

## 6. 候选人落地页投影

落地页不得直接序列化 `jobs` 或 `job_requirements`。服务端必须生成独立的白名单 DTO，最多包含职位名称、类别、城市、薪资范围、职责摘要、要求摘要和候选人可执行操作。

以下字段始终禁止进入落地页响应和客户端埋点：公司名称及别名、详细地址、内部职位编号、客户联系人、招聘负责人、原始 JD 和供应商原始载荷。

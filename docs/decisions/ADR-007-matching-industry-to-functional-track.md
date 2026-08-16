# ADR-007：匹配评分 industry 维度重定义为「职能方向匹配」

- 状态：accepted
- 日期：2026-08-16
- 决策人：匹配阶段负责人

## 背景

匹配审核工作台诊断（2026-08-16）发现七维评分里的 **industry 维度恒不可评估、分数无意义**：

1. **职位侧无参照**：`job-projection.mjs` 的 `scoring_context.industry` 来自 `job.category`，而生产环境 `job.category` 恒为空串（MCP 同步与浏览器采集都写空）——LLM/假适配器因职位侧无参照判 `assessable:false`。
2. **两侧不同轴**：候选侧 `candidate_profiles.industry` 存的是**详情页职业标签 title-text**（技术专家/产品经理/PM），与职位侧粗分类（互联网技术/产品设计）是不同语义轴——即使 category 回填，`技术专家` vs `互联网技术` 也无法比对。

后果：industry 维度从不参与评分 → 分数只在 4 维上重归一（27 条 match 全 74、80 分靠 location=90 拉高），industry 权重 0.1 形同虚设。

## 决策

把 industry 维度的**语义重定义为「职能方向匹配」**：两侧用**细职能词表**提取职能方向，同轴比对。

- **职位侧**：`scoring_context.industry` 从「源 category」改为**从职位标题 + JD 提取职能方向**（`lib/matching/functional-track.mjs` 的 `extractFunctionalTracks`），取代恒空的 category。
- **候选侧**：`profile.industry` 从「职业标签原文」改为**职业标签提取的职能方向**（词表未命中回落原始标签，保证 LLM 有输入）。
- **比对**：职能方向有交集 → 高分（90）；都有值无交集 → 中分（65）；任一侧空 → 不可评估。
- **维度键保持 `industry`**（`llm-detail-score/v1` 枚举不变，避免 schema v2 与大面积改名）；语义变化由 **prompt `match-detail-prompt/v2`** 与 **聚合 `aggregation/v3`** 承载版本信号。
- **职能词表启发式非权威**（同 skills 简历推断技术债），覆盖互联网技术池常见职能（数据/算法AI/工程研发/产品/运营/市场销售/测试质量/安全风控/设计）。

## 备选方案

1. **保留行业语义、只补 `job.category` 数据**：治标不治本——候选侧职业标签与职位侧粗分类本就不同轴，category 回填后仍无法比对（`技术专家` vs `互联网技术`）。
2. **像 salary 一样移除 industry 维度**：丢掉一个本可用的「职能方向」信号；等语义定义清楚再启用的成本更高。
3. **维度键改名 functional_track**：语义更清晰，但需 `llm-detail-score/v2` + 投影 schema v2 + landing 标签白名单 + match_dimensions 维度键全链迁移，当前真实 LLM 未启用、收益不抵成本；未来若确需改名再升 schema v2。

## 后果

- **收益**：industry 维度从「恒不可评估」变为「多数职位/候选可评估」，评分覆盖面从 4 维扩到 5+ 维；候选职业标签与职位标题/JD 同轴可比。
- **成本**：新增 `functional-track.mjs` 词表（约 9 类职能方向 + 关键词），需随业务补充；词表命中率取决于标题/JD/职业标签措辞。
- **风险**：词表启发式非权威——「技术专家」这类宽泛职业标签可能映射到宽桶、或未命中回落原文导致比对退化为字符串包含。已记录技术债，权威职能数据源到位后应替换。
- **版本**：prompt `match-detail-prompt/v1→v2`、聚合 `aggregation/v2→v3`、投影生成器 `rules/v1→v2`（触发投影重生成）。旧 match 保留 `aggregation/v2`，不被覆盖。
- **回滚**：恢复 `scoring_context.industry = job.category ?? null` + 投影重生成即可回到 v2 语义；新维度键未引入，无 schema 迁移负担。

## 重新评估触发条件

- 出现权威职能/行业数据源（职位侧真实 category、候选侧真实行业/职能字段）时，评估是否用权威值替换词表提取。
- 候选侧职业标签与职位侧职能方向语义继续错配、导致评分偏离人工判断时，考虑维度键改名（functional_track）或移除维度。
- salary 维度数据源到位时（ADR-006 意向采集 / 详情页薪资字段），恢复 salary 权重并补薪资语义定义（升 aggregation/v4）。

## 相关规范

- `docs/10-matching-contracts.md`（prompt v2 / 维度语义 / aggregation v3）
- `docs/03-data-model.md`（landing 维度标签白名单）
- `docs/07-acceptance-criteria.md`
- `CHANGELOG.md`

# 猎必得筛选列表批量采集验证记录（2026-08-13）

## 验证对象

- 列表合同：`liebide-filtered-job-list-v2`
- 任务链：`browser_job_batch_discover → browser_job_collect × N`
- 数据迁移：`0009_browser_collection_batches.sql`
- CSDN-Agent：列表有界翻页、详情确定性导航与页面就绪等待

## 已执行并通过

auto-headcount：

```text
node --test tests/browser-collection-contract.test.mjs \
  tests/browser-job-collection.unit.test.mjs \
  tests/browser-contract-schema-check.test.mjs \
  tests/postgres-migration-contract.test.mjs
# 20/20 passed

npm run test:unit
# 167/167 passed

npm run lint
npm run build
node scripts/check-browser-contracts.mjs
# passed；列表与详情请求/回执 Schema 和 Provider 哈希一致
```

CSDN-Agent Provider：

```text
npm run check
npm test
npm run check:extraction-contract
# 静态检查通过；Node 72/72；合同定向 7/7

cd ../../src-tauri
cargo test connection_status --lib --features test-utils
# Rust Relay 定向 1/1 passed
```

## 结论与边界

- 2026-08-14 真实页面复核确认猎必得不提供“发布 7～30 天”筛选；页面提供“最近 30 天”，当日日期控件范围为 30 个自然日（含首尾），并可同时选择“推荐0人”。旧 v1 在该页面按预期返回 `FILTER_CONTRACT_MISMATCH`，未产生发现条目或职位写入。列表合同因此不兼容升级为 v2；v2 只负责最近 30 天发现，详情合同仍权威复核 7～30 天，0～6 天项跳过。
- v2 静态验证：Consumer 定向 22/22、Provider 全量 73/73、双仓请求/回执 Schema 哈希一致、ESLint 与 Vinext 生产构建通过。Bridge 已重启加载 v2；扩展重载及授权登录态真实整批成功路径尚待复验。
- v2 首次真实执行确认筛选证据通过，但职位列表由 `.job-item[data-spm-e-data]` 卡片构成，没有 `/Job/` 锚点；合同以 `PAGE_CONTRACT_CHANGED` 失败关闭且零写入。新增完全虚构卡片 Fixture 并观察 5/6 RED，随后固定解析公开卡片元数据内的同源详情地址与职位名称，Provider 定向 8/8 GREEN、静态检查通过。修复后的扩展重载及整批复验仍待完成。
- 跨页真实回执显示 20 条中只有 10 个唯一 ID，Consumer 以 `result.items contains duplicate externalId` 失败关闭且零写入。根因是 Element 分页先切 active 页码、职位卡片稍后刷新；新增延迟刷新 Fixture 并观察 6/7 RED，改为等待首条职位 ID 真正变化。Provider 合同定向 9/9、全量 75/75 GREEN；最新扩展重载与整批复验待完成。
- 修复后真实列表发现成功，持久化 20 个唯一发现条目并创建 20 个详情任务。详情复验暴露 Consumer 仍按列表页做预检以及内部 `contractId` 重复进入关闭参数构造器；已改为仅在唯一同源、已登录页面上允许 `WRONG_ENTITY` 进入确定性导航，并剥离内部合同选择字段，Consumer 定向 20/20、ESLint 与生产构建通过。
- 真实详情状态标签使用 `.name_tags_wrap .tags` 且正文包含“招聘中”和其他标签，不存在旧 Fixture 的 `.tags .job-tag-primary`。新增虚构 Fixture 观察 RED 后兼容该固定形状，Provider 合同定向 10/10、全量 76/76 GREEN；扩展重载后的详情成功/跳过/入库计数仍待完成。

- `specified`：列表筛选证据、批次上限、数字断点、详情复核和失败关闭规则已进入权威规范及 Schema。
- `implemented`：Consumer、数据库批次/条目、调度器、运营入口和 Provider 固定工作流均已实现。
- `verified`：Fixture、Consumer/Provider 单元测试、Schema 哈希、ESLint 与生产构建已通过。
- 路由配置补充验证：服务端环境注入、缺失失败关闭和客户端不可覆盖 3/3；相关定向测试合计 18/18。运营页面不再读取 localStorage 或要求手填 `userId/deviceId`。
- 首次本地真实批次暴露并修复三处 Consumer 接线：列表内部合同选择字段重复校验、Docker 容器宿主机 Bridge URL、连接预检误走浏览器执行端点。修复后连接预检返回 `READY`；实际批次因执行时 active page 为 `http://127.0.0.1:3000` 而以 `BROWSER_WRONG_ORIGIN` 失败关闭，未发现条目、未写 `jobs`。仍需在猎必得筛选页 active 时复验成功路径。
- 尚未标记为真实生产 `verified`：授权账号下的猎必得真实筛选 DOM/分页控件、PostgreSQL 整批调度及部署后端到端采集仍需分别完成。

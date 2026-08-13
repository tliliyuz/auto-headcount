# Liebide 职位详情受限提取契约验证记录

- 日期：2026-08-13
- 环境：本机 CSDN-Agent Bridge、Chrome 扩展、供应方授权登录态
- 范围：单职位、只读、`https://portal.liebide.com`
- 契约：`liebide-job-detail-v1` / version `1`
- auto-headcount 版本：`13f974ca`
- CSDN-Agent 版本：`f992bcb`（基于新的本地 `main` root commit；尚未配置远端）
- 权威边界：[`ADR-005`](../decisions/ADR-005-authorized-web-collection-and-local-matching.md)
- 操作流程：[`browser-collection.md`](../runbooks/browser-collection.md)

## 授权与数据边界

项目负责人已确认供应方开通的 Web 平台账号可用于授权页面范围内的受控采集。本次只验证一个职位详情的固定白名单回执，没有批量采集候选人、简历或联系方式，没有执行供应方写操作。

完整职位 ID、`userId`、`deviceId`、`browserSessionId`、Relay token 和真实 JD 均不写入本记录。验证期间没有把真实 JD 保存为 Fixture 或仓库文件。

## Fixture 与实现验证

| 验证项 | 结果 |
|---|---|
| auto-headcount Consumer 契约测试 | 5/5 通过 |
| CSDN-Agent 插件与 Bridge 全量测试 | 69/69 通过 |
| CSDN-Agent 静态检查 | 通过 |
| CSDN-Agent Rust 连接诊断定向测试 | 1/1 通过 |
| auto-headcount 单元测试 | 126/126 通过 |
| auto-headcount ESLint | 通过 |
| Markdown 相对链接检查 | 通过 |
| Provider 契约 Schema 定向测试 | 5/5 通过 |
| Consumer 契约与 Schema 测试 | 7/7 通过 |
| 双仓规范化 Schema 哈希 | 请求 `ea9331…e583`、回执 `8ba4b0…e04e`，一致 |

真实页面首次验证发现薪资文本 `30K-60K` 与后续文字之间没有空白，原解析器因此返回空薪资。该 DOM 边界先转换为完全虚构测试并确认 RED，再修改解析边界；插件测试恢复 66/66 GREEN 后重载扩展并复验通过。

## 单职位真实 smoke test 摘要

| 字段/控制 | 脱敏结果 |
|---|---|
| 身份路由归属 | `userId + deviceId + browserSessionId` 绑定检查通过；完整值未记录 |
| 来源 | 允许域名匹配 |
| 页面职位 ID | 与任务期望一致；完整值未记录 |
| 契约 ID/版本 | `liebide-job-detail-v1` / `1` |
| 职位状态 | `active` |
| 城市 | 存在 |
| 薪资 | 30000–60000 |
| 发布时间 | 存在 |
| 有效推荐数 | 返回 number 类型 |
| JD | 1190 字；正文未打印、未落盘 |
| 内容哈希 | 64 位小写 SHA-256 格式合法；具体值未记录 |
| Relay 耗时 | 单次交互秒级完成 |

## 结论与限制

- `verified`：固定参数、来源白名单、职位 ID 一致性和结构化回执的单职位协议闭环已通过真实登录态验证。
- `implemented`：auto-headcount Consumer 适配器和 Relay 客户端已实现。
- `specified`：本 Runbook 和请求/回执 Schema 已固化开发、联调和证据边界。
- `verified`：CSDN-Agent 只读连接预检已在 Node Bridge 与 Rust Relay 上验证，状态与最小化输出一致；auto-headcount 自动调用尚未接线。
- 未实现：`async_tasks` 接线、`browser_job_collect`、规范化职位入库、管理端触发、ingestion ticket、候选人/简历采集与脱敏流水线。
- 本次职位不满足 7～30 天且有效推荐数为 0 的完整沉睡条件，不能作为沉睡职位入库验收样本。
- CSDN-Agent 已在项目负责人确认放弃不可访问的旧历史后，以脱敏源码快照建立新的本地 root commit `e1bb9d9`；`b74e369` 增加 Provider Schema 和标准检查，`f992bcb` 增加只读连接预检。插件静态检查、69/69 Node 测试和 1/1 Rust 定向测试通过。新仓库尚未配置远端，因此可以本地精确追溯，但不能描述为已推送、已发布或可由其他环境拉取。

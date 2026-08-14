# 授权浏览器采集开发与联调 Runbook

本文定义 CSDN-Agent 浏览器执行端与 auto-headcount 受限提取契约的开发、连接、验证、故障恢复和证据留存流程。架构与信任边界以 [`ADR-005`](../decisions/ADR-005-authorized-web-collection-and-local-matching.md) 为准；本文不扩大已批准的数据范围。

## 1. 适用范围

当前允许验证筛选列表合同 `liebide-filtered-job-list-v2` 与职位详情契约 `liebide-job-detail-v1`：

- 来源固定为 `https://portal.liebide.com`；
- 单次只读取一个明确职位；
- 请求固定为 [`liebide-job-detail.request.v1`](../contracts/liebide-job-detail.request.v1.schema.json)；
- 回执固定为 [`liebide-job-detail.receipt.v1`](../contracts/liebide-job-detail.receipt.v1.schema.json)；
- 不包含候选人、简历、联系方式采集，不创建推荐或其他写操作；
- 不得将本流程扩展为任意脚本、选择器、URL 或跨域浏览器控制。

生产批次固定为 `browser_job_batch_discover → browser_job_collect × N`。运营人工登录并在列表选择“推荐 0 人、发布时间最近 30 天”，然后在管理端选择本批数量。发现合同最多处理 `batchSize<=100`、`maxPages<=20`，保存 page/offset 数字断点；详情合同按固定地址自动导航并重新校验职位 ID、active、发布 7～30 天和零推荐。最近 30 天中发布不足 7 天的职位只记跳过，不写 `jobs`。不得要求运营逐个打开详情，也不得用自然语言提示词驱动生产翻页循环。

候选人或完整简历采集必须先完成 ingestion ticket、独立加密分层、保留/删除和日志门禁，不得复用职位回执通道传输。

## 2. 开始前门禁

每次受控真实联调开始前确认并记录：

| 项目 | 最低要求 |
|---|---|
| 授权 | 记录批准人、日期、平台账号归属、允许页面/字段、用途、频率、保存与删除要求 |
| 范围 | 单职位、只读、允许域名和已审核契约版本 |
| 数据 | 不把真实 JD、页面正文、Cookie、Authorization、验证码或完整会话 ID写入 Git、聊天、普通日志或 Fixture |
| 版本 | 记录 auto-headcount commit；CSDN-Agent 必须记录 commit/tag，尚未版本化时只允许一次性开发验证且登记偏差 |
| 环境 | 使用员工已获授权的浏览器登录态；不得复制 Profile、Cookie 或口令到服务器 |
| 停止条件 | 验证码、429、异常跳转、错误账号、连续契约失败或授权不明确时立即停止 |

未满足任一项时，只能运行完全虚构的 Fixture 契约测试。

## 3. 契约开发生命周期

```text
确认授权与字段目标
  → 使用通用浏览器工具做单页探索（仅开发）
  → 记录 DOM 事实，不保存真实正文
  → 更新请求/回执 Schema 与虚构 Fixture
  → RED：Provider 或 Consumer 因目标行为缺失而失败
  → 实现固定来源、固定字段的内置解析器
  → GREEN：CSDN-Agent Provider + auto-headcount Consumer 测试通过
  → 单职位受控真实 smoke test
  → 脱敏验证记录与清理检查
```

通用 `csdn_*` 页面操作只用于探索和制定契约，生产任务只能调用 `csdn_run_extraction_contract`。真实页面揭示的新边界必须先转写成完全虚构 Fixture 并观察 RED，再修改生产解析器。

以下变化必须升级契约版本，不能静默修改 v1：

- 字段增加、删除、重命名或类型变化；
- 允许域名、路由或身份绑定方式变化；
- 页面正文最小化、PII 分类或哈希口径变化；
- 现有 Consumer 无法兼容的错误语义变化。

只修复不改变请求/回执语义的 DOM 定位兼容问题可以保留版本，但必须新增 Provider 回归 Fixture，并记录页面结构变化。

## 4. 浏览器连接顺序

1. 启动 CSDN-Agent Bridge，并确认健康状态。
2. 在 Chrome/Edge 中加载已记录版本的 CSDN-Agent 插件。
3. 打开供应方平台，由操作人员人工登录；不自动填写口令，不绕过验证码。
4. 打开目标职位详情页，确认来源是允许域名，页面职位 ID 与任务目标一致。
5. 调用 `csdn_get_browser_connection_status`，传入当前 `userId + deviceId`、
   `liebide-job-detail-v1` 和任务职位 ID；只有返回 `READY` 才进入提取。
6. 仅在内存或被 Git 忽略的本地环境中提供 `userId + deviceId + browserSessionId`；验证记录只保存不可逆指纹或“已匹配”，不保存完整值。
7. 先执行 Fixture 测试，再执行单职位真实 smoke test。

Docker Desktop 本地联调时，容器必须通过 `http://host.docker.internal:48887/mcp/request`
访问宿主机 Bridge；容器内的 `127.0.0.1` 指向容器自身。该固定 Docker 主机别名与
`localhost/127.0.0.1` 一样只允许开发期 HTTP，其他主机仍强制 HTTPS。

当前 Consumer 标准验证命令：

```bash
make check-browser-contract
```

CSDN-Agent Provider 标准验证命令：

```bash
cd plugins/csdn-browser-agent
npm run check:extraction-contract
```

同时拥有两个仓库时执行完整一致性检查：

```bash
CSDN_AGENT_REPO=/absolute/path/to/csdn-agent \
  make check-browser-contract-cross-repo
```

命令会分别校验两端实现常量和关闭字段白名单，再比较请求/回执 Schema 的规范化 SHA-256；任何语义漂移均失败。`browser_job_batch_discover` 与 `browser_job_collect` 均在受限提取前自动执行连接预检；本节手工预检只用于部署后 smoke test 和故障定位，不能替代任务内门禁。

## 5. 故障与恢复矩阵

| 现象/状态 | 自动重试 | 写业务库 | 标准处置 |
|---|---:|---:|---|
| 客户端 `BRIDGE_OFFLINE`（Bridge 未启动或不可达） | 有限 | 否 | 启动 Bridge，确认健康后重新检查 |
| `PAGE_NOT_REGISTERED` | 否 | 否 | 刷新供应方页面；仍失败则重载插件后再次刷新 |
| `BROWSER_SESSION_MISSING` | 否 | 否 | 从当前用户和设备已注册页面中重新选择，不借用其他设备 session |
| `AUTH_REQUIRED` | 否 | 否 | 由操作人员人工重新登录 |
| 验证码或异常跳转 | 否 | 否 | 立即停止，不绕过风控 |
| 429 | 否 | 否 | 熔断并等待人工确认预算和恢复时间 |
| `WRONG_ORIGIN` | 否 | 否 | 导航到授权域名，不放宽白名单 |
| `WRONG_ENTITY` | 否 | 否 | 检查任务目标和当前页面，不覆盖任务 ID |
| `PAGE_CONTRACT_CHANGED` | 否 | 否 | 暂停该契约，按 §3 重新走 Fixture 和版本判断 |
| Relay 暂时网络错误 | 有限 | 否 | 使用机器错误码重试，不记录上游正文 |
| Schema、未知字段或敏感键异常 | 否 | 否 | 失败关闭并进行安全审查 |

“刷新页面”和“重载插件”只用于恢复页面注册，不得用于规避权限、验证码、429 或契约漂移。

当前 Relay 只注册页面 session，没有独立的设备/plugin 在线心跳。因此
`PAGE_NOT_REGISTERED` 只表示指定 `userId + deviceId` 下没有可观察页面，不能进一步
判定是设备关机、插件离线、页面未刷新还是脚本未注册；界面和日志不得伪造更细原因。
诊断结果只允许包含状态、恢复动作、页面数、origin、粗粒度 auth 状态和匹配布尔值，
不得保存完整 URL、页面标题/正文、auth 对象或 `browserSessionId`。

## 6. 真实 smoke test 输出边界

允许记录：

- 契约 ID/版本；
- 两端代码版本或“未版本化”偏差；
- 外部职位 ID 是否匹配，不记录完整真实 ID；
- 状态类型、城市是否存在、薪资上下限；
- 发布时间是否存在、推荐数字段类型；
- JD 字符数、内容 SHA-256 格式是否合法；
- 执行耗时和机器错误码。

禁止记录：

- 完整 JD、候选人信息、公司敏感字段或页面正文；
- Cookie、Authorization、口令、验证码、Relay token；
- 完整 `userId`、`deviceId`、`browserSessionId`；
- 浏览器 Profile、本地存储、可复用页面令牌；
- 原始 Relay 请求/响应正文。

真实 smoke test 只证明受限回执协议可用，不证明职位满足沉睡规则，也不授权写入 `jobs`。接入 `browser_job_collect` 后仍需重新校验 `active + 7～30 天 + 有效推荐数 0`。

## 7. 验证记录与结束清理

验证记录放在 `docs/validation/YYYY-MM-DD-<contract>.md`，使用以下字段：

```text
日期与环境：
授权范围：
auto-headcount 版本：
CSDN-Agent/插件版本：
契约 ID/版本：
Fixture RED/GREEN：
Provider/Consumer 命令与结果：
真实 smoke test 最小摘要：
敏感数据检查：
已知偏差：
结论（specified/implemented/verified）：
```

结束前必须：

1. 停止临时 Bridge 或确认其仍在批准的运行范围内。
2. 删除仓库外临时响应；若无法证明未产生，则停止提交并人工检查。
3. 检查 `git diff`、测试输出和普通日志不含真实正文、联系方式、凭证或完整会话标识。
4. 将可复用边界转成虚构 Fixture，不保留真实页面副本或打码简历。
5. 在 `CHANGELOG.md` 区分协议验证、数据入库和业务闭环状态。

## 8. 跨仓库交付

CSDN-Agent 应作为独立、可版本化的浏览器执行端，不复制进 auto-headcount。两仓库通过契约 ID、版本和 Schema 兼容，不通过源码引用耦合。每次契约交付记录两边 commit/tag；任何一边未版本化时不得声明可复现发布或批量运行。

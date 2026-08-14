# 猎必得浏览器采集 · 运营操作手册

> 适用：auto-headcount 运营后台「采集当前筛选结果」批次的日常执行。开发/联调细节见
> [`browser-collection.md`](browser-collection.md)；本手册只讲"每批次怎么跑、跑之前检查什么、卡住怎么办"。

## 0. 时区

- 数据库、调度器日志、批次时间**全部是 UTC**；本机为 UTC+8，换算时 +8 小时。
  （例如批次 `created_at=04:41 UTC` = 本地 12:41。）

## 1. 一次性前置配置（部署或首次，不属于每批次）

| 项 | 位置 | 说明 |
|---|---|---|
| 服务端 relay 身份 | `apps/web/.env.local` 或 docker env | `BROWSER_RELAY_URL=http://host.docker.internal:48887/mcp/request`；`BROWSER_RELAY_USER_ID=local_ops_local`；`BROWSER_RELAY_DEVICE_ID=device-67f4301f-…`；`BROWSER_RELAY_TOKEN=dev` |
| 本批数量上限 | 前端「采集当前筛选结果」下拉 | 10/20/50/100；**该数量即本次抓取上限**（发现合同自动翻页直到凑满该数量或列表到底，`maxPages` 已按 API 上限 20 发送）。重复采集同一批职位时 `jobs` 为 upsert 覆盖，数量不涨；只有筛选列表里出现未入库过的新职位才会插入 |
| 扩展身份 | 浏览器扩展 `chrome.storage.local` | `localUserId` 由 `localUserName` 派生；`deviceId` 首次生成后持久化。**必须与服务端 `BROWSER_RELAY_USER_ID / BROWSER_RELAY_DEVICE_ID` 一致**，否则批次在预检就 `BROWSER_SESSION_MISSING` |
| 调度器 | docker compose `scheduler` 服务 | `node scripts/run-scheduled-tick.mjs --loop --interval-minutes 1`，**每 1 分钟一轮**；`browser_job_collect` 按批次**突发认领**（每轮最多 10 条、单进程串行执行），不再每轮只处理 1 条 |

**deviceId 校验**：批次绑定的 deviceId 来自服务端 env。扩展注册时会以自身存储的 deviceId 上报。
两者不一致时，批次任务预检返回 `BROWSER_SESSION_MISSING` / `PAGE_NOT_REGISTERED`。
改 deviceId 就要改服务端 env **并且** 重新入队（批次 payload 已固化旧 deviceId）。

## 2. 每批次标准操作流程

### 2.1 启动 bridge（若未在跑）

```bash
cd /Users/csdn/Documents/yu/yu_csdn_project_first/csdn-agent/plugins/csdn-browser-agent
CSDN_BROWSER_AGENT_BRIDGE_ONLY=1 node mcp/server.js
```

- 监听 `127.0.0.1:48887`；auto-headcount relay 通过 `host.docker.internal:48887` 访问它。
- **bridge 是常驻进程，必须一直跑**；它由某个终端/会话拉起，会话结束会退出，下次要重新启动。
- 启动后扩展会在轮询时自动重新注册会话（自愈），无需手动重连。

### 2.2 准备浏览器页面（每批次必做）

1. 打开/切到猎必得**职位列表页**：`https://portal.liebide.com/#/jobList`（或站点内"职位搜索"入口）。
2. 在页面上设好筛选：
   - **推荐 0 人**（单选）
   - **发布时间：最近 30 天**（日期区间，结束=今天，跨度 29 天）
   - 发现合同会**校验这个筛选证据**，没设对会 `FILTER_CONTRACT_MISMATCH` 失败关闭。
3. **刷新页面**（F5/Cmd+R）：让扩展内容脚本重新注入、会话以当前 URL 注册到 bridge。
4. 保持**只开一个猎必得标签页**。多余的猎必得标签页会让会话选择器无法唯一确定会话 →
   `BROWSER_SESSION_MISSING`（详情合同要求"恰好一个 liebide 会话"）。

### 2.3 验证连接（可选但推荐）

```bash
curl -s -X POST http://127.0.0.1:48887/mcp/local-tool \
  -H "authorization: Bearer dev" -H "content-type: application/json" \
  -d '{"tool":"csdn_get_browser_connection_status","arguments":{"userId":"local_ops_local","deviceId":"device-67f4301f-9578-4bbf-83d5-cb42d4a92798","contractId":"liebide-filtered-job-list-v2","batchSize":20,"maxPages":3},"timeoutMs":12000}'
```

预期：`{"status":"READY","ready":true,...}`。若 `BROWSER_SESSION_MISSING` → 回到 2.2 检查页面/标签页。

### 2.4 触发批次

- 管理端「数据源」页 → 选择来源 → 「采集当前筛选结果」，填数量后入队。
- 前端只回 `202 { accepted:true, batchId, taskId }` 并提示「批次已入队」，**不显示后续进度**——这是前端 UX 缺口，需核对用 2.6/2.7 的查询。

### 2.5 等待调度（批次"没动静"的最常见原因）

- 调度器**每 1 分钟**跑一轮 tick。批次入队后约 **1 分钟内**开始执行发现；发现成功后详情任务按批次**突发认领**（每轮最多 10 条、串行执行），20 条详情约 2~3 轮（2~3 分钟）跑完。
- 检查方式：
```bash
docker exec auto-headcount-db-1 psql -U auto_headcount -d auto_headcount -c \
  "select id,status,discovered_count,created_at from browser_collection_batches order by created_at desc limit 3;"
docker logs auto-headcount-scheduler-1 -t --since 5m 2>&1 | tail -3   # 看最近一轮 tick 时间
```
- 想立刻跑（不等 1 分钟），手动触发一轮：
```bash
docker exec auto-headcount-scheduler-1 node scripts/run-scheduled-tick.mjs
```
  它会认领到期任务执行并打印 `{claimed, succeeded, failed, ...}`。

### 2.6 执行中

- **不要动浏览器标签页**。详情任务会反复把标签页导航到不同职位详情页（每次强制整页加载）。
- 详情任务按批次**突发认领**：每轮 tick 认领最多 10 条（含批次内全部到期项），单进程串行执行，
  20 条约 2~3 分钟跑完。调度器每 1 分钟一轮。
- 某条详情任务失败会进入**重试退避**（`next_attempt_at` 置未来）；由于突发认领已放开同 kind 限制，
  退避任务不会挡住批次内其他到期任务。发现卡住时查 `async_tasks` 的 `next_attempt_at / last_error_code`。

### 2.7 完成后核对

```bash
docker exec auto-headcount-db-1 psql -U auto_headcount -d auto_headcount -c \
  "select status,discovered_count,succeeded_count,failed_count,skipped_count from browser_collection_batches where id='<batchId>';"
docker exec auto-headcount-db-1 psql -U auto_headcount -d auto_headcount -c \
  "select i.title as list_title, j.title as db_title, (j.title=i.title) as match from browser_collection_items i
   left join jobs j on j.external_id=i.external_id and j.source_connection_id='b624e601-aa10-45f3-b23c-371c371905a6'
   where i.batch_id='<batchId>' order by i.page_number,i.position;"
```

- `succeeded` = 全部入库；`completed_with_errors` = 有失败。
- 期望：入库条目的 `db_title` 与 `list_title` 一致、各岗位**互不相同**（曾出现"全部相同"的 bug）。
- `skipped`（`AGE_OUT_OF_RANGE` 等）是**正常业务排除**：发布不在 7~30 天窗口的沉睡职位不写 `jobs`，不算失败。

## 3. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 批次一直 pending，tick 到了也不跑 | 未到下一轮 15 分钟 tick；或详情任务重试退避挡住队列 | 手动触发 tick；查 `async_tasks.next_attempt_at` |
| 预检 `BROWSER_SESSION_MISSING` | 不在列表页 / 多个 liebide 标签页 / bridge 会话注册表陈旧 | 导航到列表页+设筛选+刷新；关多余标签页；重启 bridge |
| 扩展完全无响应（连快照都超时） | 扩展 background 被挂起的 `Runtime.evaluate` 堵死 | 刷新猎必得标签页；必要时重载扩展 |
| 详情任务 `BROWSER_RELAY_UNAVAILABLE` | 提取超过 30s relay 超时，或 bridge 短暂不可达 | 确认 bridge 在跑；重试（可重试） |
| 详情任务 `unknown job status` | 状态标签选择器命中职级标签而非招募状态 | 检查扩展是否已加载最新 `extraction-contracts.js`（重载扩展） |
| 扩展注册的 deviceId 与服务端不一致 | 扩展存储的 deviceId 变了 | 统一后重新入队批次 |

## 4. 改动后必须重启/重载的清单

- 改 `mcp/server.js`、`extension/extraction-contracts.js` → **重载浏览器扩展**，**重启 48887 bridge**。
- 改 `apps/web/lib/jobs/*`、`browser-job-batch-repository.mjs` → **重启 scheduler 容器**（`docker restart auto-headcount-scheduler-1`）。
- Rust Relay 无入参白名单，改参数白名单类契约时无需动。

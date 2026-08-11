# MCP 脱敏夹具

本目录只保存经过人工检查、可进入 Git 的 MCP 契约或脱敏响应夹具。

## 发现流程

1. 复制仓库根目录 `.env.example` 为根目录 `.env.local`，并配置轮换后的测试凭证。兼容读取 `apps/web/.env.local`，但根目录文件是标准入口。
2. 将发现结果先写入仓库外的临时路径：

   ```bash
   npm run mcp:discover -- --output /tmp/auto-headcount-mcp-discovery.json
   ```

3. 人工确认文件不包含凭证、真实联系方式、完整简历、可使用令牌或供应商禁止保存的字段。
4. 只把需要的工具 Schema 复制为本目录中的版本化 Fixture，并在文件名或元数据中记录协议版本和获取日期。
5. 外部 Schema 变化时新增/更新契约测试，不用静默覆盖旧 Fixture。

发现命令使用独占创建模式，不会覆盖已有文件。原始真实响应不得直接写入本目录。

最小职位响应样本也必须先写入仓库外：

```bash
npm run mcp:sample-jobs -- --output /tmp/auto-headcount-under-served.json
```

该命令硬编码只允许 `wb.jobs.under_served`，请求 `page_size=1`，不能通过参数改为短信、邮件、批量创建或其他工具。

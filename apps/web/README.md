# 零推荐职位激活系统 Web

基于 Vinext 的内部运营后台。项目使用外部 PostgreSQL 17 和 Drizzle；`.openai/hosting.json` 中的 D1/R2 绑定保持为空，不是当前数据持久层。

## Prerequisites

- Node.js `>=22.13.0`

## 标准开发入口

```bash
cd ../..
cp .env.example .env.local
make dev
```

标准开发与验收均在 Docker Compose 内运行。只有维护脚本或排查问题时才直接在本目录执行 npm 命令。

## 目录结构

- `app/` 保存页面和服务端入口
- `db/schema.ts` 定义 PostgreSQL 规范化表和加密原始快照表
- `drizzle/` 保存版本化 PostgreSQL 迁移
- `lib/mcp/` 隔离供应商 MCP 协议和字段
- `lib/jobs/` 提供职位同步入库骨架

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes
- `npm run db:migrate`: apply versioned PostgreSQL migrations
- `npm run test:unit`: run business-rule and MCP adapter unit tests
- `npm run test:integration`: run PostgreSQL migration and persistence tests
- `npm run mcp:discover -- --output /tmp/auto-headcount-mcp-discovery.json`: discover the test MCP protocol and tool schemas using the repository-root `.env.local`

Copy the repository-root `.env.example` to `.env.local` and replace every placeholder with rotated test credentials. For backward compatibility the command also loads `apps/web/.env.local`, with app-local values taking precedence. MCP discovery output must be written outside the repository first and reviewed before a sanitized, versioned Fixture is added under `fixtures/mcp/`. The command never overwrites an existing output file and never serializes configured access or secret keys.

## 参考资料

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle PostgreSQL Guide](https://orm.drizzle.team/docs/get-started/postgresql-new)

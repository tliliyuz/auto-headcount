import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const connectionString = process.env.DATABASE_URL;
const workerPath = fileURLToPath(
  new URL("../dist/server/index.js", import.meta.url),
);

/**
 * HTTP 层鉴权/CSRF/包络测试：走构建后 Worker 的真实请求路径，验证仓储层测试
 * 覆盖不到的 HTTP 行为——无会话 401（withAudit 门禁）、跨源写请求 CSRF 403、坏请求 400。
 *
 * 边界说明（I12）：构建产物把 `postgres` 编译为 workerd 专用（`cloudflare:` socket），
 * Node 中一触数据库即抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，因此**带真实 DB 的 HTTP 用例
 * （登录成功/角色 403/password_change_required/成功包络/审计落库）无法在此运行**——
 * 这些由以下逻辑层测试覆盖：`tests/identity/authz.test.mjs`（RBAC）、
 * `tests/server/with-audit-gate.test.mjs`（首登改密门禁）、`tests/server/audit.test.mjs`
 * （审计计划）、`tests/ops-read.integration.test.mjs`（仓储层包络/投影）。
 */
test(
  "HTTP 鉴权/CSRF/包络：无会话 401、跨源写 403、坏请求 400",
  // withAudit 在 401 判断前即解析 DB 上下文（getDb 校验连接串），
  // 故需 DATABASE_URL 存在（容器/CI 满足）；纯 Node 无连接串环境跳过。
  { skip: !connectionString || !(await distExists()) },
  async () => {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const env = {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const base = "http://localhost";

    // 1) 业务只读端点无会话 → 401 统一包络（withAudit 在查库前拒绝，不触 DB）
    const anon = await worker.fetch(
      new Request(`${base}/api/jobs/under-served`),
      env,
      ctx,
    );
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).code, "unauthorized");

    // 1b) 职位详情动态路由注册且同样被会话门禁拒绝（匿名 401，不触 DB）。
    //     I12：带真实 DB 会话的 200/400/404 由仓储层与 id 解析单测覆盖。
    for (const path of [
      "/api/jobs/00000000-0000-0000-0000-000000000000",
      "/api/jobs/not-a-uuid",
    ]) {
      const res = await worker.fetch(new Request(`${base}${path}`), env, ctx);
      assert.equal(res.status, 401, `${path} 应 401`);
      assert.equal((await res.json()).code, "unauthorized");
    }

    // 1c) 手动触发同步写路由：无会话 401（CSRF 同源放行后进 withAudit 会话门禁）。
    //     去重行为（accepted/deduplicated 形状）由仓储层集成测试覆盖（I12 边界）。
    const syncTrigger = await worker.fetch(
      new Request(`${base}/api/sync/under-served`, { method: "POST" }),
      env,
      ctx,
    );
    assert.equal(syncTrigger.status, 401, "触发同步无会话应 401");
    assert.equal((await syncTrigger.json()).code, "unauthorized");

    // 1d) M3 匹配端点：列表 / 详情 / 异常 / 已停用旧入口 / 审核，无会话均 401。
    for (const req of [
      new Request(`${base}/api/matches`),
      new Request(`${base}/api/matches/00000000-0000-0000-0000-000000000000`),
      new Request(`${base}/api/matches/not-a-uuid`),
      new Request(`${base}/api/match-exceptions`),
      new Request(`${base}/api/match-tasks`, { method: "POST" }),
      new Request(`${base}/api/matches/00000000-0000-0000-0000-000000000000/review`, {
        method: "POST",
      }),
    ]) {
      const res = await worker.fetch(req, env, ctx);
      assert.equal(res.status, 401, `${req.method} ${req.url} 应 401`);
      assert.equal((await res.json()).code, "unauthorized");
    }

    // 1e) 落地页运营建链：无会话 401（withAudit 会话门禁）；跨源写 403（CSRF 先于会话，N4 同源）。
    const landingCreate = await worker.fetch(
      new Request(`${base}/api/landing-links`, { method: "POST" }),
      env,
      ctx,
    );
    assert.equal(landingCreate.status, 401, "建链无会话应 401");
    assert.equal((await landingCreate.json()).code, "unauthorized");

    const landingCreateCross = await worker.fetch(
      new Request(`${base}/api/landing-links`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", candidateId: "00000000-0000-0000-0000-000000000000" }),
      }),
      env,
      ctx,
    );
    assert.equal(landingCreateCross.status, 403, "建链跨源应 403");
    assert.equal((await landingCreateCross.json()).code, "forbidden");

    // 1f) 公开意向提交（独立身份域）：跨源写 403（CSRF）；同源无会话坏请求 400；无加密配置 503。
    const intentCross = await worker.fetch(
      new Request(`${base}/api/landing/sometoken/intent`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ option: "A", phone: "1" }),
      }),
      env,
      ctx,
    );
    assert.equal(intentCross.status, 403, "意向跨源应 403");
    assert.equal((await intentCross.json()).code, "forbidden");

    const intentBadBody = await worker.fetch(
      new Request(`${base}/api/landing/sometoken/intent`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "not-json",
      }),
      env,
      ctx,
    );
    assert.equal(intentBadBody.status, 400, "意向坏请求体应 400");
    assert.equal((await intentBadBody.json()).code, "invalid_request");

    // 2) 空/畸形会话 Cookie → 401（parseSessionToken 拒绝，同样不触 DB）
    for (const cookie of ["session_token=", "session_token", "foo=bar"]) {
      const res = await worker.fetch(
        new Request(`${base}/api/sources`, { headers: { cookie } }),
        env,
        ctx,
      );
      assert.equal(res.status, 401, `cookie=${JSON.stringify(cookie)}`);
    }

    // 3) 写路由跨源 Origin → CSRF 403（N4 同源校验）
    const cross = await worker.fetch(
      new Request(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ username: "x", password: "y" }),
      }),
      env,
      ctx,
    );
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).code, "forbidden");

    // 4) 同源但请求体非法 → 400 包络
    const badBody = await worker.fetch(
      new Request(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "not-json",
      }),
      env,
      ctx,
    );
    assert.equal(badBody.status, 400);
    assert.equal((await badBody.json()).code, "invalid_request");
  },
);

async function distExists() {
  try {
    await access(workerPath);
    return true;
  } catch {
    return false;
  }
}

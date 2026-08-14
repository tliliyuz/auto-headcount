#!/usr/bin/env node
/**
 * 集成测试专用数据库引导 + 运行器。
 *
 * 背景（技术债，docs/02 §6）：此前集成测试直接连 dev 的 `auto_headcount` 库，
 * 真实 scheduler（docker compose）会持续写入 jobs/sync_runs/audit_logs，导致整批
 * 并行集成测试偶发 flaky（分页 total 波动、关键词/审计计数被污染）。本脚本把集成
 * 测试整体隔离到独立测试库 `auto_headcount_test`，从根源消除与 dev 数据的竞争：
 *
 *   1. 由 DATABASE_URL 推导测试库连接串（仅库名替换为 auto_headcount_test）；
 *   2. 确保测试库存在（缺失则 CREATE DATABASE）；
 *   3. 清空业务表（保留 __drizzle_migrations 迁移记录，TRUNCATE ... CASCADE）；
 *   4. 对测试库跑 db:migrate（幂等，复用 db/migrate.mjs）；
 *   5. 以 DATABASE_URL=<测试库> 派生 `node --test <files>`；
 *   6. 透传子进程退出码。
 *
 * 用法（npm script 在 apps/web 下运行）：
 *   node --env-file-if-exists=../../.env.local --env-file-if-exists=.env.local \
 *     scripts/run-integration-tests.mjs tests/xxx.integration.test.mjs ...
 *
 * DATABASE_URL 缺失时退出码 2（集成测试需要 PostgreSQL，本地 .env.local、CI workflow
 * env 注入）；测试失败透传非零退出码。
 */
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const TEST_DB_NAME = "auto_headcount_test";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error(
    "[test-db] DATABASE_URL 未设置。集成测试需要 PostgreSQL：本地经 .env.local，CI 经 workflow env。",
  );
  process.exit(2);
}

const testUrl = deriveTestUrl(sourceUrl, TEST_DB_NAME);

await ensureDatabase();
await clearTestDb();
await migrateTestDb();

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("[test-db] 未指定测试文件，用法见文件头注释。");
  process.exit(2);
}

console.log(
  `[test-db] 测试库: ${maskUrl(testUrl)}  测试文件: ${files.length} 个`,
);
// --test-concurrency=1：测试文件顺序执行。node --test 默认并行跑文件，多个集成
// 文件并发写同一测试库，会让全局分页/计数断言在两次查询间漂移（页间重叠、total
// 波动）。顺序执行后每次断言窗口内无并发写者，结果确定。
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  { env: { ...process.env, DATABASE_URL: testUrl }, stdio: "inherit" },
);
process.exit(result.status ?? 1);

/** 推导测试库连接串：仅替换库名，保留用户/口令/主机/端口与查询参数。 */
function deriveTestUrl(sourceUrl, testDbName) {
  const u = new URL(sourceUrl);
  u.pathname = `/${testDbName}`;
  return u.toString();
}

/** 日志脱敏：不输出连接串里的口令。 */
function maskUrl(url) {
  const u = new URL(url);
  return u.toString().replace(/\/\/[^@]*@/, "//***@");
}

/** 确保测试库存在：连接维护库 postgres，缺失则 CREATE DATABASE。 */
async function ensureDatabase() {
  const maint = new URL(sourceUrl);
  maint.pathname = "/postgres";
  const sql = postgres(maint.toString(), { max: 1 });
  try {
    const [row] = await sql`
      select 1 from pg_database where datname = ${TEST_DB_NAME}
    `;
    if (!row) {
      // CREATE DATABASE 不能参数化（extended protocol 会在事务块内执行而失败）。
      // 库名是内部固定常量，用 unsafe + 双引号转义（identifier 白名单，无用户输入）。
      await sql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      console.log(`[test-db] 已创建测试库 ${TEST_DB_NAME}`);
    }
  } finally {
    await sql.end();
  }
}

/** 清空业务表（保留 __drizzle_migrations），保证每次整批运行从干净状态开始。 */
async function clearTestDb() {
  const sql = postgres(testUrl, { max: 1 });
  try {
    const tables = await sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename <> '__drizzle_migrations'
    `;
    if (tables.length > 0) {
      const quoted = tables.map((t) => `"${t.tablename}"`).join(", ");
      await sql.unsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
      console.log(`[test-db] 已清空 ${tables.length} 张业务表`);
    }
  } finally {
    await sql.end();
  }
}

/** 对测试库跑 drizzle 迁移（幂等）。 */
function migrateTestDb() {
  const result = spawnSync(process.execPath, ["db/migrate.mjs"], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("[test-db] 测试库迁移失败");
    process.exit(result.status ?? 1);
  }
}

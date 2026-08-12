import postgres from "postgres";
import { cacheForRequest } from "vinext/cache";

import { getWorkerEnv } from "./runtime-env";

/**
 * 运行时数据库客户端：
 * - Worker 运行时经 Hyperdrive 绑定（dev 下 Miniflare 指向本地 Docker Postgres）；
 * - Node / 测试 / 脚本上下文回退到 DATABASE_URL 直连。
 *
 * workerd 强制请求级 I/O 上下文隔离：连接池必须在当前请求内创建才能被当前请求使用，
 * 因此不能使用模块级单例，而采用 cacheForRequest 做“每请求缓存”——同一请求复用，
 * 跨请求各自创建独立客户端。
 */
function resolveConnectionString(): string {
  const hyperdrive = getWorkerEnv().HYPERDRIVE;
  if (hyperdrive?.connectionString) return hyperdrive.connectionString;
  return process.env.DATABASE_URL ?? "";
}

export interface RuntimeDb {
  client: postgres.Sql;
}

export const getDb = cacheForRequest<RuntimeDb>(() => {
  const connectionString = resolveConnectionString();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = postgres(connectionString, {
    max: 5,
    idle_timeout: 3,
    connect_timeout: 10,
  });
  return { client };
});

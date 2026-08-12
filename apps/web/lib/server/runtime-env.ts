import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Worker 运行时环境绑定。Vinext 的 RSC 入口不透传 Worker `env` 给路由，
 * 因此由自有的 worker 入口在每次 fetch 时经 AsyncLocalStorage 写入，
 * 路由与服务端代码通过 getWorkerEnv() 读取（并发安全）。
 */
export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  ASSETS?: unknown;
  [key: string]: unknown;
}

const envStore = new AsyncLocalStorage<WorkerEnv>();

export function runWithEnv<T>(env: WorkerEnv, run: () => T): T {
  return envStore.run(env, run);
}

export function getWorkerEnv(): WorkerEnv {
  return envStore.getStore() ?? {};
}

/** 运行时环境判定：优先 APP_ENV，其次 NODE_ENV，默认 development。 */
export function getRuntimeEnv(): "development" | "test" | "production" {
  const raw = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

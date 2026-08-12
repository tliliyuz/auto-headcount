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

/** 已就回落 development 发出过告警（避免每个请求重复刷屏）。 */
let warnedDevelopmentFallback = false;

/**
 * 运行时环境判定：
 * 1. 优先读 Worker 环境绑定 `APP_ENV`（生产部署经 wrangler vars 注入，绑定是权威来源）；
 * 2. 其次 `process.env.APP_ENV` / `NODE_ENV`（Node 脚本、测试、本地工具链）；
 * 3. 两者都未显式声明时回落 `development` 并**发出告警**——防止生产部署漏配
 *    APP_ENV=production 时静默关闭生产管理员 TOTP 强制与 Secure Cookie。
 */
export function getRuntimeEnv(): "development" | "test" | "production" {
  const workerEnv = getWorkerEnv();
  const binding = typeof workerEnv.APP_ENV === "string" ? workerEnv.APP_ENV : null;
  const procEnv =
    typeof process !== "undefined"
      ? process.env.APP_ENV ?? process.env.NODE_ENV
      : undefined;
  const raw = binding ?? procEnv ?? null;

  if (raw === "production") return "production";
  if (raw === "test") return "test";
  if (raw === "development") return "development";

  if (!warnedDevelopmentFallback) {
    warnedDevelopmentFallback = true;
    console.warn(
      "[runtime-env] 未检测到 APP_ENV/NODE_ENV，已回落 development；" +
        "生产部署必须显式注入 APP_ENV=production，否则管理员 TOTP 强制与 Secure Cookie 会被关闭。",
    );
  }
  return "development";
}

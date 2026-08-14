/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runScheduledTick } from "../lib/jobs/sync-scheduler.mjs";
import { getDb } from "../lib/server/db";
import { runWithEnv, type WorkerEnv } from "../lib/server/runtime-env";

// Cloudflare Worker 绑定类型的最小结构声明。项目未安装 @cloudflare/workers-types
// （全局类型会与 tsconfig 的 dom lib 冲突），本文件沿用 ExecutionContext/ScheduledEvent
// 的手写结构类型风格；此处补全 ASSETS（Service/Assets 绑定）与 DB（D1 绑定）两个缺口。
interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}
interface D1Database {
  prepare(query: string): unknown;
}

interface Env extends WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  HYPERDRIVE?: { connectionString: string };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  cron?: string;
  scheduledTime?: Date;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // 把 Worker env 绑定放入请求作用域，供路由/服务端代码经 getWorkerEnv() 读取
    return runWithEnv(env, () => handler.fetch(request, env, ctx));
  },

  /**
   * 定时调度：按 cron 触发同步任务表 tick（入队周期任务 + 处理到期任务）。
   * 配置（加密/MCP/同步源）从 Worker env 绑定解析；getDb() 在非请求作用域每次新建
   * client，因此在此显式建一次并在 finally 关闭。真实 MCP 凭证只经部署绑定注入，
   * dev 缺省无凭证时任务按失败安全处理（机器可读错误码）。
   */
  async scheduled(event: ScheduledEvent, env: Env) {
    await runWithEnv(env, async () => {
      const { client } = getDb();
      try {
        const result = await runScheduledTick({ env, sql: client });
        console.log(
          `[scheduled:tick] enqueued=${result.enqueued} claimed=${result.claimed} ` +
            `succeeded=${result.succeeded} retried=${result.retried} ` +
            `failed=${result.failed} dead=${result.dead}`,
        );
      } catch (error) {
        console.error("[scheduled:tick] 未预期异常", error);
      } finally {
        await client.end();
      }
    });
  },
};

export default worker;

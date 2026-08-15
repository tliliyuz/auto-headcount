import { headers } from "next/headers";
import { getRuntimeEnv } from "@/lib/server/runtime-env";

/**
 * SSR 门禁（不查库，保持渲染轻量、Node 渲染测试可跑）：
 * - `x-prototype-view: app` 请求头仅**非生产**环境强制工作台（供服务端渲染测试覆盖两个视图；
 *   生产环境忽略该头，避免任意客户端强制渲染工作台外壳）；
 * - 请求携带 `session_token` Cookie 视为已登录 → 渲染工作台，客户端再用 /api/auth/me 核实；
 * - 否则渲染登录页。
 * 供 `/` 工作台页与 `/jobs/[id]` 详情页共用。
 */
export async function prototypeView(): Promise<"login" | "app"> {
  const requestHeaders = await headers();
  const forcedApp =
    getRuntimeEnv() !== "production" &&
    requestHeaders.get("x-prototype-view") === "app";
  const cookie = requestHeaders.get("cookie") ?? "";
  return forcedApp || cookie.includes("session_token=") ? "app" : "login";
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prototypeView } from "@/lib/server/prototype-view";
import { JobDetailPage } from "./job-detail-page";

/**
 * 沉睡职位详情页（内部运营，RBAC operations/admin）。
 * 与 `/` 同用 prototypeView SSR 门禁：未登录重定向回 `/`（登录页）；
 * 已登录渲染客户端详情页，客户端再经 /api/auth/me 核实会话并经 /api/jobs/:id 拉详情。
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "职位详情｜职位激活台",
    description: "沉睡职位完整 JD 与运营信息。",
  };
}

export default async function JobDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await prototypeView();
  if (view === "login") redirect("/");
  return <JobDetailPage jobId={id} />;
}

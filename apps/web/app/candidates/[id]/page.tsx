import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prototypeView } from "@/lib/server/prototype-view";
import { CandidateDetailPage } from "./candidate-detail-page";

/**
 * 候选人详情页（内部运营，RBAC operations/admin）。
 * 与 `/` 同用 prototypeView SSR 门禁：未登录重定向回 `/`（登录页）；
 * 已登录渲染客户端详情页，客户端再经 /api/auth/me 核实会话并经 /api/candidates/:id 拉详情。
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "候选人简历｜职位激活台",
    description: "候选人完整简历与画像（内部运营）。",
  };
}

export default async function CandidateDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await prototypeView();
  if (view === "login") redirect("/");
  return <CandidateDetailPage candidateId={id} />;
}

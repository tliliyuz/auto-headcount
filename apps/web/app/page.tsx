import type { Metadata } from "next";
import { OperationsDashboard } from "./operations-dashboard";
import { prototypeView } from "@/lib/server/prototype-view";

export async function generateMetadata(): Promise<Metadata> {
  const view = await prototypeView();
  return {
    title: view === "app" ? "沉睡职位巡检｜职位激活台" : "登录｜职位激活台",
    description: "面向招聘运营的沉睡职位发现、匹配审核与候选人激活工作台。",
  };
}

export default async function Home() {
  const initialView = await prototypeView();
  return <OperationsDashboard initialView={initialView} />;
}

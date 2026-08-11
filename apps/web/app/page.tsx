import type { Metadata } from "next";
import { OperationsDashboard } from "./operations-dashboard";

export const metadata: Metadata = {
  title: "沉睡职位巡检｜职位激活台",
  description: "面向招聘运营的沉睡职位发现、匹配审核与候选人激活工作台。",
};

export default function Home() {
  return <OperationsDashboard />;
}

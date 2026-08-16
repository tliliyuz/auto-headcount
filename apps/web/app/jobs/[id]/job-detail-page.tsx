"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { meRequest } from "@/lib/auth-client";
import { fetchJobDetail, type JobDetail } from "@/lib/ops-client";
import { jobCoarseBucket } from "@/lib/job-category.mjs";

/** 内部页可直接展示真实薪资区间；字段缺省时回落「薪资面议」。 */
function formatSalary(min: number | null, max: number | null): string {
  const validMin = typeof min === "number" && Number.isFinite(min) && min > 0;
  const validMax = typeof max === "number" && Number.isFinite(max) && max >= (min ?? 0);
  if (validMin && validMax) return `¥ ${min}–${max}`;
  return "薪资面议";
}

type LoadState = "loading" | "ready" | "error";

/**
 * 沉睡职位详情页（内部运营）。会话经 /api/auth/me 核实，详情经 /api/jobs/:id 拉取；
 * 401 / password_change_required 回落登录页，403 无权限，404 视为已下架。
 */
export function JobDetailPage({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 挂载时核实会话并拉取详情；async IIFE + AbortController + cancelled 标记防竞态与卸载后 setState。
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const me = await meRequest();
      if (cancelled) return;
      if (!me.ok || me.data.passwordChangeRequired) {
        router.replace("/");
        return;
      }
      const result = await fetchJobDetail(jobId, { signal: controller.signal });
      if (cancelled) return;
      if (result.ok) {
        setDetail(result.data);
        setState("ready");
      } else if (result.status === 401 || result.code === "password_change_required") {
        router.replace("/");
      } else if (result.status === 403) {
        setErrorMessage("无权限访问职位详情");
        setState("error");
      } else if (result.status === 404) {
        setErrorMessage("职位不存在或已下架");
        setState("error");
      } else {
        setErrorMessage("详情加载失败，请稍后重试");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, router]);

  // 就绪后同步浏览器标题（SSR 阶段由 generateMetadata 给静态标题）。
  useEffect(() => {
    if (state === "ready" && detail) {
      document.title = `${detail.title}｜职位激活台`;
    }
  }, [state, detail]);

  return (
    <div className="job-detail-page">
      <Link href="/" className="back-link">← 返回职位列表</Link>

      {state === "loading" && (
        <p className="jd-note">正在加载职位详情…</p>
      )}

      {state === "error" && (
        <div className="jd-note">
          <p>{errorMessage}</p>
          <Link href="/" className="back-link">← 返回职位列表</Link>
        </div>
      )}

      {state === "ready" && detail && (
        <>
          <header className="job-detail-header">
            <span className="role-icon">{detail.title.slice(0, 1)}</span>
            <div>
              <span className="status-pill"><i />待激活</span>
              <h1 className="jd-title">{detail.title}</h1>
              <p className="jd-company">{detail.companyName}</p>
              <p className="jd-meta">{jobCoarseBucket(detail.category, detail.title)} · {detail.cities?.length ? detail.cities.join(" · ") : detail.city}</p>
            </div>
          </header>

          <div className="jd-tags">
            <span className="jd-tag">⌁ {jobCoarseBucket(detail.category, detail.title)}</span>
            <span className="jd-tag">⌖ {detail.cities?.length ? detail.cities.join(" · ") : detail.city}</span>
            <span className="jd-tag">{formatSalary(detail.salaryMin, detail.salaryMax)}</span>
            <span className={`jd-tag ${detail.ageDays >= 27 ? "urgent" : ""}`}>沉睡 {detail.ageDays} 天</span>
          </div>

          <div className="sleeping-alert"><span>!</span><div><strong>已沉睡 {detail.ageDays} 天</strong><p>距 30 天观察上限还有 {30 - detail.ageDays} 天</p></div></div>

          <section className="jd-section">
            <div className="section-title"><h3>职位详情（完整 JD）</h3><span className="internal-label">仅内部</span></div>
            {detail.jobDescription ? (
              <div className="jd-main">{detail.jobDescription}</div>
            ) : (
              <p className="jd-note">暂无详情</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

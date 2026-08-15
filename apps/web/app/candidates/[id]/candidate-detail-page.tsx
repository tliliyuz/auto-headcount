"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { meRequest } from "@/lib/auth-client";
import { fetchCandidateDetail, type CandidateDetailView } from "@/lib/ops-client";

type LoadState = "loading" | "ready" | "error";

/**
 * 候选人详情页（内部运营，真实姓名 RBAC 保护）。会话经 /api/auth/me 核实，
 * 详情经 /api/candidates/:id 拉取（含从 raw_records 解密的工作/项目/教育完整简历）。
 * 401 / password_change_required 回落登录页，403 无权限，404 视为已移除。
 */
export function CandidateDetailPage({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CandidateDetailView | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      const result = await fetchCandidateDetail(candidateId, { signal: controller.signal });
      if (cancelled) return;
      if (result.ok) {
        setDetail(result.data);
        setState("ready");
      } else if (result.status === 401 || result.code === "password_change_required") {
        router.replace("/");
      } else if (result.status === 403) {
        setErrorMessage("无权限访问候选人详情");
        setState("error");
      } else if (result.status === 404) {
        setErrorMessage("候选人不存在或已移除");
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
  }, [candidateId, router]);

  useEffect(() => {
    if (state === "ready" && detail) {
      document.title = `${detail.name}｜候选人简历｜职位激活台`;
    }
  }, [state, detail]);

  return (
    <div className="candidate-detail-page">
      <Link href="/" className="back-link">← 返回候选人池</Link>

      {state === "loading" && <p className="jd-note">正在加载候选人简历…</p>}

      {state === "error" && (
        <div className="jd-note">
          <p>{errorMessage}</p>
          <Link href="/" className="back-link">← 返回候选人池</Link>
        </div>
      )}

      {state === "ready" && detail && (
        <>
          <header className="job-detail-header">
            <span className="role-icon">{detail.name.slice(0, 1)}</span>
            <div>
              <span className="status-pill"><i />{detail.status}</span>
              <h1 className="jd-title">{detail.name}</h1>
              <p className="jd-company">{detail.title ?? "—"} · {detail.company ?? "—"}</p>
              <p className="jd-meta">{detail.city ?? "城市未知"} · {detail.experienceYears != null ? `${detail.experienceYears} 年经验` : "经验未知"} · {detail.education ?? "学历未知"}</p>
            </div>
          </header>

          <div className="jd-tags">
            <span className="jd-tag">⌖ {detail.city ?? "城市未知"}</span>
            <span className="jd-tag">⌁ {detail.experienceYears != null ? `${detail.experienceYears} 年` : "经验未知"}</span>
            <span className="jd-tag">♢ {detail.education ?? "学历未知"}</span>
            {(detail.school || detail.major) && <span className="jd-tag">◉ {[detail.school, detail.major].filter(Boolean).join(" · ")}</span>}
          </div>

          <section className="jd-section">
            <div className="section-title"><h3>工作经历</h3><span className="internal-label">完整简历</span></div>
            {detail.workExperiences.length > 0 ? (
              <div className="resume-list">
                {detail.workExperiences.map((work, index) => (
                  <article key={index} className="resume-entry">
                    <div className="resume-entry-head">
                      <strong>{work.company ?? "—"}</strong>
                      <span className="resume-period">{[work.period, work.duration].filter(Boolean).join(" · ")}</span>
                    </div>
                    <p className="resume-sub">{[work.title, work.city].filter(Boolean).join(" · ")}</p>
                    {work.description && <div className="resume-body">{work.description}</div>}
                  </article>
                ))}
              </div>
            ) : (
              <p className="jd-note">无工作经历记录</p>
            )}
          </section>

          <section className="jd-section">
            <div className="section-title"><h3>项目经历</h3></div>
            {detail.projects.length > 0 ? (
              <div className="resume-list">
                {detail.projects.map((project, index) => (
                  <article key={index} className="resume-entry">
                    <div className="resume-entry-head"><strong>{project.name ?? "—"}</strong></div>
                    {project.description && <div className="resume-body">{project.description}</div>}
                  </article>
                ))}
              </div>
            ) : (
              <p className="jd-note">无项目经历记录</p>
            )}
          </section>

          <section className="jd-section">
            <div className="section-title"><h3>教育经历</h3></div>
            {detail.educationHistory.length > 0 ? (
              <div className="resume-list">
                {detail.educationHistory.map((edu, index) => (
                  <article key={index} className="resume-entry">
                    <div className="resume-entry-head">
                      <strong>{edu.school ?? "—"}</strong>
                      <span className="resume-period">{[edu.period, edu.duration].filter(Boolean).join(" · ")}</span>
                    </div>
                    <p className="resume-sub">{[edu.major, edu.degree].filter(Boolean).join(" · ")}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="jd-note">无教育经历记录</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

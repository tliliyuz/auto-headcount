"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type MaskedJobView = {
  title: string;
  category: string;
  city: string;
  salaryRange: string;
  summary: string;
  candidateName: string | null;
  companyTeaser: {
    industryPositioning: string | null;
    companyScale: string | null;
    benchmarks: string | null;
    officeLocation: string | null;
  } | null;
};

type IntentOption = "A" | "B" | "C" | "opt_out";

const OPTION_LABELS: Record<IntentOption, string> = {
  A: "有兴趣，请联系我",
  B: "暂不考虑",
  C: "愿意了解更多 / 开放查看",
  opt_out: "退订，不再联系",
};

const OPTION_BUTTONS: Array<{ value: IntentOption; label: string; tone?: "primary" | "text" }> = [
  { value: "A", label: OPTION_LABELS.A, tone: "primary" },
  { value: "C", label: OPTION_LABELS.C },
  { value: "B", label: OPTION_LABELS.B },
  { value: "opt_out", label: OPTION_LABELS.opt_out, tone: "text" },
];

export default function LandingPage() {
  const token = useMemo(
    () => window.location.pathname.split("/").filter(Boolean).pop() ?? "",
    [],
  );
  const [status, setStatus] = useState<"loading" | "unavailable" | "ready">("loading");
  const [view, setView] = useState<MaskedJobView | null>(null);
  const [option, setOption] = useState<IntentOption | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "submitted" | "error">("idle");
  const [deduplicated, setDeduplicated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/landing/${encodeURIComponent(token)}`);
        if (!res.ok || cancelled) {
          if (!cancelled) setStatus("unavailable");
          return;
        }
        const data = (await res.json()) as MaskedJobView;
        if (!cancelled) {
          setView(data);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const canSubmit = useCallback(
    () =>
      option !== null &&
      (phone.trim() !== "" || email.trim() !== "") &&
      !submitting,
    [option, phone, email, submitting],
  );

  async function submit() {
    if (!option || !canSubmit()) return;
    setSubmitting(true);
    setSubmitState("idle");
    try {
      const res = await fetch(`/api/landing/${encodeURIComponent(token)}/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          option,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
        }),
      });
      const data = (await res.json()) as { deduplicated?: boolean };
      if (res.ok) {
        setDeduplicated(Boolean(data.deduplicated));
        setSubmitState("submitted");
      } else {
        setSubmitState("error");
      }
    } catch {
      setSubmitState("error");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading") {
    return <PageShell>加载中…</PageShell>;
  }
  if (status === "unavailable" || !view) {
    return (
      <PageShell>
        <p className="lp-error">这个职位机会链接不可用或已过期。</p>
      </PageShell>
    );
  }
  if (submitState === "submitted") {
    return (
      <PageShell>
        <span className="lp-label">提交成功</span>
        <p className="lp-done">
          {deduplicated
            ? "你已经提交过意向，无需重复提交。我们会按你之前的意愿处理。"
            : "已收到你的选择，我们会尽快与你联系。"}
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <span className="lp-label">
        {view.candidateName ? `${view.candidateName}，为你精选的职业机会` : "为你精选的职业机会"}
      </span>
      <h1 className="lp-title">{view.title}</h1>
      <div className="lp-meta">
        <span>⌖ {view.city}</span>
        <span>¥ {view.salaryRange}</span>
        <span>某科技企业</span>
      </div>
      <div className="lp-divider" />
      {view.companyTeaser ? (
        <div className="lp-teaser">
          <h3 className="lp-sub">关于这家公司</h3>
          <ul>
            {view.companyTeaser.industryPositioning ? <li>行业定位：{view.companyTeaser.industryPositioning}</li> : null}
            {view.companyTeaser.companyScale ? <li>公司体量：{view.companyTeaser.companyScale}</li> : null}
            {view.companyTeaser.benchmarks ? <li>对标企业：{view.companyTeaser.benchmarks}</li> : null}
            {view.companyTeaser.officeLocation ? <li>办公地点：{view.companyTeaser.officeLocation}</li> : null}
          </ul>
        </div>
      ) : null}
      {view.summary ? <p className="lp-desc">{view.summary}</p> : null}
      <h2 className="lp-sub">这份机会与你的经历是否契合？</h2>
      <div className="lp-actions">
        {OPTION_BUTTONS.map(({ value, label, tone }) => (
          <button
            key={value}
            className={[
              "lp-action",
              option === value ? "is-selected" : "",
              tone === "primary" ? "is-primary" : "",
              tone === "text" ? "is-text" : "",
            ].join(" ")}
            onClick={() => setOption(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="lp-contact">
        <label className="lp-field">
          <span>手机号</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="用于与你联系"
            autoComplete="tel"
          />
        </label>
        <label className="lp-field">
          <span>邮箱</span>
          <input
            type="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="用于与你联系（选填）"
            autoComplete="email"
          />
        </label>
      </div>
      {submitState === "error" ? <p className="lp-error">提交失败，请稍后再试。</p> : null}
      <button
        className="lp-submit"
        type="button"
        disabled={!canSubmit()}
        onClick={submit}
      >
        {submitting ? "提交中…" : "提交意向"}
      </button>
      <small className="lp-privacy">
        你的选择仅用于本次职位沟通，可随时拒绝后续联系。
      </small>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="lp-shell">
      <section className="lp-card">{children}</section>
      <style>{LANDING_STYLES}</style>
    </main>
  );
}

const LANDING_STYLES = `
  .lp-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f2f5fa; }
  .lp-card { width: min(460px, 100%); padding: 34px 36px 30px; border-radius: 18px; background: #fff; box-shadow: 0 20px 50px rgb(7 19 43 / 12%); }
  .lp-label { display: inline-block; padding: 5px 10px; border-radius: 12px; color: #275ec5; background: #edf3ff; font-size: 12px; font-weight: 700; }
  .lp-title { margin: 14px 0 10px; font-size: 24px; letter-spacing: -.02em; color: #12203a; }
  .lp-meta { display: flex; flex-wrap: wrap; gap: 14px; color: #627189; font-size: 13px; }
  .lp-divider { height: 1px; margin: 22px 0; background: #e9edf3; }
  .lp-desc { margin: 0; color: #6f7d92; font-size: 13px; line-height: 1.8; }
  .lp-sub { margin: 22px 0 12px; font-size: 15px; color: #12203a; }
  .lp-teaser { margin: 0 0 6px; padding: 14px 16px; border-radius: 12px; background: #f5f8fd; }
  .lp-teaser .lp-sub { margin: 0 0 8px; font-size: 13px; }
  .lp-teaser ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  .lp-teaser li { color: #52627a; font-size: 13px; line-height: 1.6; }
  .lp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .lp-action { height: 44px; border: 1px solid #dce3ed; border-radius: 9px; color: #52627a; background: #fff; font-size: 13px; font-weight: 700; cursor: pointer; }
  .lp-action.is-selected { border-color: #2864dc; color: #fff; background: #2864dc; }
  .lp-action.is-primary.is-selected { border-color: #2864dc; }
  .lp-action.is-text { grid-column: 1 / -1; height: 32px; border: 0; color: #929eae; background: none; }
  .lp-contact { display: grid; gap: 10px; margin-top: 18px; }
  .lp-field { display: grid; gap: 5px; }
  .lp-field span { font-size: 12px; color: #52627a; }
  .lp-field input { height: 40px; padding: 0 12px; border: 1px solid #dce3ed; border-radius: 8px; font-size: 14px; color: #12203a; }
  .lp-field input:focus { outline: 2px solid #bcd0f7; border-color: #2864dc; }
  .lp-submit { width: 100%; height: 44px; margin-top: 18px; border: 0; border-radius: 9px; color: #fff; background: #2864dc; font-size: 15px; font-weight: 700; cursor: pointer; }
  .lp-submit:disabled { background: #a9b8d4; cursor: not-allowed; }
  .lp-privacy { display: block; margin-top: 12px; color: #a0aaba; font-size: 11px; text-align: center; }
  .lp-error { margin: 18px 0 0; color: #b3423a; font-size: 13px; text-align: center; }
  .lp-done { margin: 14px 0 0; color: #277e60; font-size: 14px; text-align: center; line-height: 1.7; }
`;

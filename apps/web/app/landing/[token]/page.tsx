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

/** 纯展示格式化：给纯数字薪资范围加千分位（不做单位/币种推断，docs/07 §3「不推断精确薪资」）。 */
function formatSalaryRange(range: string): string {
  const parts = range.split("–").map((part) => part.trim());
  if (parts.length !== 2) return range;
  const [min, max] = parts;
  if (/^\d+$/.test(min) && /^\d+$/.test(max)) {
    return `${Number(min).toLocaleString()}–${Number(max).toLocaleString()}`;
  }
  return range;
}

export default function LandingPage() {
  const token = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.location.pathname.split("/").filter(Boolean).pop() ?? ""
        : "",
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
    return (
      <HeroShell>
        <p className="hero-muted">正在为你准备这个机会…</p>
      </HeroShell>
    );
  }
  if (status === "unavailable" || !view) {
    return (
      <HeroShell>
        <p className="hero-unavailable">这个职位机会链接不可用或已过期。</p>
      </HeroShell>
    );
  }
  if (submitState === "submitted") {
    return (
      <HeroShell>
        <span className="hero-done-label">提交成功</span>
        <h1 className="hero-done-title">
          {deduplicated ? "你已经提交过意向" : "已收到你的选择"}
        </h1>
        <p className="hero-done-copy">
          {deduplicated
            ? "无需重复提交，我们会按你之前的意愿处理。"
            : "我们会尽快与你联系。"}
        </p>
      </HeroShell>
    );
  }

  const teaser = view.companyTeaser;
  const positioning = teaser?.industryPositioning ?? teaser?.companyScale ?? null;
  const greeting = view.candidateName ? `${view.candidateName}，你好` : "你好";

  return (
    <HeroShell>
      <section className="hero-top">
        <span className="hero-eyebrow">为你精选的职业机会</span>
        <h1 className="hero-greet">{greeting}</h1>
        <p className="hero-lead">
          {positioning ? `一家${positioning}` : "一家值得你了解的公司"}，正在寻找一位{" "}
          <strong className="hero-role">{view.title}</strong>
        </p>
        <div className="hero-chips">
          <span className="chip">⌖ {view.city}</span>
          <span className="chip">¥ {formatSalaryRange(view.salaryRange)}</span>
          {view.category ? <span className="chip">{view.category}</span> : null}
        </div>
        <div className="hero-scroll">了解这个机会 ↓</div>
      </section>

      <div className="hero-body">
        {teaser ? (
          <section className="hero-card">
            <div className="card-index">01</div>
            <h2 className="card-title">关于这家公司</h2>
            <ul className="teaser-list">
              {teaser.industryPositioning ? (
                <li><span>行业定位</span>{teaser.industryPositioning}</li>
              ) : null}
              {teaser.companyScale ? (
                <li><span>公司体量</span>{teaser.companyScale}</li>
              ) : null}
              {teaser.benchmarks ? (
                <li><span>对标企业</span>{teaser.benchmarks}</li>
              ) : null}
              {teaser.officeLocation ? (
                <li><span>办公地点</span>{teaser.officeLocation}</li>
              ) : null}
            </ul>
          </section>
        ) : null}

        <section className="hero-card">
          <div className="card-index">02</div>
          <h2 className="card-title">这个职位做什么</h2>
          <p className="role-summary">{view.summary}</p>
        </section>

        <section className="hero-card">
          <div className="card-index">03</div>
          <h2 className="card-title">薪酬与地点</h2>
          <ul className="meta-list">
            <li><span>薪资范围</span>¥ {formatSalaryRange(view.salaryRange)}</li>
            <li><span>工作城市</span>{view.city}</li>
            {teaser?.officeLocation ? (
              <li><span>办公地点</span>{teaser.officeLocation}</li>
            ) : null}
          </ul>
        </section>

        <section className="hero-card cta-card">
          <div className="card-index">04</div>
          <h2 className="card-title">你的选择</h2>
          <p className="cta-hint">你希望我们如何与你联系？</p>
          <div className="cta-actions">
            {OPTION_BUTTONS.map(({ value, label, tone }) => (
              <button
                key={value}
                className={[
                  "cta-action",
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
          <div className="cta-contact">
            <label className="cta-field">
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
            <label className="cta-field">
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
          {submitState === "error" ? <p className="cta-error">提交失败，请稍后再试。</p> : null}
          <button
            className="cta-submit"
            type="button"
            disabled={!canSubmit()}
            onClick={submit}
          >
            {submitting ? "提交中…" : "提交意向"}
          </button>
          <small className="hero-privacy">
            你的选择仅用于本次职位沟通，可随时拒绝后续联系。
          </small>
        </section>
      </div>

      <footer className="hero-footer">
        <small>尊重你的每一次选择 · 你的信息仅用于这次机会的沟通</small>
      </footer>
    </HeroShell>
  );
}

function HeroShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="hero-shell">
      <div className="hero-glow" aria-hidden />
      <div className="hero-inner">{children}</div>
      <style>{HERO_STYLES}</style>
    </main>
  );
}

const HERO_STYLES = `
  .hero-shell { position: relative; min-height: 100vh; overflow-x: hidden; background: linear-gradient(160deg, #0b1530 0%, #070d1b 48%, #0d1730 100%); color: #f2f4f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .hero-glow { position: fixed; top: -22vh; left: 50%; width: 90vw; max-width: 900px; height: 46vh; transform: translateX(-50%); background: radial-gradient(ellipse at center, rgb(226 193 132 / 16%) 0%, rgb(226 193 132 / 4%) 45%, transparent 70%); pointer-events: none; }
  .hero-inner { position: relative; max-width: 760px; margin: 0 auto; padding: 0 24px 40px; }

  .hero-top { display: flex; flex-direction: column; align-items: center; text-align: center; min-height: 86vh; justify-content: center; padding: 60px 0 40px; }
  .hero-eyebrow { display: inline-block; padding: 6px 14px; border: 1px solid rgb(226 193 132 / 32%); border-radius: 999px; color: #e2c184; background: rgb(226 193 132 / 8%); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
  .hero-greet { margin: 26px 0 10px; font-size: clamp(30px, 5.2vw, 44px); font-weight: 700; letter-spacing: -.02em; background: linear-gradient(180deg, #fff 30%, #c9d4ea); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero-lead { max-width: 620px; margin: 0; font-size: clamp(16px, 2.4vw, 20px); line-height: 1.7; color: #a9b7d0; }
  .hero-role { color: #f2f4f9; font-weight: 700; }
  .hero-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 30px; }
  .chip { padding: 9px 16px; border-radius: 999px; border: 1px solid rgb(255 255 255 / 10%); background: rgb(255 255 255 / 5%); color: #d7dfee; font-size: 13px; }
  .hero-scroll { margin-top: 44px; color: #64748f; font-size: 12px; letter-spacing: .08em; }

  .hero-body { display: grid; gap: 18px; padding-top: 10px; }
  .hero-card { position: relative; padding: 28px 28px 26px; border-radius: 18px; border: 1px solid rgb(255 255 255 / 9%); background: rgb(255 255 255 / 4%); box-shadow: 0 18px 50px rgb(0 0 0 / 22%); }
  .card-index { position: absolute; top: 22px; right: 26px; font-size: 13px; color: rgb(226 193 132 / 55%); font-weight: 700; letter-spacing: .1em; }
  .card-title { margin: 0 0 14px; font-size: 19px; letter-spacing: -.01em; color: #f2f4f9; }
  .teaser-list, .meta-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 11px; }
  .teaser-list li, .meta-list li { display: flex; gap: 14px; align-items: baseline; font-size: 14px; line-height: 1.65; color: #c7d1e3; }
  .teaser-list li span, .meta-list li span { flex: 0 0 68px; color: #64748f; font-size: 13px; }
  .role-summary { margin: 0; font-size: 15px; line-height: 1.9; color: #c7d1e3; }

  .cta-card { border-color: rgb(226 193 132 / 26%); background: linear-gradient(180deg, rgb(226 193 132 / 7%), rgb(255 255 255 / 3%)); }
  .cta-hint { margin: 0 0 18px; font-size: 14px; color: #8fa0bb; }
  .cta-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .cta-action { height: 48px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 12px; color: #d7dfee; background: rgb(255 255 255 / 4%); font-size: 14px; font-weight: 600; cursor: pointer; transition: all .15s ease; }
  .cta-action:hover { border-color: rgb(226 193 132 / 40%); color: #fff; }
  .cta-action.is-selected { border-color: #e2c184; color: #0b1530; background: #e2c184; box-shadow: 0 8px 26px rgb(226 193 132 / 28%); }
  .cta-action.is-primary.is-selected { border-color: #e2c184; }
  .cta-action.is-text { grid-column: 1 / -1; height: 36px; border: 0; color: #8fa0bb; background: none; font-size: 13px; }
  .cta-action.is-text.is-selected { color: #e2c184; background: none; box-shadow: none; }
  .cta-contact { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
  .cta-field { display: grid; gap: 7px; }
  .cta-field span { font-size: 12px; color: #8fa0bb; }
  .cta-field input { height: 46px; padding: 0 14px; border-radius: 10px; border: 1px solid rgb(255 255 255 / 12%); background: rgb(255 255 255 / 6%); color: #f2f4f9; font-size: 14px; outline: none; }
  .cta-field input::placeholder { color: #64748f; }
  .cta-field input:focus { border-color: rgb(226 193 132 / 55%); box-shadow: 0 0 0 3px rgb(226 193 132 / 14%); }
  .cta-submit { width: 100%; height: 50px; margin-top: 18px; border: 0; border-radius: 12px; color: #0b1530; background: linear-gradient(180deg, #efd6a4, #e2c184); font-size: 16px; font-weight: 700; cursor: pointer; transition: transform .12s ease, box-shadow .15s ease; }
  .cta-submit:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 14px 34px rgb(226 193 132 / 26%); }
  .cta-submit:disabled { background: #3a4560; color: #7b88a2; cursor: not-allowed; }
  .cta-error { margin: 16px 0 0; color: #e08a80; font-size: 13px; text-align: center; }
  .hero-privacy { display: block; margin-top: 16px; color: #64748f; font-size: 12px; text-align: center; }

  .hero-footer { margin-top: 46px; text-align: center; color: #4d5b74; font-size: 12px; }
  .hero-muted { text-align: center; color: #8fa0bb; font-size: 14px; }
  .hero-unavailable { text-align: center; color: #a9b7d0; font-size: 15px; }
  .hero-done-label { display: inline-block; padding: 6px 14px; border: 1px solid rgb(226 193 132 / 32%); border-radius: 999px; color: #e2c184; background: rgb(226 193 132 / 8%); font-size: 12px; letter-spacing: .12em; }
  .hero-done-title { margin: 24px 0 10px; font-size: 28px; font-weight: 700; }
  .hero-done-copy { margin: 0; color: #a9b7d0; font-size: 15px; line-height: 1.8; }

  @media (max-width: 620px) {
    .hero-inner { padding-inline: 18px; }
    .hero-card { padding: 22px 20px 20px; }
    .cta-contact { grid-template-columns: 1fr; }
  }
`;

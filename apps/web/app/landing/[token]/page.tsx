"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

type AiEvaluation = {
  score: number | null;
  bandLabel: string | null;
  dimensions: Array<{ label: string; score: number }>;
};

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
  aiEvaluation: AiEvaluation | null;
};

type IntentOption = "A" | "B" | "C" | "opt_out";

const SCREENS = [
  { id: "open", index: "01" },
  { id: "salary", index: "02" },
  { id: "employer", index: "03" },
  { id: "role", index: "04" },
  { id: "match", index: "05" },
  { id: "choice", index: "06" },
];

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
    () =>
      typeof window !== "undefined"
        ? window.location.pathname.split("/").filter(Boolean).pop() ?? ""
        : "",
    [],
  );
  const [status, setStatus] = useState<"loading" | "unavailable" | "ready">("loading");
  const [view, setView] = useState<MaskedJobView | null>(null);
  const [activeScreen, setActiveScreen] = useState(0);
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

  // 滚动追踪当前屏：IntersectionObserver 只负责「位置可能变了」的信号，实际高亮用实时
  // getBoundingClientRect 判定「哪屏覆盖视口中央线」——不依赖 scroll 事件与 entry 标志，
  // 对任意滚动容器（window 或滚动祖先）都稳健。
  useEffect(() => {
    if (status !== "ready") return;
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".hero-screen"));
    const recompute = () => {
      const mid = window.innerHeight / 2;
      for (let index = sections.length - 1; index >= 0; index -= 1) {
        const rect = sections[index].getBoundingClientRect();
        if (rect.top <= mid && rect.bottom > mid) {
          setActiveScreen(index);
          return;
        }
      }
    };
    recompute();
    const observer = new IntersectionObserver(recompute, {
      rootMargin: "-50% 0px -50% 0px",
      threshold: 0,
    });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [status, view]);

  const scrollToScreen = useCallback((index: number) => {
    document.querySelectorAll<HTMLElement>(".hero-screen")[index]?.scrollIntoView({
      behavior: "smooth",
    });
  }, []);

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
  const evaluation = view.aiEvaluation;

  return (
    <HeroShell>
      <nav className="progress-rail" aria-label="页面进度">
        {SCREENS.map((screen, index) => (
          <button
            key={screen.id}
            type="button"
            className={index === activeScreen ? "is-active" : ""}
            onClick={() => scrollToScreen(index)}
            aria-label={`第 ${screen.index} 屏`}
          >
            <span>{screen.index}</span>
          </button>
        ))}
      </nav>

      {/* P1 开场 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="hero-eyebrow">为你精选的职业机会</span>
          <h1 className="hero-greet">{greeting}</h1>
          <p className="hero-lead">
            {positioning ? `一家${positioning}` : "一家值得你了解的公司"}，正在寻找{" "}
            <strong className="hero-role">{view.title}方向</strong> 的人才
          </p>
          <div className="hero-chips">
            {view.category ? <span className="chip">{view.category}</span> : null}
            <span className="chip">⌖ {view.city}</span>
            <span className="chip hiring"><span className="dot" />招聘中</span>
          </div>
          <ScreenHint>了解这个机会</ScreenHint>
        </div>
      </section>

      {/* P2 薪酬 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="screen-eyebrow">02 · 薪酬</span>
          <h2 className="screen-title">这个岗位的薪酬</h2>
          <p className="salary-big">{view.salaryRange}</p>
          <p className="salary-sub">月薪范围 · 具体以面谈为准</p>
          <ScreenHint>下一屏 · 关于雇主</ScreenHint>
        </div>
      </section>

      {/* P3 关于雇主 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="screen-eyebrow">03 · 关于雇主</span>
          <h2 className="screen-title">关于这家公司</h2>
          {teaser ? (
            <div className="teaser-panel">
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
            </div>
          ) : (
            <p className="hero-muted">更多公司信息会在后续沟通中为你介绍。</p>
          )}
          <ScreenHint>下一屏 · 岗位内容</ScreenHint>
        </div>
      </section>

      {/* P4 岗位内容 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="screen-eyebrow">04 · 岗位内容</span>
          <h2 className="screen-title">这个岗位做什么</h2>
          <p className="role-summary">{view.summary}</p>
          <ScreenHint>下一屏 · AI 匹配分析</ScreenHint>
        </div>
      </section>

      {/* P5 AI 匹配评价 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="screen-eyebrow">05 · AI 匹配分析</span>
          <h2 className="screen-title">我们为什么觉得这个岗位适合你</h2>
          {evaluation ? (
            <>
              <div className="match-summary">
                <div
                  className="score-ring"
                  style={
                    {
                      "--score-deg": `${Math.max(0, Math.min(100, evaluation.score ?? 0)) * 3.6}deg`,
                    } as CSSProperties
                  }
                >
                  <div className="score-ring-inner">
                    <span className="score-num">{evaluation.score ?? "—"}</span>
                    <span className="score-cap">匹配度</span>
                  </div>
                </div>
                {evaluation.bandLabel ? (
                  <p className="match-band">{evaluation.bandLabel}</p>
                ) : null}
              </div>
              <div className="match-dims">
                {evaluation.dimensions.map((dimension) => (
                  <div className="match-dim" key={dimension.label}>
                    <div className="match-dim-head">
                      <span>{dimension.label}</span>
                      <span className="match-dim-score">{dimension.score}</span>
                    </div>
                    <div className="match-dim-track">
                      <i
                        className="match-dim-fill"
                        style={{ width: `${Math.max(0, Math.min(100, dimension.score))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="hero-muted">这份匹配分析会在确认后为你展示。</p>
          )}
          <ScreenHint>下一屏 · 你的选择</ScreenHint>
        </div>
      </section>

      {/* P6 意向填写 */}
      <section className="hero-screen">
        <div className="hero-screen-inner">
          <span className="screen-eyebrow">06 · 你的选择</span>
          <h2 className="screen-title">你希望我们如何与你联系？</h2>
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
        </div>
      </section>

      <footer className="hero-footer">
        <small>尊重你的每一次选择 · 你的信息仅用于这次机会的沟通</small>
      </footer>
    </HeroShell>
  );
}

function ScreenHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="screen-hint">
      <span>{children}</span>
      <span className="hint-arrow" aria-hidden>↓</span>
    </div>
  );
}

function HeroShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="hero-shell">
      <div className="hero-glow" aria-hidden />
      <div className="hero-scroll">{children}</div>
      <style>{HERO_STYLES}</style>
    </main>
  );
}

const HERO_STYLES = `
  .hero-shell { position: relative; min-height: 100vh; background: linear-gradient(160deg, #0b1530 0%, #070d1b 48%, #0d1730 100%); color: #f2f4f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .hero-glow { position: fixed; top: -22vh; left: 50%; width: 90vw; max-width: 900px; height: 46vh; transform: translateX(-50%); background: radial-gradient(ellipse at center, rgb(226 193 132 / 16%) 0%, rgb(226 193 132 / 4%) 45%, transparent 70%); pointer-events: none; }
  .hero-scroll { position: relative; }

  /* 屏容器：整屏 hero，自然滚动（进度导轨引导，不做滚动吸附以避免与滚动目标打架） */
  .hero-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
  .hero-screen-inner { width: 100%; max-width: 760px; margin: 0 auto; text-align: center; }

  /* 右侧进度导航 */
  .progress-rail { position: fixed; right: 20px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; z-index: 6; }
  .progress-rail button { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgb(255 255 255 / 12%); background: rgb(255 255 255 / 4%); color: #64748f; font-size: 10px; letter-spacing: .02em; cursor: pointer; display: grid; place-items: center; transition: all .2s ease; }
  .progress-rail button:hover { border-color: rgb(226 193 132 / 40%); color: #c9d4ea; }
  .progress-rail button.is-active { border-color: #e2c184; color: #e2c184; background: rgb(226 193 132 / 10%); box-shadow: 0 0 0 4px rgb(226 193 132 / 12%); }

  /* P1 开场 */
  .hero-eyebrow { display: inline-block; padding: 6px 14px; border: 1px solid rgb(226 193 132 / 32%); border-radius: 999px; color: #e2c184; background: rgb(226 193 132 / 8%); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
  .hero-greet { margin: 26px 0 10px; font-size: clamp(30px, 5.2vw, 44px); font-weight: 700; letter-spacing: -.02em; background: linear-gradient(180deg, #fff 30%, #c9d4ea); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero-lead { max-width: 620px; margin: 0 auto; font-size: clamp(16px, 2.4vw, 20px); line-height: 1.7; color: #a9b7d0; }
  .hero-role { color: #f2f4f9; font-weight: 700; }
  .hero-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 30px; }
  .chip { padding: 9px 16px; border-radius: 999px; border: 1px solid rgb(255 255 255 / 10%); background: rgb(255 255 255 / 5%); color: #d7dfee; font-size: 13px; }
  .chip.hiring { display: inline-flex; align-items: center; gap: 7px; color: #cfe6d8; border-color: rgb(79 196 138 / 30%); background: rgb(79 196 138 / 10%); }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #4fc48a; box-shadow: 0 0 0 3px rgb(79 196 138 / 18%); }

  /* 屏级标题 */
  .screen-eyebrow { display: block; font-size: 12px; letter-spacing: .16em; color: #e2c184; text-transform: uppercase; margin-bottom: 18px; }
  .screen-title { margin: 0 auto 28px; max-width: 560px; font-size: clamp(26px, 4.4vw, 40px); font-weight: 700; letter-spacing: -.02em; background: linear-gradient(180deg, #fff 30%, #c9d4ea); -webkit-background-clip: text; background-clip: text; color: transparent; }

  /* P2 薪酬：视觉焦点，接近一级标题 */
  .salary-big { margin: 8px 0 6px; font-size: clamp(44px, 9vw, 84px); font-weight: 700; letter-spacing: -.02em; background: linear-gradient(180deg, #f8ecd2, #e2c184); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .salary-sub { margin: 0; color: #64748f; font-size: 14px; }

  /* P3 关于雇主 */
  .teaser-panel { max-width: 560px; margin: 0 auto; padding: 26px 30px; border-radius: 18px; border: 1px solid rgb(255 255 255 / 9%); background: rgb(255 255 255 / 4%); box-shadow: 0 18px 50px rgb(0 0 0 / 22%); text-align: left; }
  .teaser-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 13px; }
  .teaser-list li { display: flex; gap: 14px; align-items: baseline; font-size: 15px; line-height: 1.7; color: #c7d1e3; }
  .teaser-list li span { flex: 0 0 68px; color: #64748f; font-size: 13px; }

  /* P4 岗位内容 */
  .role-summary { max-width: 580px; margin: 0 auto; font-size: 16px; line-height: 2; color: #c7d1e3; }

  /* P5 AI 匹配评价 */
  .match-summary { display: flex; flex-direction: column; align-items: center; gap: 16px; margin-bottom: 26px; }
  .score-ring { width: 132px; height: 132px; border-radius: 50%; background: conic-gradient(#e2c184 var(--score-deg), rgb(255 255 255 / 7%) 0); display: grid; place-items: center; box-shadow: 0 0 44px rgb(226 193 132 / 16%); }
  .score-ring-inner { width: 108px; height: 108px; border-radius: 50%; background: rgb(7 13 27 / 0.96); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
  .score-num { font-size: 34px; font-weight: 700; line-height: 1; color: #f5e6c6; }
  .score-cap { font-size: 11px; letter-spacing: .12em; color: #8fa0bb; }
  .match-band { margin: 0; display: inline-block; padding: 8px 18px; border-radius: 999px; border: 1px solid rgb(226 193 132 / 32%); color: #e2c184; background: rgb(226 193 132 / 8%); font-size: 14px; font-weight: 600; }
  .match-dims { max-width: 460px; margin: 0 auto; display: grid; gap: 16px; text-align: left; }
  .match-dim-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; color: #c7d1e3; margin-bottom: 7px; }
  .match-dim-score { color: #e2c184; font-weight: 700; font-size: 15px; }
  .match-dim-track { height: 6px; border-radius: 999px; background: rgb(255 255 255 / 8%); overflow: hidden; }
  .match-dim-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #e2c184, #f2d9a4); }

  /* P6 意向填写 */
  .cta-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 520px; margin: 0 auto; }
  .cta-action { height: 48px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 12px; color: #d7dfee; background: rgb(255 255 255 / 4%); font-size: 14px; font-weight: 600; cursor: pointer; transition: all .15s ease; }
  .cta-action:hover { border-color: rgb(226 193 132 / 40%); color: #fff; }
  .cta-action.is-selected { border-color: #e2c184; color: #0b1530; background: #e2c184; box-shadow: 0 8px 26px rgb(226 193 132 / 28%); }
  .cta-action.is-primary.is-selected { border-color: #e2c184; }
  .cta-action.is-text { grid-column: 1 / -1; height: 36px; border: 0; color: #8fa0bb; background: none; font-size: 13px; }
  .cta-action.is-text.is-selected { color: #e2c184; background: none; box-shadow: none; }
  .cta-contact { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; max-width: 520px; margin-left: auto; margin-right: auto; }
  .cta-field { display: grid; gap: 7px; }
  .cta-field span { font-size: 12px; color: #8fa0bb; }
  .cta-field input { height: 46px; padding: 0 14px; border-radius: 10px; border: 1px solid rgb(255 255 255 / 12%); background: rgb(255 255 255 / 6%); color: #f2f4f9; font-size: 14px; outline: none; }
  .cta-field input::placeholder { color: #64748f; }
  .cta-field input:focus { border-color: rgb(226 193 132 / 55%); box-shadow: 0 0 0 3px rgb(226 193 132 / 14%); }
  .cta-submit { width: 100%; max-width: 520px; height: 50px; margin-top: 18px; border: 0; border-radius: 12px; color: #0b1530; background: linear-gradient(180deg, #efd6a4, #e2c184); font-size: 16px; font-weight: 700; cursor: pointer; transition: transform .12s ease, box-shadow .15s ease; }
  .cta-submit:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 14px 34px rgb(226 193 132 / 26%); }
  .cta-submit:disabled { background: #3a4560; color: #7b88a2; cursor: not-allowed; }
  .cta-error { margin: 16px 0 0; color: #e08a80; font-size: 13px; text-align: center; }
  .hero-privacy { display: block; margin-top: 16px; color: #64748f; font-size: 12px; text-align: center; }

  /* 屏间提示 */
  .screen-hint { margin-top: 46px; display: inline-flex; align-items: center; gap: 9px; color: #64748f; font-size: 12px; letter-spacing: .08em; }
  .hint-arrow { color: #e2c184; font-size: 14px; animation: hint-bounce 1.6s ease-in-out infinite; }
  @keyframes hint-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(5px); } }

  .hero-footer { margin-top: 8px; padding-bottom: 40px; text-align: center; color: #4d5b74; font-size: 12px; }
  .hero-muted { margin: 0; text-align: center; color: #8fa0bb; font-size: 14px; line-height: 1.9; max-width: 560px; margin-left: auto; margin-right: auto; }
  .hero-unavailable { text-align: center; color: #a9b7d0; font-size: 15px; }
  .hero-done-label { display: inline-block; padding: 6px 14px; border: 1px solid rgb(226 193 132 / 32%); border-radius: 999px; color: #e2c184; background: rgb(226 193 132 / 8%); font-size: 12px; letter-spacing: .12em; }
  .hero-done-title { margin: 24px 0 10px; font-size: 28px; font-weight: 700; }
  .hero-done-copy { margin: 0; color: #a9b7d0; font-size: 15px; line-height: 1.8; }

  @media (max-width: 620px) {
    .progress-rail { display: none; }
    .hero-screen { padding-inline: 18px; }
    .teaser-panel { padding: 22px 20px; }
    .cta-contact { grid-template-columns: 1fr; }
  }
`;

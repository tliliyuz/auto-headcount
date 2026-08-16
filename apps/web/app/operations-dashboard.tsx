"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { isUnderServedJob, toPublicJobView } from "@/lib/job-rules.mjs";
import {
  JOB_CATEGORY_BUCKETS,
  jobCoarseBucket,
} from "@/lib/job-category.mjs";
import {
  changePasswordRequest,
  loginRequest,
  logoutRequest,
  meRequest,
  type AuthSession,
} from "@/lib/auth-client";
import {
  fetchAuditLogs,
  fetchDormantJobs,
  fetchMatchDetail,
  fetchMatches,
  fetchMatchExceptions,
  fetchSources,
  fetchSyncRuns,
  fetchBrowserBatches,
  fetchCandidateBatches,
  fetchCandidates,
  triggerSync,
  triggerBrowserCollection,
  triggerCandidateCollection,
  reviewMatch,
  type AuditLogView,
  type BrowserBatchView,
  type CandidateBatchView,
  type CandidateView,
  type DormantJob,
  type MatchDetailView,
  type MatchExceptionView,
  type MatchView,
  type SourceView,
  type SyncRunView,
} from "@/lib/ops-client";

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const SYNC_STATUS_VIEW: Record<string, { label: string; className: string }> = {
  succeeded: { label: "成功", className: "status-成功" },
  failed: { label: "失败", className: "status-失败" },
  running: { label: "运行中", className: "status-运行中" },
  pending: { label: "排队中", className: "status-排队中" },
  dead: { label: "失败（超限）", className: "status-失败" },
};

const BATCH_STATUS_VIEW: Record<string, { label: string; className: string }> = {
  pending: { label: "排队中", className: "status-排队中" },
  discovering: { label: "发现中", className: "status-运行中" },
  collecting: { label: "采集中", className: "status-运行中" },
  succeeded: { label: "成功", className: "status-成功" },
  completed_with_errors: { label: "部分失败", className: "status-失败" },
  failed: { label: "失败", className: "status-失败" },
};

/** 数据源页统一批次列表：浏览器职位/候选人采集批次（collection/candidate）与 MCP 同步批次（sync）合并为一种事件。 */
type BatchEvent =
  | (BrowserBatchView & { kind: "collection"; key: string; shortId: string })
  | (CandidateBatchView & { kind: "candidate"; key: string; shortId: string })
  | (SyncRunView & { kind: "sync"; key: string; shortId: string });

/** 按批次种类取状态视图：采集/候选人批次共用批次状态机，同步批次用同步状态机。 */
function batchEventStatusView(ev: BatchEvent): { label: string; className: string } {
  const map = ev.kind === "sync" ? SYNC_STATUS_VIEW : BATCH_STATUS_VIEW;
  return map[ev.status] ?? { label: ev.status, className: "" };
}

/** 事件种类展示名：批次为原子事件（发现 + 入库在一个事件里），标签直接区分职位/候选人/周期同步。 */
function batchKindLabel(kind: BatchEvent["kind"]): string {
  return kind === "collection" ? "职位采集" : kind === "candidate" ? "候选人采集" : "周期同步";
}

/**
 * 同步触发状态机：idle 空闲 → triggering 请求中 → queued 已入队（等待调度 tick 认领）
 * → syncing 执行中 → succeeded/failed 终态。终态显示结果文本（含计数/错误码），可再次触发。
 */
type SyncTriggerState =
  | "idle"
  | "triggering"
  | "queued"
  | "syncing"
  | "succeeded"
  | "failed";

/** 同步状态轮询间隔：调度 tick 最长约 15 分钟，仅活跃窗口（queued/syncing）内轮询，终态即停。 */
const SYNC_POLL_MS = 10 * 1000;


const categories = ["全部", ...JOB_CATEGORY_BUCKETS];

const JOB_PAGE_SIZE = 10;

/** 客户端会话心跳间隔：静默调 /api/auth/me 刷新服务端空闲窗口（空闲 30 分钟内多次续期）。 */
const SESSION_HEARTBEAT_MS = 5 * 60 * 1000;

/** 生成分页页码序列：总数 ≤7 全显示，否则显示首尾与当前页邻域，空隙用省略号。 */
function pageItems(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  // 去重后再排序：current 落在端点时（如 current=1 或 current=total），
  // 候选集里的 1/current/total 会重复，重复项会同时造成重复页码与重复 React key。
  const pages = [...new Set([1, current - 1, current, current + 1, total])]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const items: Array<number | "…"> = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) items.push("…");
    items.push(p);
    prev = p;
  }
  return items;
}

type PageId = "jobs" | "matching" | "candidates" | "campaigns" | "followups" | "funnel" | "sources" | "audit";

const pageLabels: Record<PageId, string> = {
  jobs: "沉睡职位巡检",
  matching: "智能匹配",
  candidates: "候选人",
  campaigns: "触达活动",
  followups: "跟进任务",
  funnel: "转化漏斗",
  sources: "数据源",
  audit: "审计日志",
};

const DIMENSION_LABELS: Record<string, string> = {
  skills: "技能", industry: "行业", seniority: "职级", experience: "经历",
  location: "地点", salary: "薪资", activity: "活跃度",
};

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: string }) {
  return (
    <section className="page-heading prototype-heading">
      <div><span className="eyebrow"><i />{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action && <button className="primary-button">{action}</button>}
    </section>
  );
}

function SummaryStrip({ items }: { items: Array<{ label: string; value: string; note: string; tone?: string }> }) {
  return (
    <section className="summary-strip">
      {items.map((item) => <article key={item.label}><span className={`summary-mark ${item.tone ?? "blue"}`} /><div><small>{item.label}</small><strong>{item.value}</strong><p>{item.note}</p></div></article>)}
    </section>
  );
}

type AuthUser = { name: string; role: string };

const ROLE_LABELS: Record<string, string> = {
  operations: "招聘运营",
  recruiter: "招聘顾问",
  admin: "管理员",
};

function toAuthUser(session: AuthSession): AuthUser {
  return {
    name: session.user.displayName,
    role: ROLE_LABELS[session.roles[0]] ?? session.roles[0],
  };
}

/** 登录失败兜底文案：服务端可能返回更具体文案，此处保证统一口径存在。 */
const LOGIN_FAILED_FALLBACK = "账号或口令不正确";

function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [step, setStep] = useState<"form" | "force-change">("form");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginSession, setLoginSession] = useState<AuthSession | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (busy) return;
    if (!username.trim() || !password.trim()) {
      setError("请输入账号和口令。");
      return;
    }
    setBusy(true);
    const result = await loginRequest({
      username: username.trim(),
      password,
      totpCode: totp.trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message || LOGIN_FAILED_FALLBACK);
      return;
    }
    if (result.data.passwordChangeRequired) {
      setLoginSession(result.data);
      setStep("force-change");
      return;
    }
    onLogin(toAuthUser(result.data));
  }

  async function handleChangeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setError("两次输入的新口令不一致。");
      return;
    }
    setBusy(true);
    const result = await changePasswordRequest({
      currentPassword: password,
      newPassword,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (loginSession) {
      onLogin(toAuthUser(loginSession));
    } else {
      setStep("form");
    }
  }

  return (
    <main className="login-shell">
      <section className="login-brand-panel">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">职</span>
          <div><strong>职位激活台</strong><span>Recruit Ops</span></div>
        </div>
        <div className="login-panel-copy">
          <span className="login-eyebrow"><i />内部运营后台</span>
          <h1>让沉睡的职位，重新流动起来。</h1>
          <p>识别长期无推荐的职位，从授权人才库匹配候选人，通过合规触达收集意向，形成可追踪的推荐闭环。</p>
        </div>
        <ul className="login-features">
          <li><i>⌁</i><span><strong>沉睡职位巡检</strong><small>发布 7–30 天、仍有效且零推荐</small></span></li>
          <li><i>◎</i><span><strong>匹配审核</strong><small>逐条核对证据、缺失项与风险</small></span></li>
          <li><i>↗</i><span><strong>合规触达</strong><small>人工审批、退订与频控门禁</small></span></li>
        </ul>
        <p className="login-panel-foot">受邀请用户登录 · 未开放自主注册</p>
      </section>

      <section className="login-form-panel">
        <div className="login-card">
          {step === "form" ? (
            <form className="login-form" onSubmit={handleSubmit} noValidate>
              <div className="login-card-head">
                <h2>登录职位激活台</h2>
                <p>使用账号口令登录；生产管理员需校验动态验证码。</p>
              </div>
              {error && <div className="login-notice danger" role="alert">{error}</div>}
              <label className="login-field"><span>账号</span><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入账号" /></label>
              <label className="login-field"><span>口令</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入口令" /></label>
              <label className="login-field"><span>动态验证码 <em>生产管理员必填</em></span><input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(event) => setTotp(event.target.value)} placeholder="6 位验证码" /></label>
              <button className="primary-button login-submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
              <div className="login-demo-hint"><strong>开发提示</strong><p>开发种子账号 <code>ops</code> 直接进入；<code>admin</code> 首次登录需设置新口令。生产环境账号由管理员创建。</p></div>
            </form>
          ) : (
            <form className="login-form" onSubmit={handleChangeSubmit} noValidate>
              <div className="login-card-head">
                <h2>设置新口令</h2>
                <p>首次登录需设置新口令后才能使用业务功能。</p>
              </div>
              {error && <div className="login-notice danger" role="alert">{error}</div>}
              <label className="login-field"><span>新口令</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 12 位，含字母与数字" /></label>
              <label className="login-field"><span>确认新口令</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新口令" /></label>
              <button className="primary-button login-submit" disabled={busy}>{busy ? "提交中…" : "确认并进入工作台"}</button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function MatchingPage({ onAuthExpired }: { onAuthExpired: () => void }) {
  const [matches, setMatches] = useState<MatchView[]>([]);
  const [exceptions, setExceptions] = useState<MatchExceptionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<MatchDetailView | null>(null);
  const [queueView, setQueueView] = useState<"review" | "exceptions">("review");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const loadQueues = useCallback(async (signal?: AbortSignal) => {
    const [matchResult, exceptionResult] = await Promise.all([
      fetchMatches({ status: "pending_review", pageSize: 50, signal }),
      fetchMatchExceptions({ pageSize: 50, signal }),
    ]);
    if (!matchResult.ok || !exceptionResult.ok) {
      // 三元分支里 TS 无法把「至少一个失败」传播到 failure，需按 ok 判别再访问失败字段
      const failure = !matchResult.ok ? matchResult : exceptionResult;
      if (failure.ok) {
        setError("数据加载失败");
      } else if (failure.status === 401 || failure.code === "password_change_required") {
        onAuthExpired();
      } else {
        setError(failure.message);
      }
      setLoading(false);
      return;
    }
    setMatches(matchResult.data.list);
    setExceptions(exceptionResult.data.list);
    if (matchResult.data.list.length === 0) setCandidate(null);
    setSelected((current) => current && matchResult.data.list.some((item) => item.id === current) ? current : matchResult.data.list[0]?.id ?? null);
    setError(null);
    setLoading(false);
  }, [onAuthExpired]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => loadQueues(controller.signal));
    return () => controller.abort();
  }, [loadQueues]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void fetchMatchDetail(selected, { signal: controller.signal }).then((result) => {
      if (result.ok) setCandidate(result.data);
      else if (result.status === 401 || result.code === "password_change_required") onAuthExpired();
      else setError(result.message);
    });
    return () => controller.abort();
  }, [selected, onAuthExpired]);

  const decide = async (decision: "approve" | "reject") => {
    if (!candidate || reviewing) return;
    setReviewing(true);
    const result = await reviewMatch(candidate.id, decision);
    if (result.ok) await loadQueues();
    else if (result.status === 401 || result.code === "password_change_required") onAuthExpired();
    else setError(result.message);
    setReviewing(false);
  };

  return <>
    <PageIntro eyebrow="系统自动生成 · 人工最终确认" title="匹配审核工作台" description="职位或候选人信息变化后系统自动重算；运营只需审核结果和处理异常。" />
    <SummaryStrip items={[
      { label: "待人工审核", value: String(matches.length), note: `${matches.filter((item) => item.band === "high").length} 个高匹配`, tone: "violet" },
      { label: "自动评分", value: "增量", note: "按版本与预算运行" },
      { label: "需要处理", value: String(exceptions.length), note: "数据或评分异常", tone: "amber" },
      { label: "触达门禁", value: "人工", note: "审核通过后放行", tone: "green" },
    ]} />
    <section className="matching-flow" aria-label="自动匹配流程">
      <div className="flow-step done"><i>✓</i><span><strong>数据就绪</strong><small>职位与候选人投影</small></span></div><b>→</b>
      <div className="flow-step done"><i>✓</i><span><strong>硬过滤</strong><small>剔除明确不符合项</small></span></div><b>→</b>
      <div className="flow-step running"><i>◎</i><span><strong>详情评分</strong><small>脱敏七维评估</small></span></div><b>→</b>
      <div className="flow-step"><i>4</i><span><strong>人工审核</strong><small>通过后进入触达</small></span></div>
      <span className="flow-budget">系统按 Top-K 与全局预算自动运行</span>
    </section>
    <div className="queue-switch" role="tablist" aria-label="匹配工作区">
      <button role="tab" aria-selected={queueView === "review"} className={queueView === "review" ? "active" : ""} onClick={() => setQueueView("review")}>待审核 <b>{matches.length}</b></button>
      <button role="tab" aria-selected={queueView === "exceptions"} className={queueView === "exceptions" ? "active" : ""} onClick={() => setQueueView("exceptions")}>需要处理 <b>{exceptions.length}</b></button>
    </div>
    {error && <div className="login-notice danger" role="alert">{error}</div>}
    {queueView === "exceptions" ? <section className="surface-card exception-panel">
      <div className="surface-header"><div><h2>需要人工处理</h2><p>失败关闭的任务不会生成分数，也不会进入触达池</p></div><button className="plain-filter">全部异常⌄</button></div>
      <div className="exception-list">{exceptions.map((item) => <article key={item.id}>
        <span className={`exception-icon ${item.type === "scoring" ? "red" : "amber"}`}>!</span>
        <div><header><strong>{item.type === "scoring" ? "详情评分失败" : "硬过滤输入异常"}</strong><code>{item.errorCode}</code></header><p>{item.jobTitle} · {item.candidateName} · {formatDateTime(item.createdAt)}</p></div>
        <button disabled={!item.retryable}>{item.retryable ? "等待自动重试" : "检查输入"}</button>
      </article>)}</div>
      {!loading && exceptions.length === 0 && <div className="empty-state">当前没有需要处理的匹配异常</div>}
    </section> : <section className="review-layout">
      <div className="surface-card review-list">
        <div className="surface-header"><div><h2>待审核候选人</h2><p>已完成硬过滤、详情评分和本地汇总</p></div><button className="plain-filter">优先级：从高到低⌄</button></div>
        <div className="segmented"><button className="active">全部 {matches.length}</button><button>高匹配 {matches.filter((item) => item.band === "high").length}</button><button>中匹配 {matches.filter((item) => item.band === "medium").length}</button></div>
        <div className="candidate-list">
          {matches.map((item) => <button key={item.id} className={`candidate-row ${selected === item.id ? "active" : ""}`} onClick={() => setSelected(item.id)}>
            <span className="candidate-avatar">{item.candidateName.slice(-1)}</span>
            <span className="candidate-main"><strong>{item.candidateName}<i>待审核</i></strong><small>{item.jobTitle} · {item.jobExternalId}</small><em>{item.candidateSummary && <b>{item.candidateSummary}</b>}</em></span>
            <span className={`match-score ${item.band ?? "medium"}`}><strong>{item.score ?? "—"}</strong><small>匹配分</small></span>
          </button>)}
          {!loading && matches.length === 0 && <div className="empty-state">暂无待审核结果，系统会在新版本就绪后自动生成</div>}
        </div>
      </div>
      <aside className="surface-card candidate-detail">
        {candidate ? <>
          <div className="detail-head"><span className="candidate-avatar large">{candidate.candidateName.slice(-1)}</span><div><h2>{candidate.candidateName}</h2><p>{candidate.candidateSummary ?? "暂无候选人摘要"}</p></div><span className="score-badge">{candidate.score ?? "—"} 分</span></div>
          <div className="score-context"><span>匹配职位 <b>{candidate.jobTitle}</b></span><span>模型 <b>{candidate.modelId ?? "—"}</b></span><span>更新于 <b>{formatDateTime(candidate.updatedAt)}</b></span></div>
          <div className="detail-section"><h3>匹配证据</h3><ul className="evidence-list positive">{candidate.evidence.map((copy, index) => <li key={`${copy}-${index}`}><b>证据 {index + 1}</b><span>{copy}</span></li>)}</ul></div>
          <div className="detail-section two-cols"><div><h3>缺失项</h3><p className="notice amber">{candidate.missing.join("；") || "无"}</p></div><div><h3>风险提示</h3><p className="notice red">{candidate.risk.join("；") || "无"}</p></div></div>
          <div className="dimension-scores"><h3>七维评分</h3>{candidate.dimensions.map((item) => <div key={item.dimension}><span>{DIMENSION_LABELS[item.dimension] ?? item.dimension}</span><i><b style={{ width: `${item.score ?? 0}%` }} /></i><strong>{item.assessable === false ? "不可评估" : item.score ?? "—"}</strong></div>)}</div>
          <details className="score-trace"><summary>评分追溯</summary><p>{candidate.schemaVersion ?? "—"} · {candidate.promptVersion ?? "—"} · {candidate.aggregationRuleVersion ?? "—"} · 输出 {candidate.outputHash?.slice(0, 12) ?? "—"}</p></details>
          <label className="review-note"><span>审核备注</span><textarea placeholder="填写判断依据或后续关注点（选填）" disabled /></label>
          <div className="review-actions"><button disabled={reviewing} onClick={() => void decide("reject")}>拒绝</button><button className="approve" disabled={reviewing} onClick={() => void decide("approve")}>{reviewing ? "提交中…" : "通过并加入触达池"}</button></div>
        </> : <div className="empty-state">{loading ? "正在加载匹配结果…" : "请选择一条待审核结果"}</div>}
      </aside>
    </section>}
  </>;
}

const campaignRows = [
  ["前端高匹配人才激活", "资深前端工程师", "短信 + 邮件", "96 / 108", "31.2%", "进行中"],
  ["AI 产品经理定向沟通", "AI 产品经理", "邮件", "64 / 64", "26.6%", "已完成"],
  ["海外市场人才召回", "海外市场负责人", "短信", "0 / 42", "—", "待审批"],
  ["数据分析师机会开放", "高级数据分析师", "邮件", "38 / 40", "18.4%", "已暂停"],
];

function CampaignsPage() {
  const [active, setActive] = useState(0);
  const row = campaignRows[active];
  return <>
    <PageIntro eyebrow="触达前必须完成人工审批" title="活动执行概况" description="管理短信与邮件草稿、审批状态、发送进度和候选人反馈。" action="新建活动草稿" />
    <SummaryStrip items={[
      { label: "进行中", value: "3", note: "今日发送 286 条", tone: "blue" }, { label: "待审批", value: "2", note: "需由独立审批人处理", tone: "amber" }, { label: "平均送达率", value: "96.2%", note: "较上周 +1.8%", tone: "green" }, { label: "意向率", value: "12.4%", note: "近 30 天", tone: "violet" },
    ]} />
    <section className="campaign-layout">
      <div className="surface-card data-card">
        <div className="surface-header"><div><h2>触达活动</h2><p>共 12 个活动 · 数据更新时间 14:36</p></div><div className="inline-actions"><button>全部状态⌄</button><button>全部渠道⌄</button></div></div>
        <div className="data-table campaign-table"><div className="data-row data-head"><span>活动 / 职位</span><span>渠道</span><span>发送进度</span><span>点击率</span><span>状态</span></div>{campaignRows.map((item, index) => <button key={item[0]} onClick={() => setActive(index)} className={`data-row ${active === index ? "active" : ""}`}><span><strong>{item[0]}</strong><small>{item[1]}</small></span><span>{item[2]}</span><span><b className="progress-mini"><i style={{ width: `${Number(item[3].split("/")[0]) / Math.max(1, Number(item[3].split("/")[1])) * 100}%` }} /></b><small>{item[3]}</small></span><span>{item[4]}</span><span><em className={`status-tag status-${item[5]}`}>{item[5]}</em></span></button>)}</div>
      </div>
      <aside className="surface-card campaign-detail"><span className="status-tag status-进行中">{row[5]}</span><h2>{row[0]}</h2><p>{row[1]} · 创建人 林然</p><div className="campaign-stats"><div><strong>108</strong><small>目标人数</small></div><div><strong>104</strong><small>已送达</small></div><div><strong>30</strong><small>已点击</small></div><div><strong>12</strong><small>有兴趣</small></div></div><div className="message-preview"><span>短信预览 · 62 字</span><p>你好，我们有一份与你经历较契合的资深前端岗位，工作地点上海，薪资 30–45K。点击查看脱敏详情并选择是否愿意了解。</p><small>短链将在审批通过后生成</small></div><div className="approval-flow"><h3>审批记录</h3><div><i className="done">✓</i><p><strong>活动草稿已创建</strong><span>林然 · 今天 10:24</span></p></div><div><i>2</i><p><strong>等待独立审批</strong><span>审批人：徐安</span></p></div><div><i>3</i><p><strong>按计划开始发送</strong><span>计划：明天 10:00</span></p></div></div><button className="secondary-button full">预览候选人页面</button></aside>
    </section>
  </>;
}

const followupColumns = [
  { title: "待联系", count: 5, tone: "blue", cards: [["周先生", "资深前端工程师", "A · 有兴趣", "今天 16:00"], ["唐女士", "AI 产品经理", "C · 开放了解", "今天 17:30"]] },
  { title: "沟通中", count: 4, tone: "amber", cards: [["陈女士", "前端技术专家", "已完成首轮沟通", "明天 10:30"], ["吴先生", "高级数据分析师", "等待薪资确认", "明天 14:00"]] },
  { title: "待推荐", count: 3, tone: "violet", cards: [["李女士", "海外市场负责人", "意向已确认", "今天 18:00"], ["许先生", "供应链顾问", "资料待复核", "8 月 13 日"]] },
  { title: "已完成", count: 18, tone: "green", cards: [["赵女士", "招聘运营专家", "已提交正式推荐", "今天 11:42"], ["孙先生", "资深前端工程师", "候选人暂缓", "昨天"]] },
];

function FollowupsPage() {
  return <><PageIntro eyebrow="候选人意向需要及时响应" title="今日跟进" description="集中处理有兴趣、开放了解以及已经进入推荐准备的人选。" action="新增跟进任务" /><SummaryStrip items={[{ label: "今日到期", value: "12", note: "其中 3 项即将超时", tone: "amber" }, { label: "沟通中", value: "9", note: "平均响应 1.6 小时" }, { label: "待推荐", value: "3", note: "资料已基本齐全", tone: "violet" }, { label: "本周完成", value: "18", note: "完成率 81.8%", tone: "green" }]} /><div className="followup-toolbar"><div className="segmented"><button className="active">看板</button><button>列表</button></div><div className="inline-actions"><button>负责人：全部⌄</button><button>到期时间：本周⌄</button></div></div><section className="kanban">{followupColumns.map((column) => <div className="kanban-column" key={column.title}><header><span><i className={column.tone} />{column.title}</span><b>{column.count}</b></header>{column.cards.map((card) => <article key={card[0]}><div><span className="candidate-avatar small">{card[0].slice(0, 1)}</span><strong>{card[0]}</strong><button aria-label="更多操作">•••</button></div><h3>{card[1]}</h3><p>{card[2]}</p><footer><span>◷ {card[3]}</span><em>林</em></footer></article>)}<button className="add-card">＋ 添加任务</button></div>)}</section></>;
}

function FunnelPage() {
  const bars = [54, 71, 63, 82, 67, 76, 88, 72, 92, 81, 86, 96, 78, 84];
  const stages = [["已发送","1,842","100%"],["已送达","1,771","96.1%"],["已点击","526","28.6%"],["已浏览","438","23.8%"],["表达意向","147","8.0%"],["确认联系","92","5.0%"],["完成推荐","31","1.7%"]];
  return <><PageIntro eyebrow="近 30 天运营数据" title="转化趋势" description="从消息发送到完成推荐，按职位、活动和渠道观察每一层转化。" action="导出报表" /><div className="analytics-grid"><section className="surface-card trend-card"><div className="surface-header"><div><h2>触达与意向趋势</h2><p>7 月 13 日 — 8 月 11 日</p></div><div className="legend"><span><i className="blue" />已送达</span><span><i className="green" />表达意向</span></div></div><div className="chart-area"><div className="y-axis"><span>300</span><span>200</span><span>100</span><span>0</span></div><div className="bar-chart">{bars.map((bar, index) => <div key={index}><i style={{ height: `${bar}%` }} /><b style={{ height: `${Math.max(8, bar * .18)}%` }} /></div>)}</div></div><div className="x-labels"><span>7/13</span><span>7/20</span><span>7/27</span><span>8/3</span><span>8/11</span></div></section><section className="surface-card funnel-card"><div className="surface-header"><div><h2>全链路漏斗</h2><p>所有渠道汇总</p></div></div><div className="funnel-steps">{stages.map((stage, index) => <div key={stage[0]} style={{ width: `${100 - index * 7}%` }}><span>{stage[0]}</span><strong>{stage[1]}</strong><em>{stage[2]}</em></div>)}</div></section></div><section className="surface-card data-card channel-performance"><div className="surface-header"><div><h2>职位转化表现</h2><p>按最终推荐率排序</p></div><button className="plain-filter">全部活动⌄</button></div><div className="data-table performance-table"><div className="data-row data-head"><span>职位</span><span>已送达</span><span>点击率</span><span>意向率</span><span>确认联系</span><span>完成推荐</span></div>{[["资深前端工程师","384","32.6%","11.7%","28","9"],["AI 产品经理","296","29.4%","10.1%","19","7"],["高级数据分析师","248","25.8%","7.7%","12","5"],["海外市场负责人","182","31.3%","9.3%","11","4"]].map((row) => <div className="data-row" key={row[0]}>{row.map((cell, index) => <span key={cell}>{index === 0 ? <strong>{cell}</strong> : cell}</span>)}</div>)}</div></section></>;
}

function CandidatesPage({ onAuthExpired }: { onAuthExpired: () => void }) {
  const router = useRouter();
  const CANDIDATE_PAGE_SIZE = 10;
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState("全部");
  const [query, setQuery] = useState("");
  const [candidatePage, setCandidatePage] = useState(1);
  const [jumpValue, setJumpValue] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 拉取候选人池（真实姓名 RBAC 保护；按页拉全量后客户端筛选/分页）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCandidatesLoading(true);
      const collected: CandidateView[] = [];
      let page = 1;
      let failed: { status: number; code: string | null } | null = null;
      while (true) {
        const result = await fetchCandidates({ page, pageSize: 100 });
        if (cancelled) return;
        if (!result.ok) {
          failed = { status: result.status, code: result.code };
          break;
        }
        collected.push(...result.data.list);
        if (collected.length >= result.data.total || result.data.list.length === 0) break;
        page += 1;
      }
      if (cancelled) return;
      if (failed) {
        if (failed.status === 401 || failed.code === "password_change_required") {
          onAuthExpired();
          return;
        }
        setCandidatesError("候选人池加载失败，请稍后重试");
      } else {
        setCandidates(collected);
      }
      setCandidatesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [onAuthExpired]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of candidates) counts[c.status] = (counts[c.status] ?? 0) + 1;
    return counts;
  }, [candidates]);
  const matchedCount = candidates.filter((c) => c.status === "已匹配").length;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthNew = candidates.filter((c) => new Date(c.createdAt) >= monthStart).length;

  const filteredCandidates = candidates.filter((c) => {
    const statusMatches = activeStatus === "全部" || c.status === activeStatus;
    const q = query.trim().toLowerCase();
    const queryMatches =
      q === "" ||
      `${c.name}${c.title ?? ""}${c.company ?? ""}${c.city ?? ""}${c.school ?? ""}${c.major ?? ""}`
        .toLowerCase()
        .includes(q);
    return statusMatches && queryMatches;
  });
  const candidateTotalPages = Math.max(1, Math.ceil(filteredCandidates.length / CANDIDATE_PAGE_SIZE));
  const currentCandidatePage = Math.min(candidatePage, candidateTotalPages);
  const pageCandidates = filteredCandidates.slice(
    (currentCandidatePage - 1) * CANDIDATE_PAGE_SIZE,
    currentCandidatePage * CANDIDATE_PAGE_SIZE,
  );
  const selected = candidates.find((c) => c.id === selectedId) ?? pageCandidates[0] ?? candidates[0];
  const selectedSummary =
    selected?.summary ??
    (`${[selected?.school, selected?.major].filter(Boolean).join(" · ")}${selected?.experienceYears != null ? ` · ${selected.experienceYears} 年经验` : ""}${selected?.city ? ` · ${selected.city}` : ""}`.replace(/^\s*·\s*/, "") || "暂无摘要");

  function jumpToCandidatePage() {
    const page = Number.parseInt(jumpValue, 10);
    if (!Number.isNaN(page) && page >= 1) setCandidatePage(Math.min(page, candidateTotalPages));
    setJumpValue("");
  }

  return <>
    <PageIntro eyebrow="授权人才池采集的候选人画像" title="候选人池" description="展示采集的候选人画像与匹配状态；真实姓名按 RBAC 保护，匹配投影不含联系方式。" action="采集人才池候选人" />
    <SummaryStrip items={[
      { label: "候选人总数", value: String(candidates.length), note: "互联网技术其他分类", tone: "blue" },
      { label: "已匹配", value: String(matchedCount), note: "进入智能匹配池", tone: "green" },
      { label: "待匹配", value: String(candidates.length - matchedCount), note: "等待匹配任务", tone: "amber" },
      { label: "本月新增", value: String(monthNew), note: "人才池采集入库", tone: "violet" },
    ]} />
    <section className="workspace-grid">
      <div className="jobs-card">
        <div className="card-header"><div><h2>候选人画像</h2><span>人才池采集 · 按状态与关键词筛选</span></div></div>
        <div className="category-tabs" role="tablist" aria-label="候选人状态">
          {["全部", "待匹配", "已匹配", "已审核"].map((status) => (
            <button
              key={status}
              role="tab"
              aria-selected={activeStatus === status}
              className={activeStatus === status ? "active" : ""}
              onClick={() => { setActiveStatus(status); setCandidatePage(1); }}
            >
              {status}
              {status === "全部" ? <span>{candidates.length}</span> : <span>{statusCounts[status] ?? 0}</span>}
            </button>
          ))}
        </div>
        <div className="table-tools">
          <label className="table-search"><span>⌕</span><input value={query} onChange={(e) => { setQuery(e.target.value); setCandidatePage(1); }} placeholder="搜索姓名 / 职位 / 公司 / 城市 / 学校" /></label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>候选人</th><th>当前职位</th><th>公司 / 城市</th><th>经验</th><th>学历</th><th>行业</th><th>状态</th><th /></tr></thead>
            <tbody>
              {pageCandidates.map((c) => (
                <tr key={c.id} className={selected?.id === c.id ? "selected" : ""} onClick={() => setSelectedId(c.id)}>
                  <td><span className="candidate-cell"><button className="candidate-avatar small" onClick={(event) => { event.stopPropagation(); router.push(`/candidates/${c.id}`); }}>{c.name.slice(0, 1)}</button><button className="candidate-name-link" onClick={(event) => { event.stopPropagation(); router.push(`/candidates/${c.id}`); }}>{c.name}</button></span></td>
                  <td><button className="candidate-title-link" onClick={(event) => { event.stopPropagation(); router.push(`/candidates/${c.id}`); }}>{c.title ?? "—"}</button></td>
                  <td><strong>{c.company ?? "—"}</strong><small>{c.city ?? "—"}</small></td>
                  <td><span>{c.experienceYears != null ? `${c.experienceYears} 年` : "—"}</span></td>
                  <td><span>{c.education ?? "—"}</span></td>
                  <td>{c.industry && <span className="industry-cell">{c.industry}</span>}</td>
                  <td><span className={`status-tag status-${c.status}`}>{c.status}</span></td>
                  <td><button aria-label={`查看 ${c.name}`} onClick={(event) => { event.stopPropagation(); router.push(`/candidates/${c.id}`); }}>›</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {candidatesLoading ? (
            <div className="empty-state">正在加载候选人池…</div>
          ) : candidatesError ? (
            <div className="empty-state">{candidatesError}</div>
          ) : filteredCandidates.length === 0 && (
            <div className="empty-state">没有符合当前条件的候选人</div>
          )}
        </div>
        <div className="table-footer">
          <span>{filteredCandidates.length === 0 ? "显示 0 条" : `显示 ${(currentCandidatePage - 1) * CANDIDATE_PAGE_SIZE + 1}–${Math.min(currentCandidatePage * CANDIDATE_PAGE_SIZE, filteredCandidates.length)} 条，共 ${filteredCandidates.length} 条候选人`}</span>
          <div>
            <button disabled={currentCandidatePage <= 1} onClick={() => setCandidatePage(currentCandidatePage - 1)} aria-label="上一页">‹</button>
            {pageItems(currentCandidatePage, candidateTotalPages).map((item, index) =>
              item === "…" ? (
                <span key={`gap-${index}`} className="page-gap">…</span>
              ) : (
                <button key={item} className={item === currentCandidatePage ? "active" : ""} onClick={() => setCandidatePage(item)}>{item}</button>
              ),
            )}
            <button disabled={currentCandidatePage >= candidateTotalPages} onClick={() => setCandidatePage(currentCandidatePage + 1)} aria-label="下一页">›</button>
            <div className="page-jump">
              <input
                type="text"
                inputMode="numeric"
                value={jumpValue}
                onChange={(e) => setJumpValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") jumpToCandidatePage(); }}
                aria-label="跳转到指定页"
                placeholder="页码"
              />
              <span>/ {candidateTotalPages} 页</span>
              <button type="button" onClick={jumpToCandidatePage} disabled={!jumpValue}>GO</button>
            </div>
          </div>
        </div>
      </div>
      <aside className="surface-card campaign-detail">
        {selected ? (
          <>
            <span className={`status-tag status-${selected.status}`}>{selected.status}</span>
            <h2>{selected.name}</h2>
            <p>{selected.title ?? "—"} · {selected.company ?? "—"}</p>
            <div className="campaign-stats">
              <div><strong>{selected.experienceYears != null ? selected.experienceYears : "—"}</strong><small>年经验</small></div>
              <div><strong>{selected.city ?? "—"}</strong><small>城市</small></div>
              <div><strong>{selected.education ?? "—"}</strong><small>学历</small></div>
              <div><strong>{selected.seniority ?? "—"}</strong><small>职级</small></div>
            </div>
            <div className="message-preview"><span>教育背景</span><p>{(selected.school ?? "—")}{selected.major ? ` · ${selected.major}` : ""}</p></div>
            <div className="message-preview"><span>候选人摘要</span><p>{selectedSummary}</p></div>
            {(selected.skills?.length ?? 0) > 0 && (
              <div className="message-preview"><span>技能标签</span><div className="skill-tags">{selected.skills.map((skill) => <span key={skill} className="skill-tag">{skill}</span>)}</div></div>
            )}
            <div className="approval-flow"><h3>采集信息</h3><div><i className="done">✓</i><p><strong>人才池画像已采集</strong><span>来源：猎必得人才池 · 互联网技术其他</span></p></div><div><i>{selected.matchCount}</i><p><strong>匹配记录</strong><span>{selected.matchCount} 条 · 匹配状态由 matches 推导</span></p></div></div>
          </>
        ) : (
          <>
            <span className="status-tag">—</span>
            <h2>{candidatesLoading ? "正在加载候选人池…" : "暂无候选人"}</h2>
            <p>{candidatesLoading ? "拉取真实画像中" : "先触发「采集人才池候选人」批次入库画像"}</p>
          </>
        )}
      </aside>
    </section>
  </>;
}

function SourcesPage({
  onAuthExpired,
  onSync,
  syncState,
}: {
  onAuthExpired: () => void;
  onSync: () => void;
  syncState: SyncTriggerState;
}) {
  const [sources, setSources] = useState<SourceView[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRunView[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [browserBatches, setBrowserBatches] = useState<BrowserBatchView[]>([]);
  const [browserBatchSize, setBrowserBatchSize] = useState(20);
  const [browserCollectState, setBrowserCollectState] = useState<"idle" | "triggering" | "queued" | "failed">("idle");
  const [browserCollectMessage, setBrowserCollectMessage] = useState<string | null>(null);
  const [candidateBatches, setCandidateBatches] = useState<CandidateBatchView[]>([]);
  const [candidateBatchSize, setCandidateBatchSize] = useState(20);
  const [candidateForceRefresh, setCandidateForceRefresh] = useState(false);
  const [candidateCollectState, setCandidateCollectState] = useState<"idle" | "triggering" | "queued" | "failed">("idle");
  const [candidateCollectMessage, setCandidateCollectMessage] = useState<string | null>(null);
  // 统一批次列表：类型 tabs + 关键词 + 客户端分页 + 详情选中（职位/候选人采集批次与同步批次合并）
  const [batchType, setBatchType] = useState<"all" | "collection" | "sync" | "candidate">("all");
  const [batchQuery, setBatchQuery] = useState("");
  const [batchPage, setBatchPage] = useState(1);
  const [batchJumpValue, setBatchJumpValue] = useState("");
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [sourcesResult, runsResult, batchesResult, candidateBatchesResult] = await Promise.all([
        fetchSources({ pageSize: 50 }),
        fetchSyncRuns({ pageSize: 100 }),
        fetchBrowserBatches({ pageSize: 100 }),
        fetchCandidateBatches({ pageSize: 100 }),
      ]);
      if (cancelled) return;
      // 会话中途失效：退回登录页，不滞留空工作台。
      if (!sourcesResult.ok) {
        if (sourcesResult.status === 401 || sourcesResult.code === "password_change_required") {
          onAuthExpired();
          return;
        }
        setSourcesError("数据源加载失败，请稍后重试");
      } else {
        setSources(sourcesResult.data.list);
      }
      if (!runsResult.ok) {
        if (runsResult.status === 401 || runsResult.code === "password_change_required") {
          onAuthExpired();
          return;
        }
        setSourcesError((current) => current ?? "同步批次加载失败，请稍后重试");
      } else {
        setSyncRuns(runsResult.data.list);
      }
      if (!batchesResult.ok) {
        if (batchesResult.status === 401 || batchesResult.code === "password_change_required") {
          onAuthExpired();
          return;
        }
        setSourcesError((current) => current ?? "采集批次加载失败，请稍后重试");
      } else {
        setBrowserBatches(batchesResult.data.list);
      }
      if (!candidateBatchesResult.ok) {
        if (candidateBatchesResult.status === 401 || candidateBatchesResult.code === "password_change_required") {
          onAuthExpired();
          return;
        }
        setSourcesError((current) => current ?? "候选人批次加载失败，请稍后重试");
      } else {
        setCandidateBatches(candidateBatchesResult.data.list);
      }
    })().finally(() => {
      if (!cancelled) setSourcesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [onAuthExpired]);

  // 统一批次列表刷新：入队成功后立即调用一次，随后每 10 秒轮询，让采集批次
  // pending→discovering→collecting→终态、同步批次 running→终态无需手动刷新即可看到。
  const refreshBatches = useCallback(async () => {
    const [runsResult, batchesResult, candidateBatchesResult] = await Promise.all([
      fetchSyncRuns({ pageSize: 100 }),
      fetchBrowserBatches({ pageSize: 100 }),
      fetchCandidateBatches({ pageSize: 100 }),
    ]);
    if (runsResult.ok) setSyncRuns(runsResult.data.list);
    if (batchesResult.ok) setBrowserBatches(batchesResult.data.list);
    if (candidateBatchesResult.ok) setCandidateBatches(candidateBatchesResult.data.list);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled) void refreshBatches();
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshBatches]);

  const primarySource = sources.find((s) => s.status === "active") ?? sources[0];

  const collectFilteredJobs = async () => {
    if (!primarySource) {
      setBrowserCollectMessage("请先启用职位数据源");
      return;
    }
    setBrowserCollectState("triggering");
    setBrowserCollectMessage(null);
    // maxPages 提到 API 上限（20），让“本批数量”成为真正的数量上限：
    // 发现合同会翻页直到凑满 batchSize 或列表到底，而不是被写死的 3 页截断。
    const result = await triggerBrowserCollection({ sourceConnectionId: primarySource.id, batchSize: browserBatchSize, maxPages: 20 });
    if (result.ok) {
      setBrowserCollectState("queued");
      setBrowserCollectMessage(result.data.deduplicated ? "已有采集批次在执行，已返回现有批次" : `批次已入队：${result.data.batchId.slice(0, 8)}`);
      // 入队后立即刷新「最近采集批次」面板，无需手动刷新页面即可看到新批次。
      void refreshBatches();
      // 入队提示保持可见，但按钮 6 秒后复位，允许连续触发多个批次；批次进度看「最近采集批次」面板。
      window.setTimeout(() => {
        setBrowserCollectState((current) => (current === "queued" ? "idle" : current));
      }, 6000);
    } else if (result.status === 401 || result.code === "password_change_required") {
      setBrowserCollectState("idle");
      onAuthExpired();
    } else {
      setBrowserCollectState("failed");
      setBrowserCollectMessage("采集触发失败，请检查浏览器连接与设备路由");
    }
  };

  const collectCandidates = async () => {
    if (!primarySource) {
      setCandidateCollectMessage("请先启用职位数据源");
      return;
    }
    setCandidateCollectState("triggering");
    setCandidateCollectMessage(null);
    // maxPages 提到 API 上限（20）：人才池发现合同翻页直到凑满本批数量或列表到底。
    const result = await triggerCandidateCollection({ sourceConnectionId: primarySource.id, batchSize: candidateBatchSize, maxPages: 20, forceRefresh: candidateForceRefresh });
    if (result.ok) {
      setCandidateCollectState("queued");
      setCandidateCollectMessage(result.data.deduplicated ? "已有采集批次在执行，已返回现有批次" : `批次已入队：${result.data.batchId.slice(0, 8)}`);
      void refreshBatches();
      window.setTimeout(() => {
        setCandidateCollectState((current) => (current === "queued" ? "idle" : current));
      }, 6000);
    } else if (result.status === 401 || result.code === "password_change_required") {
      setCandidateCollectState("idle");
      onAuthExpired();
    } else {
      setCandidateCollectState("failed");
      setCandidateCollectMessage("采集触发失败，请检查浏览器连接与设备路由");
    }
  };

  // —— 统一批次列表（职位/候选人采集 + 同步）数据派生 ——
  const allEvents = useMemo<BatchEvent[]>(() => {
    const collections: BatchEvent[] = browserBatches.map((b) => ({
      ...b,
      kind: "collection",
      key: `collection:${b.id}`,
      shortId: `BATCH-${b.id.slice(0, 8)}`,
    }));
    const candidates: BatchEvent[] = candidateBatches.map((b) => ({
      ...b,
      kind: "candidate",
      key: `candidate:${b.id}`,
      shortId: `CAND-${b.id.slice(0, 8)}`,
    }));
    const syncs: BatchEvent[] = syncRuns.map((r) => ({
      ...r,
      kind: "sync",
      key: `sync:${r.id}`,
      shortId: `SYNC-${r.id.slice(0, 8)}`,
    }));
    return [...collections, ...candidates, ...syncs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [browserBatches, candidateBatches, syncRuns]);

  const filteredEvents = allEvents.filter((ev) => {
    if (batchType === "collection" && ev.kind !== "collection") return false;
    if (batchType === "sync" && ev.kind !== "sync") return false;
    if (batchType === "candidate" && ev.kind !== "candidate") return false;
    const q = batchQuery.trim().toLowerCase();
    if (!q) return true;
    if (ev.id.toLowerCase().includes(q) || ev.shortId.toLowerCase().includes(q)) return true;
    return ev.kind === "sync" && (ev.sourceDisplayName ?? "").toLowerCase().includes(q);
  });

  const BATCH_PAGE_SIZE = 10;
  const batchTotalPages = Math.max(1, Math.ceil(filteredEvents.length / BATCH_PAGE_SIZE));
  const currentBatchPage = Math.min(batchPage, batchTotalPages);
  const pageEvents = filteredEvents.slice((currentBatchPage - 1) * BATCH_PAGE_SIZE, currentBatchPage * BATCH_PAGE_SIZE);
  const displayedEvent =
    (selectedEventKey ? filteredEvents.find((e) => e.key === selectedEventKey) : null) ??
    pageEvents[0] ??
    null;

  function jumpToBatchPage() {
    const page = Number.parseInt(batchJumpValue, 10);
    if (Number.isFinite(page) && page >= 1 && page <= batchTotalPages) setBatchPage(page);
    setBatchJumpValue("");
  }

  return (
    <>
      <PageIntro eyebrow="连接与同步状态" title="MCP 职位数据源" description="查看连接健康、字段映射、最近同步批次和异常记录。" action="添加数据源" />
      {sourcesError && (
        <div className="login-notice danger" role="alert">{sourcesError}</div>
      )}
      <section className="source-grid">
        {primarySource ? (
          <article className="source-card primary-source">
            <header>
              <span className="source-logo">M</span>
              <div><h2>{primarySource.displayName}</h2><p>{primarySource.provider} · {primarySource.environment}</p></div>
              <em className={primarySource.status === "active" ? "" : primarySource.status === "error" ? "error" : "disabled"}><i />{primarySource.status === "active" ? "连接正常" : primarySource.status === "error" ? "连接异常" : "当前关闭"}</em>
            </header>
            <div className="source-meta">
              <div><small>最近同步</small><strong>{formatDateTime(primarySource.lastRunStartedAt)}</strong></div>
              <div><small>本次入库</small><strong>{primarySource.lastRunStats?.persisted ?? "—"} 个职位</strong></div>
              <div><small>契约版本</small><strong>2025-11-25</strong></div>
            </div>
            <div className="source-actions">
              <button
                className="secondary-button"
                onClick={() => onSync()}
                disabled={syncState === "triggering" || syncState === "queued" || syncState === "syncing"}
                title="触发沉睡职位同步（入队调度任务，同一时刻至多一个活跃任务）"
              >
                {syncState === "triggering" || syncState === "syncing"
                  ? "同步中…"
                  : syncState === "queued"
                    ? "已入队"
                    : syncState === "succeeded"
                      ? "已触发"
                      : "立即同步"}
              </button>
              <button>查看字段映射</button>
              <button>连接设置</button>
            </div>
          </article>
        ) : (
          sourcesLoading && <p className="empty-state">正在加载数据源…</p>
        )}
        <article className="source-card browser-source">
          <header><span className="source-logo browser">B</span><div><h2>浏览器采集</h2><p>筛选列表 → 批量详情复核</p></div><em><i />固定合同</em></header>
          <p className="source-description">先在猎必得筛选“推荐 0 人、发布时间最近 30 天”，然后选择本批数量。本批数量 = 本批要采集的“新增 + 标题变更”职位数：已入库且未变的职位自动跳过，系统翻页直到凑满该数量或列表到底；详情页再复核发布已满 7 天。</p>
          <div className="browser-route-fields">
            <label>本批数量<select value={browserBatchSize} onChange={(event) => setBrowserBatchSize(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label>
          </div>
          <button className="secondary-button" disabled={browserCollectState === "triggering" || browserCollectState === "queued"} onClick={() => void collectFilteredJobs()}>{browserCollectState === "triggering" ? "正在入队…" : browserCollectState === "queued" ? "批次已入队" : "采集当前筛选结果"}</button>
          {browserCollectMessage && <p className={browserCollectState === "failed" ? "source-message error" : "source-message"}>{browserCollectMessage}</p>}
        </article>
        <article className="source-card browser-source">
          <header><span className="source-logo browser">C</span><div><h2>人才池候选人采集</h2><p>人才池列表 → 候选人画像批量入库</p></div><em><i />固定合同</em></header>
          <p className="source-description">先在猎必得人才池页设好「互联网技术其他」分类筛选，然后选择本批数量。本批数量 = 本批要采集的“新增 + 画像变化”候选人画像数：已入库且画像未变的候选人自动跳过，系统翻页直到凑满该数量或列表到底；勾选「重新采集已入库画像」则忽略差分跳过、把本批数量内已入库候选人一并重采（覆盖画像，升级为完整简历）。</p>
          <div className="browser-route-fields">
            <label>本批数量<select value={candidateBatchSize} onChange={(event) => setCandidateBatchSize(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label>
            <label className="force-refresh"><input type="checkbox" checked={candidateForceRefresh} onChange={(event) => setCandidateForceRefresh(event.target.checked)} /> 重新采集已入库画像</label>
          </div>
          <button className="secondary-button" disabled={candidateCollectState === "triggering" || candidateCollectState === "queued"} onClick={() => void collectCandidates()}>{candidateCollectState === "triggering" ? "正在入队…" : candidateCollectState === "queued" ? "批次已入队" : "采集人才池候选人"}</button>
          {candidateCollectMessage && <p className={candidateCollectState === "failed" ? "source-message error" : "source-message"}>{candidateCollectMessage}</p>}
        </article>
        <button className="add-source"><span>＋</span><strong>连接新的授权数据源</strong><small>支持 MCP 或经审核的导入适配器</small></button>
      </section>

      <section className="workspace-grid">
        <div className="jobs-card">
          <div className="card-header">
            <div><h2>采集与同步批次</h2><span>浏览器职位/候选人采集批次与 MCP 同步批次统一查看，最近记录优先</span></div>
            <button className="more-button" aria-label="更多操作">•••</button>
          </div>
          <div className="category-tabs" role="tablist" aria-label="批次类型">
            <button role="tab" aria-selected={batchType === "all"} className={batchType === "all" ? "active" : ""} onClick={() => { setBatchType("all"); setBatchPage(1); }}>全部<span>{allEvents.length}</span></button>
            <button role="tab" aria-selected={batchType === "collection"} className={batchType === "collection" ? "active" : ""} onClick={() => { setBatchType("collection"); setBatchPage(1); }}>职位采集批次<span>{browserBatches.length}</span></button>
            <button role="tab" aria-selected={batchType === "candidate"} className={batchType === "candidate" ? "active" : ""} onClick={() => { setBatchType("candidate"); setBatchPage(1); }}>候选人批次<span>{candidateBatches.length}</span></button>
            <button role="tab" aria-selected={batchType === "sync"} className={batchType === "sync" ? "active" : ""} onClick={() => { setBatchType("sync"); setBatchPage(1); }}>周期同步<span>{syncRuns.length}</span></button>
          </div>
          <div className="table-tools">
            <label className="table-search"><span>⌕</span><input value={batchQuery} onChange={(event) => { setBatchQuery(event.target.value); setBatchPage(1); }} placeholder="搜索批次 ID 或来源" /></label>
          </div>
          <div className="table-wrap batches-wrap">
            <table>
              <thead><tr><th>类型</th><th>批次</th><th>状态</th><th>进度</th><th>结果</th><th>耗时</th><th /></tr></thead>
              <tbody>
                {pageEvents.map((ev) => {
                  const statusView = batchEventStatusView(ev);
                  // 职位/候选人采集批次共用批次字段；同步批次用 stats/errorCode 形态
                  const isCollectionLike = ev.kind === "collection" || ev.kind === "candidate";
                  return (
                    <tr key={ev.key} className={displayedEvent?.key === ev.key ? "selected" : ""} onClick={() => setSelectedEventKey(ev.key)}>
                      <td><span className={`event-kind ${ev.kind}`}><i />{batchKindLabel(ev.kind)}</span></td>
                      <td><strong>{ev.shortId}</strong><small className="job-updated"><span className="job-external-id" title={ev.id}>{ev.id}</span><span className="job-updated-at"> · {formatDateTime(ev.createdAt)}</span></small></td>
                      <td><em className={`status-tag ${statusView.className}`}>{statusView.label}</em></td>
                      <td>{isCollectionLike
                        ? <><strong>{ev.discoveredCount} 发现</strong><small>{ev.succeededCount} 入库 · {ev.failedCount} 失败 · {ev.skippedCount} 跳过</small></>
                        : <><strong>{ev.stats?.persisted ?? 0} 入库</strong><small>{ev.stats?.skipped ?? 0} 跳过 · {ev.stats?.failed ?? 0} 失败</small></>}</td>
                      <td>{isCollectionLike
                        ? ev.status === "failed"
                          ? <code>{ev.stopReason ?? "采集失败"}</code>
                          : ev.status === "pending" || ev.status === "discovering"
                            ? ev.status === "discovering" ? "发现中…" : "等待调度"
                            : ev.status === "collecting"
                              ? "采集进行中…"
                              : ev.status === "succeeded" && ev.discoveredCount === 0
                                ? "无新增（全部已知）"
                                : "完成"
                        : ev.errorCode ? <code>{ev.errorCode}</code> : "正常"}</td>
                      <td>{formatDuration(isCollectionLike ? ev.createdAt : ev.startedAt, ev.finishedAt)}</td>
                      <td><button aria-label={`查看 ${ev.shortId}`} onClick={() => setSelectedEventKey(ev.key)}>›</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {sourcesLoading ? (
              <div className="empty-state">正在加载批次…</div>
            ) : (
              filteredEvents.length === 0 && <div className="empty-state">没有符合当前条件的批次</div>
            )}
          </div>
          <div className="table-footer">
            <span>{filteredEvents.length === 0 ? "显示 0 条" : `显示 ${(currentBatchPage - 1) * BATCH_PAGE_SIZE + 1}–${Math.min(currentBatchPage * BATCH_PAGE_SIZE, filteredEvents.length)} 条，共 ${filteredEvents.length} 条`}</span>
            <div>
              <button disabled={currentBatchPage <= 1} onClick={() => setBatchPage(currentBatchPage - 1)} aria-label="上一页">‹</button>
              {pageItems(currentBatchPage, batchTotalPages).map((item, index) =>
                item === "…" ? (
                  <span key={`gap-${index}`} className="page-gap">…</span>
                ) : (
                  <button key={item} className={item === currentBatchPage ? "active" : ""} onClick={() => setBatchPage(item)}>{item}</button>
                ),
              )}
              <button disabled={currentBatchPage >= batchTotalPages} onClick={() => setBatchPage(currentBatchPage + 1)} aria-label="下一页">›</button>
              <div className="page-jump">
                <input type="text" inputMode="numeric" value={batchJumpValue} onChange={(event) => setBatchJumpValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") jumpToBatchPage(); }} aria-label="跳转到指定页" placeholder="页码" />
                <span>/ {batchTotalPages} 页</span>
                <button type="button" onClick={jumpToBatchPage} disabled={!batchJumpValue}>GO</button>
              </div>
            </div>
          </div>
        </div>

        <aside className="insight-panel" aria-label="批次详情">
          {displayedEvent ? (
            <>
              <div className="panel-heading">
                <span className="role-icon">{displayedEvent.kind === "collection" ? "B" : displayedEvent.kind === "candidate" ? "C" : "M"}</span>
                <div>
                  <span className="status-pill"><i />{batchKindLabel(displayedEvent.kind)}</span>
                  <h2>{displayedEvent.shortId}</h2>
                  <p>{displayedEvent.kind === "collection" ? "筛选列表 → 批量详情复核" : displayedEvent.kind === "candidate" ? "人才池列表 → 候选人画像批量入库" : `${displayedEvent.syncType} · ${displayedEvent.sourceDisplayName}`}</p>
                </div>
              </div>
              <div className="panel-section">
                <div className="section-title"><h3>运行统计</h3><em className={`status-tag ${batchEventStatusView(displayedEvent).className}`}>{batchEventStatusView(displayedEvent).label}</em></div>
                <div className="campaign-stats">
                  {displayedEvent.kind === "collection" || displayedEvent.kind === "candidate" ? (
                    <>
                      <div><strong>{displayedEvent.discoveredCount}</strong><small>发现（新增+变更）</small></div>
                      <div><strong>{displayedEvent.succeededCount}</strong><small>入库</small></div>
                      <div><strong>{displayedEvent.failedCount}</strong><small>失败</small></div>
                      <div><strong>{displayedEvent.skippedCount}</strong><small>跳过</small></div>
                    </>
                  ) : (
                    <>
                      <div><strong>{displayedEvent.stats?.persisted ?? 0}</strong><small>入库</small></div>
                      <div><strong>{displayedEvent.stats?.skipped ?? 0}</strong><small>跳过</small></div>
                      <div><strong>{displayedEvent.stats?.failed ?? 0}</strong><small>失败</small></div>
                      <div><strong>{displayedEvent.stats?.jobsQueried ?? 0}</strong><small>查询</small></div>
                    </>
                  )}
                </div>
              </div>
              <div className="panel-section">
                <div className="section-title"><h3>批次信息</h3></div>
                <div className="detail-meta">
                  {displayedEvent.kind === "collection" || displayedEvent.kind === "candidate" ? (
                    <>
                      <div><span>本批数量</span><b>{displayedEvent.batchSize}</b></div>
                      <div><span>上限页数</span><b>{displayedEvent.maxPages}</b></div>
                    </>
                  ) : (
                    <>
                      <div><span>同步类型</span><b>{displayedEvent.syncType}</b></div>
                      <div><span>错误码</span><b>{displayedEvent.errorCode ?? "—"}</b></div>
                    </>
                  )}
                  <div><span>创建时间</span><b>{formatDateTime(displayedEvent.createdAt)}</b></div>
                  <div><span>完成时间</span><b>{formatDateTime(displayedEvent.finishedAt)}</b></div>
                  <div><span>耗时</span><b>{formatDuration(displayedEvent.kind === "sync" ? displayedEvent.startedAt : displayedEvent.createdAt, displayedEvent.finishedAt)}</b></div>
                </div>
              </div>
              <div className="panel-note"><span>i</span><p>{displayedEvent.kind === "collection" ? "采集批次按断点续采：已入库未变的职位自动跳过，翻页直到凑满本批数量或列表到底。" : displayedEvent.kind === "candidate" ? "候选人批次按断点续采：已入库且画像未变的候选人自动跳过，详情在新标签页提取后关闭回列表。" : "同步任务由调度 tick 异步认领执行；同步完成会自动刷新职位列表。"}</p></div>
            </>
          ) : (
            <>
              <div className="panel-heading">
                <span className="role-icon">—</span>
                <div><span className="status-pill"><i />批次</span><h2>未选择批次</h2><p>点击左侧批次查看运行详情</p></div>
              </div>
              <div className="panel-section">
                <div className="section-title"><h3>批次详情</h3></div>
              </div>
            </>
          )}
        </aside>
      </section>

      <section className="surface-card health-strip">
        <div className="health-cols">
          <div><span><i className={primarySource?.status === "active" ? "green" : "amber"} />连接状态</span><strong>{primarySource ? (primarySource.status === "active" ? "有效" : primarySource.status === "error" ? "异常" : "未启用") : "—"}</strong></div>
          <div><span><i className="green" />运行环境</span><strong>{primarySource?.environment ?? "—"}</strong></div>
          <div><span><i className="green" />数据源数量</span><strong>{sources.length}</strong></div>
        </div>
        <p>系统仅启用了职位只读白名单工具；短信、邮件和候选人详情调用保持关闭。</p>
      </section>
    </>
  );
}

const AUDIT_RESULT_VIEW: Record<string, { label: string; className: string }> = {
  success: { label: "成功", className: "status-成功" },
  failure: { label: "失败", className: "status-失败" },
  denied: { label: "已拒绝", className: "status-已拒绝" },
};

const AUDIT_ACTION_VIEW: Record<string, string> = {
  "auth.login": "登录",
  "auth.logout": "登出",
  "auth.password_change": "改密",
  "jobs.list": "沉睡职位访问",
  "jobs.detail": "职位详情访问",
  "sources.list": "数据源访问",
  "sync-runs.list": "同步批次访问",
  "browser-batches.list": "采集批次访问",
  "candidate-batches.list": "候选人批次访问",
  "sync.run": "同步执行",
  "sync.trigger": "触发同步",
  "browser.collection.trigger": "触发浏览器采集",
  "candidate.collection.trigger": "触发候选人采集",
  "audit-logs.list": "审计日志访问",
  "match-exceptions.list": "匹配异常访问",
  "matches.list": "匹配列表访问",
  "matches.detail": "匹配详情访问",
  "matches.review": "匹配审核",
  "match-tasks.deprecated": "匹配任务（已停用）",
  "retention.run": "保留清理",
};

/** 审计「事件类型」筛选下拉选项：全部 + 已知动作白名单。 */
const AUDIT_ACTION_OPTIONS = Object.entries(AUDIT_ACTION_VIEW).map(([value, label]) => ({ value, label }));

const AUDIT_RESOURCE_VIEW: Record<string, string> = {
  user: "用户",
  job: "职位",
  source_connection: "数据源",
  sync_run: "同步批次",
  browser_collection: "采集批次",
  audit_log: "审计日志",
};

const AUDIT_ACTOR_VIEW: Record<string, string> = {
  user: "运营用户",
  system: "系统任务",
};

function AuditPage({ onAuthExpired }: { onAuthExpired: () => void }) {
  const [logs, setLogs] = useState<AuditLogView[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditTotalPages, setAuditTotalPages] = useState(0);
  const [auditResult, setAuditResult] = useState<"all" | "success" | "failure" | "denied">("all");
  const [auditAction, setAuditAction] = useState("all");
  const [auditActor, setAuditActor] = useState<"all" | "user" | "system">("all");
  const [auditQuery, setAuditQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const pageSize = 10;

  // 关键词搜索做 350ms 防抖：敲键不立即触发服务端查询，避免审计接口被打满；防抖后回到第一页。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(auditQuery.trim());
      setAuditPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [auditQuery]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setAuditLoading(true);
      const result = await fetchAuditLogs({
        action: auditAction === "all" ? undefined : auditAction,
        actorType: auditActor === "all" ? undefined : auditActor,
        result: auditResult === "all" ? undefined : auditResult,
        q: debouncedQuery || undefined,
        page: auditPage,
        pageSize,
      });
      if (cancelled) return;
      if (result.ok) {
        setLogs(result.data.list);
        setAuditTotal(result.data.total);
        setAuditTotalPages(result.data.total_pages);
        setAuditError(null);
      } else if (result.status === 401 || result.code === "password_change_required") {
        onAuthExpired();
      } else if (result.status === 403) {
        setAuditError("无权限访问该数据");
      } else {
        setAuditError("加载失败，请稍后重试");
      }
    })().finally(() => {
      if (!cancelled) setAuditLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [auditPage, auditResult, auditAction, auditActor, debouncedQuery, onAuthExpired]);

  const firstShown = logs.length === 0 ? 0 : (auditPage - 1) * pageSize + 1;
  const lastShown = logs.length === 0 ? 0 : (auditPage - 1) * pageSize + logs.length;

  function jumpToAuditPage() {
    const page = Number.parseInt(jumpValue, 10);
    if (Number.isFinite(page) && page >= 1 && page <= auditTotalPages) setAuditPage(page);
    setJumpValue("");
  }

  return (
    <>
      <PageIntro eyebrow="安全与可追踪性" title="操作审计记录" description="查看管理操作、审批、同步和数据访问记录；现有记录不可修改，仅保留任务按策略清理。" action="导出审计记录" />
      <section className="jobs-card">
        <div className="card-header">
          <div><h2>审计事件</h2><span>{auditLoading ? "加载中…" : `共 ${auditTotal} 条 · 写入时已按动作白名单收敛，不含敏感正文`}</span></div>
          <span className="immutable-label">▣ 追加写保护</span>
        </div>
        <div className="category-tabs" role="tablist" aria-label="审计结果">
          {([
            ["all", "全部"],
            ["success", "成功"],
            ["failure", "失败"],
            ["denied", "已拒绝"],
          ] as Array<["all" | "success" | "failure" | "denied", string]>).map(([value, label]) => (
            <button key={value} role="tab" aria-selected={auditResult === value} className={auditResult === value ? "active" : ""} onClick={() => { setAuditResult(value); setAuditPage(1); }}>{label}</button>
          ))}
        </div>
        <div className="table-tools">
          <label className="table-search"><span>⌕</span><input value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="搜索操作人 / 关联 ID / 事件" /></label>
          <div className="filter-dropdown-wrap">
            <button className={`filter-button ${filterOpen ? "active" : ""}`} aria-expanded={filterOpen} aria-haspopup="menu" onClick={() => setFilterOpen((open) => !open)}>≡ 筛选{filterOpen ? " ⌃" : " ⌄"}</button>
            {filterOpen && (
              <div className="filter-panel" role="menu" aria-label="审计筛选">
                <div className="filter-field"><span>事件类型</span><select value={auditAction} onChange={(event) => { setAuditAction(event.target.value); setAuditPage(1); }}><option value="all">全部</option>{AUDIT_ACTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
                <div className="filter-field"><span>操作人</span><select value={auditActor} onChange={(event) => { setAuditActor(event.target.value as "all" | "user" | "system"); setAuditPage(1); }}><option value="all">全部</option><option value="user">运营用户</option><option value="system">系统任务</option></select></div>
                <p className="filter-panel-note">筛选即时生效并回到第一页；关键词匹配事件、操作人或关联 ID。</p>
              </div>
            )}
          </div>
        </div>
        <div className="table-wrap audit-wrap">
          <table>
            <thead><tr><th>时间 / 事件</th><th>操作人</th><th>对象</th><th>结果</th><th>关联 ID</th><th>来源 IP</th></tr></thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td><strong>{AUDIT_ACTION_VIEW[log.action] ?? log.action}</strong><small>{formatDateTime(log.occurredAt)}</small></td>
                  <td><span>{AUDIT_ACTOR_VIEW[log.actorType] ?? log.actorType}</span></td>
                  <td><span>{log.resourceType ? `${AUDIT_RESOURCE_VIEW[log.resourceType] ?? log.resourceType}${log.resourceId ? " · " + log.resourceId.slice(0, 8) : ""}` : "—"}</span></td>
                  <td><em className={`status-tag ${AUDIT_RESULT_VIEW[log.result]?.className ?? ""}`}>{AUDIT_RESULT_VIEW[log.result]?.label ?? log.result}</em></td>
                  <td><code>{log.requestId ? log.requestId.slice(0, 8) : "—"}</code></td>
                  <td><code>{log.ipAddress ?? "—"}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {auditLoading ? (
            <div className="empty-state">正在加载审计记录…</div>
          ) : auditError ? (
            <div className="empty-state">{auditError}</div>
          ) : (
            logs.length === 0 && <div className="empty-state">没有符合当前筛选条件的审计记录</div>
          )}
        </div>
        <div className="table-footer">
          <span>{auditLoading ? "加载中…" : logs.length === 0 ? "显示 0 条" : `显示 ${firstShown}–${lastShown} 条，共 ${auditTotal} 条`}</span>
          <div>
            <button disabled={auditPage <= 1} onClick={() => setAuditPage(Math.max(1, auditPage - 1))} aria-label="上一页">‹</button>
            {pageItems(auditPage, auditTotalPages).map((item, index) =>
              item === "…" ? (
                <span key={`gap-${index}`} className="page-gap">…</span>
              ) : (
                <button key={item} className={item === auditPage ? "active" : ""} onClick={() => setAuditPage(item)}>{item}</button>
              ),
            )}
            <button disabled={auditTotalPages <= auditPage} onClick={() => setAuditPage(auditPage + 1)} aria-label="下一页">›</button>
            <div className="page-jump">
              <input type="text" inputMode="numeric" value={jumpValue} onChange={(event) => setJumpValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") jumpToAuditPage(); }} aria-label="跳转到指定页" placeholder="页码" />
              <span>/ {auditTotalPages} 页</span>
              <button type="button" onClick={jumpToAuditPage} disabled={!jumpValue}>GO</button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function PrototypePage({
  page,
  onAuthExpired,
  onSync,
  syncState,
}: {
  page: Exclude<PageId, "jobs">;
  onAuthExpired: () => void;
  onSync: () => void;
  syncState: SyncTriggerState;
}) {
  if (page === "matching") return <MatchingPage onAuthExpired={onAuthExpired} />;
  if (page === "candidates") return <CandidatesPage onAuthExpired={onAuthExpired} />;
  if (page === "campaigns") return <CampaignsPage />;
  if (page === "followups") return <FollowupsPage />;
  if (page === "funnel") return <FunnelPage />;
  if (page === "sources")
    return <SourcesPage onAuthExpired={onAuthExpired} onSync={onSync} syncState={syncState} />;
  return <AuditPage onAuthExpired={onAuthExpired} />;
}

export function OperationsDashboard({ initialView = "login" }: { initialView?: "login" | "app" } = {}) {
  const [view, setView] = useState<"login" | "app">(initialView);
  const [user, setUser] = useState<AuthUser>({ name: "林然", role: "招聘运营" });
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const [activePage, setActivePage] = useState<PageId>("jobs");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [jobPage, setJobPage] = useState(1);
  const [jumpValue, setJumpValue] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [dormantJobs, setDormantJobs] = useState<DormantJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [latestSyncAt, setLatestSyncAt] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // 会话核实：会话 Cookie 为 HttpOnly，JS 无法探测，因此无条件调 /api/auth/me。
  // SSR 已按 Cookie 存在性渲染视图；这里用 me 确认真实会话与用户，
  // 过期/撤销/禁用返回 401 时退回登录页。
  useEffect(() => {
    let cancelled = false;
    void meRequest().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        if (result.data.passwordChangeRequired) {
          // 会话仍带强制改密标记（绕过首登改密的存量会话）：退回登录，
          // 重新登录时会进入设置新口令步骤。
          setView("login");
          return;
        }
        setUser(toAuthUser(result.data));
        setView("app");
      } else {
        setView("login");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 会话中途失效/改密未完成的统一回落：退回登录页（重新登录后按需进入改密步骤）。
  // useCallback 保证身份稳定，子页面效果可作为依赖而不会反复重建。
  const handleAuthExpired = useCallback(() => {
    setUser({ name: "林然", role: "招聘运营" });
    setView("login");
  }, []);

  // 手动同步触发状态：入队 async_tasks 任务即返回（202 + taskId），调度 tick 异步执行。
  // 去重：服务端保证同 kind 至多一个活跃任务，重复点击返回 deduplicated:true + 既有任务 id。
  const [syncState, setSyncState] = useState<SyncTriggerState>("idle");
  const [syncResult, setSyncResult] = useState<string | null>(null);
  // 触发基线：触发瞬间的最新 under_served 批次 id；调度器认领执行后出现的新批次即本次触发的进度。
  // "__skip__" 表示跳过基线抑制（去重场景直接展示活跃任务当前批次状态）。
  const syncPollRef = useRef<{ baselineRunId: string }>({ baselineRunId: "none" });
  // 同步结果刷新信号：触发 reloadSeq 重跑业务数据加载 effect，同步完成后自动刷新列表。
  const [reloadSeq, setReloadSeq] = useState(0);

  const handleSync = useCallback(async () => {
    if (syncState === "triggering" || syncState === "queued" || syncState === "syncing") return;
    setSyncState("triggering");
    setSyncResult(null);
    const result = await triggerSync();
    if (result.ok) {
      const deduplicated = result.data?.deduplicated === true;
      setSyncResult(deduplicated ? "已有同步任务在执行中，正在跟踪进度" : null);
      // 触发后立即取一次基线：记录当前最新 under_served 批次 id，之后的新批次即本次进度。
      const baseline = await fetchSyncRuns({ pageSize: 20 });
      const newest = baseline.ok
        ? baseline.data.list.find((run) => run.syncType === "under_served_jobs") ?? null
        : null;
      syncPollRef.current.baselineRunId = deduplicated ? "__skip__" : newest?.id ?? "none";
      setSyncState(deduplicated ? "syncing" : "queued");
    } else if (result.status === 401 || result.code === "password_change_required") {
      setSyncState("idle");
      handleAuthExpired();
    } else {
      setSyncState("failed");
      setSyncResult("同步触发失败，请重试");
    }
  }, [syncState, handleAuthExpired]);

  // 同步状态轮询：仅活跃窗口（queued/syncing）内每 10s 读一次 /api/sync-runs，
  // 跟踪 under_served 批次状态（sync_runs 原地更新：running → succeeded/failed）。
  // 终态（succeeded/failed）→ 停止轮询、显示结果文本、触发 reloadSeq 自动刷新列表。
  useEffect(() => {
    if (view !== "app") return;
    const active = syncState === "queued" || syncState === "syncing";
    if (!active) return;
    const poll = async () => {
      const result = await fetchSyncRuns({ pageSize: 20 });
      if (!result.ok) {
        if (result.status === 401 || result.code === "password_change_required") {
          handleAuthExpired();
        }
        return;
      }
      const newest =
        result.data.list.find((run) => run.syncType === "under_served_jobs") ?? null;
      const baseline = syncPollRef.current.baselineRunId;
      // 尚未出现新批次（等待调度 tick 认领）；去重场景跳过基线抑制，直接看最新批次。
      if (baseline !== "__skip__" && (!newest || newest.id === baseline)) {
        setSyncState("queued");
        return;
      }
      if (newest && (newest.status === "running" || newest.status === "pending")) {
        setSyncState("syncing");
        return;
      }
      if (!newest) {
        setSyncState("queued");
        return;
      }
      // 终态：显示结果并触发列表刷新（reloadSeq 重跑业务数据加载 effect）。
      if (newest.status === "succeeded") {
        setSyncResult(`同步完成：${newest.stats?.persisted ?? 0} 个职位`);
        setSyncState("succeeded");
      } else {
        setSyncResult(`同步失败：${newest.errorCode ?? newest.status}`);
        setSyncState("failed");
      }
      setReloadSeq((seq) => seq + 1);
    };
    void poll();
    const timer = setInterval(() => void poll(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [view, syncState, handleAuthExpired]);

  // 客户端会话心跳：服务端空闲窗口仅在 API 请求时刷新，前端无轮询则静默 30 分钟掉线。
  // tab 开着（view=app）时每 5 分钟静默调 /api/auth/me 续期；会话真正失效（401）时回落登录。
  useEffect(() => {
    if (view !== "app") return;
    const timer = setInterval(() => {
      void meRequest().then((result) => {
        if (!result.ok && (result.status === 401 || result.code === "password_change_required")) {
          handleAuthExpired();
        }
      });
    }, SESSION_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [view, handleAuthExpired]);

  // 业务数据加载：SSR 阶段无数据库，进入工作台后客户端拉取。
  // 401（会话中途失效）与 password_change_required 统一退回登录页；
  // 403 显示明确的无权限文案，其余失败为通用重试文案。
  // 分页拉取设置页数上限（防异常数据无限拉全量撑爆内存），卸载时 AbortController 中断在途请求。
  useEffect(() => {
    if (view !== "app") return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const collected: DormantJob[] = [];
      let page = 1;
      const pageSize = 100;
      const maxPages = 50;
      for (;;) {
        const result = await fetchDormantJobs({ page, pageSize, signal: controller.signal });
        if (cancelled) return;
        if (!result.ok) {
          if (result.status === 401 || result.code === "password_change_required") {
            handleAuthExpired();
          } else if (result.status === 403) {
            setJobsError("无权限访问该数据");
          } else {
            setJobsError("加载失败，请稍后重试");
          }
          return;
        }
        collected.push(...result.data.list);
        if (
          collected.length >= result.data.total ||
          result.data.list.length === 0 ||
          page >= maxPages
        ) {
          break;
        }
        page += 1;
      }
      setDormantJobs(collected);
      setSelectedId((current) => current ?? collected[0]?.id ?? null);
      const latest = await fetchSyncRuns({ pageSize: 1 });
      if (cancelled) return;
      if (latest.ok) {
        setLatestSyncAt(latest.data.list[0]?.startedAt ?? null);
      } else if (latest.status === 401 || latest.code === "password_change_required") {
        handleAuthExpired();
      }
    })().finally(() => {
      if (!cancelled) setJobsLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // reloadSeq：同步完成后自动刷新列表（触发同步的 effect 在终态时 bump 一次）。
  }, [view, handleAuthExpired, reloadSeq]);

  async function handleLogout() {
    setMenuOpen(false);
    await logoutRequest();
    setUser({ name: "林然", role: "招聘运营" });
    setView("login");
  }

  // 视图切换时同步浏览器标签标题（客户端侧登录/登出不触发 SSR title）。
  useEffect(() => {
    document.title =
      view === "app" ? "沉睡职位巡检｜职位激活台" : "登录｜职位激活台";
  }, [view]);

  const sleepingJobs = useMemo(
    () => dormantJobs.filter((job) => isUnderServedJob(job)),
    [dormantJobs],
  );

  // 每个粗桶 tab 的计数：按映射后的粗桶统计沉睡职位数（与「全部」tab 同口径）。
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const job of sleepingJobs) {
      const bucket = jobCoarseBucket(job.category, job.title);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    return counts;
  }, [sleepingJobs]);

  const filteredJobs = sleepingJobs.filter((job) => {
    const bucket = jobCoarseBucket(job.category, job.title);
    const categoryMatches =
      activeCategory === "全部" || bucket === activeCategory;
    const queryMatches =
      query.trim() === "" ||
      `${job.title}${job.city}${job.category}${bucket}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    return categoryMatches && queryMatches;
  });

  const filteredTotal = filteredJobs.length;
  const jobTotalPages = Math.max(1, Math.ceil(filteredTotal / JOB_PAGE_SIZE));
  const currentJobPage = Math.min(jobPage, jobTotalPages);
  const pageJobs = filteredJobs.slice(
    (currentJobPage - 1) * JOB_PAGE_SIZE,
    currentJobPage * JOB_PAGE_SIZE,
  );

  // 跳页：输入页码直接到达（超界收敛到首/末页），跳完清空输入。
  function jumpToPage() {
    const page = Number.parseInt(jumpValue, 10);
    if (!Number.isNaN(page) && page >= 1) {
      setJobPage(Math.min(page, jobTotalPages));
    }
    setJumpValue("");
  }

  // 右侧面板选中职位：行点击仅更新选中态；完整 JD 见独立详情页 /jobs/[id]（标题/› 跳转）。
  const selectedJob =
    sleepingJobs.find((job) => job.id === selectedId) ?? sleepingJobs[0];
  const publicJob = selectedJob ? toPublicJobView(selectedJob) : null;

  if (view === "login") {
    return (
      <LoginPage
        onLogin={(nextUser) => {
          setUser(nextUser);
          setMenuOpen(false);
          setDormantJobs([]);
          setSelectedId(null);
          setLatestSyncAt(null);
          setJobsLoading(true);
          setView("app");
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">职</span>
          <div>
            <strong>职位激活台</strong>
            <span>Recruit Ops</span>
          </div>
        </div>

        <nav className="nav" aria-label="主导航">
          <span className="nav-label">工作台</span>
          <button className={`nav-item ${activePage === "jobs" ? "active" : ""}`} onClick={() => setActivePage("jobs")}><span>⌁</span>沉睡职位<i>{sleepingJobs.length}</i></button>
          <button className={`nav-item ${activePage === "matching" ? "active" : ""}`} onClick={() => setActivePage("matching")}><span>◎</span>智能匹配<i>28</i></button>
          <button className={`nav-item ${activePage === "campaigns" ? "active" : ""}`} onClick={() => setActivePage("campaigns")}><span>↗</span>触达活动</button>
          <button className={`nav-item ${activePage === "followups" ? "active" : ""}`} onClick={() => setActivePage("followups")}><span>◇</span>跟进任务<i className="warning">12</i></button>
          <span className="nav-label secondary">数据与配置</span>
          <button className={`nav-item ${activePage === "funnel" ? "active" : ""}`} onClick={() => setActivePage("funnel")}><span>⌗</span>转化漏斗</button>
          <button className={`nav-item ${activePage === "sources" ? "active" : ""}`} onClick={() => setActivePage("sources")}><span>⌘</span>数据源</button>
          <button className={`nav-item ${activePage === "candidates" ? "active" : ""}`} onClick={() => setActivePage("candidates")}><span>◈</span>候选人</button>
          <button className={`nav-item ${activePage === "audit" ? "active" : ""}`} onClick={() => setActivePage("audit")}><span>▣</span>审计日志</button>
        </nav>

        <div className="sidebar-footer">
          <div className="source-status"><span />MCP 数据源已连接</div>
          <div className="profile">
            {menuOpen && (
              <div className="profile-menu" role="menu" aria-label="用户菜单">
                <button onClick={() => void handleLogout()}>⏻ 退出登录</button>
              </div>
            )}
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div><strong>{user.name}</strong><small>{user.role}</small></div>
            <button aria-label="打开用户菜单" onClick={() => setMenuOpen((open) => !open)}>•••</button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="crumb"><span>运营工作台</span><b>/</b>{pageLabels[activePage]}</div>
          <div className="topbar-actions">
            <label className="global-search">
              <span aria-hidden="true">⌕</span>
              <input aria-label="全局搜索" placeholder="搜索职位、人选或活动" />
              <kbd>⌘ K</kbd>
            </label>
            <button className="icon-button" aria-label="通知">◌<i /></button>
            <button className="help-button" aria-label="帮助">?</button>
          </div>
        </header>

        <div className="page-wrap">
          {activePage === "jobs" ? <>
          <section className="page-heading" id="jobs">
            <div>
              <span className="eyebrow"><i />每日职位巡检</span>
              <h1>让沉睡的职位，重新流动起来。</h1>
              <p>系统自动同步、补全职位并增量匹配；这里用于查看数据状态和处理异常。</p>
            </div>
            <div className="heading-actions">
              <span className="last-sync">最近同步：<strong>{formatDateTime(latestSyncAt)}</strong></span>
              {syncState === "queued" && (
                <span className={`sync-live ${syncResult ? "warn" : ""}`}>
                  ● {syncResult ?? "已入队，等待调度执行（最长约 15 分钟）"}
                </span>
              )}
              {syncState === "syncing" && (
                <span className={`sync-live ${syncResult ? "warn" : ""}`}>
                  ● {syncResult ?? "同步中…"}
                </span>
              )}
              {syncState === "succeeded" && (
                <span className="sync-live ok">✓ {syncResult ?? "同步完成"}</span>
              )}
              {syncState === "failed" && (
                <span className="sync-live fail">✕ {syncResult ?? "同步失败"}</span>
              )}
            </div>
          </section>

          <section className="metric-grid" aria-label="职位巡检概况">
            <article className="metric-card feature">
              <div><span className="metric-icon blue">⌁</span><span className="trend up">↑ 12%</span></div>
              <small>沉睡职位</small><strong>{dormantJobs.length}</strong><p>较上周新增 5 个</p>
            </article>
            <article className="metric-card">
              <div><span className="metric-icon violet">◎</span><span className="trend">本周</span></div>
              <small>待审核匹配</small><strong>28</strong><p>其中高匹配 7 人</p>
            </article>
            <article className="metric-card">
              <div><span className="metric-icon amber">↗</span><span className="trend up">↑ 8.4%</span></div>
              <small>近 7 天触达</small><strong>286</strong><p>送达率 96.2%</p>
            </article>
            <article className="metric-card">
              <div><span className="metric-icon green">✓</span><span className="trend up">↑ 3.1%</span></div>
              <small>意向候选人</small><strong>19</strong><p>等待人工跟进 12 人</p>
            </article>
          </section>

          <section className="workspace-grid">
            <div className="jobs-card">
              <div className="card-header">
                <div><h2>沉睡职位</h2><span>只展示满足巡检规则的有效职位</span></div>
                <button className="more-button" aria-label="更多操作">•••</button>
              </div>

              <div className="category-tabs" role="tablist" aria-label="职位类别">
                {categories.map((category) => (
                  <button
                    key={category}
                    role="tab"
                    aria-selected={activeCategory === category}
                    className={activeCategory === category ? "active" : ""}
                    onClick={() => { setActiveCategory(category); setJobPage(1); }}
                  >
                    {category}
                    {category === "全部"
                      ? <span>{sleepingJobs.length}</span>
                      : <span>{categoryCounts[category] ?? 0}</span>}
                  </button>
                ))}
              </div>

              <div className="table-tools">
                <label className="table-search"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setJobPage(1); }} placeholder="搜索职位名称或城市" /></label>
                <div className="filter-dropdown-wrap">
                  <button
                    className={`filter-button ${filterOpen ? "active" : ""}`}
                    aria-expanded={filterOpen}
                    aria-haspopup="menu"
                    onClick={() => setFilterOpen((open) => !open)}
                  >
                    ≡ 筛选{filterOpen ? " ⌃" : " ⌄"}
                  </button>
                  {filterOpen && (
                    <div className="filter-panel" role="menu" aria-label="职位筛选">
                      <div className="filter-field">
                        <span>发布时间</span>
                        <strong>7–30 天</strong>
                      </div>
                      <div className="filter-field">
                        <span>负责人</span>
                        <strong>全部</strong>
                      </div>
                      <p className="filter-panel-note">发布时间与负责人筛选待数据源补齐后开放。</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead><tr><th>运行状态</th><th>职位</th><th>类别 / 地点</th><th>沉睡时长</th><th>匹配结果</th><th>最近运行</th><th /></tr></thead>
                  <tbody>
                    {pageJobs.map((job) => (
                      <tr key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => setSelectedId(job.id)}>
                        <td><span className={`job-run-state ${job.hasDescription ? "queued" : "blocked"}`}><i />{job.hasDescription ? "自动排队" : "待补详情"}</span></td>
                        <td><button className="job-detail-link" onClick={(event) => { event.stopPropagation(); router.push(`/jobs/${job.id}`); }}>{job.title}</button><small className="job-updated"><span className="job-external-id" title={job.externalId}>{job.externalId}</span><span className="job-updated-at"> · 更新于 {formatDateTime(job.updatedAt)}</span></small></td>
                        <td><span>{jobCoarseBucket(job.category, job.title)}</span><small>{job.city}</small></td>
                        <td><span className={`days ${job.ageDays >= 27 ? "urgent" : ""}`}>{job.ageDays} 天</span></td>
                        <td><strong>{job.hasDescription ? "等待评分" : "尚未生成"}</strong><small>{job.hasDescription ? "输入变化后自动运行" : "补全 JD 后自动继续"}</small></td>
                        <td><span>{job.hasDescription ? "排队中" : "—"}</span><small>{job.hasDescription ? "无需人工触发" : "等待数据"}</small></td>
                        <td><button aria-label={`查看 ${job.title}`} onClick={(event) => { event.stopPropagation(); router.push(`/jobs/${job.id}`); }}>›</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {jobsLoading ? (
                  <div className="empty-state">正在加载职位…</div>
                ) : jobsError ? (
                  <div className="empty-state">{jobsError}</div>
                ) : (
                  filteredJobs.length === 0 && <div className="empty-state">没有符合当前条件的职位</div>
                )}
              </div>

              <div className="table-footer">
                <span>{filteredTotal === 0 ? "显示 0 条" : `显示 ${(currentJobPage - 1) * JOB_PAGE_SIZE + 1}–${Math.min(currentJobPage * JOB_PAGE_SIZE, filteredTotal)} 条，共 ${filteredTotal} 条匹配`}</span>
                <div>
                  <button disabled={currentJobPage <= 1} onClick={() => setJobPage(currentJobPage - 1)} aria-label="上一页">‹</button>
                  {pageItems(currentJobPage, jobTotalPages).map((item, index) =>
                    item === "…" ? (
                      <span key={`gap-${index}`} className="page-gap">…</span>
                    ) : (
                      <button key={item} className={item === currentJobPage ? "active" : ""} onClick={() => setJobPage(item)}>{item}</button>
                    ),
                  )}
                  <button disabled={currentJobPage >= jobTotalPages} onClick={() => setJobPage(currentJobPage + 1)} aria-label="下一页">›</button>
                  <div className="page-jump">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={jumpValue}
                      onChange={(event) => setJumpValue(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") jumpToPage(); }}
                      aria-label="跳转到指定页"
                      placeholder="页码"
                    />
                    <span>/ {jobTotalPages} 页</span>
                    <button type="button" onClick={jumpToPage} disabled={!jumpValue}>GO</button>
                  </div>
                </div>
              </div>
            </div>

            <aside className="insight-panel" aria-label="当前职位匹配与公开预览">
              {selectedJob ? (
                <>
                  <div className="panel-heading">
                    <span className="role-icon">{selectedJob.title.slice(0, 1)}</span>
                    <div><span className="status-pill"><i />待激活</span><h2>{selectedJob.title}</h2><p>{jobCoarseBucket(selectedJob.category, selectedJob.title)} · {selectedJob.city}</p></div>
                  </div>

                  <div className="sleeping-alert"><span>!</span><div><strong>已沉睡 {selectedJob.ageDays} 天</strong><p>距 30 天观察上限还有 {30 - selectedJob.ageDays} 天</p></div></div>

                  <div className="panel-section">
                    <div className="section-title"><h3>自动匹配状态</h3><button onClick={() => setActivePage("matching")}>查看审核队列</button></div>
                    <div className="score-summary">
                      <div className="score-ring"><strong>{selectedJob.hasDescription ? "队列" : "阻塞"}</strong><span>{selectedJob.hasDescription ? "等待运行" : "缺少 JD"}</span></div>
                      <p className="muted-note">{selectedJob.hasDescription ? "职位输入准备完成，系统将在预算窗口内自动生成匹配结果。" : "补全职位详情后，系统会自动恢复后续匹配流程。"}</p>
                    </div>
                  </div>

                  <div className="panel-section">
                    <div className="section-title"><h3>候选人看到的内容</h3><span className="safe-label">✓ 已脱敏</span></div>
                    <div className="public-preview-card">
                      <small>职位公开预览</small>
                      <strong>{publicJob?.title}</strong>
                      <div><span>⌖ {publicJob?.city}</span><span>¥ {publicJob?.salaryRange}</span></div>
                      <p>{publicJob?.companyLabel} · 公司名称已隐藏</p>
                      <button onClick={() => setPreviewOpen(true)}>预览候选人落地页 <span>↗</span></button>
                    </div>
                  </div>

                  <div className="panel-note"><span>i</span><p>完整 JD 已迁移到独立详情页 /jobs/[id]；正常匹配无需人工创建任务，职位、候选人或规则版本变化时系统自动增量重算。</p></div>
                </>
              ) : (
                <>
                  <div className="panel-heading">
                    <span className="role-icon">—</span>
                    <div><span className="status-pill"><i />待激活</span><h2>未选择职位</h2><p>加载后自动选中首个职位</p></div>
                  </div>
                  <div className="panel-section">
                    <div className="section-title"><h3>候选人看到的内容</h3><span className="safe-label">✓ 已脱敏</span></div>
                  </div>
                </>
              )}
            </aside>
          </section>
          </> : <PrototypePage page={activePage} onAuthExpired={handleAuthExpired} onSync={() => void handleSync()} syncState={syncState} />}
        </div>
      </main>

      {previewOpen && publicJob && (
        <div className="modal-backdrop" role="presentation">
          <button className="modal-dismiss" onClick={() => setPreviewOpen(false)} aria-label="关闭候选人落地页预览" />
          <section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="preview-toolbar"><span>候选人视角 · 脱敏预览</span><button onClick={() => setPreviewOpen(false)} aria-label="关闭预览">×</button></div>
            <div className="candidate-page">
              <span className="opportunity-label">为你精选的职业机会</span>
              <h2 id="preview-title">{publicJob.title}</h2>
              <div className="candidate-meta"><span>⌖ {publicJob.city}</span><span>¥ {publicJob.salaryRange}</span><span>某科技企业</span></div>
              <div className="candidate-divider" />
              <h3>这份机会与你的经历很契合</h3>
              <p>该岗位关注复杂业务场景下的产品研发能力，期待你有成熟项目经验，并能够与产品及业务团队高效协作。</p>
              <div className="match-reason"><strong>匹配亮点</strong><span>核心技能契合</span><span>同城机会</span><span>经验相符</span></div>
              <div className="candidate-actions"><button className="interested">有兴趣，请联系我</button><button>开放查看</button><button className="text-action">暂不考虑</button></div>
              <small className="privacy-copy">你的选择仅用于本次职位沟通，可随时拒绝后续联系。</small>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

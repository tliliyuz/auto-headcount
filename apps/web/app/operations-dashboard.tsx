"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isUnderServedJob, toPublicJobView } from "@/lib/job-rules.mjs";
import {
  changePasswordRequest,
  loginRequest,
  logoutRequest,
  meRequest,
  type AuthSession,
} from "@/lib/auth-client";

type Job = {
  id: string;
  title: string;
  companyName: string;
  companyAlias: string;
  category: string;
  city: string;
  detailedLocation: string;
  salaryMin: number;
  salaryMax: number;
  salaryUnit: string;
  ageDays: number;
  status: "active" | "paused" | "closed";
  recommendationCount: number;
  matched: number;
  highMatches: number;
  mediumMatches: number;
  owner: string;
  updatedAt: string;
};

const jobs: Job[] = [
  {
    id: "JOB-0821",
    title: "资深前端工程师",
    companyName: "海岳智能科技有限公司",
    companyAlias: "海岳智能",
    category: "技术研发",
    city: "上海",
    detailedLocation: "浦东新区张江路 88 号",
    salaryMin: 30,
    salaryMax: 45,
    salaryUnit: "K/月",
    ageDays: 12,
    status: "active",
    recommendationCount: 0,
    matched: 48,
    highMatches: 9,
    mediumMatches: 21,
    owner: "林然",
    updatedAt: "14:18",
  },
  {
    id: "JOB-0814",
    title: "AI 产品经理",
    companyName: "澄明数据技术有限公司",
    companyAlias: "澄明数据",
    category: "产品设计",
    city: "北京",
    detailedLocation: "海淀区中关村东路 1 号",
    salaryMin: 28,
    salaryMax: 42,
    salaryUnit: "K/月",
    ageDays: 18,
    status: "active",
    recommendationCount: 0,
    matched: 36,
    highMatches: 6,
    mediumMatches: 17,
    owner: "徐安",
    updatedAt: "13:42",
  },
  {
    id: "JOB-0809",
    title: "海外市场负责人",
    companyName: "星海消费科技有限公司",
    companyAlias: "星海科技",
    category: "市场销售",
    city: "深圳",
    detailedLocation: "南山区科技园南区",
    salaryMin: 35,
    salaryMax: 55,
    salaryUnit: "K/月",
    ageDays: 22,
    status: "active",
    recommendationCount: 0,
    matched: 27,
    highMatches: 4,
    mediumMatches: 13,
    owner: "周屿",
    updatedAt: "12:56",
  },
  {
    id: "JOB-0802",
    title: "高级数据分析师",
    companyName: "北辰零售科技有限公司",
    companyAlias: "北辰零售",
    category: "数据智能",
    city: "杭州",
    detailedLocation: "余杭区文一西路 998 号",
    salaryMin: 25,
    salaryMax: 38,
    salaryUnit: "K/月",
    ageDays: 27,
    status: "active",
    recommendationCount: 0,
    matched: 41,
    highMatches: 7,
    mediumMatches: 19,
    owner: "林然",
    updatedAt: "11:30",
  },
  {
    id: "JOB-0796",
    title: "供应链解决方案顾问",
    companyName: "云帆企业服务有限公司",
    companyAlias: "云帆企服",
    category: "咨询服务",
    city: "广州",
    detailedLocation: "天河区珠江新城",
    salaryMin: 22,
    salaryMax: 35,
    salaryUnit: "K/月",
    ageDays: 30,
    status: "active",
    recommendationCount: 0,
    matched: 19,
    highMatches: 2,
    mediumMatches: 8,
    owner: "徐安",
    updatedAt: "10:24",
  },
  {
    id: "JOB-0792",
    title: "招聘运营专家",
    companyName: "青山人力资源有限公司",
    companyAlias: "青山人才",
    category: "职能支持",
    city: "成都",
    detailedLocation: "高新区天府三街",
    salaryMin: 18,
    salaryMax: 28,
    salaryUnit: "K/月",
    ageDays: 8,
    status: "active",
    recommendationCount: 0,
    matched: 32,
    highMatches: 5,
    mediumMatches: 15,
    owner: "周屿",
    updatedAt: "09:48",
  },
];

const categories = ["全部", "技术研发", "产品设计", "市场销售", "数据智能"];

type PageId = "jobs" | "matching" | "campaigns" | "followups" | "funnel" | "sources" | "audit";

const pageLabels: Record<PageId, string> = {
  jobs: "沉睡职位巡检",
  matching: "智能匹配",
  campaigns: "触达活动",
  followups: "跟进任务",
  funnel: "转化漏斗",
  sources: "数据源",
  audit: "审计日志",
};

const candidates = [
  { id: "C-2048", name: "周先生", role: "高级前端工程师", city: "上海", score: 94, years: "8 年经验", education: "本科", status: "待审核", tags: ["React", "TypeScript", "复杂系统"] },
  { id: "C-2017", name: "陈女士", role: "前端技术专家", city: "上海", score: 89, years: "7 年经验", education: "硕士", status: "待审核", tags: ["工程化", "Node.js", "团队管理"] },
  { id: "C-1982", name: "林先生", role: "资深全栈工程师", city: "杭州", score: 86, years: "9 年经验", education: "本科", status: "待审核", tags: ["React", "可视化", "B 端产品"] },
  { id: "C-1961", name: "许女士", role: "高级前端开发", city: "上海", score: 82, years: "6 年经验", education: "本科", status: "需关注", tags: ["Vue", "TypeScript", "跨端"] },
];

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

function MatchingPage() {
  const [selected, setSelected] = useState(candidates[0].id);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const candidate = candidates.find((item) => item.id === selected) ?? candidates[0];
  const decision = decisions[candidate.id];

  return <>
    <PageIntro eyebrow="匹配结果需要人工确认" title="匹配审核队列" description="逐条核对匹配证据、缺失项和风险提示，通过后才可进入触达活动。" action="批量审核" />
    <SummaryStrip items={[
      { label: "待审核", value: "128", note: "23 个高匹配", tone: "violet" },
      { label: "今日已通过", value: "36", note: "通过率 71%", tone: "green" },
      { label: "需补充信息", value: "9", note: "等待运营处理", tone: "amber" },
      { label: "规则版本", value: "v1.4", note: "今天 09:00 生效" },
    ]} />
    <section className="review-layout">
      <div className="surface-card review-list">
        <div className="surface-header"><div><h2>资深前端工程师</h2><p>JOB-0821 · 共 48 位匹配候选人</p></div><button className="plain-filter">匹配度：从高到低⌄</button></div>
        <div className="segmented"><button className="active">全部 48</button><button>高匹配 9</button><button>中匹配 21</button><button>已处理 18</button></div>
        <div className="candidate-list">
          {candidates.map((item) => <button key={item.id} className={`candidate-row ${selected === item.id ? "active" : ""}`} onClick={() => setSelected(item.id)}>
            <span className="candidate-avatar">{item.name.slice(0, 1)}</span>
            <span className="candidate-main"><strong>{item.name}<i>{decisions[item.id] ?? item.status}</i></strong><small>{item.role} · {item.city} · {item.years}</small><em>{item.tags.map((tag) => <b key={tag}>{tag}</b>)}</em></span>
            <span className={`match-score ${item.score >= 85 ? "high" : "medium"}`}><strong>{item.score}</strong><small>匹配分</small></span>
          </button>)}
        </div>
      </div>
      <aside className="surface-card candidate-detail">
        <div className="detail-head"><span className="candidate-avatar large">{candidate.name.slice(0, 1)}</span><div><h2>{candidate.name}</h2><p>{candidate.role} · {candidate.city}</p></div><span className="score-badge">{candidate.score} 分</span></div>
        {decision && <div className={`decision-banner ${decision === "已通过" ? "success" : "danger"}`}>当前审核结果：{decision}</div>}
        <div className="detail-section"><h3>匹配证据</h3><ul className="evidence-list positive"><li><b>核心技能</b><span>React 与 TypeScript 项目经历 5 年</span></li><li><b>业务复杂度</b><span>主导过大型 B 端平台重构</span></li><li><b>地点意向</b><span>当前在上海，接受同城机会</span></li></ul></div>
        <div className="detail-section two-cols"><div><h3>缺失项</h3><p className="notice amber">未确认英文沟通频率</p></div><div><h3>风险提示</h3><p className="notice red">期望薪资接近上限</p></div></div>
        <div className="dimension-scores"><h3>维度评分</h3>{[["技能",96],["行业",88],["职级",92],["地点",100],["薪资",78]].map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>)}</div>
        <label className="review-note"><span>审核备注</span><textarea placeholder="填写判断依据或后续关注点（选填）" /></label>
        <div className="review-actions"><button onClick={() => setDecisions((current) => ({ ...current, [candidate.id]: "已拒绝" }))}>拒绝</button><button className="approve" onClick={() => setDecisions((current) => ({ ...current, [candidate.id]: "已通过" }))}>通过并加入触达池</button></div>
      </aside>
    </section>
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

function SourcesPage() {
  const [syncing, setSyncing] = useState(false);
  return <><PageIntro eyebrow="连接与同步状态" title="MCP 职位数据源" description="查看连接健康、字段映射、最近同步批次和异常记录。" action="添加数据源" /><section className="source-grid"><article className="source-card primary-source"><header><span className="source-logo">M</span><div><h2>招聘业务 MCP</h2><p>Streamable HTTP · 只读权限</p></div><em><i />连接正常</em></header><div className="source-meta"><div><small>最近同步</small><strong>今天 14:32</strong></div><div><small>本次入库</small><strong>47 个职位</strong></div><div><small>契约版本</small><strong>2025-11-25</strong></div></div><div className="source-actions"><button className="secondary-button" onClick={() => { setSyncing(true); window.setTimeout(() => setSyncing(false), 900); }}>{syncing ? "同步中…" : "立即同步"}</button><button>查看字段映射</button><button>连接设置</button></div></article><article className="source-card muted-source"><header><span className="source-logo browser">B</span><div><h2>浏览器采集</h2><p>备用数据获取方式</p></div><em className="disabled">当前关闭</em></header><p className="source-description">当前里程碑不启用。仅在 MCP 无法满足已授权数据范围，且完成安全评审后开放。</p><button className="text-link">查看启用条件 →</button></article><button className="add-source"><span>＋</span><strong>连接新的授权数据源</strong><small>支持 MCP 或经审核的导入适配器</small></button></section><section className="source-bottom"><div className="surface-card data-card"><div className="surface-header"><div><h2>最近同步批次</h2><p>原始快照与规范化结果</p></div><button className="plain-filter">查看全部</button></div><div className="data-table sync-table">{[["SYNC-0811-1432","今天 14:32","成功","47","0","1m 24s"],["SYNC-0811-0900","今天 09:00","成功","45","2","1m 18s"],["SYNC-0810-1800","昨天 18:00","部分成功","42","3","2m 07s"],["SYNC-0810-1200","昨天 12:00","成功","44","0","1m 31s"]].map((row) => <div className="data-row" key={row[0]}><span><strong>{row[0]}</strong><small>{row[1]}</small></span><span><em className={`status-tag status-${row[2]}`}>{row[2]}</em></span><span>{row[3]} 条</span><span>{row[4]} 异常</span><span>{row[5]}</span></div>)}</div></div><aside className="surface-card health-panel"><h2>连接健康</h2>{[["鉴权状态","有效","green"],["接口响应","482 ms","green"],["字段契约","无漂移","green"],["候选人能力","未授权","amber"]].map((item) => <div key={item[0]}><span><i className={item[2]} />{item[0]}</span><strong>{item[1]}</strong></div>)}<p>系统仅启用了职位只读白名单工具；短信、邮件和候选人详情调用保持关闭。</p></aside></section></>;
}

function AuditPage() {
  return <><PageIntro eyebrow="安全与可追踪性" title="操作审计记录" description="查看管理操作、审批、同步和数据访问记录；现有记录不可修改。" action="导出审计记录" /><section className="audit-filters surface-card"><label><span>搜索操作人或关联 ID</span><input placeholder="输入关键词" /></label><button>事件类型：全部⌄</button><button>风险等级：全部⌄</button><button>时间：近 7 天⌄</button><button className="secondary-button">筛选</button></section><section className="surface-card data-card audit-card"><div className="surface-header"><div><h2>审计事件</h2><p>共 1,284 条 · 展示脱敏后的最小必要信息</p></div><span className="immutable-label">▣ 追加写保护</span></div><div className="data-table audit-table"><div className="data-row data-head"><span>时间 / 事件</span><span>操作人</span><span>对象</span><span>结果</span><span>关联 ID</span><span>风险</span></div>{[["14:36:22","活动审批通过","徐安","前端高匹配人才激活","成功","REQ-82F1","低"],["14:32:08","职位同步完成","系统任务","招聘业务 MCP","成功","SYNC-1432","低"],["13:48:51","候选人匹配拒绝","林然","C-1961 / JOB-0821","成功","REQ-813A","低"],["12:17:09","数据导出申请","周屿","跟进任务报表","已拒绝","REQ-79CD","中"],["11:42:36","正式推荐登记","徐安","候选人 C-1884","成功","REC-1042","中"],["10:03:14","连接配置查看","管理员","招聘业务 MCP","成功","REQ-772B","高"]].map((row) => <div className="data-row" key={row[5]}><span><strong>{row[1]}</strong><small>今天 {row[0]}</small></span><span>{row[2]}</span><span>{row[3]}</span><span><em className={`status-tag ${row[4] === "成功" ? "status-成功" : "status-已拒绝"}`}>{row[4]}</em></span><span><code>{row[5]}</code></span><span><em className={`risk risk-${row[6]}`}>{row[6]}</em></span></div>)}</div><div className="table-footer"><span>显示 1–6 条，共 1,284 条</span><div><button disabled>‹</button><button className="active">1</button><button>2</button><button>3</button><button>›</button></div></div></section></>;
}

function PrototypePage({ page }: { page: Exclude<PageId, "jobs"> }) {
  if (page === "matching") return <MatchingPage />;
  if (page === "campaigns") return <CampaignsPage />;
  if (page === "followups") return <FollowupsPage />;
  if (page === "funnel") return <FunnelPage />;
  if (page === "sources") return <SourcesPage />;
  return <AuditPage />;
}

export function OperationsDashboard({ initialView = "login" }: { initialView?: "login" | "app" } = {}) {
  const [view, setView] = useState<"login" | "app">(initialView);
  const [user, setUser] = useState<AuthUser>({ name: "林然", role: "招聘运营" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePage, setActivePage] = useState<PageId>("jobs");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(jobs[0].id);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);

  // 会话核实：会话 Cookie 为 HttpOnly，JS 无法探测，因此无条件调 /api/auth/me。
  // SSR 已按 Cookie 存在性渲染视图；这里用 me 确认真实会话与用户，
  // 过期/撤销/禁用返回 401 时退回登录页。
  useEffect(() => {
    let cancelled = false;
    void meRequest().then((result) => {
      if (cancelled) return;
      if (result.ok) {
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
    () => jobs.filter((job) => isUnderServedJob(job)),
    [],
  );

  const filteredJobs = sleepingJobs.filter((job) => {
    const categoryMatches =
      activeCategory === "全部" || job.category === activeCategory;
    const queryMatches =
      query.trim() === "" ||
      `${job.title}${job.city}${job.category}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    return categoryMatches && queryMatches;
  });

  const selectedJob =
    sleepingJobs.find((job) => job.id === selectedId) ?? sleepingJobs[0];
  const publicJob = toPublicJobView(selectedJob);

  function toggleRow(id: string) {
    setSelectedRows((current) =>
      current.includes(id)
        ? current.filter((rowId) => rowId !== id)
        : [...current, id],
    );
  }

  function runSync() {
    setSyncing(true);
    window.setTimeout(() => setSyncing(false), 900);
  }

  if (view === "login") {
    return (
      <LoginPage
        onLogin={(nextUser) => {
          setUser(nextUser);
          setMenuOpen(false);
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
          <button className={`nav-item ${activePage === "jobs" ? "active" : ""}`} onClick={() => setActivePage("jobs")}><span>⌁</span>沉睡职位<i>47</i></button>
          <button className={`nav-item ${activePage === "matching" ? "active" : ""}`} onClick={() => setActivePage("matching")}><span>◎</span>智能匹配<i>128</i></button>
          <button className={`nav-item ${activePage === "campaigns" ? "active" : ""}`} onClick={() => setActivePage("campaigns")}><span>↗</span>触达活动</button>
          <button className={`nav-item ${activePage === "followups" ? "active" : ""}`} onClick={() => setActivePage("followups")}><span>◇</span>跟进任务<i className="warning">12</i></button>
          <span className="nav-label secondary">数据与配置</span>
          <button className={`nav-item ${activePage === "funnel" ? "active" : ""}`} onClick={() => setActivePage("funnel")}><span>⌗</span>转化漏斗</button>
          <button className={`nav-item ${activePage === "sources" ? "active" : ""}`} onClick={() => setActivePage("sources")}><span>⌘</span>数据源</button>
          <button className={`nav-item ${activePage === "audit" ? "active" : ""}`} onClick={() => setActivePage("audit")}><span>▣</span>审计日志</button>
        </nav>

        <div className="sidebar-footer">
          <div className="source-status"><span />MCP 数据源等待联调</div>
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
              <p>已自动筛选发布 7–30 天、仍有效且零推荐的职位，等待运营确认。</p>
            </div>
            <div className="heading-actions">
              <span className="last-sync">最近同步：今天 14:32</span>
              <button className="secondary-button" onClick={runSync} disabled={syncing}>
                <span className={syncing ? "rotating" : ""}>↻</span>
                {syncing ? "同步中" : "同步职位"}
              </button>
              <button className="primary-button" disabled={selectedRows.length === 0}>
                创建匹配任务 {selectedRows.length > 0 && `(${selectedRows.length})`}
              </button>
            </div>
          </section>

          <section className="metric-grid" aria-label="职位巡检概况">
            <article className="metric-card feature">
              <div><span className="metric-icon blue">⌁</span><span className="trend up">↑ 12%</span></div>
              <small>沉睡职位</small><strong>47</strong><p>较上周新增 5 个</p>
            </article>
            <article className="metric-card">
              <div><span className="metric-icon violet">◎</span><span className="trend">本周</span></div>
              <small>待审核匹配</small><strong>128</strong><p>其中高匹配 23 人</p>
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
                    onClick={() => setActiveCategory(category)}
                  >
                    {category}
                    {category === "全部" && <span>{sleepingJobs.length}</span>}
                  </button>
                ))}
              </div>

              <div className="table-tools">
                <label className="table-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索职位名称或城市" /></label>
                <button>发布时间：7–30 天⌄</button>
                <button>负责人：全部⌄</button>
                <button className="filter-button">≡ 筛选</button>
              </div>

              <div className="table-wrap">
                <table>
                  <thead><tr><th><span className="fake-checkbox" /></th><th>职位</th><th>类别 / 地点</th><th>沉睡时长</th><th>匹配池</th><th>负责人</th><th /></tr></thead>
                  <tbody>
                    {filteredJobs.map((job) => (
                      <tr key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => setSelectedId(job.id)}>
                        <td><input aria-label={`选择 ${job.title}`} type="checkbox" checked={selectedRows.includes(job.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleRow(job.id)} /></td>
                        <td><strong>{job.title}</strong><small>{job.id} · 更新于 {job.updatedAt}</small></td>
                        <td><span>{job.category}</span><small>{job.city}</small></td>
                        <td><span className={`days ${job.ageDays >= 27 ? "urgent" : ""}`}>{job.ageDays} 天</span></td>
                        <td><strong>{job.matched}</strong><small><i className="dot high" />高 {job.highMatches} <i className="dot medium" />中 {job.mediumMatches}</small></td>
                        <td><span className="owner-avatar">{job.owner.slice(0, 1)}</span>{job.owner}</td>
                        <td><button aria-label={`查看 ${job.title}`}>›</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredJobs.length === 0 && <div className="empty-state">没有符合当前条件的职位</div>}
              </div>

              <div className="table-footer"><span>显示 {filteredJobs.length} 个，共 {sleepingJobs.length} 个沉睡职位</span><div><button disabled>‹</button><button className="active">1</button><button>2</button><button>3</button><button>›</button></div></div>
            </div>

            <aside className="insight-panel" aria-label="当前职位详情">
              <div className="panel-heading">
                <span className="role-icon">{selectedJob.title.slice(0, 1)}</span>
                <div><span className="status-pill"><i />待激活</span><h2>{selectedJob.title}</h2><p>{selectedJob.category} · {selectedJob.city}</p></div>
              </div>

              <div className="sleeping-alert"><span>!</span><div><strong>已沉睡 {selectedJob.ageDays} 天</strong><p>距 30 天观察上限还有 {30 - selectedJob.ageDays} 天</p></div></div>

              <div className="panel-section">
                <div className="section-title"><h3>候选人匹配池</h3><button>查看全部</button></div>
                <div className="score-summary">
                  <div className="score-ring"><strong>{selectedJob.matched}</strong><span>已匹配</span></div>
                  <div className="score-bars">
                    <div><span><i className="dot high" />高匹配 85+</span><b>{selectedJob.highMatches} 人</b></div>
                    <div className="bar"><i style={{ width: `${Math.max(18, selectedJob.highMatches * 7)}%` }} /></div>
                    <div><span><i className="dot medium" />中匹配 75–84</span><b>{selectedJob.mediumMatches} 人</b></div>
                    <div className="bar medium"><i style={{ width: `${Math.max(28, selectedJob.mediumMatches * 3)}%` }} /></div>
                  </div>
                </div>
              </div>

              <div className="panel-section">
                <div className="section-title"><h3>候选人看到的内容</h3><span className="safe-label">✓ 已脱敏</span></div>
                <div className="public-preview-card">
                  <small>职位公开预览</small>
                  <strong>{publicJob.title}</strong>
                  <div><span>⌖ {publicJob.city}</span><span>¥ {publicJob.salaryRange}</span></div>
                  <p>{publicJob.companyLabel} · 公司名称已隐藏</p>
                  <button onClick={() => setPreviewOpen(true)}>预览候选人落地页 <span>↗</span></button>
                </div>
              </div>

              <div className="panel-note"><span>i</span><p>创建匹配任务前，系统会再次检查职位状态和推荐数。</p></div>
            </aside>
          </section>
          </> : <PrototypePage page={activePage} />}
        </div>
      </main>

      {previewOpen && (
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

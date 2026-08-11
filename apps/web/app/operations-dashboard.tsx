"use client";

import { useMemo, useState } from "react";
import { isUnderServedJob, toPublicJobView } from "@/lib/job-rules.mjs";

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

export function OperationsDashboard() {
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(jobs[0].id);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);

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
          <a className="nav-item active" href="#jobs"><span>⌁</span>沉睡职位<i>47</i></a>
          <a className="nav-item" href="#matching"><span>◎</span>智能匹配<i>128</i></a>
          <a className="nav-item" href="#campaigns"><span>↗</span>触达活动</a>
          <a className="nav-item" href="#followups"><span>◇</span>跟进任务<i className="warning">12</i></a>
          <span className="nav-label secondary">数据与配置</span>
          <a className="nav-item" href="#funnel"><span>⌗</span>转化漏斗</a>
          <a className="nav-item" href="#sources"><span>⌘</span>数据源</a>
          <a className="nav-item" href="#audit"><span>▣</span>审计日志</a>
        </nav>

        <div className="sidebar-footer">
          <div className="source-status"><span />MCP 数据源等待联调</div>
          <div className="profile">
            <span className="avatar">LR</span>
            <div><strong>林然</strong><small>招聘运营</small></div>
            <button aria-label="打开用户菜单">•••</button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="crumb"><span>运营工作台</span><b>/</b>沉睡职位巡检</div>
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

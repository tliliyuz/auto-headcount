/**
 * JD 结构化提取（确定性规则，无 LLM）——从 `jobs.job_description` 提取期望候选人条件，
 * 写入 `job_requirements`（M3 职位侧数据缺口，docs/05-roadmap 第 216 行）。
 *
 * 设计原则（与 `lib/landing/landing-summary.mjs` 一致）：
 * - **结构性去标识化保证**：输出字段只可能来自白名单词库（通用技能/证书词），JD 里的
 *   公司名/产品专名不在词库 → 永远无法进入输出。
 * - **确定性纯函数**：同输入同输出、无外部依赖；技能/证书输出排序，与 `normalizeJobInput`
 *   的排序口径一致。
 * - **不确定 → null/[] + warning，绝不编造**（docs 03 §10「不转成年薪」、10 §3.1）：
 *   薪资只解析显式月薪（`20K-35K`/`2-3.5万/月`），年薪/面议/超界一律留空并记 warning。
 *
 * generator：`rules/v1`。
 */

export const JOB_REQUIREMENTS_GENERATOR_VERSION = "rules/v1";

/** 白名单：硬技能词（有序，词库定义顺序 = 优先级；避免歧义子串，如 Go→Golang、JS→JavaScript）。 */
const SKILLS_LEXICON = [
  // 语言 / 框架
  "Java", "Spring", "SpringBoot", "MyBatis", "Python", "Golang", "Go语言", "C++",
  "C语言", "JavaScript", "TypeScript", "Vue", "React", "Node.js", "Flutter",
  "Android", "iOS", "小程序", "H5", "Web", "HTML5",
  // 数据 / 存储 / 中间件
  "MySQL", "PostgreSQL", "MongoDB", "Redis", "Elasticsearch", "Kafka", "RocketMQ",
  "消息队列", "缓存", "数据库", "分布式", "微服务", "高并发", "高可用", "云原生",
  "Docker", "Kubernetes", "容器化",
  // 大数据 / 算法
  "Flink", "Spark", "Hadoop", "数据仓库", "数据中台", "数据分析", "数据挖掘", "大数据",
  "机器学习", "深度学习", "强化学习", "大模型", "自然语言处理", "NLP", "计算机视觉",
  "推荐系统", "推荐算法", "知识图谱", "向量检索", "特征工程",
  // 前端 / 工程 / 设计
  "前端工程化", "组件库", "微前端", "低代码", "数据可视化", "架构设计", "系统设计",
  "性能优化", "自动化测试", "持续集成", "质量保障",
];

/** 白名单：证书（确定性命中，绝不编造）。 */
const CERTIFICATES_LEXICON = [
  "PMP", "CPA", "CFA", "FRM", "注册会计师", "法律职业资格", "律师执业证",
  "教师资格证", "一级建造师", "二级建造师", "注册电气工程师", "注册结构工程师",
  "基金从业", "证券从业", "银行从业",
];

/** 职级阶梯（索引即高低；提取取最高档）。 */
const SENIORITY_LADDER = ["初级", "中级", "高级", "资深", "专家", "总监"];

/** 学历档（高→低；硬性门槛取最高档；同义词在匹配前归一化）。 */
const EDUCATION_LEVELS = ["博士", "硕士", "本科", "大专", "高中"];
const EDUCATION_SYNONYMS = { 研究生: "硕士", 专科: "大专" };

const SKILL_LIMIT = 10;
const CERT_LIMIT = 3;
const PREF_LIMIT = 5;
const PREF_CONTEXT_RE = /优先|加分/;
const PREF_WINDOW = 12;

/** 职级仅在紧邻角色名词（中间最多 6 个字符的修饰语）时才算，避免「高级功能」误判。 */
const SENIORITY_ROLE_RE = new RegExp(
  "(" + SENIORITY_LADDER.join("|") + ")\\s*([\\u4e00-\\u9fa5A-Za-z]{0,6}?)" +
    "(工程师|产品经理|经理|专家|架构师|设计师|研发|开发|研究员|运营|销售|主管|顾问|负责人)",
);

/** 按词库定义顺序取前 limit 个命中词（确定性、词库优先级可控；同 landing-summary）。 */
function extractInOrder(text, lexicon, limit) {
  const found = [];
  for (const word of lexicon) {
    if (found.length >= limit) break;
    if (text.includes(word)) found.push(word);
  }
  return found;
}

/** 技能：白名单命中后排序（与 normalizeJobInput 排序口径一致）。 */
export function extractSkills(text, limit = SKILL_LIMIT) {
  return [...extractInOrder(text, SKILLS_LEXICON, limit)].sort();
}

/** 学历：硬性门槛取最高档；仅「X优先」出现不算硬性 → null + warning。 */
export function extractEducation(text) {
  const normalized = String(text ?? "")
    .replace(/研究生/g, EDUCATION_SYNONYMS.研究生)
    .replace(/专科/g, EDUCATION_SYNONYMS.专科);
  for (const level of EDUCATION_LEVELS) {
    // 硬性：出现该档且其后不紧跟「优先」。
    const hard = new RegExp(level + "(?!\\s*优先)");
    if (hard.test(normalized)) return { value: level, warning: null };
  }
  // 仅以「优先」形式出现：不算硬性门槛。
  if (/优先/.test(normalized)) {
    return { value: null, warning: "学历仅以「优先」形式出现，未作为硬性门槛" };
  }
  return { value: null, warning: null };
}

/** 职级：title 优先（短、可靠，直接子串）；JD 需紧邻角色名词；取最高档。 */
export function extractSeniority(title, jd) {
  const titleText = String(title ?? "");
  for (let i = SENIORITY_LADDER.length - 1; i >= 0; i -= 1) {
    if (titleText.includes(SENIORITY_LADDER[i])) return SENIORITY_LADDER[i];
  }
  const jdText = String(jd ?? "");
  let bestIndex = -1;
  const globalRoleRe = new RegExp(SENIORITY_ROLE_RE.source, "g");
  for (const match of jdText.matchAll(globalRoleRe)) {
    const idx = SENIORITY_LADDER.indexOf(match[1]);
    if (idx > bestIndex) bestIndex = idx;
  }
  return bestIndex >= 0 ? SENIORITY_LADDER[bestIndex] : null;
}

/** 工作年限：范围/「N年以上」→ 下限；「N年以下」是上限 → null + warning；0≤N≤80。 */
export function extractExperienceYears(text) {
  const jd = String(text ?? "");
  const range = jd.match(/(\d+(?:\.\d+)?)\s*[-~—至]\s*(\d+)\s*年/);
  let years = range ? Math.floor(Number(range[1])) : null;
  let warning = null;
  if (years === null) {
    const above = jd.match(/(\d+)\s*年\s*(以上|及以上)/) ?? jd.match(/(?:至少|不少于)\s*(\d+)\s*年/);
    years = above ? Number(above[1] ?? above[0].match(/\d+/)?.[0]) : null;
  }
  if (years === null) {
    const below = jd.match(/(\d+)\s*年\s*(以下|以内)/);
    if (below) {
      warning = "仅见「N年以下」表述（上限而非下限），min_experience_years 留空";
    }
  }
  if (years !== null && (!Number.isInteger(years) || years < 0 || years > 80)) {
    years = null;
    warning = "工作年限取值越界，留空";
  }
  return { years, warning };
}

/** 薪资：只解析显式月薪（k/万 + 月），年薪/面议/单边界/超界一律留空 + warning（不推断）。 */
export function extractSalary(text) {
  const jd = String(text ?? "");
  const warn = (message) => ({ min: null, max: null, warning: message });

  if (/(年薪|万\/年|万一年)/.test(jd)) {
    return warn("年薪表述，未转为月薪（不推断）");
  }
  const kRange = jd.match(/(\d+(?:\.\d+)?)\s*[Kk]?\s*[-~—至]\s*(\d+(?:\.\d+)?)\s*[Kk]/);
  if (kRange) {
    return validateSalary(Number(kRange[1]) * 1000, Number(kRange[2]) * 1000);
  }
  const wanRange = jd.match(/(\d+(?:\.\d+)?)\s*万?\s*[-~—至]\s*(\d+(?:\.\d+)?)\s*万\s*\/?\s*月/);
  if (wanRange) {
    return validateSalary(Number(wanRange[1]) * 10000, Number(wanRange[2]) * 10000);
  }
  if (/(?:月薪|薪资|薪酬)?\s*面议/.test(jd)) {
    return warn("薪资面议，未提取薪资范围");
  }
  return { min: null, max: null, warning: null };
}

/** 薪资校验：整数、1000 ≤ min ≤ max ≤ 1_000_000（复用 landing-mask 口径）。 */
function validateSalary(min, max) {
  const plausible = Number.isInteger(min) && Number.isInteger(max) &&
    min >= 1000 && max >= min && max <= 1_000_000;
  if (!plausible) {
    return { min: null, max: null, warning: "薪资范围越界或不可信，留空（不推断）" };
  }
  return { min, max, warning: null };
}

/** 证书：白名单命中后排序。 */
export function extractRequiredCertificates(text, limit = CERT_LIMIT) {
  return [...extractInOrder(String(text ?? ""), CERTIFICATES_LEXICON, limit)].sort();
}

/** 优先技能：白名单命中且落在「优先/加分」±窗口内才算（镜像 landing-summary extractCollabs）。 */
export function extractPreferredSkills(text, limit = PREF_LIMIT) {
  const jd = String(text ?? "");
  const found = [];
  for (const word of SKILLS_LEXICON) {
    if (found.length >= limit) break;
    let idx = jd.indexOf(word);
    let hit = false;
    while (idx !== -1) {
      const start = Math.max(0, idx - PREF_WINDOW);
      const window = jd.slice(start, idx + word.length + PREF_WINDOW);
      if (PREF_CONTEXT_RE.test(window)) {
        hit = true;
        break;
      }
      idx = jd.indexOf(word, idx + word.length);
    }
    if (hit) found.push(word);
  }
  return [...found].sort();
}

/**
 * 从 JD 提取结构化期望候选人条件（job_requirements 行形状）。
 * 输入为职位行（title/category/jobDescription）；`category` v1 未使用（预留）。
 */
export function extractJobRequirements({ title, jobDescription } = {}) {
  const jd = String(jobDescription ?? "");
  const warnings = [];
  if (jd.trim() === "") {
    warnings.push("JD 为空，未提取任何结构化要求");
  }

  const skills = extractSkills(jd, SKILL_LIMIT);
  const edu = extractEducation(jd);
  if (edu.warning) warnings.push(edu.warning);
  const seniority = extractSeniority(title, jd);
  const exp = extractExperienceYears(jd);
  if (exp.warning) warnings.push(exp.warning);
  const salary = extractSalary(jd);
  if (salary.warning) warnings.push(salary.warning);
  const certificates = extractRequiredCertificates(jd);
  const preferred = extractPreferredSkills(jd);

  return {
    skills,
    seniority,
    education: edu.value,
    salaryMin: salary.min,
    salaryMax: salary.max,
    constraints: {
      min_experience_years: exp.years,
      required_certificates: certificates,
      preferred_skills: preferred,
      business_context: null,
      salary_hard_constraint: true,
    },
    extraction_warnings: warnings,
  };
}

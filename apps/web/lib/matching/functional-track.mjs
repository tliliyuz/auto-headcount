/**
 * 职能方向词表（匹配评分 industry 维度语义，ADR-007，2026-08-16）。
 *
 * 背景：industry 维度原先职位侧取 `job.category`（生产恒空）、候选侧取职业标签（title-text），
 * 两侧不同轴 → 恒不可评估。重定义为「职能方向匹配」：职位侧从标题/JD、候选侧从职业标签
 * 用本词表提取职能方向，同轴比对。词表启发式非权威（同 skills 推断技术债），覆盖
 * 互联网技术人才池常见职能。
 *
 * 语义：`scoring_context.industry` / `profile.industry` 字段名保持（避免投影 schema 版本迁移），
 * 值改为命中的职能方向标签（"、" 连接）；LLM prompt 把该维度描述为「职能方向匹配」。
 */

/** 职能方向 → 关键词。命中多个方向是合法的（如「数据产品经理」→ 数据 + 产品）。 */
const FUNCTIONAL_TRACK_KEYWORDS = {
  数据: [
    "数据仓库", "数据平台", "数据分析", "数据开发", "数据智能", "数据建模",
    "数据中台", "数据科学", "数据工程师", "ETL", "BI", "商业分析", "经营分析",
  ],
  算法AI: [
    "算法", "机器学习", "深度学习", "大模型", "NLP", "自然语言", "知识图谱",
    "Text2SQL", "推荐算法", "推荐系统", "搜索算法", "图像算法", "机器视觉",
    "语音识别", "AIGC",
  ],
  工程研发: [
    "工程师", "研发", "开发", "后端", "前端", "全栈", "架构", "中间件", "分布式",
    "系统架构", "运维", "嵌入式", "硬件", "芯片", "电路", "内核", "编译", "DevOps", "容器",
  ],
  产品: [
    "产品经理", "产品总监", "产品设计", "产品运营", "产品策划", "用户研究",
  ],
  运营: [
    "运营", "增长", "内容运营", "用户运营", "数据运营", "活动运营", "新媒体",
  ],
  市场销售: [
    "市场", "销售", "商务", "品牌", "公关", "渠道", "媒介", "投放", "营销", "推广", "BD",
  ],
  测试质量: [
    "测试", "QA", "质量保障", "自动化测试",
  ],
  安全风控: [
    "安全", "风控", "合规", "信息安全",
  ],
  设计: [
    "设计", "UX", "UI", "视觉", "交互",
  ],
};

/** Top-N：只取命中强度最高的前 N 个职能方向，避免宽职位命中 6 个方向、跟谁都 90。 */
const MAX_FUNCTIONAL_TRACKS = 2;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** ASCII 关键词预编译：仅以非 ASCII 词符为邻才命中（避免 BI 误伤 BIA 等），复用 skills 推断模式。 */
const ASCII_PATTERN_CACHE = new Map();
function asciiPattern(keyword) {
  if (!ASCII_PATTERN_CACHE.has(keyword)) {
    ASCII_PATTERN_CACHE.set(
      keyword,
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(keyword)}(?![A-Za-z0-9_])`, "i"),
    );
  }
  return ASCII_PATTERN_CACHE.get(keyword);
}

const isAsciiWord = (keyword) => /^[A-Za-z0-9_+./-]+$/.test(keyword);

/** 从文本提取命中强度最高的前 N 个职能方向标签（按词表内关键词命中数计分，并列保词表顺序）。 */
export function extractFunctionalTracks(input) {
  const text = (Array.isArray(input) ? input.filter(Boolean) : [input])
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return [];
  const scored = [];
  for (const [track, keywords] of Object.entries(FUNCTIONAL_TRACK_KEYWORDS)) {
    const hits = keywords.filter((keyword) =>
      isAsciiWord(keyword) ? asciiPattern(keyword).test(text) : text.includes(keyword),
    ).length;
    if (hits > 0) scored.push({ track, hits });
  }
  // 稳定排序：命中数降序，并列保持词表顺序（数据/算法AI 优先于 工程研发/运营 等宽方向）
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, MAX_FUNCTIONAL_TRACKS).map((item) => item.track);
}

/** 职能方向匹配分（industry 维度语义）：有交集 90 / 都有值无交集 65 / 任一侧空不可评估。 */
export function scoreFunctionalTracks({ jobTracks, candidateTracks }) {
  if (!Array.isArray(jobTracks) || jobTracks.length === 0) return null;
  if (!Array.isArray(candidateTracks) || candidateTracks.length === 0) return null;
  const job = new Set(jobTracks);
  return candidateTracks.some((track) => job.has(track)) ? 90 : 65;
}

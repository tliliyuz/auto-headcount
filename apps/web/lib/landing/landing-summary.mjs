import { jobCoarseBucket } from "../job-category.mjs";

/**
 * 职位职责摘要生成器（模板 + 白名单变量，docs/03 §10、docs/07 §3 落地页切片）。
 *
 * 摘要 = 大类桶句子骨架 + 4 类变量槽，全部从 JD 白名单抽取：
 *   {team}    加入的团队（JD 部门词，排除已在「协同」上下文中识别的协作团队）
 *   {skills}  负责的能力短语（技术/运营/市场通用能力词）
 *   {action}  职责动作词（规划/优化/拓展…）
 *   {collabs} 协同团队（仅在「协同/协作/配合/联动/合作」上下文附近抽取）
 *
 * **结构性去标识化保证**：变量只可能来自白名单词库（通用能力/部门/动作词），JD 里的公司名/
 * 产品专名不在词库 → 永远无法进入摘要（规避原始 JD 截断泄漏品牌名的风险）。
 * 确定性纯函数（同输入同输出）、无外部依赖；LLM 改写变量留作增强路径（走 M3 门禁）。
 */

/** 白名单：部门/团队词（通用部门名词，避免「工程化/技术亮点」这类技能语境误判）。 */
const TEAM_WORDS = [
  "媒介", "市场", "销售", "商务", "渠道", "客服", "供应链", "增长",
  "运营", "产品", "设计", "研发", "数据", "内容", "公关", "品牌", "技术",
];

/** 白名单：能力短语（技术/运营/市场通用能力，绝不包含公司/产品专名）。 */
const SKILL_WORDS = [
  // 技术 / 算法
  "大模型", "语言模型", "多模态", "AI Agent", "智能体", "RAG", "检索增强", "知识图谱",
  "推荐系统", "广告系统", "风控", "反欺诈", "特征工程", "机器学习", "深度学习",
  "强化学习", "自然语言处理", "NLP", "计算机视觉", "图像生成", "语音识别", "向量检索",
  "文本生成", "模型训练", "模型推理", "算法优化", "图神经网络",
  "分布式", "高并发", "微服务", "服务网格", "消息队列", "缓存", "中间件", "云原生",
  "容器化", "弹性伸缩", "网关", "性能优化", "高可用", "API",
  "前端工程化", "组件库", "微前端", "低代码", "数据可视化", "可视化", "跨端",
  "小程序", "H5", "移动端", "动效",
  "数据仓库", "数据中台", "数据分析", "数据挖掘", "BI", "数据治理", "指标体系",
  "实时计算", "离线计算",
  // 产品 / 运营 / 市场
  "需求分析", "用户研究", "产品规划", "路线图", "竞品分析", "商业化", "增长",
  "用户运营", "内容运营", "活动运营", "数据运营", "社群运营", "转化率", "留存", "拉新",
  "大客户", "解决方案", "商务拓展", "客户成功", "品牌建设", "品牌曝光", "媒介投放",
  "广告投放", "媒体关系", "内容传播", "内容创作", "舆情监测", "危机公关", "危机管理",
  "活动策划", "用户转化", "渠道拓展", "客户拓展", "商业变现", "流量运营", "用户增长",
  "私域", "短视频", "直播",
  // 设计 / 质量
  "交互设计", "视觉设计", "设计系统", "体验优化",
  "自动化测试", "质量保障", "性能测试", "持续集成",
];

/** 白名单：职责动作词。 */
const ACTION_WORDS = [
  "规划", "建设", "拓展", "维护", "统筹", "策划", "投放", "优化", "复盘",
  "迭代", "评估", "制定", "执行", "落地", "提升", "构建", "主导", "推动",
];

/** 白名单：协同团队（仅在「协同」上下文附近才算）。 */
const COLLAB_WORDS = [
  "产品", "运营", "设计", "研发", "技术", "业务", "内容", "公关", "市场", "销售",
  "数据", "客服", "供应链", "品牌", "工程",
];

/** 协同/协作上下文关键词：候选词落在其 ±窗口内才判为「协同团队」（「合作」太泛，排除）。 */
const COLLAB_CONTEXT_RE = /协同|协作|配合|联动|联手|跨部门/;
const COLLAB_WINDOW = 12;

const TEAM_LIMIT = 1;
const SKILL_LIMIT = 3;
const ACTION_LIMIT = 2;
const COLLAB_LIMIT = 2;

/** 每桶模板（句子骨架 + 4 变量槽；{action} 仅市场销售桶使用）。 */
const BUCKET_TEMPLATES = {
  技术研发:
    "你将加入{team}团队，专注{skills}方向的核心建设，负责相关模块的设计、开发与持续优化，与{collabs}团队紧密协作，推动方案在真实业务场景中落地。",
  数据智能:
    "你将加入{team}团队，专注{skills}的研发与落地，负责建模、调优与效果评估，用数据驱动业务决策，与{collabs}团队紧密协作。",
  产品设计:
    "你将加入{team}团队，负责{skills}相关的需求洞察与产品规划，与{collabs}团队紧密协作，推动产品在真实场景中创造价值。",
  市场销售:
    "你将加入{team}团队，负责{skills}相关的{action}工作，与{collabs}团队紧密协同，推动业务持续增长。",
  其他:
    "你将加入{team}方向的团队，负责{skills}相关工作，与{collabs}团队紧密协作，推动业务目标的达成。",
};

const BUCKET_TEAM_FALLBACK = {
  技术研发: "研发",
  数据智能: "数据/算法",
  产品设计: "产品",
  市场销售: "市场/销售",
  其他: "业务",
};

/** 按词库定义顺序取前 limit 个命中词（确定性、词库优先级可控）。 */
function extractInOrder(text, lexicon, limit) {
  const found = [];
  for (const word of lexicon) {
    if (found.length >= limit) break;
    if (text.includes(word)) found.push(word);
  }
  return found;
}

/** 取协同上下文附近的协作团队词（扫描该词全部出现位置，任一处落在协同关键词 ±窗口内即算）。 */
function extractCollabs(text, limit) {
  const found = [];
  for (const word of COLLAB_WORDS) {
    if (found.length >= limit) break;
    let idx = text.indexOf(word);
    let hit = false;
    while (idx !== -1) {
      const start = Math.max(0, idx - COLLAB_WINDOW);
      const window = text.slice(start, idx + word.length + COLLAB_WINDOW);
      if (COLLAB_CONTEXT_RE.test(window)) {
        hit = true;
        break;
      }
      idx = text.indexOf(word, idx + word.length);
    }
    if (hit) found.push(word);
  }
  return found;
}

/**
 * 生成去标识化职责摘要。输入为职位行（camelCase 投影，与 toMaskedJobView 一致）。
 * 各变量槽无命中时回退到桶默认值；无 JD / 完全无命中时退化为安全通用文案。
 */
export function inferJobSummary({ category, title, jobDescription } = {}) {
  const bucket = jobCoarseBucket(category, title);
  const jd = String(jobDescription ?? "");

  const collabs = extractCollabs(jd, COLLAB_LIMIT);
  const team = extractInOrder(
    jd,
    TEAM_WORDS.filter((word) => !collabs.includes(word)),
    TEAM_LIMIT,
  );
  const skills = extractInOrder(jd, SKILL_WORDS, SKILL_LIMIT);
  const actions = extractInOrder(jd, ACTION_WORDS, ACTION_LIMIT);

  const template = BUCKET_TEMPLATES[bucket] ?? BUCKET_TEMPLATES.其他;
  return template
    .replace("{team}", team[0] ?? BUCKET_TEAM_FALLBACK[bucket] ?? "业务")
    .replace("{skills}", skills.join("、") || "核心业务")
    .replace(
      "{action}",
      actions.join("、") || "增长与客户拓展",
    )
    .replace("{collabs}", collabs.join("、") || "产品、运营")
    .trim();
}

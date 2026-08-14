export const AGGREGATION_RULE_VERSION = "aggregation/v1";
export const DETAIL_SCORE_WEIGHTS = Object.freeze({
  skills: 0.25,
  industry: 0.1,
  seniority: 0.15,
  experience: 0.2,
  location: 0.15,
  salary: 0.1,
  activity: 0.05,
});

export async function aggregateDetailScore(output) {
  const assessable = (output.dimensions ?? []).filter((item) => item.assessable && Number.isFinite(item.score));
  const denominator = assessable.reduce((sum, item) => sum + (DETAIL_SCORE_WEIGHTS[item.dimension] ?? 0), 0);
  if (denominator <= 0) throw new Error("NO_ASSESSABLE_DIMENSIONS");
  const weighted = assessable.reduce((sum, item) => sum + item.score * (DETAIL_SCORE_WEIGHTS[item.dimension] ?? 0), 0);
  const score = Math.round(weighted / denominator);
  return {
    score,
    band: score >= 85 ? "high" : score >= 75 ? "medium" : "low",
    aggregationRuleVersion: AGGREGATION_RULE_VERSION,
    dimensions: output.dimensions ?? [],
    evidence: assessable.flatMap((item) => item.evidence ?? []).map((item) => item.assessment),
    missing: output.missing_items ?? [],
    risk: output.risks ?? [],
  };
}

export async function deriveMatchRuleVersion(versionBundle) {
  const bytes = new TextEncoder().encode(canonicalJson(versionBundle));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return ((digest[0] << 24 | digest[1] << 16 | digest[2] << 8 | digest[3]) >>> 1) || 1;
}

export async function hashCanonical(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

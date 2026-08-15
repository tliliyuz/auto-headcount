import type postgres from "postgres";

export declare const LANDING_INTENT_OPTIONS: readonly ["A", "B", "C", "opt_out"];
export declare const LANDING_LINK_UNAVAILABLE_CODE: "landing_link_unavailable";

export interface MaskedJobView {
  title: string;
  category: string;
  city: string;
  salaryRange: string;
  summary: string;
  /** 候选人本人姓名（展示给本人，个性化开场；非打码投影）。 */
  candidateName: string | null;
  /** 公司隐性信息 teaser（公司档案维护；无档案为 null，不展示隐性信息段）。 */
  companyTeaser: {
    industryPositioning: string | null;
    companyScale: string | null;
    benchmarks: string | null;
    officeLocation: string | null;
  } | null;
  /** AI 匹配评价（已审核匹配维度分投影；无/未审核为 null，P5，docs/03 §10）。 */
  aiEvaluation: {
    score: number | null;
    bandLabel: string | null;
    dimensions: Array<{ label: string; score: number }>;
  } | null;
}

export interface IntentSubmitOk {
  ok: true;
  deduplicated: boolean;
  responseId: string;
  option: string;
  notifyStatus: "pending" | "succeeded" | "failed";
  notifyErrorCode: string | null;
}

export interface IntentSubmitUnavailable {
  ok: false;
  code: "landing_link_unavailable";
}

export declare function getLandingJobView(
  sql: postgres.Sql,
  input: { token: string; now: Date },
): Promise<MaskedJobView | null>;

export declare function submitLandingIntent(
  sql: postgres.Sql,
  input: {
    token: string;
    option: string;
    phone?: string;
    email?: string;
    consentSnapshot: { scope: string; canRefuse: boolean; language: string };
    config: {
      encryptionKey: string;
      encryptionKeyVersion: string;
      channel?: string;
      feishuWebhookUrl?: string;
      feishuWebhookSecret?: string;
    };
    now: Date;
  },
): Promise<IntentSubmitOk | IntentSubmitUnavailable>;

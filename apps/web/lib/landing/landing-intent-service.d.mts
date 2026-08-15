import type postgres from "postgres";

export declare const LANDING_INTENT_OPTIONS: readonly ["A", "B", "C", "opt_out"];
export declare const LANDING_LINK_UNAVAILABLE_CODE: "landing_link_unavailable";

export interface MaskedJobView {
  title: string;
  category: string;
  city: string;
  salaryRange: string;
  summary: string;
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

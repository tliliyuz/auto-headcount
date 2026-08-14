import type postgres from "postgres";

export interface LandingLinkRow {
  id: string;
  jobId: string;
  candidateId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface ValidLandingLinkRow extends LandingLinkRow {
  title: string;
  category: string;
  city: string;
  salaryMin: number | null;
  salaryMax: number | null;
  jobDescription: string | null;
}

export interface PagedLandingLinks {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: Array<LandingLinkRow & { jobTitle: string }>;
}

export declare function createLandingLink(
  sql: postgres.Sql,
  input: {
    jobId: string;
    candidateId: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  },
): Promise<LandingLinkRow>;

export declare function findValidLandingLinkByTokenHash(
  sql: postgres.Sql,
  input: { tokenHash: string; now: Date },
): Promise<ValidLandingLinkRow | null>;

export declare function findLandingLinkById(
  sql: postgres.Sql,
  id: string,
): Promise<LandingLinkRow | null>;

export declare function revokeLandingLink(
  sql: postgres.Sql,
  input: { id: string; revokedBy: string | null; now: Date },
): Promise<LandingLinkRow | null>;

export declare function listLandingLinks(
  sql: postgres.Sql,
  input?: { page?: number; pageSize?: number },
): Promise<PagedLandingLinks>;

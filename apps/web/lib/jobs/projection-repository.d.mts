import type postgres from "postgres";

type SqlClient = postgres.Sql;

export function insertJobProjection(
  sql: SqlClient,
  input: {
    jobId: string;
    schemaVersion: string;
    generatorType: string;
    generatorVersion: string;
    inputHash: string;
    sourceSnapshotRefs?: Array<Record<string, unknown>>;
    displaySummary: string;
    requirements: Record<string, unknown>;
    status?: string;
  },
): Promise<{ id: string; created: boolean }>;

export function insertCandidateProjection(
  sql: SqlClient,
  input: {
    candidateId: string;
    schemaVersion: string;
    generatorVersion: string;
    redactionVersion: string;
    inputHash: string;
    sourceSnapshotRefs?: Array<Record<string, unknown>>;
    displaySummary: string;
    profile: Record<string, unknown>;
    redactedDetail: Record<string, unknown>;
    redactionReport: Record<string, unknown>;
    status?: string;
  },
  encryption: { key: string; keyVersion: string },
): Promise<{ id: string; created: boolean }>;

export function findJobProjection(
  sql: SqlClient,
  input: { jobId: string; schemaVersion: string; generatorVersion: string; inputHash: string },
): Promise<string | null>;

export function findCandidateProjection(
  sql: SqlClient,
  input: {
    candidateId: string;
    schemaVersion: string;
    generatorVersion: string;
    redactionVersion: string;
    inputHash: string;
  },
): Promise<string | null>;

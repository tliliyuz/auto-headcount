import { createRetentionRepository } from "./retention-repository.mjs";

const DEFAULT_TTL = {
  rawSuccessDays: 30,
  rawExceptionDays: 90,
  jobClosedDays: 180,
  auditDays: 365,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 保留清理：按可配置 TTL 删除过期原始快照、关闭职位、过期会话与过期审计日志，
 * 并写入一条 `retention.run` 审计（system actor，仅计数与 TTL，无敏感正文）。
 *
 * `repo` 可注入（测试用假仓储）；`now`/`requestId` 可注入保证确定性与可追溯。
 * 失败时尽力记录 failure 审计（失败本身不掩盖原错误），返回机器可读错误码。
 */
export async function runRetention({
  sql,
  ttl,
  now = new Date(),
  requestId = null,
  repo,
}) {
  const retentionRepo = repo ?? createRetentionRepository(sql);
  const resolvedTtl = { ...DEFAULT_TTL, ...(ttl ?? {}) };
  const counts = {
    rawRecordsDeleted: 0,
    jobsDeleted: 0,
    sessionsDeleted: 0,
    auditLogsDeleted: 0,
  };

  const successCutoff = new Date(now.getTime() - resolvedTtl.rawSuccessDays * DAY_MS);
  const exceptionCutoff = new Date(now.getTime() - resolvedTtl.rawExceptionDays * DAY_MS);
  const jobCutoff = new Date(now.getTime() - resolvedTtl.jobClosedDays * DAY_MS);
  const auditCutoff = new Date(now.getTime() - resolvedTtl.auditDays * DAY_MS);

  try {
    counts.rawRecordsDeleted = await retentionRepo.deleteExpiredRawRecords({
      successCutoff,
      exceptionCutoff,
    });
    counts.jobsDeleted = await retentionRepo.deleteClosedJobs({ cutoff: jobCutoff });
    counts.sessionsDeleted = await retentionRepo.deleteExpiredSessions({ now });
    counts.auditLogsDeleted = await retentionRepo.deleteExpiredAuditLogs({
      cutoff: auditCutoff,
    });

    await writeRetentionAudit(retentionRepo, {
      result: "success",
      counts,
      resolvedTtl,
      requestId,
    });
    return { status: "succeeded", counts };
  } catch {
    const errorCode = "RETENTION_INTERNAL_ERROR";
    await writeRetentionAudit(retentionRepo, {
      result: "failure",
      counts,
      resolvedTtl,
      requestId,
      errorCode,
    }).catch(() => {});
    return { status: "failed", errorCode, counts };
  }
}

async function writeRetentionAudit(repo, { result, counts, resolvedTtl, requestId, errorCode }) {
  const metadata = {
    rawRecordsDeleted: counts.rawRecordsDeleted,
    jobsDeleted: counts.jobsDeleted,
    sessionsDeleted: counts.sessionsDeleted,
    auditLogsDeleted: counts.auditLogsDeleted,
    ttl: resolvedTtl,
  };
  if (errorCode) metadata.errorCode = errorCode;

  await repo.insertAudit({
    actorType: "system",
    actorId: null,
    action: "retention.run",
    resourceType: null,
    resourceId: null,
    result,
    requestId,
    metadata,
  });
}

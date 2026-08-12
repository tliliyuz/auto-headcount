import { createAuthRepository } from "../identity/auth-repository.mjs";

/**
 * 保留清理仓储：按 TTL 删除过期原始快照、关闭职位、过期会话与过期审计，
 * 并复用身份模块的审计写入（保证审计格式一致）。
 */
export function createRetentionRepository(sql) {
  const auth = createAuthRepository(sql);

  return {
    /** 成功响应（captured/normalized）按 successCutoff，异常（invalid）按 exceptionCutoff 删除。 */
    async deleteExpiredRawRecords({ successCutoff, exceptionCutoff }) {
      const success = await sql`
        delete from raw_records
        where processing_status in ('captured', 'normalized')
          and captured_at < ${successCutoff}
      `;
      const exception = await sql`
        delete from raw_records
        where processing_status = 'invalid'
          and captured_at < ${exceptionCutoff}
      `;
      return Number(success.count) + Number(exception.count);
    },

    /** 关闭（非 active）职位按 cutoff 删除；当前同步只写 active，实际为可测的 no-op 路径。 */
    async deleteClosedJobs({ cutoff }) {
      const result = await sql`
        delete from jobs
        where status <> 'active'
          and updated_at < ${cutoff}
      `;
      return Number(result.count);
    },

    /** 过期会话（双过期任一到点）删除。 */
    async deleteExpiredSessions({ now }) {
      const result = await sql`
        delete from sessions
        where expires_at < ${now}
          or idle_expires_at < ${now}
      `;
      return Number(result.count);
    },

    /** 过期审计日志按 cutoff 删除；追加写触发器只放行带 app.audit_retention=on 的删除（保留任务专用）。 */
    async deleteExpiredAuditLogs({ cutoff }) {
      const result = await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        return t`
          delete from audit_logs
          where occurred_at < ${cutoff}
        `;
      });
      return Number(result.count);
    },

    insertAudit: auth.insertAudit,
  };
}

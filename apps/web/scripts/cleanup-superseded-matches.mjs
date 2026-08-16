#!/usr/bin/env node

/**
 * 历史匹配清理（问题 4，迁移 0016 superseded 语义）——一次性数据修复脚本。
 *
 * 背景：职位去重（同 JD 多城市合并为代表）上线晚于一批 match 生成，导致：
 *   - 同 JD 组多个城市变体各自出 match（重复）；
 *   - 预览 fixture（预览候选人/林小满）混入工作台。
 * 本脚本把数据收敛到 superseded 不变量：每 (JD组, 候选人) 只保留代表 job（组内最小
 * job_id）一条 active，其余标 is_superseded=true（**不硬删**，库里保留可审计）；
 * fixture 匹配直接删除（假数据，无审计价值）。
 *
 * 幂等：重复运行不重复 supersede（`not is_superseded` 守卫）、fixture 已删后 no-op。
 *
 * 用法（apps/web 下）：
 *   node --env-file-if-exists=../../.env.local --env-file-if-exists=.env.local \
 *     scripts/cleanup-superseded-matches.mjs
 *
 * 也可作为模块导入：`cleanupSupersededMatches(sql)` 返回
 * `{ deletedFixtures, superseded }`（集成测试复用）。
 */
import postgres from "postgres";

/** 已知预览 fixture 候选人（假数据，非真实采集）：直接删除其匹配，无审计价值。 */
const FIXTURE_CANDIDATE_NAMES = Object.freeze(["预览候选人", "林小满"]);

/**
 * 执行历史清理。返回 `{ deletedFixtures, superseded }`（受影响行数）。
 *
 * @param {import("postgres").Sql} sql
 */
export async function cleanupSupersededMatches(sql) {
  const fixtureDelete = await sql`
    delete from matches where candidate_id in (
      select id from candidates where display_name = any(${FIXTURE_CANDIDATE_NAMES})
    )
  `;
  const deletedFixtures = fixtureDelete.count ?? 0;

  // 每 (候选人, JD组) 保留组内最小 job_id 的 match（与管线代表选举同序：uuid 排序），其余 superseded。
  // 组键：非空 JD → sha256(JD)；空 JD → 'job:<job_id>'（各自成组，永不互相 supersede）。
  // keep 只统计非 superseded 行，保证幂等重跑不把已 superseded 的 match 重新卷入。
  const supersededUpdate = await sql`
    with job_group as (
      select id as job_id,
        case when job_description is null or btrim(job_description) = '' then 'job:' || id::text
          else encode(sha256(convert_to(btrim(job_description), 'UTF8')), 'hex') end as grp
      from jobs
    ),
    keep as (
      select candidate_id, grp, job_id as keep_job_id
      from (
        select m.candidate_id, jg.grp, m.job_id,
          row_number() over (
            partition by m.candidate_id, jg.grp
            order by m.job_id
          ) as rn
        from matches m
        join job_group jg on jg.job_id = m.job_id
        where not m.is_superseded
      ) s
      where rn = 1
    )
    update matches m
    set is_superseded = true, updated_at = now()
    where not m.is_superseded
      and exists (
        select 1
        from keep k
        join job_group jg on jg.job_id = m.job_id
        where k.candidate_id = m.candidate_id
          and k.grp = jg.grp
          and m.job_id <> k.keep_job_id
      )
  `;
  const superseded = supersededUpdate.count ?? 0;

  return { deletedFixtures, superseded };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(2);
  }
  const sql = postgres(connectionString, { max: 1 });
  try {
    const result = await cleanupSupersededMatches(sql);
    process.stdout.write(
      `cleanup done: deletedFixtures=${result.deletedFixtures} superseded=${result.superseded}\n`,
    );
  } finally {
    await sql.end();
  }
}

// CLI 入口（被 import 时不执行）
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  await main();
}

#!/usr/bin/env node

/**
 * 同步任务表调度 tick 的 CLI 入口（云服务器 docker compose scheduler 服务使用）。
 *
 * 单次模式（默认）：跑一轮 `runScheduledTick`——入队当前周期同步任务 + 处理到期任务，
 * 输出 JSON 汇总（enqueued/claimed/succeeded/retried/failed/dead）；未预期异常退出非零。
 * `--loop [--interval-minutes N]`：常驻循环，每 N 分钟（默认 15）跑一轮，单轮失败不退出
 * （下轮重试），供 scheduler 容器使用。
 *
 * 配置从环境变量读取（容器经 `env_file: .env.production` 注入）：
 * - `DATABASE_URL` 必填（缺 → exit 2）；
 * - `APP_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY_VERSION` 必填（缺 → exit 2）；
 * - MCP 凭证/`SYNC_*` 缺省时由 runScheduledTick 失败安全处理（任务记 failed，不崩溃）。
 */
import postgres from "postgres";

import { runScheduledTick } from "../lib/jobs/sync-scheduler.mjs";

const DEFAULT_INTERVAL_MINUTES = 15;

function parseArgs(argv) {
  const loop = argv.includes("--loop");
  const index = argv.indexOf("--interval-minutes");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const intervalMinutes =
    raw === undefined ? DEFAULT_INTERVAL_MINUTES : Number(raw);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    process.stderr.write(
      "INVALID_INTERVAL: --interval-minutes must be a positive integer\n",
    );
    process.exit(2);
  }
  return { loop, intervalMinutes };
}

async function runTickOnce() {
  const connectionString = process.env.DATABASE_URL;
  const encryptionKey = process.env.APP_ENCRYPTION_KEY;
  const encryptionKeyVersion = process.env.APP_ENCRYPTION_KEY_VERSION;

  if (!connectionString) {
    process.stderr.write(
      "DATABASE_URL_REQUIRED: set DATABASE_URL before running sync:tick\n",
    );
    process.exit(2);
  }
  if (!encryptionKey || !encryptionKeyVersion) {
    process.stderr.write(
      "ENCRYPTION_CONFIG_REQUIRED: set APP_ENCRYPTION_KEY and APP_ENCRYPTION_KEY_VERSION\n",
    );
    process.exit(2);
  }

  const sql = postgres(connectionString, { max: 1 });
  try {
    const outcome = await runScheduledTick({ env: process.env, sql });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } finally {
    await sql.end();
  }
}

const { loop, intervalMinutes } = parseArgs(process.argv.slice(2));

if (!loop) {
  await runTickOnce();
} else {
  // setTimeout 链避免 tick 与 interval 重叠；单轮失败仅记日志，下轮重试。
  const intervalMs = intervalMinutes * 60 * 1000;
  for (;;) {
    try {
      await runTickOnce();
    } catch (error) {
      console.error(
        "[sync:tick] 未预期异常",
        error instanceof Error ? error.message : error,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

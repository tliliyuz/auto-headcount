#!/usr/bin/env node
/**
 * 全仓 markdown 相对链接检查：遍历仓库内所有 .md 文件，校验内联相对链接目标
 * （文件或目录）真实存在。忽略 URL（http/https/mailto/data）、纯锚点（#...）
 * 与含空格的链接。仓库根 = 本文件所在目录的上一级。
 *
 * 退出码：发现断链返回 1，否则 0。供 CI 与 `make ci` 调用。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "build",
  "coverage",
]);

/** 内联链接 `[text](target)`，捕获 target（不含空格、可带双引号标题）。 */
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function isIgnored(target) {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("data:") ||
    target.startsWith("#") ||
    target.includes(" ")
  );
}

let broken = 0;
const files = walk(ROOT);

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(LINK_RE)) {
    const raw = match[1];
    if (isIgnored(raw)) continue;
    // 去掉 # 锚点片段
    const target = raw.split("#")[0];
    if (!target) continue;
    const resolved = normalize(join(dirname(file), target));
    // 目标必须在仓库内（防相对路径逃逸到仓库外被误判存在）
    if (relative(ROOT, resolved).startsWith("..")) {
      console.error(`[check-md-links] ${relative(ROOT, file)}: 链接越出仓库根 → ${raw}`);
      broken += 1;
      continue;
    }
    let exists = false;
    try {
      statSync(resolved);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      console.error(`[check-md-links] ${relative(ROOT, file)}: 断链 → ${raw}`);
      broken += 1;
    }
  }
}

if (broken > 0) {
  console.error(`\n✖ ${broken} 个 markdown 相对链接失效`);
  process.exit(1);
}
console.log(`✓ markdown 相对链接检查通过（${files.length} 个文件）`);

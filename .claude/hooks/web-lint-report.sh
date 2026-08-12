#!/usr/bin/env bash
# Claude Code PostToolUse hook：编辑/写入 apps/web 源码后，报告 eslint 改动预览。
# 只报告不落盘；写入需用户在权限弹窗中对 eslint --fix 命令批准。
# 适配：本仓库用 npm（非 pnpm）、无 prettier；后端为 .mjs/.mts 原始 SQL 仓储。
set -uo pipefail

input_file="${1:-}"
if [[ -z "$input_file" || ! -f "$input_file" ]]; then
  exit 0
fi

# 从 hook JSON 提取 file_path（使用 python3，避免 macOS grep -P 依赖）
file_path="$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
tool_input = data.get('tool_input') or {}
print(tool_input.get('file_path') or '')
" "$input_file" 2>/dev/null)"

if [[ -z "$file_path" ]]; then
  exit 0
fi

# 只处理 apps/web 源码（扩展名匹配含嵌套路径）
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.mts|*.cjs|*.cts) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  apps/web/*) ;;
  *) exit 0 ;;
esac

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# 工具就绪：eslint 已安装（宿主机可能无 node_modules，容器卷内才装）
eslint_bin="apps/web/node_modules/.bin/eslint"
if [[ ! -x "$eslint_bin" ]]; then
  exit 0
fi

# eslint 由文件向上发现 apps/web/eslint.config.mjs；传仓库根相对路径即可
rel="$file_path"

eslint_diff="$("$eslint_bin" --fix-dry-run "$rel" 2>&1 || true)"

if [[ -z "$eslint_diff" ]]; then
  exit 0
fi

echo ""
echo "══ web lint 报告（未落盘，批准后才写入）══"
echo "── ESLint（eslint --fix-dry-run，只读）──"
echo "$eslint_diff"
echo "批准方式：执行 \`npm --prefix apps/web exec eslint --fix <file>\` 时在权限弹窗中允许。"
echo ""

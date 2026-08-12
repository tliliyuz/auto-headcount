#!/usr/bin/env bash
# Claude Code PostToolUse hook：编辑/写入 .py 文件后，自动报告 ruff format/check 改动预览。
# 只报告不落盘；写入需用户在权限弹窗中对 `ruff format` / `ruff check --fix` 批准。
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

if [[ -z "$file_path" || "$file_path" != *.py ]]; then
  exit 0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

if [[ ! -f .venv/bin/ruff ]]; then
  exit 0
fi

format_diff="$(.venv/bin/ruff format --check --diff "$file_path" 2>/dev/null)"
check_diff="$(.venv/bin/ruff check --diff "$file_path" 2>/dev/null)"

if [[ -z "$format_diff" && -z "$check_diff" ]]; then
  exit 0
fi

echo ""
echo "══ ruff 报告（未落盘，批准后才写入）══"
if [[ -n "$format_diff" ]]; then
  echo "── 格式改动（ruff format --check --diff）──"
  echo "$format_diff"
fi
if [[ -n "$check_diff" ]]; then
  echo "── lint 修复（ruff check --diff）──"
  echo "$check_diff"
fi
echo "批准方式：执行 \`ruff format <file>\` / \`uvx ruff format <file>\` / \`ruff check --fix <file>\` 时在权限弹窗中允许。"
echo ""

#!/usr/bin/env bash
# Claude Code PostToolUse hook：编辑/写入全量强制范围 .py 后，报告 mypy 类型检查结果。
# mypy 为只读类型检查（无 fix/写命令），无需权限门禁；只报告不落盘。
# 范围镜像 .pre-commit-config.yaml 的 python-mypy 全量范围。
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

# 确定所属服务与相对路径（case 模式内含嵌套路径与 `|` 多分支）
svc=""
rel=""
case "$file_path" in
  services/knowledge/scripts/.ab/*.py|services/research/scripts/.ab/*.py)
    exit 0
    ;;
  services/knowledge/app/*.py|services/knowledge/scripts/*.py|services/knowledge/tests/*.py|services/knowledge/alembic/env.py)
    svc=knowledge
    rel="${file_path#services/knowledge/}"
    ;;
  services/research/app/*.py|services/research/scripts/*.py|services/research/tests/*.py|services/research/alembic/env.py)
    svc=research
    rel="${file_path#services/research/}"
    ;;
  packages/contracts/generated/python/*.py|packages/contracts/tests/*.py|tests/*.py)
    svc=knowledge
    rel="../../$file_path"
    ;;
  *) exit 0 ;;
esac

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

mypy_bin="services/$svc/.venv/bin/mypy"
if [[ ! -x "$mypy_bin" ]]; then
  echo "mypy 环境未就绪；请在仓库根目录执行 make setup-python-dev。" >&2
  exit 0
fi

# 只运行该文件（mypy 会沿 import 检查依赖），config 用根 pyproject.toml。
# cd 进服务目录后使用服务内相对路径 .venv/bin/mypy（root 相对路径在此会失效）。
# 仅当 mypy 报错（exit != 0，如 "Found N errors" 或配置错误）时输出，干净静默。
out="$( (cd "services/$svc" && .venv/bin/mypy --config-file ../../pyproject.toml --follow-imports=skip "$rel") 2>&1 )"
rc=$?
if [[ $rc -eq 0 || -z "$out" ]]; then
  exit 0
fi

echo ""
echo "══ mypy 报告（只读类型检查，无写命令）══"
echo "$out"
echo ""

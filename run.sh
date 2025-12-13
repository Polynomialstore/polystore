#!/usr/bin/env bash
set -euo pipefail

# Maximum attempts per perf step before failing.
MAX_RUNS="${MAX_RUNS:-5}"

prompt_files=(
prompts/01_outline_next_goals.md
prompts/02_detail_plan_and_spec_alignment.md
prompts/03_implement_verify_and_commit.md
)

for prompt_file in "${prompt_files[@]}"; do
  base="$(basename "$prompt_file")"
  if [[ "$base" =~ ^([0-9]+)_ ]]; then
    step_raw="${BASH_REMATCH[1]}"
    step_num=$((10#$step_raw))
  else
    echo "ERROR: Could not parse perf step number from $prompt_file" >&2
    exit 1
  fi

  marker="@PROMPT_$(printf '%02d' "$step_num")_COMPLETE"

  if [[ -f "$marker" ]]; then
    echo "== prompt step $step_num already complete ($marker present); skipping =="
    continue
  fi

  for attempt in $(seq 1 "$MAX_RUNS"); do
    echo "== Running $prompt_file (attempt $attempt/$MAX_RUNS) =="
    npx @openai/codex@latest exec --dangerously-bypass-approvals-and-sandbox "$(cat "$prompt_file")"

    if [[ -f "$marker" ]]; then
      echo "== Perf step $step_num complete ($marker created) =="
      break
    fi

    if [[ "$attempt" -eq "$MAX_RUNS" ]]; then
      echo "ERROR: Perf step $step_num did not complete after $MAX_RUNS attempts." >&2
      exit 1
    fi
  done
done



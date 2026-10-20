#!/usr/bin/env bash
# Lưu/nạp file trạng thái "đã xử lý" (.processed_*.json) ở nhánh riêng `pipeline-state` thay vì main,
# để cập nhật hằng ngày KHÔNG kích hoạt Hostinger redeploy (Hostinger chỉ triển khai nhánh main).
#   pipeline_state.sh load <file-trạng-thái>
#   pipeline_state.sh save <file-trạng-thái>   (đồng thời dọn mọi thay đổi bài/âm thanh đã đẩy lên máy chủ khỏi thư mục làm việc)
set -u
cmd="${1:-}"; file="${2:-}"
cd "$(git rev-parse --show-toplevel)"
git config user.name "github-actions[bot]"; git config user.email "github-actions[bot]@users.noreply.github.com"
if [ "$cmd" = "load" ]; then
  if git fetch origin pipeline-state 2>/dev/null; then git checkout FETCH_HEAD -- "$file" 2>/dev/null && echo "Đã nạp trạng thái từ nhánh pipeline-state"; fi
  exit 0
fi
if [ "$cmd" = "save" ]; then
  tmp="$(mktemp)"; cp "$file" "$tmp"
  git checkout -- backend/data/listening backend/public/audio/listening 2>/dev/null || true
  git clean -fdq backend/data/listening backend/public/audio/listening 2>/dev/null || true
  for i in 1 2 3 4 5; do
    wt="$(mktemp -d)"
    if git fetch origin pipeline-state 2>/dev/null; then
      git worktree add -f -B pipeline-state "$wt" FETCH_HEAD -q
    else
      git worktree add -f --detach "$wt" -q && (cd "$wt" && git checkout -q --orphan pipeline-state && git rm -rfq . 2>/dev/null || true)
    fi
    mkdir -p "$wt/$(dirname "$file")"; cp "$tmp" "$wt/$file"
    (cd "$wt" && git add "$file" && { git diff --cached --quiet && echo "Trạng thái không đổi" && exit 0; git commit -qm "state: $file" && git push -q origin pipeline-state; }) && { git worktree remove --force "$wt"; exit 0; }
    git worktree remove --force "$wt" 2>/dev/null || true
    sleep $((RANDOM % 8 + 3))
  done
  echo "Không lưu được trạng thái" >&2; exit 1
fi

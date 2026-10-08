#!/usr/bin/env bash
# 把本地 master 清洗后同步到 GitHub 公开镜像（Gitee 才是完整历史的真相源）。
#
#   scripts/publish-github.sh              # 清洗 + 扫描 + 推送
#   scripts/publish-github.sh --dry-run    # 清洗 + 扫描，不推送
#
# 清洗规则 **不在仓库里**（规则本身含有要抹掉的字符串，入库等于公开它们）：
#   ${AIDE_PUBLISH_RULES_DIR:-~/.config/aide-publish}/
#     rules.txt      git filter-repo --replace-text / --replace-message 规则
#     mailmap.txt    作者邮箱改写（真实邮箱 → GitHub noreply）
#     forbidden.txt  清洗后全历史不许再出现的 ERE，每行一条；命中即中止、不推送
#
# filter-repo 对同一输入是确定性的：旧提交的哈希不变，所以日常推送是快进；
# 只有规则改了（整段历史重写）才需要 --force。
set -euo pipefail

RULES_DIR="${AIDE_PUBLISH_RULES_DIR:-$HOME/.config/aide-publish}"
REMOTE="${AIDE_PUBLISH_REMOTE:-git@github.com:Nc997321/aide.git}"
BRANCH="${AIDE_PUBLISH_BRANCH:-master}"
DRY_RUN=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

for f in rules.txt mailmap.txt forbidden.txt; do
  [ -f "$RULES_DIR/$f" ] || { echo "缺少 $RULES_DIR/$f" >&2; exit 1; }
done
command -v git-filter-repo >/dev/null || {
  echo "需要 git-filter-repo：pipx install git-filter-repo（或 pip install --user git-filter-repo）" >&2
  exit 1
}

SRC="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ 克隆 $BRANCH 到临时目录并清洗…"
git clone -q --no-local --single-branch --branch "$BRANCH" "$SRC" "$WORK/repo"
cd "$WORK/repo"
git filter-repo --quiet \
  --replace-text "$RULES_DIR/rules.txt" \
  --replace-message "$RULES_DIR/rules.txt" \
  --mailmap "$RULES_DIR/mailmap.txt"

echo "→ 扫描全历史（内容 + 作者 + 提交信息）…"
git log --all -p --format='%an <%ae> %cn <%ce>%n%B' > "$WORK/full.txt"
leaks=0
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  n=$(grep -cE -- "$pat" "$WORK/full.txt" || true)
  if [ "$n" -gt 0 ]; then
    echo "  ✗ 命中 $n 处：$pat" >&2
    leaks=1
  fi
done < "$RULES_DIR/forbidden.txt"
[ "$leaks" -eq 0 ] || { echo "清洗后仍有敏感串，已中止，未推送。" >&2; exit 1; }
echo "  ✓ 无残留"

NEW="$(git rev-parse HEAD)"
git remote add github "$REMOTE"
OLD="$(git ls-remote github "refs/heads/$BRANCH" | cut -f1)"
echo "→ 远端 ${OLD:-<空>}  本次 $NEW"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run：不推送。"
  exit 0
fi
if [ "$OLD" = "$NEW" ]; then
  echo "已是最新。"
  exit 0
fi

if [ -z "$OLD" ]; then
  git push github "$BRANCH:$BRANCH"
else
  git fetch -q github "$BRANCH"
  if git merge-base --is-ancestor "$OLD" "$NEW"; then
    git push github "$BRANCH:$BRANCH"
  elif [ "$FORCE" -eq 1 ]; then
    git push github "$BRANCH:$BRANCH" --force-with-lease="$BRANCH:$OLD"
  else
    echo "远端不是本次历史的祖先（规则改过，或远端被别处改动）。确认后加 --force。" >&2
    exit 1
  fi
fi

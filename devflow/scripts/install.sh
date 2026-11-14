#!/usr/bin/env bash
# Install the devflow pack into a Java repository.
#
#   devflow/scripts/install.sh <target-repo> [--link] [--force]
#
#   --link   symlink the pack instead of copying it (edits to this checkout are live)
#   --force  replace an existing <target>/.archon/workflows/devflow (only that directory)
#
# Writes, never overwriting an existing file:
#   <target>/.archon/workflows/devflow        the pack (copy or symlink)
#   <target>/.archon/config.yaml              from templates/archon-repo-config.yaml
#   <target>/.archon/packs/devflow.yaml       from templates/packs-devflow.yaml
#   <target>/.git/info/exclude                gains `.archon/` unless .archon is tracked or ignored
# Nothing under ~/.archon is touched; the home config is a printed next step.
set -euo pipefail

usage() { echo "usage: $0 <target-repo> [--link] [--force]" >&2; exit 2; }

TARGET=""
LINK=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) [ -z "$TARGET" ] || usage; TARGET="$arg" ;;
  esac
done
[ -n "$TARGET" ] || usage

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVFLOW="$(cd "$HERE/.." && pwd)"
PACK_SRC="$DEVFLOW/pack/devflow"
TEMPLATES="$DEVFLOW/templates"

[ -d "$TARGET" ] || { echo "refusing: $TARGET is not a directory" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd -P)"
TOP="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$TOP" ] || [ "$(cd "$TOP" && pwd -P)" != "$TARGET" ]; then
  echo "refusing: $TARGET is not the root of a git work tree" >&2
  exit 1
fi
[ -f "$PACK_SRC/.pack/pack.yaml" ] || { echo "refusing: pack source $PACK_SRC is incomplete" >&2; exit 1; }

say() { printf '  %-8s %s\n' "$1" "$2"; }
echo "devflow install -> $TARGET"

# --- the pack ------------------------------------------------------------------------
DEST="$TARGET/.archon/workflows/devflow"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "refusing: $DEST already exists; pass --force to replace that directory (nothing else is removed)" >&2
    exit 1
  fi
  # No trailing slash: a symlinked pack loses only the link, never the files it points at.
  rm -rf -- "$DEST"
  say removed "$DEST (--force)"
fi
mkdir -p "$TARGET/.archon/workflows"
if [ "$LINK" -eq 1 ]; then
  ln -s "$PACK_SRC" "$DEST"
  say linked "$DEST -> $PACK_SRC"
else
  cp -R "$PACK_SRC" "$DEST"
  say copied "$PACK_SRC -> $DEST"
fi

# --- templates -----------------------------------------------------------------------
# write_new <template> <dest> <sed-script>: create dest from the template, or leave an
# existing file alone and print how to compare it.
write_new() {
  local template="$1" dest="$2" script="$3" rendered
  rendered="$(sed -e "$script" "$template")"
  if [ -e "$dest" ]; then
    if [ "$rendered" = "$(cat "$dest")" ]; then
      say same "$dest"
    else
      say kept "$dest (exists; compare: diff -u '$dest' '$template')"
    fi
    return
  fi
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$rendered" > "$dest"
  say wrote "$dest"
}

# origin/HEAD names the remote's default branch without a network call. When it is
# unknown the line stays commented and Archon detects the base branch itself.
BASE="$(git -C "$TARGET" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
BASE="${BASE#origin/}"
if [ -n "$BASE" ]; then
  # A refname may contain `&` or `|`, which sed's replacement would interpret.
  BASE_SCRIPT="s|__BASE_BRANCH__|$(printf '%s' "$BASE" | sed 's/[&|\\]/\\&/g')|"
else
  BASE_SCRIPT='s|^\(  \)baseBranch: __BASE_BRANCH__|\1# baseBranch: main   # origin/HEAD unknown at install: set this|'
  say warn "origin/HEAD is not set; run 'git -C $TARGET remote set-head origin --auto' or set worktree.baseBranch by hand"
fi
write_new "$TEMPLATES/archon-repo-config.yaml" "$TARGET/.archon/config.yaml" "$BASE_SCRIPT"
if ! grep -q '\.archon/packs' "$TARGET/.archon/config.yaml"; then
  say warn "$TARGET/.archon/config.yaml has no worktree.copyFiles entry for .archon/packs/; devflow-deliver worktrees will not see the pack settings"
fi

if [ -x "$TARGET/mvnw" ]; then MVN='./mvnw'; else MVN='mvn'; fi
write_new "$TEMPLATES/packs-devflow.yaml" "$TARGET/.archon/packs/devflow.yaml" "s|__MVN__|$MVN|g"

# --- keep .archon/ out of git status ---------------------------------------------------
EXCLUDE="$(git -C "$TARGET" rev-parse --path-format=absolute --git-path info/exclude)"
if [ -n "$(git -C "$TARGET" ls-files -- .archon | head -n 1)" ]; then
  say skip "$EXCLUDE: .archon/ has tracked files; the pack and settings files show as untracked until you commit or ignore them"
elif git -C "$TARGET" check-ignore -q .archon/; then
  say skip "$EXCLUDE: .archon/ is already ignored"
else
  mkdir -p "$(dirname "$EXCLUDE")"
  printf '.archon/\n' >> "$EXCLUDE"
  say appended "'.archon/' to $EXCLUDE"
fi

cat <<EOF

Next steps
  1. Review $TARGET/.archon/packs/devflow.yaml (checkstyle_cmd, jira_view_cmd, copilot_mode,
     required_checks, ui_hint/api_hint) and worktree.baseBranch in $TARGET/.archon/config.yaml.
  2. Define the four model aliases in ~/.archon/config.yaml (merge from
     $TEMPLATES/archon-home-config.yaml), or run:
       archon ai alias set @devflow-main claude opus
       archon ai alias set @devflow-fast claude sonnet
       archon ai alias set @devflow-ci claude sonnet
       archon ai alias set @devflow-cross pi <pi-provider>/<model-id>
     @devflow-cross should be another vendor through Pi (check the ref with
     pi --list-models <model-id>); without Pi, 'claude sonnet' works, but then Claude
     reviews Claude's work.
     Secrets go in ~/.archon/.env: see $TEMPLATES/archon-home-env.example.
  3. Check the machine:   $DEVFLOW/scripts/doctor.sh
  4. Check this repo:     cd $TARGET && archon validate workflows devflow-smoke
                          archon workflow run devflow-smoke [--input key=<JIRA-KEY>]
EOF

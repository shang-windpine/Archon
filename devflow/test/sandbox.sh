#!/usr/bin/env bash
# Build a disposable sandbox for exercising the devflow pack without touching a real project.
#
#   devflow/test/sandbox.sh [--copy] [SANDBOX_ROOT]     (default /tmp/devflow-sandbox)
#
# Creates:
#   $ROOT/remote.git        bare git remote (stands in for GitHub; forge ops will NOT work against it)
#   $ROOT/repo              a tiny Maven project, `origin` -> remote.git, branch main pushed
#   $ROOT/home              an isolated ARCHON_HOME with config.yaml defining the devflow aliases
#   $ROOT/env.sh            `source` it to point the Archon CLI at the sandbox
# The pack is symlinked into repo/.archon/workflows/devflow so edits are live. `--copy`
# copies it instead: `archon workflow test` discovers fixtures without following
# symlinks, so fixtures only run against a copied pack (re-run the script after edits).
# Re-running deletes and recreates $ROOT.
set -euo pipefail

COPY=0
if [ "${1:-}" = "--copy" ]; then COPY=1; shift; fi
ROOT="${1:-/tmp/devflow-sandbox}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVFLOW="$(cd "$HERE/.." && pwd)"
ARCHON_ROOT="$(cd "$DEVFLOW/.." && pwd)"

case "$ROOT" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing: SANDBOX_ROOT must live under /tmp (got $ROOT)" >&2; exit 1 ;;
esac

rm -rf "$ROOT"
mkdir -p "$ROOT/home" "$ROOT/repo"
git init -q --bare -b main "$ROOT/remote.git"

cd "$ROOT/repo"
git init -q -b main
git config user.email devflow-sandbox@example.invalid
git config user.name "devflow sandbox"
mkdir -p src/main/java/com/example/demo src/test/java/com/example/demo
cat > pom.xml <<'POM'
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
POM
cat > src/main/java/com/example/demo/Greeter.java <<'JAVA'
package com.example.demo;

/** Builds greetings for users. */
public final class Greeter {
    private Greeter() {
    }

    /** Returns a greeting for the given name. */
    public static String greet(String name) {
        return "Hello, " + name;
    }
}
JAVA
cat > AGENTS.md <<'MD'
# demo

Tiny sandbox project used to exercise the devflow Archon pack. `Greeter` is the only class.
MD
git add -A
git commit -q -m "init sandbox project"
git remote add origin "$ROOT/remote.git"
git push -q -u origin main
git remote set-head origin main

mkdir -p .archon/workflows .archon/packs
if [ "$COPY" -eq 1 ]; then
  cp -R "$DEVFLOW/pack/devflow" .archon/workflows/devflow
else
  ln -s "$DEVFLOW/pack/devflow" .archon/workflows/devflow
fi
printf '.archon/\n' >> .git/info/exclude
cat > .archon/config.yaml <<'YAML'
assistant: claude
worktree:
  baseBranch: main
  copyFiles: [.archon/packs/]
YAML
cat > .archon/packs/devflow.yaml <<'YAML'
settings:
  # The sandbox has no Jira and no checkstyle plugin: stub both.
  jira_view_cmd: ""
  checkstyle_cmd: "true"
YAML

cat > "$ROOT/home/config.yaml" <<'YAML'
defaultAssistant: claude
aliases:
  '@devflow-main': { provider: claude, model: sonnet }
  '@devflow-fast': { provider: claude, model: haiku }
  '@devflow-ci': { provider: claude, model: haiku }
  '@devflow-cross': { provider: claude, model: haiku }
YAML

cat > "$ROOT/env.sh" <<ENV
# source me
export ARCHON_HOME="$ROOT/home"
export ARCHON_TELEMETRY_DISABLED=1
export DEVFLOW_SANDBOX_REPO="$ROOT/repo"
archon() { bun "$ARCHON_ROOT/packages/cli/src/cli.ts" "\$@"; }
ENV

echo "sandbox ready: $ROOT"
echo "  source $ROOT/env.sh && cd $ROOT/repo && archon validate workflows --json"

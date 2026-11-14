#!/usr/bin/env bash
# Check a work machine's prerequisites for the devflow pack. It runs version, status
# and list commands, and never writes a config or credential. One side effect it cannot
# avoid: the `archon doctor` it calls creates or opens $ARCHON_HOME/archon.db (with its
# -shm/-wal files). It skips the Archon checks when ARCHON_HOME has no config.yaml,
# because Archon would create one.
#
#   devflow/scripts/doctor.sh
#
# Env: ARCHON_HOME (default ~/.archon); ARCHON_CLI to name the Archon command
# (default: `archon` on PATH, else this checkout's packages/cli/src/cli.ts via bun).
# Prints one PASS/WARN/FAIL line per check, with a fix hint under each WARN/FAIL.
# Exits 1 when any check fails. For one repository's forge, Jira and model access,
# run the devflow-smoke workflow there.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHON_SRC="$(cd "$HERE/../.." && pwd)"
HOME_DIR="${ARCHON_HOME:-$HOME/.archon}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
GH_COPILOT_MIN="2.88.0"
GIT_MIN="2.38.0"
ROLES="@devflow-main @devflow-fast @devflow-ci @devflow-cross"

FAILS=0
WARNS=0
report() { # report <PASS|WARN|FAIL> <check> <detail> [fix]
  printf '%-4s  %-18s %s\n' "$1" "$2" "$3"
  if [ "$1" != PASS ] && [ -n "${4:-}" ]; then printf '      %-18s fix: %s\n' '' "$4"; fi
  case "$1" in FAIL) FAILS=$((FAILS + 1)) ;; WARN) WARNS=$((WARNS + 1)) ;; esac
}

# Runs a command with a time limit; tools that call the network must not hang the doctor.
with_timeout() { local seconds="$1"; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"; }

# The first major.minor[.patch] in a tool's version banner.
version_of() { grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1; }

# version_cmp A B: prints -1, 0 or 1.
version_cmp() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    if [ "$x" -lt "$y" ]; then echo -1; return; fi
    if [ "$x" -gt "$y" ]; then echo 1; return; fi
  done
  echo 0
}

have() { command -v "$1" >/dev/null 2>&1; }

echo "devflow doctor (ARCHON_HOME=$HOME_DIR)"
echo

# --- bun -------------------------------------------------------------------------------
if ! have bun; then
  report FAIL bun "not on PATH" "Install bun (https://bun.sh); Archon's script nodes run on it."
else
  BUN_V="$(bun --version 2>/dev/null | version_of)"
  WANT=""
  if [ -f "$ARCHON_SRC/package.json" ] && [ -f "$ARCHON_SRC/packages/cli/src/cli.ts" ]; then
    WANT="$(bun -e 'const p = await Bun.file(process.argv[1]).json(); console.log(p.engines?.bun ?? "")' "$ARCHON_SRC/package.json" 2>/dev/null)"
  fi
  WANT_V="$(printf '%s' "$WANT" | version_of)"
  if [ -z "$WANT_V" ]; then
    report PASS bun "$BUN_V (no Archon source checkout here to compare engines with)"
  else
    case "$(version_cmp "$BUN_V" "$WANT_V")" in
      0) report PASS bun "$BUN_V (Archon engines: $WANT)" ;;
      1) report WARN bun "$BUN_V is newer than Archon's engines pin $WANT" "Usually fine; if Archon misbehaves, install bun $WANT_V (curl -fsSL https://bun.sh/install | bash -s bun-v$WANT_V)." ;;
      *) report FAIL bun "$BUN_V is older than Archon's engines pin $WANT" "bun upgrade (or install bun $WANT_V)." ;;
    esac
  fi
fi

# --- git -------------------------------------------------------------------------------
# devflow-deliver's await checks base conflicts with `git merge-tree --write-tree` (2.38+).
if ! have git; then
  report FAIL git "not on PATH" "Install git $GIT_MIN or newer."
else
  GIT_V="$(git --version | version_of)"
  if [ -z "$GIT_V" ]; then
    report WARN git "\`git --version\` printed no version" "Check that git is $GIT_MIN or newer."
  elif [ "$(version_cmp "$GIT_V" "$GIT_MIN")" -lt 0 ]; then
    report FAIL git "$GIT_V is older than $GIT_MIN (no git merge-tree --write-tree)" "Upgrade git; devflow-deliver needs it to check conflicts with the base branch."
  else
    report PASS git "$GIT_V"
  fi
fi

# --- gh --------------------------------------------------------------------------------
if ! have gh; then
  report FAIL gh "not on PATH" "Install the GitHub CLI (https://cli.github.com), then gh auth login."
else
  GH_V="$(gh --version 2>/dev/null | version_of)"
  if [ "$(version_cmp "$GH_V" "$GH_COPILOT_MIN")" -lt 0 ]; then
    # Only copilot_mode: request needs it, and that is a per-repository setting the doctor
    # cannot see; devflow-smoke in the repository fails on it when it matters.
    report WARN gh "$GH_V is older than $GH_COPILOT_MIN (no --add-reviewer @copilot)" "Matters only with copilot_mode: request (the default), which then fails: upgrade gh, or set copilot_mode: auto|off in the repo's .archon/packs/devflow.yaml."
  else
    report PASS gh "$GH_V"
  fi
  # Any host: the repository's host is per repository, and devflow-smoke checks that one.
  if with_timeout 20 gh auth status >/dev/null 2>&1; then
    report PASS "gh auth" "logged in (devflow-smoke checks the repository's host)"
  elif [ -f "$HOME_DIR/.env" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?GH_TOKEN=.+' "$HOME_DIR/.env"; then
    report WARN "gh auth" "gh is not logged in; GH_TOKEN is set in $HOME_DIR/.env" "Fine for the forge plugin; gh itself (Copilot review requests) also needs it: gh auth login."
  else
    report FAIL "gh auth" "gh is not logged in" "gh auth login"
  fi
fi

# --- ~/.archon/.env pitfalls (key names only; values are never read out) ---------------
if [ -f "$HOME_DIR/.env" ]; then
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?GH_TOKEN=[[:space:]]*$' "$HOME_DIR/.env"; then
    report FAIL "archon .env" "$HOME_DIR/.env has an empty GH_TOKEN= line" "Delete the line: an empty GH_TOKEN refuses forge operations instead of falling back to gh."
  fi
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=.+' "$HOME_DIR/.env"; then
    report WARN "archon .env" "ANTHROPIC_API_KEY is set in $HOME_DIR/.env" "It moves Claude nodes from your subscription to API billing; remove it unless that is intended."
  fi
fi

# --- claude ----------------------------------------------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  report WARN "claude env" "ANTHROPIC_API_KEY is set in this shell" "Claude nodes would bill the API instead of your subscription; unset it unless intended."
fi
if ! have claude; then
  report WARN claude "claude CLI not on PATH" "Install Claude Code and run claude, then /login. A source checkout of Archon still runs Claude through the SDK, but the login lives in the CLI."
else
  CLAUDE_AUTH="$(with_timeout 30 claude auth status --json 2>/dev/null)"
  LOGGED="$(printf '%s' "$CLAUDE_AUTH" | bun -e 'try { const j = JSON.parse(await Bun.stdin.text()); console.log(j.loggedIn === true ? `yes ${j.authMethod ?? ""}` : "no") } catch { console.log("unknown") }' 2>/dev/null)"
  case "$LOGGED" in
    yes*) report PASS claude "logged in (${LOGGED#yes })" ;;
    no) report FAIL claude "not logged in" "Run claude, then /login (or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token in $HOME_DIR/.env)." ;;
    *) report WARN claude "claude auth status gave no answer" "Run claude auth status by hand." ;;
  esac
fi

# --- Archon CLI ------------------------------------------------------------------------
if [ -n "${ARCHON_CLI:-}" ]; then
  # shellcheck disable=SC2206
  ARCHON=($ARCHON_CLI)
elif have archon; then
  ARCHON=(archon)
elif [ -f "$ARCHON_SRC/packages/cli/src/cli.ts" ] && have bun; then
  ARCHON=(bun "$ARCHON_SRC/packages/cli/src/cli.ts")
else
  ARCHON=()
fi
# Telemetry off: it is the only thing `archon version` writes (marker files in ARCHON_HOME).
[ "${#ARCHON[@]}" -gt 0 ] && ARCHON=(env ARCHON_TELEMETRY_DISABLED=1 "${ARCHON[@]}")
ARCHON_OK=0
if [ "${#ARCHON[@]}" -eq 0 ]; then
  report FAIL archon "no Archon CLI found" "Put archon on PATH, or set ARCHON_CLI='bun /path/to/Archon/packages/cli/src/cli.ts'."
elif ARCHON_V="$(with_timeout 60 "${ARCHON[@]}" version 2>/dev/null | head -n 1)" && [ -n "$ARCHON_V" ]; then
  report PASS archon "$ARCHON_V (${ARCHON[*]:2})"
  ARCHON_OK=1
else
  report FAIL archon "\`${ARCHON[*]} version\` failed" "Run it by hand; a source checkout needs bun install first."
fi

# --- ARCHON_HOME config and the four aliases --------------------------------------------
PI_ALIASES=""
PI_REFS=""
MAIN_TARGET=""
CROSS_TARGET=""
if [ ! -f "$HOME_DIR/config.yaml" ]; then
  # Archon creates a default config on first use; the doctor does not, so nothing is written.
  report FAIL "archon config" "$HOME_DIR/config.yaml does not exist" "Copy devflow/templates/archon-home-config.yaml there (or merge its aliases: block)."
elif [ "$ARCHON_OK" -eq 1 ]; then
  if with_timeout 120 "${ARCHON[@]}" doctor >/dev/null 2>&1; then
    report PASS "archon doctor" "all checks passed"
  else
    report FAIL "archon doctor" "reported a failure" "Run ${ARCHON[*]} doctor and fix what it names."
  fi
  ALIASES_JSON="$(with_timeout 60 "${ARCHON[@]}" ai alias list --json 2>/dev/null)"
  # One line per role: "<alias> <provider>/<model>" or "<alias> MISSING".
  ROLE_LINES="$(printf '%s' "$ALIASES_JSON" | bun -e '
    let list = [];
    try { list = JSON.parse(await Bun.stdin.text()).aliases ?? []; } catch { console.log("UNREADABLE"); process.exitCode = 0; }
    for (const role of process.argv.slice(1)) {
      const hit = list.find(a => a.name === role)?.effective;
      console.log(hit ? `${role} ${hit.provider}/${hit.model}` : `${role} MISSING`);
    }' $ROLES 2>/dev/null)"
  if [ "$ROLE_LINES" = "UNREADABLE" ] || [ -z "$ROLE_LINES" ]; then
    report FAIL aliases "\`archon ai alias list --json\` gave no readable answer" "Run ${ARCHON[*]} ai alias list."
  else
    while read -r role target; do
      [ "$role" = UNREADABLE ] && continue
      if [ "$target" = MISSING ]; then
        case "$role" in
          @devflow-cross) FIX="archon ai alias set $role pi <pi-provider>/<model-id>   (no Pi: claude sonnet works, at a cost; see devflow/templates/archon-home-config.yaml)" ;;
          @devflow-main) FIX="archon ai alias set $role claude opus   (see devflow/templates/archon-home-config.yaml)" ;;
          *) FIX="archon ai alias set $role claude sonnet   (see devflow/templates/archon-home-config.yaml)" ;;
        esac
        report FAIL "$role" "not defined" "$FIX"
      else
        report PASS "$role" "$target"
        case "$target" in pi/*) PI_ALIASES="$PI_ALIASES $role"; PI_REFS="$PI_REFS $role=${target#pi/}" ;; esac
        case "$role" in
          @devflow-main) MAIN_TARGET="$target" ;;
          @devflow-cross) CROSS_TARGET="$target" ;;
        esac
      fi
    done <<< "$ROLE_LINES"
    # Review nodes start fresh sessions either way; a second vendor is what makes the
    # review a second opinion (DESIGN §4). Only a same-vendor pair the doctor can prove
    # is reported: one non-Pi provider (each serves one vendor's models), or the same
    # Pi model ref. A Pi ref names a gateway, not a vendor, so other pairs say nothing.
    MAIN_PROVIDER="${MAIN_TARGET%%/*}"
    if [ -n "$MAIN_TARGET" ] && [ -n "$CROSS_TARGET" ]; then
      if [ "$MAIN_TARGET" = "$CROSS_TARGET" ]; then
        report WARN "cross vendor" "@devflow-cross is the same model as @devflow-main ($CROSS_TARGET)" "Works (reviewers get a fresh session), but a model reviewing its own work agrees more; point @devflow-cross at another vendor's model, through Pi: archon ai alias set @devflow-cross pi <pi-provider>/<model-id>."
      elif [ "$MAIN_PROVIDER" != pi ] && [ "$MAIN_PROVIDER" = "${CROSS_TARGET%%/*}" ]; then
        report WARN "cross vendor" "@devflow-cross and @devflow-main both run on $MAIN_PROVIDER, so on one vendor's models" "Works (reviewers get a fresh session), but a model reviewing its own vendor's work agrees more; use Pi with another vendor's model: archon ai alias set @devflow-cross pi <pi-provider>/<model-id>."
      fi
    fi
  fi
fi

# --- pi --------------------------------------------------------------------------------
# Pi matters only when a devflow alias runs on it; Archon embeds the Pi SDK, so the CLI
# is needed only for `pi /login` and `pi update --models`.
if [ -z "$PI_ALIASES" ]; then
  report PASS pi "not needed (no devflow alias uses pi)$(have pi && printf '; pi %s installed' "$(pi --version 2>/dev/null | version_of)")"
else
  if have pi; then
    report PASS pi "$(pi --version 2>/dev/null | version_of) (aliases on pi:$PI_ALIASES)"
  else
    report WARN pi "pi CLI not on PATH (aliases on pi:$PI_ALIASES)" "npm install -g @earendil-works/pi-coding-agent, for pi /login and pi update --models."
  fi
  FOUND=""
  [ -f "$PI_DIR/auth.json" ] && FOUND="auth.json"
  [ -f "$PI_DIR/models.json" ] && FOUND="${FOUND:+$FOUND, }models.json"
  if [ -n "$FOUND" ]; then
    report PASS "pi config" "$PI_DIR: $FOUND"
  else
    report FAIL "pi config" "no auth.json or models.json in $PI_DIR" "pi then /login, or add a gateway to $PI_DIR/models.json (devflow/templates/pi-models.example.json)."
  fi
  # A YAML parse, not a line match: `archon ai alias set` rewrites the file in flow style
  # ({assistants: {pi: {enableExtensions: false}}, ...}).
  if [ -f "$HOME_DIR/config.yaml" ]; then
    EXT="$(bun -e '
      try {
        const doc = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
        const value = doc?.assistants?.pi?.enableExtensions;
        console.log(value === false ? "off" : value === undefined ? "unset" : `${value}`);
      } catch { console.log("unreadable"); }' "$HOME_DIR/config.yaml" 2>/dev/null)"
    case "$EXT" in
      off) report PASS "pi extensions" "assistants.pi.enableExtensions: false" ;;
      unreadable|"") report WARN "pi extensions" "could not parse $HOME_DIR/config.yaml" "Run ${ARCHON[*]:-archon} doctor; Archon reports a config it cannot load." ;;
      *) report WARN "pi extensions" "assistants.pi.enableExtensions is $EXT in $HOME_DIR/config.yaml (Pi loads extensions unless it is false)" "Unattended devflow nodes should not load Pi extensions; set assistants.pi.enableExtensions: false (devflow/templates/archon-home-config.yaml)." ;;
    esac
  fi
  # Each Pi ref must be a model Pi lists: <pi-provider>/<model-id>, compared exactly
  # against the provider and model columns (`--list-models` searches fuzzily).
  for entry in $PI_REFS; do
    role="${entry%%=*}"; ref="${entry#*=}"
    if ! have pi; then
      report WARN "${role#@devflow-} model" "pi CLI not on PATH; $ref not checked" "Install the pi CLI, then pi --list-models '${ref#*/}' must list provider ${ref%%/*}."
      continue
    fi
    LISTED="$(with_timeout 60 pi --list-models "${ref#*/}" 2>/dev/null)"
    if [ -z "$LISTED" ]; then
      report WARN "${role#@devflow-} model" "pi --list-models gave no answer for $ref" "Run pi --list-models '${ref#*/}' by hand."
    elif printf '%s\n' "$LISTED" | awk -v p="${ref%%/*}" -v m="${ref#*/}" '$1 == p && $2 == m { found = 1 } END { exit !found }'; then
      report PASS "${role#@devflow-} model" "pi lists $ref"
    else
      report FAIL "${role#@devflow-} model" "pi does not list $ref" "The ref is <pi-provider>/<model-id> as pi --list-models shows them (provider column, then model column); fix it with archon ai alias set $role pi <pi-provider>/<model-id>."
    fi
  done
fi

# --- jira-cli --------------------------------------------------------------------------
# Machine-level: whether a repository uses Jira is its jira_view_cmd setting, which the
# doctor does not read (devflow-smoke in the repository does). These WARNs stay even
# when no repository uses Jira.
if ! have jira; then
  report WARN jira "jira-cli not on PATH" "Ignore if jira_view_cmd is empty in your repo's .archon/packs/devflow.yaml. Otherwise install https://github.com/ankitpokhrel/jira-cli and run jira init."
elif with_timeout 30 jira me >/dev/null 2>&1; then
  report PASS jira "$(jira version 2>/dev/null | version_of), jira me answered"
else
  report WARN jira "jira me failed" "Ignore if jira_view_cmd is empty in your repo. Otherwise run jira init (server, login, API token via JIRA_API_TOKEN or the keychain), then jira me."
fi

# --- Maven and Java --------------------------------------------------------------------
if have mvn; then
  report PASS mvn "$(mvn -v 2>/dev/null | version_of)"
else
  report WARN mvn "mvn not on PATH" "Fine when the repository has ./mvnw; otherwise install Maven."
fi
if have java; then
  report PASS java "$(java -version 2>&1 | version_of)"
else
  report FAIL java "java not on PATH" "Install the JDK the project builds with; Maven and ./mvnw both need it."
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "doctor: $FAILS FAIL, $WARNS WARN"
  exit 1
fi
echo "doctor: OK ($WARNS WARN). Next: run the devflow-smoke workflow in the repository."

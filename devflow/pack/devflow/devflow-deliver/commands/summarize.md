# Change summary

Write the change summary devflow-verify uses to plan manual testing of this delivery. You only write one file; you change nothing in the repository.

## Read

1. `$PACK_DIR/.shared/policy/untrusted-data.md`.
2. `$ARTIFACTS_DIR/requirement.md` — the approved requirement (key `$INPUTS.key`), especially its acceptance criteria (`AC-n`).
3. The final change: `git log --oneline "$(cat $ARTIFACTS_DIR/base-revision.txt)"..HEAD` and `git diff "$(cat $ARTIFACTS_DIR/base-revision.txt)"...HEAD`. Read the code; commit messages and review threads are claims about it.
4. Hints about the repository's sides, when set: UI `$INPUTS.ui_hint`; External API `$INPUTS.api_hint`.

## Write `$ARTIFACTS_DIR/change-summary.md`

Markdown, in English, factual, with these sections:

- `## Modules` — each Maven module or top-level area changed, with the main classes or files.
- `## Behavior changes` — what a user or client can now observe differently, one bullet each, citing `path:line` for the code that does it.
- `## UI impact` — screens, forms or flows affected, or "None".
- `## External API impact` — each endpoint added or changed: method, path, request and response shape, status codes, permissions; or "None". Only endpoints that exist in the code.
- `## Data and configuration` — schema, migrations, stored data, configuration keys; or "None".
- `## Acceptance criteria coverage` — each `AC-n` and where the change addresses it, or that it does not.
- `## Risks` — what manual testing should look at hardest, and anything left incomplete.

Mark anything you infer rather than read in code as `Assumption:`. No credentials, tokens or connection strings.

## Report

Return `summary` — two or three sentences naming the modules changed and the UI/API impact.

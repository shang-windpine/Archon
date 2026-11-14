# Plan the manual UI test

Write the **UI** section of a manual test plan that a person runs against a local build they start and configure themselves. Another planner covers the External API; do not plan API calls here.

First read `$PACK_DIR/.shared/policy/untrusted-data.md` and follow it, then read `$PACK_DIR/.shared/policy/test-plan-format.md`: it is the format and rule set for this plan, and it wins over anything below that seems to differ.

## Read

1. `$INPUTS.context_path` — the change under test: where its code is, how to read it (it may be on another branch than the working tree), its changed files, and warnings.
2. `$INPUTS.requirement_path` — the approved requirement. Plan every acceptance criterion tagged `[UI]`, and any other criterion whose effect a UI user observes.
3. `$INPUTS.change_summary_path` — the delivery's change summary, when this path is not empty.
4. The project's guidance: `$INPUTS.project_notes` when it is not empty, otherwise the repository's own guidance files.
5. The code: the pages, components, routes, labels, permission checks and data the changed files touch, so steps use the labels a tester sees on screen and preconditions name data the product really has.

Why this change was classified as touching the UI: $INPUTS.classify_reason
Operator hint for the UI side (may be empty): $INPUTS.ui_hint

## Rules

- Preconditions are **test data only**: users and roles, permission groups, blank forms or templates, records in a given state, files to upload. Say how to create each item (UI path, API call, or SQL only where the repository shows the table, citing `path:line`). Never tell the tester how to start, build, deploy or configure anything; that is their job.
- Smoke level: the main path of each criterion and its most important error or permission path.
- Expected results must be observable. Cite `path:line` for any label, message or rule you take from the code.
- Never invent a screen, label or field the repository does not show. When the code does not show how to reach something, say so in the case.
- Do not run builds, tests or services, and do not edit any repository file.

## Write

Write the section to `$ARTIFACTS_DIR/plan-ui.md`, starting with the heading `## UI`, then the coverage list, then the cases, each headed exactly `### UI-<n> — <title>`, numbered from `UI-1` without gaps.

## Answer

- `cases` — one entry per case in the file, in order: `id` (`UI-1`, `UI-2`, ...; exactly the IDs in the headings), `title` (the heading's title, one line), `criterion` (the acceptance criteria it covers, such as `AC-2` or `AC-2, AC-4`; empty only when none applies).
- `summary` — one or two sentences: how many cases, which criteria they cover, and any `[UI]` criterion you could not plan, with why.

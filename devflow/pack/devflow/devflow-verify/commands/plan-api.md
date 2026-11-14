# Plan the manual External API test

Write the **External API** section of a manual test plan that a person runs against a local build they start and configure themselves. Another planner covers the UI; do not plan screens here.

First read `$PACK_DIR/.shared/policy/untrusted-data.md` and follow it, then read `$PACK_DIR/.shared/policy/test-plan-format.md`: it is the format and rule set for this plan, and it wins over anything below that seems to differ.

## Read

1. `$INPUTS.context_path` — the change under test: where its code is, how to read it (it may be on another branch than the working tree), its changed files, and warnings.
2. `$INPUTS.requirement_path` — the approved requirement. Plan every acceptance criterion tagged `[API]`, and any other criterion an external client of the service observes.
3. `$INPUTS.change_summary_path` — the delivery's change summary, when this path is not empty.
4. The project's guidance: `$INPUTS.project_notes` when it is not empty, otherwise the repository's own guidance files.
5. The code: controllers, route definitions, OpenAPI specs, DTOs, validation, security configuration and the data the changed endpoints read or write. Every method, path, header and body shape in the plan comes from there.

Why this change was classified as touching the External API: $INPUTS.classify_reason
Operator hint for the External API side (may be empty): $INPUTS.api_hint

## Rules

- Preconditions are **test data only**: users and tokens' roles, permission groups, records in a given state, templates. Say how to create each item (UI path, API call, or SQL only where the repository shows the table, citing `path:line`). Never tell the tester how to start, build, deploy or configure anything, and never list ports, profiles or environment variables; that is their job.
- Each case gives method, path, headers and body with placeholders (`$BASE_URL`, `$TOKEN`, `<id from data-item>`), a curl example, and the expected status code, response shape and side effect, citing the `path:line` of the controller, spec or DTO it comes from.
- Cover the main path, the permission path (missing or insufficient token) and the main validation error of each criterion.
- Never invent an endpoint, field or status code the repository does not show. Never write a real credential; use placeholders.
- Do not run builds, tests or services, do not call any endpoint, and do not edit any repository file.

## Write

Write the section to `$ARTIFACTS_DIR/plan-api.md`, starting with the heading `## External API`, then the coverage list, then the cases, each headed exactly `### API-<n> — <title>`, numbered from `API-1` without gaps.

## Answer

- `cases` — one entry per case in the file, in order: `id` (`API-1`, `API-2`, ...; exactly the IDs in the headings), `title` (the heading's title, one line), `criterion` (the acceptance criteria it covers, such as `AC-3`; empty only when none applies).
- `summary` — one or two sentences: how many cases, which criteria they cover, and any `[API]` criterion you could not plan, with why.

# Manual test plan format

`devflow-verify` writes a manual test plan a person runs against a local build they start
themselves. Write in English, one section per side, and cover every `[UI]` and `[API]`
acceptance criterion of `requirement.md` for the side you plan. Read
`$PACK_DIR/.shared/policy/untrusted-data.md` first.

## What a plan contains

- A section `## UI` or `## External API`, only for the side you are asked to plan.
- A short coverage list: each acceptance criterion of that side and the case IDs that test
  it. A criterion you cannot test manually is listed with the reason.
- The cases, in order. Each case ID is the side prefix and a number, unique in the plan:
  `UI-1`, `UI-2`, ... or `API-1`, `API-2`, ... Never reuse or renumber an ID within a plan.
- Each case starts with a heading line of exactly `### <ID> — <title>`.

## Preconditions are test data only

Preconditions list the data the case needs, never environment setup. The tester already
has the service running, configured and reachable; do not tell them how to start, build,
configure or deploy anything, and do not list environment variables, ports or profiles.

Test data is: users and their roles, permission groups and memberships, blank forms or
templates, records in a given state, files to upload, feature-flag values stored as data.
For each item, say how to create it, using the way the repository shows:

- through the UI (menu path and fields);
- through an API call (method, path and body, as below);
- through SQL, only when the repository shows the table (an entity, mapper or migration);
  cite the `path:line` that shows it.

Give each data item a short name (for example `user-editor`, `form-blank`) so steps can refer
to it, and say when cases share data. When data cannot be created through any path the
repository shows, say so; the case is then `BLOCKED` unless the tester has it.

## Case shape

```
### UI-1 — Editor can save a blank form as draft
Criterion: AC-2
Preconditions:
- user-editor: user in group `Form Editors` (create via Admin > Users > New)
- form-blank: blank form template `Expense` (create via Templates > New, no fields filled)
Steps:
1. Sign in as user-editor.
2. Open Forms > New > Expense and click Save Draft without filling fields.
Expected:
- The form is saved with status Draft and appears under My Drafts.
```

- Steps are numbered, one action each, using labels a tester sees on screen.
- Expected results are observable: what appears, what is stored, what status code returns.
  "Works" or "no error" alone is not an expected result.
- UI cases are smoke level: the main path of each `[UI]` criterion and its most important
  error or permission path. Do not script exhaustive field-by-field checks.

## API cases

Each API case adds, after Preconditions:

- `Request:` method, path, headers and body. Use placeholders for anything secret or
  environment-specific: `$BASE_URL`, `$TOKEN`, `<form-id from form-blank>`.
- A curl example the tester can paste after setting the placeholders:

```
curl -sS -X POST "$BASE_URL/api/v1/forms" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"templateId": "<form-blank id>", "status": "DRAFT"}'
```

- `Expected:` the status code and the response body shape (fields and types, and the values
  that matter), plus any side effect to check.
- Take the path, method and body shape from the repository (controller, OpenAPI spec or
  DTO) and cite `path:line`. Never invent an endpoint.
- Cover the permission path (missing or insufficient token) and the main validation error
  for each `[API]` criterion.

## Results file

`verify-results.md` has one line per case, in plan order, nothing else on the line:

```
UI-1 | PASS |
UI-2 | FAIL | Save Draft shows 500; log says NullPointerException in FormService
API-1 | BLOCKED | no user with group Form Editors on this instance
```

- Fields are separated by ` | `: case ID, status, notes.
- Status is exactly `PASS`, `FAIL` or `BLOCKED`. The generated template uses `TODO` until
  the tester fills it; a `TODO` line means the case was not run.
- Notes are free text on the same line; required for `FAIL` and `BLOCKED`.
- Lines starting with `#` are comments.

# Requirement template

`requirement.md` is the contract `devflow-deliver` builds from and `devflow-verify` tests
against. A cold reader with only this file and the repository must be able to build and
test the change. Write it in English, use exactly the sections below in this order, and
keep every section even when its answer is "None" with a reason.

Rules for the whole document:

- Every factual claim about current behavior cites the repository (`path:line`) or a
  source from `intake.md` (for example `[Jira description]`, `[inbox/meeting-0312.md]`).
  Code is the fact: when a source contradicts the code, say so and cite both.
- Mark an assumption as `Assumption:` and either confirm it from the repository or turn it
  into an open question. Never present a guess as fact.
- Do not invent product decisions. A choice only a person can make is an open question
  with `owner: human`.
- Keep a decision a person already made (decision log, `refine-log.md` human feedback)
  unless the person reversed it. Do not reopen it silently.

## Sections

### 1. Summary
Two to four sentences: what changes, for whom, and how a person will know it worked.

### 2. Problem
What is wrong or missing today, with evidence: current behavior in the code, a report, a
reproduction, or a data point.

### 3. Why it matters
Who is affected and what it costs them: users, operations, revenue, compliance, risk.

### 4. Why now
The trigger or deadline: a customer, a dependency, an incident, a release. "Not stated in
the sources" is an acceptable answer; then add an open question.

### 5. Desired outcome
The observable end state, described as behavior, not as implementation.

### 6. Scope
- **In:** bullet list of behaviors this change delivers.
- **Out:** bullet list of related things this change deliberately does not do, each with
  one line of why. Name the obvious neighbours a reader might expect.

### 7. Scope options considered
At least two options, normally one that shrinks and one that expands the scope around the
request. For each: what it includes, cost (relative effort, modules touched), risk (what
can break, reversibility), value (what the user gets). Then `Chosen:` the option and the
reason. When the choice is a product tradeoff, mark it pending a human decision and add an
open question.

### 8. Invariants
Bullets that must stay true during and after the change: existing behavior that must not
change, public API contracts, data integrity, permissions, performance budgets. Each
invariant should be checkable.

### 9. Acceptance criteria
Numbered `AC-1`, `AC-2`, ... Each criterion:

- is one testable statement with a clear pass/fail outcome (given / when / then is fine);
- carries exactly one side tag: `[UI]` (a person checks it in the UI), `[API]` (checked
  through the External API) or `[Backend]` (internal behavior, checked by automated tests
  or logs);
- names concrete inputs, roles and expected results; "works correctly", "is fast" and
  "handles errors" are not criteria until they say what the result is.

Cover error and permission paths, not only the happy path.

### 10. Impacted areas
Modules, packages, files, endpoints, screens, database tables and configuration found
during exploration, each as `path` (or `path:line`) with one line on why it is affected.
List only what you found in the repository; mark anything inferred as `Assumption:`.

### 11. Test impact
- **UI side:** affected / not affected, with the reason and the screens involved.
- **External API side:** affected / not affected, with the reason and the endpoints.
- **Neither:** when neither side is affected, say why and how the change is verified
  instead (for example automated tests only).

### 12. Open questions
Numbered `Q-1`, `Q-2`, ... Each: the question; `owner: human` or `owner: agent`; the
decision needed and what it blocks; the default you will assume if it is not answered, or
`no default` when a wrong guess is costly. An agent-owned question must be answerable from
the repository or sources in a later round. "None" when nothing is open.

### 13. Decision log
One line per decision, newest last: `YYYY-MM-DD — decision — who/source — reason`.
Include scope choices, answered questions and accepted risks. Never delete an entry; a
reversal is a new entry that names the one it reverses.

## Finding gaps

Before you finish a draft, check each area below against the request and the code. For each
gap, either cover it in scope, invariants or acceptance criteria, mark it out of scope with
a reason, or raise an open question.

- **Edge cases:** empty, null, maximum sizes, duplicates, concurrency, time zones, locale,
  pagination, partial failure.
- **Permissions:** which roles and permission groups may see or do this; what an
  unauthorized user sees; tenant or data-visibility boundaries.
- **Data migration:** existing records, schema changes, default values for old rows,
  backfill, rollback.
- **Backward compatibility:** existing API clients, request and response shapes, stored
  formats, feature flags, older UI flows.
- **Error handling:** validation messages, status codes, retries, what the user sees.
- **Observability:** logs, metrics, audit entries a person needs to confirm or debug it.
- **Performance:** expected volumes, hot paths, queries added to a request, batch sizes.
- **Security:** input validation, injection, sensitive data in logs or responses.

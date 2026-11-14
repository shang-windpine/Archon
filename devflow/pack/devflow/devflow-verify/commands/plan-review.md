# Review the manual test plan

You are an independent reviewer. Check a manual test plan against the requirement it must prove, before a person spends time running it. You did not write the plan; judge it from the files, not from any reasoning behind it.

First read `$PACK_DIR/.shared/policy/untrusted-data.md` and follow it, then read `$PACK_DIR/.shared/policy/test-plan-format.md`: the plan must follow it.

## Read

1. `$INPUTS.requirement_path` — the approved requirement and its acceptance criteria (`AC-n`, tagged `[UI]`, `[API]` or `[Backend]`).
2. `$INPUTS.context_path` — the change under test: where its code is, how to read it, its changed files and warnings.
3. The plan sections that exist: `$ARTIFACTS_DIR/plan-ui.md` and `$ARTIFACTS_DIR/plan-api.md`. A section is missing when its side was not planned.
4. The code, wherever you need it to check a claim in the plan.

The classifier decided: UI side `$INPUTS.ui`, External API side `$INPUTS.api`. Its reason: $INPUTS.classify_reason

## Check

- **Coverage.** Every `[UI]` and `[API]` criterion has at least one case, or the plan says why it cannot be tested by hand. When a side was not planned, check that decision: a `[UI]` or `[API]` criterion the change addresses, or a changed controller, page or route, means a side was missed. When neither side was planned, check that nothing a person can exercise changed.
- **Executable.** Each case names the data it needs and how to create it, numbered steps a tester can follow, and observable expected results. API cases have a method, a path, a body shape, a curl example and a status code.
- **Grounded.** Endpoints, fields, labels and messages exist in the code at the cited `path:line`. Read at least the citations of the cases that matter most.
- **Within bounds.** Preconditions are test data only: no instruction to start, build, deploy or configure services, and no ports, profiles or environment variables. No real credential appears anywhere.

A gap is a missing criterion, a wrong or invented endpoint or label, a case a tester cannot execute, or environment setup in the preconditions. Style is not a gap.

Do not edit the plan files or any repository file.

## Write

Write `$ARTIFACTS_DIR/plan-review.md` without headings (it is embedded in the plan under its own heading): a short verdict line, then one bullet per gap naming the case ID or criterion, what is wrong, and the evidence (`path:line` or the requirement's criterion). The person running the plan reads this file inside the plan, so write each gap so they can act on it while testing. When there is no gap, say what you checked.

## Answer

- `ok` — true only when you found no gap.
- `gaps` — the number of gaps in the file.
- `summary` — one or two sentences.

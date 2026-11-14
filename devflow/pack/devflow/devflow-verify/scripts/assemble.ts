/**
 * Join the side plans and the plan review into the state directory's `verify-plan.md`, and
 * write the `verify-results.md` template with one `TODO` line per planned case.
 *
 * The case IDs come from the planners' structured output, never from their markdown. A
 * side whose planner was skipped arrives as null. A planner that ran but left no plan file
 * broke its contract and the node refuses: there is nothing to put in front of a person.
 * A missing plan-review.md only loses commentary, so the review's own summary stands in
 * and the plan says so.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, input, refuse, runId } from 'archon:script';
import { artifactPath } from '../../.shared/lib/devflow.ts';
import { isObject, nullableJson } from '../../.shared/lib/inputs.ts';
import {
  type PlannedCase,
  type Side,
  planHeadline,
  renderResultsTemplate,
  validateCases,
} from '../../.shared/lib/verify.ts';

function sidePlan(
  side: Side,
  label: string,
  file: string,
  bound: string
): { cases: PlannedCase[]; body: string } {
  const output = nullableJson(bound);
  if (output === null)
    return {
      cases: [],
      body: `## ${label}\n\nNot planned: the change was classified as not touching the ${label} side.\n`,
    };
  if (!isObject(output)) throw new Error(`the ${label} planner's output is not an object`);
  const cases = validateCases(side, output.cases);
  const path = artifactPath(file);
  if (!existsSync(path)) throw new Error(`the ${label} planner did not write ${path}`);
  return { cases, body: readFileSync(path, 'utf8').trim() + '\n' };
}

function main(): void {
  const key = input('key');
  const planPath = input('plan_path');
  const resultsPath = input('results_path');
  const ui = sidePlan('UI', 'UI', 'plan-ui.md', input('ui_plan'));
  const api = sidePlan('API', 'External API', 'plan-api.md', input('api_plan'));
  const classified = { ui: input('ui') === 'true', api: input('api') === 'true' };

  const gaps = Number.parseInt(input('review_gaps'), 10) || 0;
  const reviewPath = artifactPath('plan-review.md');
  const review = existsSync(reviewPath)
    ? readFileSync(reviewPath, 'utf8').trim()
    : `The reviewer wrote no plan-review.md; its summary: ${input('review_summary')}`;
  const contextPath = input('context_path');
  const context = existsSync(contextPath)
    ? readFileSync(contextPath, 'utf8').trim()
    : `(${contextPath} is missing)`;

  const plan = [
    `# Manual verification plan for ${key}`,
    '',
    `Written by devflow-verify run ${runId()}.`,
    '',
    `- Requirement: ${input('requirement_path')}`,
    `- Results file to fill in: ${resultsPath}`,
    `- UI side: ${classified.ui ? 'yes' : 'no'}; External API side: ${classified.api ? 'yes' : 'no'}`,
    `- Why: ${input('classify_reason')}`,
    '',
    '## Before you start',
    '',
    'Starting, building and configuring the services and the environment is your job; this plan does',
    "not cover it. Each case's preconditions list only the test data to prepare, and how to create it.",
    `Record each case on its line in ${resultsPath}: \`<ID> | PASS, FAIL or BLOCKED | notes\`.`,
    '',
    ui.body,
    api.body,
    `## Plan review (${input('review_ok') === 'true' ? 'no gaps' : `${gaps} gap(s)`})`,
    '',
    review,
    '',
    '## Appendix: verification context',
    '',
    // context.md is this workflow's own file: nest its headings under the appendix.
    context.replace(/^(#+) /gm, '##$1 '),
    '',
  ].join('\n');

  writeFileSync(planPath, plan);
  copyFileSync(planPath, artifactPath('verify-plan.md'));
  const cases = [...ui.cases, ...api.cases];
  writeFileSync(resultsPath, renderResultsTemplate(key, planPath, cases));

  const reviewNote =
    input('review_ok') === 'true'
      ? 'The plan review found no gaps.'
      : `The plan review found ${gaps} gap(s); read its section in the plan.`;
  emit({
    plan_path: planPath,
    results_path: resultsPath,
    cases: cases.length,
    ui_cases: ui.cases.length,
    api_cases: api.cases.length,
    headline: `${planHeadline(ui.cases.length, api.cases.length, classified)} ${reviewNote}`,
  });
}

try {
  main();
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}

/**
 * The first node of each deliver round: number the round and write its work order.
 *
 * Round 1's work order is preflight's. A later round's is the previous round's
 * `next-work.md` (accepted threads, CI failures this change caused, a base conflict)
 * plus the operator's answer to the previous round's escalation, when there was one.
 * Every answer is also appended to `human-answers.md`, which the judges read in later
 * rounds: an answer may decide a thread or a check, not only code. An answer that chose
 * `skip-copilot` writes `$ARTIFACTS_DIR/copilot-skipped`, which stays for the rest of the
 * run and makes request-review and await treat `copilot_mode` as `off`.
 *
 * Bound inputs: previous_round, previous_has_work, previous_pr, answer, answer_choice
 * (all `$LOOP_PREV` text, empty on round 1 or after a skipped escalation), first_pr and
 * requirement (preflight's).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { artifactPath, validateKey } from '../../.shared/lib/devflow.ts';
import { COPILOT_SKIPPED_ARTIFACT } from '../../.shared/lib/deliver-settings.ts';
import { controlDecision, fence, renderWorkOrder } from '../../.shared/lib/deliver-work.ts';

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

try {
  const key = validateKey(input('key'));
  const firstPr = Number(input('first_pr') || '0');
  const decision = controlDecision({
    previousRound: input('previous_round'),
    previousHasWork: input('previous_has_work'),
    previousPr: input('previous_pr'),
    answer: input('answer'),
    answerChoice: input('answer_choice'),
    firstPr: Number.isInteger(firstPr) && firstPr > 0 ? firstPr : 0,
  });
  const workOrder = artifactPath('work-order.md');
  const workThreads = artifactPath('work-threads.json');
  if (decision.round > 1) {
    const nextWork =
      input('previous_has_work') === 'true' ? readIfExists(artifactPath('next-work.md')) : null;
    const threads =
      input('previous_has_work') === 'true'
        ? readIfExists(artifactPath('next-threads.json'))
        : null;
    const escalation = artifactPath('escalation.md');
    if (decision.skipCopilot) {
      writeFileSync(
        artifactPath(COPILOT_SKIPPED_ARTIFACT),
        `skip-copilot chosen before round ${String(decision.round)}\n`
      );
    }
    if (decision.answer !== '' || decision.skipCopilot) {
      const heading = `## Answer before round ${String(decision.round)}`;
      const choice = decision.skipCopilot
        ? 'The operator chose to stop waiting for a Copilot review for the rest of this run.\n\n'
        : '';
      const text = decision.answer === '' ? '' : `${fence(decision.answer, 8000)}\n\n`;
      appendFileSync(artifactPath('human-answers.md'), `${heading}\n\n${choice}${text}`);
    }
    writeFileSync(
      workOrder,
      decision.implement
        ? renderWorkOrder({
            key,
            round: decision.round,
            requirementPath: input('requirement'),
            followupPath: null,
            nextWork,
            answer: decision.answer,
            escalationPath: decision.answer !== '' && existsSync(escalation) ? escalation : null,
          })
        : `# Work order: ${key}, round ${String(decision.round)}\n\nNo code work this round.\n`
    );
    writeFileSync(workThreads, threads ?? '[]\n');
  }
  emit({
    round: decision.round,
    implement: decision.implement,
    pr_number: decision.prNumber,
    has_pr: decision.prNumber > 0,
    work_order: workOrder,
  });
} catch (error) {
  refuse(`control: ${error instanceof Error ? error.message : String(error)}`);
}

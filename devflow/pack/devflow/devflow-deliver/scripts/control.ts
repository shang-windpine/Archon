/**
 * The first node of each deliver round: number the round and write its work order.
 *
 * Round 1's work order is preflight's pristine copy (WORK_FILES.round1), copied into
 * place at every round 1. The engine restarts a loop_group at iteration 1 on a failure
 * resume, with `$LOOP_PREV` empty again but `$ARTIFACTS_DIR` holding what later rounds
 * wrote; without the copy, round 1 would implement the last attempt's work order and
 * publish would answer its threads. A later round's work order is the previous round's
 * `next-work.md` (accepted threads, CI failures this change caused, a base conflict, a
 * failed local verify) plus the operator's answer to the previous round's escalation,
 * when there was one.
 *
 * Every answer is also appended to `human-answers.md`, which the judges read in later
 * rounds: an answer may decide a thread or a check, not only code. An answer that chose
 * `skip-copilot` writes `$ARTIFACTS_DIR/copilot-skipped`, which stays for the rest of the
 * run and makes request-review and await treat `copilot_mode` as `off`.
 *
 * What round 1 resets and what it keeps on a restart:
 * - Reset: `work-order.md` and `work-threads.json` (from the round 1 copies), and the
 *   per-round hand-offs in ROUND_SCRATCH (`next-work.md`, `next-threads.json`,
 *   `escalation.md`). They describe a round of the earlier attempt, and nothing of
 *   this attempt has produced them yet.
 * - Kept, because each records something that happened on GitHub or a person decided
 *   in this run, and stays true after a restart: `reruns.json` (a unit is rerun at most
 *   once per head, and await tells a started rerun by it), `copilot-requests.json` (the
 *   heads Copilot was already asked to review; asking again on the same head is what
 *   GitHub may not record), `human-answers.md` (still the operator's answers; its round
 *   headings name the attempt they were given in), `copilot-skipped` (the operator's
 *   choice for the rest of the run, which a resume continues), and `thread-notes.json`
 *   (the implementer's evidence on threads it did not fix).
 *
 * Bound inputs: previous_round, previous_has_work, previous_pr, answer, answer_choice
 * (all `$LOOP_PREV` text, empty on round 1 or after a skipped escalation), first_pr and
 * requirement (preflight's).
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { artifactPath, validateKey } from '../../.shared/lib/devflow.ts';
import { COPILOT_SKIPPED_ARTIFACT } from '../../.shared/lib/deliver-settings.ts';
import {
  controlDecision,
  fence,
  ROUND_FILES,
  ROUND_SCRATCH,
  renderWorkOrder,
  WORK_FILES,
} from '../../.shared/lib/deliver-work.ts';

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
  const workOrder = artifactPath(WORK_FILES.current.order);
  const workThreads = artifactPath(WORK_FILES.current.threads);
  if (decision.round === 1) {
    for (const [from, to] of [
      [WORK_FILES.round1.order, workOrder],
      [WORK_FILES.round1.threads, workThreads],
    ] as const) {
      const source = artifactPath(from);
      if (!existsSync(source)) throw new Error(`preflight wrote no ${source}`);
      copyFileSync(source, to);
    }
    for (const name of ROUND_SCRATCH) rmSync(artifactPath(name), { force: true });
  } else {
    const nextWork =
      input('previous_has_work') === 'true'
        ? readIfExists(artifactPath(ROUND_FILES.nextWork))
        : null;
    const threads =
      input('previous_has_work') === 'true'
        ? readIfExists(artifactPath(ROUND_FILES.nextThreads))
        : null;
    const escalation = artifactPath(ROUND_FILES.escalation);
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

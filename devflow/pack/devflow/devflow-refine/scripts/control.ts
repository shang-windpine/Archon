/**
 * The first node of every refine round (DESIGN §5 step 3). It reads the previous round's
 * gate answer, records a person's answer in `refine-log.md`, and decides whether this
 * round drafts again or the loop ends because the person chose finalize.
 *
 * `$ARTIFACTS_DIR/refine-state.json` carries the round counter and the finalize decision
 * across rounds; `status` reads it after the loop, because a gate inside the loop body
 * cannot be read from outside it.
 *
 * Bound inputs: INPUTS_DECISION and INPUTS_ANSWER, the previous round's gate
 * `decision` and `text` (both '' on round 1 and after a round whose gate was skipped).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, input, refuse, runId } from 'archon:script';
import { artifactPath, statePath, validateKey } from '../../.shared/lib/devflow.ts';
import { controlStep, humanEntry, runHeading } from '../../.shared/lib/refine.ts';

interface RefineState {
  readonly round: number;
  readonly finalized: boolean;
  readonly note: string;
}

function readState(path: string): RefineState {
  if (!existsSync(path)) return { round: 0, finalized: false, note: '' };
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RefineState>;
  if (typeof value.round !== 'number' || typeof value.finalized !== 'boolean') {
    throw new Error(`${path} is not a refine state written by this workflow`);
  }
  return { round: value.round, finalized: value.finalized, note: value.note ?? '' };
}

try {
  const key = validateKey(input('key'));
  const statePathname = artifactPath('refine-state.json');
  const previous = readState(statePathname);
  const round = previous.round + 1;
  const step = controlStep(round, { decision: input('decision'), text: input('answer') });
  const refineLog = statePath(key, 'refine-log.md');

  if (step.kind === 'first')
    appendFileSync(refineLog, runHeading(runId(), new Date().toISOString()));
  if (step.kind === 'revise' || step.kind === 'finalize') {
    appendFileSync(refineLog, humanEntry(previous.round, step.kind, step.text));
  }

  const finalize = step.kind === 'finalize';
  const state: RefineState = { round, finalized: finalize, note: finalize ? step.text : '' };
  writeFileSync(statePathname, `${JSON.stringify(state, null, 2)}\n`);

  emit({
    finalize,
    round,
    human_feedback_path: step.kind === 'revise' ? refineLog : '',
    refine_log_path: refineLog,
    requirement_path: artifactPath('requirement.md'),
    review_path: artifactPath('review.md'),
  });
} catch (error) {
  refuse(`devflow-refine control: ${error instanceof Error ? error.message : String(error)}`);
}

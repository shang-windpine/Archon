/**
 * Record one round's review and decide whether its gate asks a person. It runs between
 * `review` and `gate`, so the review lands in `refine-log.md` before anyone is asked, the
 * gate's condition is one typed boolean instead of a `when:` over a setting and two
 * review fields, and the gate's message gets absolute paths (`$ARTIFACTS_DIR` stays
 * literal in attention text).
 *
 * It also snapshots the round's draft and review under `$ARTIFACTS_DIR/rounds/<n>/`, and
 * writes `last-review.json` for the final gate's message.
 *
 * Bound inputs: INPUTS_ROUND, INPUTS_VERDICT, INPUTS_NEEDS_HUMAN, INPUTS_QUESTIONS (a JSON
 * array of strings), INPUTS_SUMMARY from `control` and `review`.
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import {
  artifactPath,
  parseEnum,
  parsePositiveInt,
  statePath,
  validateKey,
} from '../../.shared/lib/devflow.ts';
import {
  REFINE_HUMAN_MODES,
  gateAsks,
  gateRecommendation,
  numbered,
  reviewEntry,
} from '../../.shared/lib/refine.ts';

function questionList(raw: string): string[] {
  const value: unknown = raw.trim() === '' ? [] : JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error('the review questions are not an array of strings');
  }
  return value.filter(item => item.trim() !== '');
}

try {
  const key = validateKey(input('key'));
  if (input('round').trim() === '') throw new Error('control gave no round');
  const round = parsePositiveInt(input('round'), 1, 'round');
  const verdict = input('verdict').trim();
  if (verdict !== 'approve' && verdict !== 'revise') {
    throw new Error(`the review verdict ${JSON.stringify(verdict)} is not approve or revise`);
  }
  const needsHuman = input('needs_human').trim() === 'true';
  const questions = questionList(input('questions'));
  const summary = input('summary').trim();
  const mode = parseEnum(input('refine_human'), REFINE_HUMAN_MODES, 'auto', 'refine_human');

  const requirementPath = artifactPath('requirement.md');
  const reviewPath = artifactPath('review.md');
  for (const [path, writer] of [
    [requirementPath, 'draft'],
    [reviewPath, 'review'],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${writer} did not write ${path}`);
  }
  copyFileSync(requirementPath, artifactPath('rounds', String(round), 'requirement.md'));
  copyFileSync(reviewPath, artifactPath('rounds', String(round), 'review.md'));

  const ask = gateAsks(mode, verdict, needsHuman);
  const refineLog = statePath(key, 'refine-log.md');
  appendFileSync(
    refineLog,
    reviewEntry({
      round,
      verdict,
      needsHuman,
      asked: ask,
      summary,
      questions,
      review: readFileSync(reviewPath, 'utf8'),
    })
  );
  writeFileSync(
    artifactPath('last-review.json'),
    `${JSON.stringify({ round, verdict, needs_human: needsHuman, summary }, null, 2)}\n`
  );

  emit({
    ask,
    round,
    verdict,
    summary,
    questions_text: numbered(questions).trimEnd(),
    requirement_path: requirementPath,
    review_path: reviewPath,
    refine_log_path: refineLog,
    recommendation: gateRecommendation(verdict, needsHuman),
  });
} catch (error) {
  refuse(`devflow-refine record: ${error instanceof Error ? error.message : String(error)}`);
}

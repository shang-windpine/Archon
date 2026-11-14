/**
 * How the refine loop ended (DESIGN §5 step 4): finalized by a person at a round gate, or
 * out of rounds. It reads `refine-state.json`, which `control` writes every round, because
 * nothing outside the loop can read the gate inside it. It also hands the final gate the
 * absolute paths its message needs (`$ARTIFACTS_DIR` stays literal in attention text).
 */

import { existsSync, readFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { artifactPath, statePath, validateKey } from '../../.shared/lib/devflow.ts';

function readJson(path: string, writer: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`${writer} did not write ${path}`);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

try {
  const key = validateKey(input('key'));
  const state = readJson(artifactPath('refine-state.json'), 'control');
  if (typeof state.finalized !== 'boolean' || typeof state.round !== 'number') {
    throw new Error('refine-state.json has no finalized/round fields');
  }
  const requirementPath = artifactPath('requirement.md');
  if (!existsSync(requirementPath)) throw new Error(`no draft was written to ${requirementPath}`);
  const lastReview = existsSync(artifactPath('last-review.json'))
    ? readJson(artifactPath('last-review.json'), 'record')
    : {};

  emit({
    finalized: state.finalized,
    rounds: state.round,
    note: typeof state.note === 'string' ? state.note : '',
    last_verdict: typeof lastReview.verdict === 'string' ? lastReview.verdict : '',
    last_summary: typeof lastReview.summary === 'string' ? lastReview.summary : '',
    requirement_path: requirementPath,
    review_path: artifactPath('review.md'),
    refine_log_path: statePath(key, 'refine-log.md'),
  });
} catch (error) {
  refuse(`devflow-refine status: ${error instanceof Error ? error.message : String(error)}`);
}

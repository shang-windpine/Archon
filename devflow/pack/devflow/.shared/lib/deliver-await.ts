/**
 * The await node's per-poll decisions (DESIGN §6): when the Copilot review and the
 * checks of the pushed head count as settled, and the thread shape the round's
 * snapshot keeps.
 *
 * Each verdict is null while waiting longer could still change it. Inputs are forge
 * values and this pack's own records; nothing here reads prose.
 *
 * Pure: the only imports from `archon:script` are types, erased at runtime.
 */

import type { ForgeOperations } from 'archon:script';
import type { ChecksSummary, CheckUnit } from './checks.ts';
import type { AwaitChecks, AwaitCopilot, RerunRecord } from './deliver-outcome.ts';
import { unitKey } from './deliver-outcome.ts';
import type { CopilotMode } from './deliver-settings.ts';
import type { ReviewItem } from './copilot.ts';

export interface CopilotFacts {
  readonly mode: CopilotMode;
  /** Copilot's review of the head (copilotReviewForHead), if any. */
  readonly review: ReviewItem | undefined;
  /** The request-review node's error for this head; empty when it raised none. */
  readonly requestError: string;
  readonly now: number;
  readonly deadline: number;
}

/**
 * `off` needs no review. A review of the head settles it whatever else happened. A
 * failed request will not produce a review, so waiting for one is pointless.
 */
export function copilotVerdict(facts: CopilotFacts): AwaitCopilot | null {
  if (facts.mode === 'off') return 'off';
  if (facts.review !== undefined) return 'done';
  if (facts.requestError !== '') return 'request_failed';
  return facts.now >= facts.deadline ? 'timeout' : null;
}

/**
 * The checks verdict once settled, or at the deadline. `rerunsPending` holds while a
 * rerun this pack issued on the head has not visibly started: until then the old red
 * result would read as settled and be judged a second time.
 */
export function checksVerdict(
  summary: ChecksSummary,
  rerunsPending: boolean,
  now: number,
  deadline: number
): AwaitChecks | null {
  if (summary.settled && !rerunsPending) {
    if (summary.state === 'green') return 'green';
    if (summary.state === 'red') return 'red';
    if (summary.state === 'gated') return 'gated';
    return 'unknown';
  }
  if (now < deadline) return null;
  return summary.state === 'none' && !summary.stale ? 'none' : 'pending_timeout';
}

/** A rerun record with the unit id the forge reported when the rerun was issued. */
export interface IssuedRerun extends RerunRecord {
  readonly id: string;
}

/**
 * Reruns issued on `head` whose unit still carries the id it had when rerun and is not
 * pending: GitHub gives a rerun check a new id, so an unchanged id means the rerun has
 * not started yet.
 */
export function pendingReruns(
  units: readonly CheckUnit[],
  issued: readonly IssuedRerun[],
  head: string
): string[] {
  const pending: string[] = [];
  for (const record of issued) {
    if (record.head !== head) continue;
    const current = units.find(entry => unitKey(entry.unit) === record.unit);
    if (current === undefined) continue;
    if (current.unit.id === record.id && current.state !== 'pending') pending.push(record.unit);
  }
  return pending;
}

type ForgeThread = ForgeOperations['pr.threads']['result']['threads'][number];

export interface ThreadComment {
  readonly author: string | null;
  readonly body: string;
  readonly url: string;
}

/** An unresolved review thread as the snapshot keeps it for the judges and act. */
export interface SnapshotThread {
  readonly id: string;
  readonly outdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly url: string;
  readonly comments: readonly ThreadComment[];
}

export function unresolvedThreads(threads: readonly ForgeThread[]): SnapshotThread[] {
  return threads
    .filter(thread => !thread.resolved)
    .map(thread => ({
      id: thread.id,
      outdated: thread.outdated,
      path: thread.path,
      line: thread.line,
      url: thread.comments[0]?.url ?? '',
      comments: thread.comments.map(comment => ({
        author: comment.author?.login ?? null,
        body: comment.body,
        url: comment.url,
      })),
    }));
}

/** A file name for a unit's saved log: the unit name with anything unsafe replaced. */
export function logFileName(unit: CheckUnit['unit'], taken: ReadonlySet<string>): string {
  const stem = unit.name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[.]+/, '_')
    .slice(0, 80);
  let name = `${stem || 'unit'}.log`;
  for (let n = 2; taken.has(name); n++) name = `${stem || 'unit'}-${String(n)}.log`;
  return name;
}

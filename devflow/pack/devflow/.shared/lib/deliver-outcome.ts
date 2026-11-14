/**
 * The `act` node's verdict for one deliver round (DESIGN §6), and the rerun bookkeeping
 * it depends on.
 *
 * Every input is a structured value: the await snapshot, the judges' typed decisions,
 * and this pack's own rerun record. Nothing here reads prose.
 *
 * Invariant beyond DESIGN §6: a round that is not done must either leave work for the
 * next round, have issued a rerun whose result the next round waits for, or ask a
 * human. Otherwise the loop would spin to `max_iterations` with nothing changing, so
 * such a round asks (reason "no progress").
 *
 * Pure: the only imports from `archon:script` are types, erased at runtime.
 */

import type { ChecksSummary, CheckUnit } from './checks.ts';

export type AwaitCopilot = 'done' | 'timeout' | 'off' | 'request_failed';
export type AwaitChecks = 'green' | 'red' | 'pending_timeout' | 'none' | 'gated' | 'unknown';

export type ThreadDecisionKind = 'accept' | 'decline' | 'not_this_change' | 'needs_human';
export interface ThreadDecision {
  readonly thread: string;
  readonly decision: ThreadDecisionKind;
  readonly reason: string;
  readonly reply: string;
}

export type CiCause = 'pr_caused' | 'infra' | 'flaky' | 'unknown';
export interface CiJudgement {
  readonly name: string;
  readonly cause: CiCause;
  readonly evidence: string;
  readonly fix: string;
}

/** One rerun this pack issued, kept in `$ARTIFACTS_DIR/reruns.json` as an array. */
export interface RerunRecord {
  readonly head: string;
  /** unitKey() of the unit. */
  readonly unit: string;
  readonly at: string;
}

/**
 * A unit's identity across reruns. The forge's unit `id` changes when GitHub reruns a
 * check, so the kind and the exact name identify "the same unit" on one head.
 */
export function unitKey(unit: CheckUnit['unit']): string {
  return `${unit.kind}:${unit.name}`;
}

export interface RerunPlan {
  /** Red, judged infra or flaky, rerunnable, and not yet rerun on this head: rerun these. */
  readonly rerun: readonly CheckUnit[];
  /** Judged infra or flaky but already rerun once on this head and still red. */
  readonly repeated: readonly CheckUnit[];
  /** Judged infra or flaky but the forge offers no rerun (`rerun` null, e.g. a commit status). */
  readonly notRerunnable: readonly CheckUnit[];
  /** Red with no judgement naming it. */
  readonly unjudged: readonly CheckUnit[];
}

/** The judgement whose `name` is the unit's exact name; the first one when several do. */
function judgementFor(
  unit: CheckUnit,
  judgements: readonly CiJudgement[]
): CiJudgement | undefined {
  return judgements.find(judgement => judgement.name === unit.unit.name);
}

/**
 * Which red units to rerun now. `history` is the rerun record before this round;
 * a unit is rerun at most once per head.
 */
export function planReruns(
  redUnits: readonly CheckUnit[],
  judgements: readonly CiJudgement[],
  history: readonly RerunRecord[],
  head: string
): RerunPlan {
  const done = new Set(history.filter(entry => entry.head === head).map(entry => entry.unit));
  const rerun: CheckUnit[] = [];
  const repeated: CheckUnit[] = [];
  const notRerunnable: CheckUnit[] = [];
  const unjudged: CheckUnit[] = [];
  for (const unit of redUnits) {
    const judgement = judgementFor(unit, judgements);
    if (judgement === undefined) {
      unjudged.push(unit);
      continue;
    }
    if (judgement.cause !== 'infra' && judgement.cause !== 'flaky') continue;
    if (done.has(unitKey(unit.unit))) repeated.push(unit);
    else if (unit.rerun === null || unit.rerun === undefined) notRerunnable.push(unit);
    else rerun.push(unit);
  }
  return { rerun, repeated, notRerunnable, unjudged };
}

/** `history` with one record per issued unit appended. */
export function recordReruns(
  history: readonly RerunRecord[],
  head: string,
  issued: readonly CheckUnit[],
  at: string
): RerunRecord[] {
  return [...history, ...issued.map(unit => ({ head, unit: unitKey(unit.unit), at }))];
}

export interface RoundFacts {
  readonly head: string;
  /** The await node's `checks`. */
  readonly checks: AwaitChecks;
  /** summarizeChecks() over the await snapshot; null when there is no snapshot. */
  readonly summary: ChecksSummary | null;
  readonly copilot: AwaitCopilot;
  /** Unresolved threads left after this round's replies and resolves. */
  readonly openThreads: number;
  /** judge-threads decisions; empty when it was skipped. */
  readonly decisions: readonly ThreadDecision[];
  /** judge-ci units; empty when it was skipped. */
  readonly ciJudgement: readonly CiJudgement[];
  readonly conflict: boolean;
  /** Units this round actually asked the forge to rerun. */
  readonly rerunsIssued: number;
  /** The rerun record as it was before this round's reruns. */
  readonly rerunHistory: readonly RerunRecord[];
}

export interface RoundOutcome {
  readonly done: boolean;
  readonly has_work: boolean;
  readonly ask: boolean;
  /** One line per fact that blocks done, makes work, or needs a human: work, asks, then status. */
  readonly reasons: readonly string[];
  /** The facts that need a person; non-empty exactly when `ask`. */
  readonly askReasons: readonly string[];
  /** Status and progress: work handed to the next round, reruns, what still blocks done. */
  readonly notes: readonly string[];
}

function names(units: readonly CheckUnit[]): string {
  return units.map(unit => unit.unit.name).join(', ');
}

export function computeRoundOutcome(facts: RoundFacts): RoundOutcome {
  const work: string[] = [];
  const asks: string[] = [];
  const blocks: string[] = [];

  const byDecision = (kind: ThreadDecisionKind): readonly ThreadDecision[] =>
    facts.decisions.filter(decision => decision.decision === kind);
  const accepted = byDecision('accept');
  if (accepted.length > 0)
    work.push(`${String(accepted.length)} review thread(s) accepted for fixing`);
  const human = byDecision('needs_human');
  if (human.length > 0) asks.push(`${String(human.length)} review thread(s) need a human decision`);

  const prCaused = facts.ciJudgement.filter(judgement => judgement.cause === 'pr_caused');
  if (prCaused.length > 0)
    work.push(`CI failure(s) caused by this change: ${prCaused.map(j => j.name).join(', ')}`);
  const unknown = facts.ciJudgement.filter(judgement => judgement.cause === 'unknown');
  if (unknown.length > 0)
    asks.push(`CI failure(s) of unknown cause: ${unknown.map(j => j.name).join(', ')}`);
  if (facts.conflict) work.push('the branch conflicts with the base branch');

  const plan = planReruns(
    facts.summary?.redUnits ?? [],
    facts.ciJudgement,
    facts.rerunHistory,
    facts.head
  );
  if (plan.unjudged.length > 0) asks.push(`red check(s) nobody judged: ${names(plan.unjudged)}`);
  if (plan.repeated.length > 0)
    asks.push(`still red after one rerun on this head: ${names(plan.repeated)}`);
  if (plan.notRerunnable.length > 0) {
    asks.push(`judged infra/flaky but the forge cannot rerun them: ${names(plan.notRerunnable)}`);
  }
  if (facts.rerunsIssued < plan.rerun.length) {
    asks.push(`${String(plan.rerun.length - facts.rerunsIssued)} planned rerun(s) were not issued`);
  }
  if (facts.rerunsIssued > 0)
    blocks.push(`${String(facts.rerunsIssued)} rerun(s) issued; waiting for their result`);

  if (facts.copilot === 'timeout') asks.push('Copilot did not review the current head in time');
  if (facts.copilot === 'request_failed') asks.push('requesting a Copilot review failed');

  if (facts.checks === 'pending_timeout')
    asks.push('checks did not settle on the current head in time');
  else if (facts.checks === 'gated') asks.push('checks are waiting for an approval');
  else if (facts.checks === 'unknown') asks.push('checks are in a state the forge cannot classify');
  else if (facts.checks === 'none') asks.push('no checks reported on the current head');
  else if (facts.checks === 'red') blocks.push('checks are red');
  if (facts.summary === null) {
    asks.push('there is no checks snapshot for this round');
  } else {
    if (facts.summary.stale) blocks.push('the checks snapshot is not of the current head');
    if (facts.summary.missingRequired.length > 0) {
      blocks.push(`required check(s) not reported: ${facts.summary.missingRequired.join(', ')}`);
    }
  }
  if (facts.openThreads > 0)
    blocks.push(`${String(facts.openThreads)} review thread(s) unresolved`);

  const hasWork = work.length > 0;
  let ask = asks.length > 0;
  const done =
    facts.checks === 'green' &&
    facts.summary?.green === true &&
    facts.openThreads === 0 &&
    (facts.copilot === 'done' || facts.copilot === 'off') &&
    !facts.conflict &&
    !hasWork &&
    facts.rerunsIssued === 0 &&
    !ask;
  if (!done && !hasWork && !ask && facts.rerunsIssued === 0) {
    ask = true;
    asks.push('no progress: the round is not done, left no work and issued no rerun');
  }
  return {
    done,
    has_work: hasWork,
    ask,
    reasons: [...work, ...asks, ...blocks],
    askReasons: asks,
    notes: [...work, ...blocks],
  };
}

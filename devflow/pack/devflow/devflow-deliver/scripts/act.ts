/**
 * Carry out the round's judgements and decide what the round means (DESIGN §6).
 *
 * - A thread judged `decline` or `not_this_change` gets the judge's reply and is
 *   resolved. `accept` goes to the next round's work; `needs_human` asks a person. A
 *   thread the judge left out, or a decline with no reply, asks too (deliver-work.ts).
 * - A red unit judged `infra` or `flaky` that the forge can rerun is rerun once per
 *   head, from a fresh read of the head's checks. A rerun whose outcome is unknown is
 *   settled by reading the checks back, never by repeating it. Reruns are recorded in
 *   `$ARTIFACTS_DIR/reruns.json` with the unit id they replaced, which await uses to
 *   tell a started rerun from the old result.
 * - `pr_caused` failures, accepted threads and a base conflict become `next-work.md`
 *   (and the accepted thread ids `next-threads.json`), which control turns into the
 *   next work order.
 * - done / has_work / ask come from computeRoundOutcome. When the round asks,
 *   `escalation.md` says what a person must decide.
 *
 * Bound inputs: key, base (preflight), round (control), pr_number, pr_url (publish),
 * snapshot_path (await), decisions, units (the judges' outputs; `null` when skipped).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { emit, ForgeError, forge, input, refuse } from 'archon:script';
import type { ChecksSummary, CheckUnit } from '../../.shared/lib/checks.ts';
import type { IssuedRerun, SnapshotThread } from '../../.shared/lib/deliver-await.ts';
import {
  type AwaitChecks,
  type AwaitCopilot,
  type CiJudgement,
  computeRoundOutcome,
  planReruns,
  type ThreadDecision,
  unitKey,
} from '../../.shared/lib/deliver-outcome.ts';
import {
  fence,
  hasNextWork,
  reconcileDecisions,
  renderNextWork,
} from '../../.shared/lib/deliver-work.ts';
import { artifactPath, validateKey } from '../../.shared/lib/devflow.ts';
import type { Repo } from '../../.shared/lib/identity.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';

interface Snapshot {
  readonly pr: { readonly repo: Repo; readonly number: number };
  readonly head_revision: string;
  readonly base_revision: string;
  readonly copilot: AwaitCopilot;
  readonly checks: AwaitChecks;
  readonly checks_summary: ChecksSummary | null;
  readonly threads: readonly SnapshotThread[];
  readonly red_units: readonly {
    readonly name: string;
    readonly log_path: string;
    readonly note: string;
  }[];
  readonly conflict: boolean;
}

type Ref = Snapshot['pr'];

function readHistory(): IssuedRerun[] {
  const path = artifactPath('reruns.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as IssuedRerun[]) : [];
}

function unresolvedIds(ref: Ref): Set<string> {
  return new Set(
    forge('pr.threads', { ref })
      .threads.filter(thread => !thread.resolved)
      .map(thread => thread.id)
  );
}

/** Reply on and resolve every thread the judge declined, skipping any someone already resolved. */
function postReplies(ref: Ref, decisions: readonly ThreadDecision[]): number {
  const replying = decisions.filter(
    d => d.decision === 'decline' || d.decision === 'not_this_change'
  );
  if (replying.length === 0) return 0;
  const open = unresolvedIds(ref);
  let posted = 0;
  for (const decision of replying) {
    if (!open.has(decision.thread)) continue;
    forge('pr.thread.reply', { ref, thread: decision.thread, body: decision.reply.trim() });
    forge('pr.thread.resolve', { ref, thread: decision.thread });
    posted++;
  }
  return posted;
}

/** Whether the forge shows the unit's rerun under way: a new unit id, or the unit pending. */
function rerunStarted(units: readonly CheckUnit[], issued: CheckUnit): boolean {
  const now = units.find(entry => unitKey(entry.unit) === unitKey(issued.unit));
  return now !== undefined && (now.unit.id !== issued.unit.id || now.state === 'pending');
}

/** Rerun the planned units from a fresh read of the head; returns the units actually rerun. */
function issueReruns(ref: Ref, head: string, planned: readonly CheckUnit[]): CheckUnit[] {
  if (planned.length === 0) return [];
  const fresh = forge('checks.state', { ref });
  if (fresh.revision !== head) return [];
  const keys = new Set(planned.map(entry => unitKey(entry.unit)));
  const picks = fresh.units.filter(
    entry =>
      keys.has(unitKey(entry.unit)) &&
      entry.state === 'red' &&
      entry.rerun !== null &&
      entry.rerun !== undefined
  );
  if (picks.length === 0) return [];
  try {
    forge('checks.rerun', {
      ref,
      revision: head,
      units: picks.map(entry => ({ unit: entry.unit, rerun: entry.rerun ?? null })),
    });
    return picks;
  } catch (error) {
    if (error instanceof ForgeError && error.mutation?.outcome === 'refused') {
      console.error(`act: checks.rerun refused: ${error.message}`);
      return [];
    }
    // The rerun may have happened: the forge's own state decides, never a second request.
    const after = forge('checks.state', { ref });
    return picks.filter(entry => rerunStarted(after.units, entry));
  }
}

function escalationReport(parts: {
  key: string;
  round: string;
  prUrl: string;
  snapshotPath: string;
  reasons: readonly string[];
  decisions: readonly ThreadDecision[];
  threads: readonly SnapshotThread[];
  unknownIds: readonly string[];
  judgements: readonly CiJudgement[];
  snapshot: Snapshot;
}): string {
  const lines = [
    `# devflow-deliver needs a decision: ${parts.key}, round ${parts.round}`,
    '',
    `Pull request: ${parts.prUrl}`,
    `Round snapshot: \`${parts.snapshotPath}\``,
    '',
    '## Why the round stopped',
    '',
    ...parts.reasons.map(reason => `- ${reason}`),
    '',
  ];
  const human = parts.decisions.filter(d => d.decision === 'needs_human');
  if (human.length > 0) {
    lines.push('## Threads that need your decision', '');
    for (const decision of human) {
      const thread = parts.threads.find(t => t.id === decision.thread);
      lines.push(`### Thread \`${decision.thread}\``, '');
      if (thread !== undefined)
        lines.push(
          `- ${thread.url || '(no url)'} at \`${thread.path ?? '?'}:${String(thread.line ?? '?')}\``
        );
      lines.push(`- Judge: ${decision.reason}`, '');
      if (thread !== undefined)
        lines.push(
          'First comment (untrusted data):',
          '',
          fence(thread.comments[0]?.body ?? '', 1500),
          ''
        );
    }
  }
  const unknown = parts.judgements.filter(j => j.cause === 'unknown');
  if (unknown.length > 0) {
    lines.push('## Checks whose failure cause is unknown', '');
    for (const judgement of unknown) {
      const saved = parts.snapshot.red_units.find(unit => unit.name === judgement.name);
      lines.push(`### \`${judgement.name}\``, '');
      if (saved !== undefined)
        lines.push(`- Log: \`${saved.log_path}\`${saved.note === '' ? '' : ` (${saved.note})`}`);
      lines.push(
        `- What to check: ${judgement.fix || '(not stated)'}`,
        '',
        'Evidence (untrusted data):',
        '',
        fence(judgement.evidence, 1500),
        ''
      );
    }
  }
  if (parts.unknownIds.length > 0) {
    lines.push(
      `Ignored decisions for threads that are not open: ${parts.unknownIds.join(', ')}`,
      ''
    );
  }
  lines.push(
    '## How to answer',
    '',
    'Answer in plain text. Your answer becomes the next round’s work order and is shown to the',
    'thread and CI judges: say what to do with each item, for example that a thread should be',
    'declined and why, that a check failure is environmental and you reran it, or what to change.',
    ''
  );
  return lines.join('\n');
}

try {
  const key = validateKey(input('key'));
  const snapshotPath = input('snapshot_path');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  const ref = snapshot.pr;
  const head = snapshot.head_revision;
  const reconciled = reconcileDecisions(
    snapshot.threads,
    (nullableJson(input('decisions')) as ThreadDecision[] | null) ?? []
  );
  const judgements = (nullableJson(input('units')) as CiJudgement[] | null) ?? [];

  const replied = postReplies(ref, reconciled.decisions);

  const history = readHistory();
  const plan = planReruns(snapshot.checks_summary?.redUnits ?? [], judgements, history, head);
  const issued = issueReruns(ref, head, plan.rerun);
  if (issued.length > 0) {
    const at = new Date().toISOString();
    const records: IssuedRerun[] = [
      ...history,
      ...issued.map(entry => ({ head, unit: unitKey(entry.unit), at, id: entry.unit.id })),
    ];
    writeFileSync(artifactPath('reruns.json'), `${JSON.stringify(records, null, 2)}\n`);
  }

  const openThreads = unresolvedIds(ref).size;
  const outcome = computeRoundOutcome({
    head,
    checks: snapshot.checks,
    summary: snapshot.checks_summary,
    copilot: snapshot.copilot,
    openThreads,
    decisions: reconciled.decisions,
    ciJudgement: judgements,
    conflict: snapshot.conflict,
    rerunsIssued: issued.length,
    rerunHistory: history,
  });

  const byId = new Map(snapshot.threads.map(thread => [thread.id, thread]));
  const work = {
    accepted: reconciled.decisions.flatMap(decision => {
      const thread = byId.get(decision.thread);
      return decision.decision === 'accept' && thread !== undefined ? [{ decision, thread }] : [];
    }),
    prCaused: judgements
      .filter(judgement => judgement.cause === 'pr_caused')
      .map(judgement => ({
        judgement,
        logPath: snapshot.red_units.find(unit => unit.name === judgement.name)?.log_path ?? null,
      })),
    conflictBase: snapshot.conflict
      ? { branch: input('base'), revision: snapshot.base_revision }
      : null,
  };
  const nextWorkPath = artifactPath('next-work.md');
  const nextThreadsPath = artifactPath('next-threads.json');
  if (outcome.has_work && hasNextWork(work)) {
    writeFileSync(nextWorkPath, renderNextWork(work));
    writeFileSync(
      nextThreadsPath,
      `${JSON.stringify(work.accepted.map(entry => entry.thread.id))}\n`
    );
  } else {
    rmSync(nextWorkPath, { force: true });
    rmSync(nextThreadsPath, { force: true });
  }

  const reasons = [
    ...outcome.reasons,
    ...(reconciled.missing.length > 0
      ? [`the judge left thread(s) undecided: ${reconciled.missing.join(', ')}`]
      : []),
    ...(replied > 0 ? [`declined and resolved ${String(replied)} thread(s)`] : []),
  ];
  const reportPath = artifactPath('escalation.md');
  if (outcome.ask) {
    writeFileSync(
      reportPath,
      escalationReport({
        key,
        round: input('round'),
        prUrl: input('pr_url'),
        snapshotPath,
        reasons,
        decisions: reconciled.decisions,
        threads: snapshot.threads,
        unknownIds: reconciled.unknown,
        judgements,
        snapshot,
      })
    );
  } else {
    rmSync(reportPath, { force: true });
  }
  const summary = outcome.done
    ? 'done: checks green, Copilot settled, no open thread'
    : reasons.join('; ');
  emit({
    done: outcome.done,
    has_work: outcome.has_work,
    ask: outcome.ask,
    reruns: issued.length,
    summary: summary.length > 1500 ? `${summary.slice(0, 1500)}…` : summary,
    report_path: outcome.ask ? reportPath : '',
    pr_number: ref.number,
    pr_url: input('pr_url'),
  });
} catch (error) {
  refuse(`act: ${error instanceof Error ? error.message : String(error)}`);
}

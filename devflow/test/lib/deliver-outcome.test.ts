import { describe, expect, test } from 'bun:test';
import { summarizeChecks } from '../../pack/devflow/.shared/lib/checks.ts';
import {
  type CiJudgement,
  computeRoundOutcome,
  planReruns,
  recordReruns,
  type RoundFacts,
  type ThreadDecision,
  unitKey,
} from '../../pack/devflow/.shared/lib/deliver-outcome.ts';
import { HEAD, OLD, skippedUnit, snapshot, unit } from './check-fixtures.ts';

const greenSummary = summarizeChecks(snapshot([unit('build', 'green')]), HEAD, [], []);

/** A finished round: everything green, Copilot reviewed, nothing open. */
function facts(overrides: Partial<RoundFacts> = {}): RoundFacts {
  return {
    head: HEAD,
    checks: 'green',
    summary: greenSummary,
    copilot: 'done',
    openThreads: 0,
    decisions: [],
    ciJudgement: [],
    conflict: false,
    rerunsIssued: 0,
    rerunHistory: [],
    localVerifyFailed: false,
    ...overrides,
  };
}

const decision = (thread: string, kind: ThreadDecision['decision']): ThreadDecision => ({
  thread,
  decision: kind,
  reason: 'r',
  reply: kind === 'decline' || kind === 'not_this_change' ? 'reply' : '',
});
const judged = (name: string, cause: CiJudgement['cause']): CiJudgement => ({
  name,
  cause,
  evidence: 'e',
  fix: '',
});

function redSummary(...names: string[]) {
  return summarizeChecks(snapshot(names.map(name => unit(name, 'red'))), HEAD, [], []);
}

describe('computeRoundOutcome', () => {
  test('green but skipped asks a person once nothing else is pending, and is never done', () => {
    const summary = summarizeChecks(
      snapshot([unit('lint', 'green'), skippedUnit('build')]),
      HEAD,
      [],
      []
    );
    const outcome = computeRoundOutcome(facts({ summary }));
    expect(outcome).toMatchObject({ done: false, has_work: false, ask: true });
    expect(outcome.askReasons).toEqual([
      'checks skipped on the draft PR: build — CI may not run on drafts; make those jobs run on draft pull requests, or start a new run with allow_skipped_checks listing build',
    ]);
  });

  test('a skipped required check is not offered allow_skipped_checks', () => {
    const summary = summarizeChecks(
      snapshot([unit('lint', 'green'), skippedUnit('build'), skippedUnit('docs')]),
      HEAD,
      ['build'],
      ['build']
    );
    expect(computeRoundOutcome(facts({ summary })).askReasons).toEqual([
      'checks skipped on the draft PR: build, docs — CI may not run on drafts; make those jobs run on draft pull requests, or start a new run with allow_skipped_checks listing docs; required_checks must really run, so allow_skipped_checks cannot admit build (or remove it from required_checks)',
    ]);
    const onlyRequired = summarizeChecks(
      snapshot([unit('lint', 'green'), skippedUnit('build')]),
      HEAD,
      ['build'],
      []
    );
    expect(computeRoundOutcome(facts({ summary: onlyRequired })).askReasons[0]).not.toContain(
      'start a new run'
    );
  });

  test('a skipped unit beside a red one is status, not a second question', () => {
    const summary = summarizeChecks(
      snapshot([unit('test', 'red'), skippedUnit('build')]),
      HEAD,
      [],
      []
    );
    const outcome = computeRoundOutcome(
      facts({ checks: 'red', summary, ciJudgement: [judged('test', 'pr_caused')] })
    );
    expect(outcome).toMatchObject({ done: false, has_work: true, ask: false });
    expect(outcome.notes).toContain('skipped check(s) do not count as passed: build');
  });

  test('a failed local verify is work for the next round and asks', () => {
    const outcome = computeRoundOutcome(facts({ localVerifyFailed: true }));
    expect(outcome).toMatchObject({ done: false, has_work: true, ask: true });
    expect(outcome.notes).toContain('local_verify_cmd failed on the pushed head');
  });

  test('all clear is done, with no work and no ask', () => {
    expect(computeRoundOutcome(facts())).toEqual({
      done: true,
      has_work: false,
      ask: false,
      reasons: [],
      askReasons: [],
      notes: [],
    });
  });

  test('copilot off counts as reviewed', () => {
    expect(computeRoundOutcome(facts({ copilot: 'off' })).done).toBe(true);
  });

  // Each row breaks exactly one condition of `done` and names the expected flags.
  const rows: [string, Partial<RoundFacts>, { has_work: boolean; ask: boolean }][] = [
    [
      'accepted thread',
      { openThreads: 1, decisions: [decision('t1', 'accept')] },
      { has_work: true, ask: false },
    ],
    [
      'needs_human thread',
      { openThreads: 1, decisions: [decision('t1', 'needs_human')] },
      { has_work: false, ask: true },
    ],
    [
      'pr_caused CI failure',
      { checks: 'red', summary: redSummary('test'), ciJudgement: [judged('test', 'pr_caused')] },
      { has_work: true, ask: false },
    ],
    [
      'unknown CI failure',
      { checks: 'red', summary: redSummary('test'), ciJudgement: [judged('test', 'unknown')] },
      { has_work: false, ask: true },
    ],
    ['merge conflict', { conflict: true }, { has_work: true, ask: false }],
    ['copilot timeout', { copilot: 'timeout' }, { has_work: false, ask: true }],
    ['copilot request failed', { copilot: 'request_failed' }, { has_work: false, ask: true }],
    ['checks pending_timeout', { checks: 'pending_timeout' }, { has_work: false, ask: true }],
    ['checks gated', { checks: 'gated' }, { has_work: false, ask: true }],
    ['checks unknown', { checks: 'unknown' }, { has_work: false, ask: true }],
    ['checks none', { checks: 'none' }, { has_work: false, ask: true }],
    ['no checks snapshot', { summary: null }, { has_work: false, ask: true }],
    [
      'stale snapshot reported green (no progress)',
      { summary: summarizeChecks(snapshot([unit('build', 'green')], OLD), HEAD, [], []) },
      { has_work: false, ask: true },
    ],
    [
      'required check missing (no progress)',
      { summary: summarizeChecks(snapshot([unit('build', 'green')]), HEAD, ['sonar'], []) },
      { has_work: false, ask: true },
    ],
    [
      'unresolved thread nobody decided (no progress)',
      { openThreads: 2 },
      { has_work: false, ask: true },
    ],
  ];
  test.each(rows)('%s is not done', (_name, override, expected) => {
    const outcome = computeRoundOutcome(facts(override));
    expect(outcome.done).toBe(false);
    expect({ has_work: outcome.has_work, ask: outcome.ask }).toEqual(expected);
    expect(outcome.reasons.length).toBeGreaterThan(0);
    expect(outcome.askReasons.length > 0).toBe(expected.ask);
    expect([...outcome.reasons].sort()).toEqual([...outcome.askReasons, ...outcome.notes].sort());
  });

  test('only what needs a person is an ask reason; progress and blockers are notes', () => {
    // The E2E round: an accepted thread, a rerun issued, red checks, an open thread, and
    // Copilot silent on the head. Only Copilot's silence needs a person.
    const outcome = computeRoundOutcome(
      facts({
        copilot: 'timeout',
        checks: 'red',
        summary: redSummary('it'),
        openThreads: 1,
        decisions: [decision('t1', 'accept')],
        ciJudgement: [judged('it', 'infra')],
        rerunsIssued: 1,
      })
    );
    expect(outcome.ask).toBe(true);
    expect(outcome.askReasons).toEqual(['Copilot did not review the current head in time']);
    expect(outcome.notes).toEqual([
      '1 review thread(s) accepted for fixing',
      '1 rerun(s) issued; waiting for their result',
      'checks are red',
      '1 review thread(s) unresolved',
    ]);
  });

  test('declined threads that were resolved do not block done', () => {
    const outcome = computeRoundOutcome(
      facts({
        openThreads: 0,
        decisions: [decision('t1', 'decline'), decision('t2', 'not_this_change')],
      })
    );
    expect(outcome).toMatchObject({ done: true, ask: false, has_work: false });
  });

  test('an infra failure rerun this round waits: not done, no ask, no work', () => {
    const outcome = computeRoundOutcome(
      facts({
        checks: 'red',
        summary: redSummary('it'),
        ciJudgement: [judged('it', 'infra')],
        rerunsIssued: 1,
      })
    );
    expect(outcome).toMatchObject({ done: false, ask: false, has_work: false });
  });

  test('reruns issued block done even when checks read green', () => {
    expect(computeRoundOutcome(facts({ rerunsIssued: 1 }))).toMatchObject({
      done: false,
      ask: false,
    });
  });

  test('a planned rerun that was not issued asks', () => {
    const outcome = computeRoundOutcome(
      facts({
        checks: 'red',
        summary: redSummary('it'),
        ciJudgement: [judged('it', 'flaky')],
        rerunsIssued: 0,
      })
    );
    expect(outcome).toMatchObject({ done: false, ask: true });
  });

  test('still red after its one rerun on this head asks', () => {
    const history = recordReruns([], HEAD, [unit('it', 'red')], '2026-11-14T10:00:00Z');
    const outcome = computeRoundOutcome(
      facts({
        checks: 'red',
        summary: redSummary('it'),
        ciJudgement: [judged('it', 'infra')],
        rerunHistory: history,
      })
    );
    expect(outcome).toMatchObject({ done: false, ask: true });
    expect(outcome.reasons.some(reason => reason.includes('still red after one rerun'))).toBe(true);
  });

  test('a red unit nobody judged asks', () => {
    const outcome = computeRoundOutcome(
      facts({
        checks: 'red',
        summary: redSummary('a', 'b'),
        ciJudgement: [judged('a', 'pr_caused')],
      })
    );
    expect(outcome).toMatchObject({ done: false, has_work: true, ask: true });
  });

  test('work and ask can both hold', () => {
    const outcome = computeRoundOutcome(
      facts({
        openThreads: 2,
        decisions: [decision('t1', 'accept'), decision('t2', 'needs_human')],
        copilot: 'timeout',
      })
    );
    expect(outcome).toMatchObject({ done: false, has_work: true, ask: true });
  });
});

describe('rerun bookkeeping', () => {
  test('unitKey is kind and exact name', () => {
    expect(unitKey({ kind: 'check', id: '1', name: 'Build / jdk17' })).toBe('check:Build / jdk17');
  });

  test('planReruns sorts red units by judgement, rerunnability and history', () => {
    const units = [
      unit('fresh', 'red'),
      unit('again', 'red'),
      unit('status', 'red', null),
      unit('mine', 'red'),
      unit('mystery', 'red'),
      unit('nobody', 'red'),
    ];
    const judgements = [
      judged('fresh', 'flaky'),
      judged('again', 'infra'),
      judged('status', 'infra'),
      judged('mine', 'pr_caused'),
      judged('mystery', 'unknown'),
    ];
    const history = [
      { head: HEAD, unit: 'check:again', at: 't' },
      { head: OLD, unit: 'check:fresh', at: 't' },
    ];
    const plan = planReruns(units, judgements, history, HEAD);
    expect(plan.rerun.map(u => u.unit.name)).toEqual(['fresh']);
    expect(plan.repeated.map(u => u.unit.name)).toEqual(['again']);
    expect(plan.notRerunnable.map(u => u.unit.name)).toEqual(['status']);
    expect(plan.unjudged.map(u => u.unit.name)).toEqual(['nobody']);
  });

  test('a rerun on an older head does not count against the new head', () => {
    const history = recordReruns([], OLD, [unit('it', 'red')], 't');
    const plan = planReruns([unit('it', 'red')], [judged('it', 'infra')], history, HEAD);
    expect(plan.rerun.map(u => u.unit.name)).toEqual(['it']);
  });

  test('recordReruns appends one record per issued unit', () => {
    const before = [{ head: OLD, unit: 'check:x', at: 't0' }];
    const after = recordReruns(before, HEAD, [unit('a', 'red'), unit('b', 'red')], 't1');
    expect(after).toEqual([
      { head: OLD, unit: 'check:x', at: 't0' },
      { head: HEAD, unit: 'check:a', at: 't1' },
      { head: HEAD, unit: 'check:b', at: 't1' },
    ]);
    expect(before).toHaveLength(1);
  });
});

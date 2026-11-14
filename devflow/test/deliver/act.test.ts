import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckUnit } from '../../pack/devflow/.shared/lib/checks.ts';
import { deliverHarness, type FakeAnswer } from './harness.ts';

const harness = deliverHarness();
const REPO = { host: 'github.com', path: 'acme/shop' };
const REF = { repo: REPO, number: 7 };
const HEAD = 'a'.repeat(40);

function unit(name: string, state: CheckUnit['state'], id = `id-${name}`): CheckUnit {
  return {
    unit: { kind: 'check', id, name },
    nativeState: state,
    phase: 'completed',
    nativeResult: null,
    result: state === 'red' ? 'failure' : 'success',
    state,
    rerun: { id: `run-${name}`, attempt: 1 },
  };
}

function checksValue(units: CheckUnit[]) {
  const red = units.filter(u => u.state === 'red').length;
  return {
    units,
    summary: {
      state: red > 0 ? 'red' : 'green',
      counts: {
        total: units.length,
        green: units.length - red,
        red,
        pending: 0,
        gated: 0,
        unknown: 0,
      },
    },
    ref: REF,
    revision: HEAD,
    required: null,
  };
}

const snapThread = (id: string) => ({
  id,
  outdated: false,
  path: 'src/main/java/Greeter.java',
  line: 12,
  url: `https://github.com/acme/shop/pull/7#discussion_${id}`,
  comments: [{ author: 'copilot-pull-request-reviewer', body: `comment on ${id}`, url: '' }],
});

const forgeThread = (id: string, resolved: boolean) => ({
  id,
  resolved,
  outdated: false,
  path: 'src/main/java/Greeter.java',
  line: 12,
  comments: [],
});

const threadsAnswer = (...threads: ReturnType<typeof forgeThread>[]): FakeAnswer => ({
  value: { ref: REF, threads },
});

function snapshot(threads: string[], red: CheckUnit[], extra: Record<string, unknown> = {}) {
  const units = [...red, unit('lint', 'green')];
  const value = checksValue(units);
  return JSON.stringify({
    pr: REF,
    head_revision: HEAD,
    base: 'main',
    base_revision: 'c'.repeat(40),
    copilot: 'done',
    checks: red.length > 0 ? 'red' : 'green',
    checks_summary: {
      state: value.summary.state,
      stale: false,
      redUnits: red,
      missingRequired: [],
      skipped: [],
      skippedRequired: [],
      settled: true,
      green: red.length === 0,
    },
    checks_state: value,
    threads: threads.map(snapThread),
    red_units: red.map(entry => ({
      name: entry.unit.name,
      kind: 'check',
      log_path: `{ARTIFACTS}/ci-logs/${entry.unit.name}.log`,
      note: '',
    })),
    conflict: false,
    ...extra,
  });
}

function inputs(
  decisions: unknown,
  units: unknown,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    key: 'ABC-1',
    base: 'main',
    round: '1',
    pr_url: 'https://github.com/acme/shop/pull/7',
    local_verify_ok: 'true',
    local_verify_log: '',
    snapshot_path: '{ARTIFACTS}/snapshot.json',
    decisions: decisions === null ? 'null' : JSON.stringify(decisions),
    units: units === null ? 'null' : JSON.stringify(units),
    ...extra,
  };
}

describe('act', () => {
  test('replies to and resolves declined threads, reruns infra once, and hands accepted work on', () => {
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': snapshot(['PRRT_1', 'PRRT_2'], [unit('build', 'red')]) },
      inputs: inputs(
        [
          {
            thread: 'PRRT_1',
            decision: 'accept',
            reason: 'Reject null names in Greeter.greet.',
            reply: '',
          },
          {
            thread: 'PRRT_2',
            decision: 'decline',
            reason: 'covered',
            reply: 'GreeterTest.rejectsBlank covers it.',
          },
        ],
        [
          {
            name: 'build',
            cause: 'infra',
            evidence: 'ci-logs/build.log: 503 Service Unavailable',
            fix: '',
          },
        ]
      ),
      forge: {
        'pr.threads': [
          threadsAnswer(forgeThread('PRRT_1', false), forgeThread('PRRT_2', false)),
          threadsAnswer(forgeThread('PRRT_1', false), forgeThread('PRRT_2', true)),
        ],
        'pr.thread.reply': [{ value: {} }],
        'pr.thread.resolve': [{ value: {} }],
        'checks.state': [{ value: checksValue([unit('build', 'red'), unit('lint', 'green')]) }],
        'checks.rerun': [{ value: {} }],
      },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({
      done: false,
      has_work: true,
      ask: false,
      reruns: 1,
      pr_number: 7,
    });

    expect(run.requests.map(r => r.op)).toEqual([
      'pr.threads',
      'pr.thread.reply',
      'pr.thread.resolve',
      'checks.state',
      'checks.rerun',
      'pr.threads',
    ]);
    expect(run.requests[1]?.request).toEqual({
      ref: REF,
      thread: 'PRRT_2',
      body: 'GreeterTest.rejectsBlank covers it.',
    });
    expect(run.requests[2]?.request).toEqual({ ref: REF, thread: 'PRRT_2' });
    expect(run.requests[4]?.request).toEqual({
      ref: REF,
      revision: HEAD,
      units: [
        {
          unit: { kind: 'check', id: 'id-build', name: 'build' },
          rerun: { id: 'run-build', attempt: 1 },
        },
      ],
    });

    const reruns = JSON.parse(readFileSync(join(run.artifacts, 'reruns.json'), 'utf8'));
    expect(reruns).toMatchObject([{ head: HEAD, unit: 'check:build', id: 'id-build' }]);
    const nextWork = readFileSync(join(run.artifacts, 'next-work.md'), 'utf8');
    expect(nextWork).toContain('### Thread `PRRT_1`');
    expect(nextWork).toContain('Reject null names in Greeter.greet.');
    expect(nextWork).not.toContain('PRRT_2');
    expect(JSON.parse(readFileSync(join(run.artifacts, 'next-threads.json'), 'utf8'))).toEqual([
      'PRRT_1',
    ]);
    expect(existsSync(join(run.artifacts, 'escalation.md'))).toBe(false);
  });

  test('does not rerun a unit already rerun on this head, and asks', () => {
    const run = harness.run('act', {
      artifacts: {
        'snapshot.json': snapshot([], [unit('build', 'red', 'id-build-2')]),
        'reruns.json': JSON.stringify([
          { head: HEAD, unit: 'check:build', at: 'x', id: 'id-build' },
        ]),
      },
      inputs: inputs(null, [{ name: 'build', cause: 'flaky', evidence: 'timeout', fix: '' }]),
      forge: { 'pr.threads': [threadsAnswer()] },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ done: false, ask: true, reruns: 0 });
    expect(run.requests.some(r => r.op === 'checks.rerun')).toBe(false);
    const report = readFileSync(join(run.artifacts, 'escalation.md'), 'utf8');
    expect(report).toContain('still red after one rerun on this head: build');
    expect(report).toContain('## How to answer');
    expect(report).toContain('`skip-copilot`');
  });

  test('the summary and the report put what needs a person ahead of the round status', () => {
    const run = harness.run('act', {
      artifacts: {
        'snapshot.json': snapshot(['PRRT_1'], [unit('build', 'red')], {
          copilot: 'request_failed',
          request_error: 'Copilot was not registered as a reviewer after the request',
        }),
      },
      inputs: inputs(
        [{ thread: 'PRRT_1', decision: 'accept', reason: 'Reject null names.', reply: '' }],
        [{ name: 'build', cause: 'pr_caused', evidence: 'compile error', fix: 'fix it' }]
      ),
      forge: { 'pr.threads': [threadsAnswer(forgeThread('PRRT_1', false))] },
    });
    expect(run.status).toBe(0);
    const output = run.output();
    expect(output).toMatchObject({ done: false, ask: true, has_work: true });
    expect(output.summary).toBe(
      'needs you: requesting a Copilot review failed; status: 1 review thread(s) accepted for fixing; ' +
        'CI failure(s) caused by this change: build; checks are red; 1 review thread(s) unresolved'
    );
    const report = readFileSync(join(run.artifacts, 'escalation.md'), 'utf8');
    const needs = report.indexOf('## Needs your decision');
    const status = report.indexOf('## Status this round');
    expect(needs).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(needs);
    expect(report.slice(needs, status)).toContain('- requesting a Copilot review failed');
    expect(report.slice(needs, status)).toContain(
      'Copilot review request: Copilot was not registered as a reviewer'
    );
    expect(report.slice(needs, status)).not.toContain('checks are red');
    expect(report.slice(status)).toContain('- checks are red');
  });

  test('a rerun with an unknown outcome is settled by reading the checks back, never repeated', () => {
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': snapshot([], [unit('build', 'red')]) },
      inputs: inputs(null, [{ name: 'build', cause: 'infra', evidence: 'runner lost', fix: '' }]),
      forge: {
        'pr.threads': [threadsAnswer()],
        'checks.state': [
          { value: checksValue([unit('build', 'red')]) },
          { value: checksValue([unit('build', 'red', 'id-build-2')]) },
        ],
        'checks.rerun': [
          {
            failure: {
              error: { kind: 'timeout', message: 'no answer' },
              mutation: { outcome: 'outcome_unknown' },
            },
          },
        ],
      },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ reruns: 1, ask: false, done: false });
    expect(run.requests.filter(r => r.op === 'checks.rerun')).toHaveLength(1);
    expect(run.requests.filter(r => r.op === 'checks.state')).toHaveLength(2);
  });

  test('a needs_human thread and a thread the judge left out ask; nothing is posted for them', () => {
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': snapshot(['PRRT_7', 'PRRT_8'], []) },
      inputs: inputs(
        [{ thread: 'PRRT_7', decision: 'needs_human', reason: 'Choose 400 or 404.', reply: '' }],
        null
      ),
      forge: {
        'pr.threads': [threadsAnswer(forgeThread('PRRT_7', false), forgeThread('PRRT_8', false))],
      },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ done: false, ask: true, has_work: false });
    expect(run.requests.map(r => r.op)).toEqual(['pr.threads']);
    const report = readFileSync(join(run.artifacts, 'escalation.md'), 'utf8');
    expect(report).toContain('### Thread `PRRT_7`');
    expect(report).toContain('Choose 400 or 404.');
    expect(report).toContain('### Thread `PRRT_8`');
    expect(report).toContain('comment on PRRT_8');
  });

  test('a green round with no thread is done without any write', () => {
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': snapshot([], []) },
      inputs: inputs(null, null),
      forge: { 'pr.threads': [threadsAnswer()] },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({
      done: true,
      has_work: false,
      ask: false,
      reruns: 0,
      report_path: '',
    });
    expect(run.requests.map(r => r.op)).toEqual(['pr.threads']);
  });

  test('a failed local verify is next round work and asks, so a green round is not done', () => {
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': snapshot([], []) },
      inputs: inputs(null, null, {
        local_verify_ok: 'false',
        local_verify_log: '/runs/x/local-verify-final.log',
      }),
      forge: { 'pr.threads': [threadsAnswer()] },
    });
    expect(run.stderr).toBe('');
    expect(run.output()).toMatchObject({ done: false, has_work: true, ask: true });
    expect(String(run.output().summary)).toContain('local_verify_cmd failed on the pushed head');
    const nextWork = readFileSync(join(run.artifacts, 'next-work.md'), 'utf8');
    expect(nextWork).toContain('## The local verify command fails');
    expect(nextWork).toContain('/runs/x/local-verify-final.log');
  });

  test('checks the forge calls green but skipped ask instead of finishing', () => {
    const skippedSnapshot = JSON.parse(snapshot([], [])) as Record<string, unknown>;
    skippedSnapshot.checks_summary = {
      ...(skippedSnapshot.checks_summary as Record<string, unknown>),
      skipped: ['build'],
      skippedRequired: [],
      green: false,
    };
    const run = harness.run('act', {
      artifacts: { 'snapshot.json': JSON.stringify(skippedSnapshot) },
      inputs: inputs(null, null),
      forge: { 'pr.threads': [threadsAnswer()] },
    });
    expect(run.output()).toMatchObject({ done: false, has_work: false, ask: true });
    expect(String(run.output().summary)).toContain(
      'checks skipped on the draft PR: build — CI may not run on drafts'
    );
  });
});

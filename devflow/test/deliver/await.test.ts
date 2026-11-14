import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CheckUnit, ChecksState } from '../../pack/devflow/.shared/lib/checks.ts';
import type { ReviewItem } from '../../pack/devflow/.shared/lib/copilot.ts';
import { deliverHarness, type FakeAnswer, gitCheckout } from './harness.ts';

const harness = deliverHarness();
const REPO = { host: 'github.com', path: 'acme/shop' };

function unit(name: string, state: CheckUnit['state'], id = `id-${name}`): CheckUnit {
  return {
    unit: { kind: 'check', id, name },
    nativeState: state,
    phase: state === 'pending' ? 'running' : 'completed',
    nativeResult: null,
    result: state === 'green' ? 'success' : state === 'red' ? 'failure' : null,
    state,
    rerun: { id: `run-${name}`, attempt: 1 },
  };
}

function checks(revision: string, units: CheckUnit[]): FakeAnswer {
  const counts = { total: units.length, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 };
  for (const entry of units) counts[entry.state]++;
  const state =
    (['red', 'gated', 'unknown', 'pending', 'green'] as const).find(s => counts[s] > 0) ?? 'none';
  const value: ChecksState = {
    units,
    summary: { state, counts },
    ref: { repo: REPO, number: 7 },
    revision,
    required: null,
  };
  return { value };
}

function copilotReview(commit: string): ReviewItem {
  return {
    kind: 'review',
    id: 'r1',
    author: {
      host: 'github.com',
      id: '1',
      login: 'copilot-pull-request-reviewer[bot]',
      type: 'bot',
    },
    commit,
    state: 'COMMENTED',
    createdAt: '2026-11-14T10:00:00Z',
    url: 'https://github.com/acme/shop/pull/7#pullrequestreview-1',
    body: 'Copilot reviewed 2 files.',
  };
}

const thread = (id: string, resolved: boolean) => ({
  id,
  resolved,
  outdated: false,
  path: 'src/main/java/Greeter.java',
  line: 10,
  comments: [
    {
      id: `c-${id}`,
      author: { host: 'github.com', id: '2', login: 'copilot-pull-request-reviewer' },
      body: 'Consider null.',
      url: `https://github.com/acme/shop/pull/7#discussion_${id}`,
    },
  ],
});

function inputs(head: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    repo: JSON.stringify(REPO),
    base: 'main',
    pr_number: '7',
    head_revision: head,
    request_error: '',
    copilot_mode: 'request',
    copilot_logins: 'copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot]',
    poll_interval_sec: '1',
    copilot_wait_min: '30',
    ci_wait_min: '90',
    required_checks: '',
    ...extra,
  };
}

describe('await', () => {
  test('polls until Copilot reviewed the head and the head checks settle, then snapshots', () => {
    const { checkout, head } = gitCheckout(harness.root());
    const run = harness.run('await', {
      cwd: checkout,
      inputs: inputs(head),
      forge: {
        // Poll 1: Copilot reviewed an older commit only; checks still running on the head.
        // Poll 2: Copilot reviewed the head; checks red and settled.
        'pr.reviews': [
          { value: { ref: { repo: REPO, number: 7 }, items: [copilotReview('f'.repeat(40))] } },
          { value: { ref: { repo: REPO, number: 7 }, items: [copilotReview(head)] } },
        ],
        'checks.state': [
          checks(head, [unit('build', 'pending'), unit('lint', 'green')]),
          checks(head, [unit('build', 'red'), unit('lint', 'green')]),
        ],
        'pr.threads': [
          {
            value: {
              ref: { repo: REPO, number: 7 },
              threads: [thread('PRRT_1', false), thread('PRRT_0', true)],
            },
          },
        ],
        'checks.logs': [
          {
            value: {
              repo: REPO,
              unit: { kind: 'check', id: 'id-build', name: 'build' },
              log: {
                kind: 'text',
                text: '[ERROR] COMPILATION ERROR\n',
                truncated: false,
                totalBytes: 26,
              },
            },
          },
        ],
      },
    });
    expect(run.stderr).not.toContain('refus');
    expect(run.status).toBe(0);
    const output = run.output();
    expect(output).toMatchObject({
      head_revision: head,
      copilot: 'done',
      checks: 'red',
      open_threads: 1,
      red_units: 1,
      conflict: false,
    });
    expect(run.requests.filter(r => r.op === 'pr.reviews')).toHaveLength(2);
    expect(run.requests.filter(r => r.op === 'checks.state')).toHaveLength(2);
    const logs = run.requests.filter(r => r.op === 'checks.logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.request).toMatchObject({ repo: REPO, unit: { name: 'build', id: 'id-build' } });

    const snapshot = JSON.parse(readFileSync(String(output.snapshot_path), 'utf8'));
    expect(snapshot.threads.map((t: { id: string }) => t.id)).toEqual(['PRRT_1']);
    expect(snapshot.copilot_review.body).toBe('Copilot reviewed 2 files.');
    expect(snapshot.red_units[0].name).toBe('build');
    expect(readFileSync(snapshot.red_units[0].log_path, 'utf8')).toContain('COMPILATION ERROR');
  });

  test('a checks observation of another commit is not settled', () => {
    const { checkout, head } = gitCheckout(harness.root());
    const run = harness.run('await', {
      cwd: checkout,
      inputs: inputs(head, { copilot_mode: 'off' }),
      forge: {
        'checks.state': [
          checks('e'.repeat(40), [unit('build', 'green')]),
          checks(head, [unit('build', 'green')]),
        ],
        'pr.threads': [{ value: { ref: { repo: REPO, number: 7 }, threads: [] } }],
      },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ copilot: 'off', checks: 'green', red_units: 0 });
    expect(run.requests.filter(r => r.op === 'checks.state')).toHaveLength(2);
    expect(run.requests.some(r => r.op === 'pr.reviews')).toBe(false);
  });

  test('waits for a rerun this pack issued to start before reading red as settled', () => {
    const { checkout, head } = gitCheckout(harness.root());
    const run = harness.run('await', {
      cwd: checkout,
      inputs: inputs(head, { copilot_mode: 'off' }),
      artifacts: {
        'reruns.json': JSON.stringify([
          { head, unit: 'check:build', at: '2026-11-14T10:00:00Z', id: 'id-build' },
        ]),
      },
      forge: {
        // Still the old red unit, then the rerun (new id) green.
        'checks.state': [
          checks(head, [unit('build', 'red')]),
          checks(head, [unit('build', 'green', 'id-build-2')]),
        ],
        'pr.threads': [{ value: { ref: { repo: REPO, number: 7 }, threads: [] } }],
      },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ checks: 'green', red_units: 0 });
    expect(run.requests.filter(r => r.op === 'checks.state')).toHaveLength(2);
  });

  test('a failed review request does not wait for Copilot', () => {
    const { checkout, head } = gitCheckout(harness.root());
    const run = harness.run('await', {
      cwd: checkout,
      inputs: inputs(head, { request_error: 'copilot_request_cmd exited 1' }),
      forge: {
        'pr.reviews': [{ value: { ref: { repo: REPO, number: 7 }, items: [] } }],
        'checks.state': [checks(head, [unit('build', 'green')])],
        'pr.threads': [{ value: { ref: { repo: REPO, number: 7 }, threads: [] } }],
      },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ copilot: 'request_failed', checks: 'green' });
  });

  test('refuses a head that is not a commit SHA without calling the forge', () => {
    const run = harness.run('await', { inputs: inputs('main') });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('head_revision is not a commit SHA');
    expect(run.requests).toHaveLength(0);
  });
});

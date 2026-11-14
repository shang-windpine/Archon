import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHarness, type FakeAnswer, gitCheckout } from './harness.ts';

const harness = deliverHarness();
const REPO = { host: 'github.com', path: 'acme/shop' };

const SETTINGS = {
  checkstyle_cmd: 'true',
  local_verify_cmd: '',
  copilot_mode: 'off',
  copilot_request_cmd: '',
  copilot_logins: '',
  poll_interval_sec: '60',
  copilot_wait_min: '30',
  ci_wait_min: '90',
  required_checks: '',
};

function prRecord(number: number, head: string, revision: string, draft = true) {
  return {
    repo: REPO,
    number,
    schemaVersion: 1,
    url: `https://github.com/acme/shop/pull/${String(number)}`,
    head,
    base: 'main',
    is_draft: draft,
    state: 'open',
    head_repo: REPO,
    head_revision: revision,
    base_revision: null,
    maintainer_can_modify: null,
  };
}

const forgeAccess: Record<string, FakeAnswer[]> = {
  check: [
    {
      value: {
        host: 'github.com',
        plugin: { name: 'forge-github', version: '1' },
        operations: [],
        credentialSource: 'gh auth token',
      },
    },
  ],
  resolve: [
    {
      value: {
        kind: 'resolved',
        forge: 'github',
        repo: REPO,
        plugin: { name: 'forge-github', version: '1' },
      },
    },
  ],
};

describe('preflight', () => {
  test('refuses without a finalized requirement, before any forge call', () => {
    const { checkout } = gitCheckout(harness.root());
    const run = harness.run('preflight', {
      cwd: checkout,
      inputs: { key: 'ABC-1', pr: '', ...SETTINGS },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no finalized requirement for ABC-1');
    expect(run.stderr).toContain('run devflow-refine');
    expect(run.requests).toHaveLength(0);
  });

  test('checks forge access, finds no PR, and writes round 1', () => {
    const root = harness.root();
    const { checkout, base } = gitCheckout(root);
    const state = join(root, 'state-in');
    mkdirSync(join(state, 'devflow', 'ABC-1'), { recursive: true });
    writeFileSync(join(state, 'devflow', 'ABC-1', 'requirement.md'), '# ABC-1\n');
    writeFileSync(join(state, 'devflow', 'ABC-1', 'followup-work.md'), '- UI-2 failed\n');
    // The harness gives each run its own state dir; point the script at this one.
    const run = harness.run('preflight', {
      cwd: checkout,
      inputs: { key: 'ABC-1', pr: '', ...SETTINGS },
      forge: { ...forgeAccess, 'pr.view': [{ value: null }] },
      env: { STATE_DIR: state, BASE_BRANCH: 'main' },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({
      repo: REPO,
      base: 'main',
      head: 'feature/ABC-1',
      has_followup: true,
      pr_number: 0,
    });
    expect(run.requests.map(r => r.op)).toEqual(['check', 'resolve', 'pr.view', 'pr.view']);
    const order = readFileSync(join(run.artifacts, 'work-order.md'), 'utf8');
    expect(order).toContain('round 1');
    expect(order).toContain('followup-work.md');
    expect(readFileSync(join(run.artifacts, 'base-revision.txt'), 'utf8').trim()).toBe(base);
  });

  test('refuses on the base branch', () => {
    const root = harness.root();
    const { checkout } = gitCheckout(root);
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: checkout });
    const state = join(root, 'state-in');
    mkdirSync(join(state, 'devflow', 'ABC-1'), { recursive: true });
    writeFileSync(join(state, 'devflow', 'ABC-1', 'requirement.md'), '# ABC-1\n');
    const run = harness.run('preflight', {
      cwd: checkout,
      inputs: { key: 'ABC-1', pr: '', ...SETTINGS },
      env: { STATE_DIR: state, BASE_BRANCH: 'main' },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('on the base branch main');
    expect(run.requests).toHaveLength(0);
  });
});

describe('publish', () => {
  test('pushes, opens a draft PR, and answers only the fixed threads the work order handed over', () => {
    const { checkout, head } = gitCheckout(harness.root());
    const run = harness.run('publish', {
      cwd: checkout,
      artifacts: {
        'pr-title.txt': 'Add greeting\n',
        'pr-body.md': '## Summary\n\nAdds a greeting.\n',
        'work-threads.json': '["PRRT_1","PRRT_3"]',
      },
      inputs: {
        key: 'ABC-1',
        repo: JSON.stringify(REPO),
        base: 'main',
        head: 'feature/ABC-1',
        pr_number: '0',
        checks_ok: 'true',
        checkstyle_cmd: 'true',
        local_verify_cmd: '',
        threads: JSON.stringify([
          { thread: 'PRRT_1', status: 'fixed', note: 'Greeter rejects null.' },
          { thread: 'PRRT_2', status: 'fixed', note: 'not handed over' },
          { thread: 'PRRT_3', status: 'not_fixed', note: 'claim is wrong at head' },
        ]),
      },
      forge: {
        'pr.view': [{ value: null }],
        'pr.create': [{ value: { pr: prRecord(9, 'feature/ABC-1', head) } }],
        'pr.threads': [{ value: { ref: { repo: REPO, number: 9 }, threads: [] } }],
        'pr.thread.reply': [{ value: {} }],
        'pr.thread.resolve': [{ value: {} }],
      },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({
      pr: { number: 9, url: 'https://github.com/acme/shop/pull/9', is_draft: true },
      pushed: true,
      head_revision: head,
      answered: 1,
    });
    const create = run.requests.find(r => r.op === 'pr.create')?.request;
    expect(create).toMatchObject({
      draft: true,
      head: 'feature/ABC-1',
      headRevision: head,
      title: 'ABC-1: Add greeting',
    });
    const replies = run.requests.filter(r => r.op === 'pr.thread.reply');
    expect(replies.map(r => r.request.thread)).toEqual(['PRRT_1']);
    expect(String(replies[0]?.request.body)).toBe(
      `Fixed in ${head.slice(0, 12)}: Greeter rejects null.`
    );
    expect(JSON.parse(readFileSync(join(run.artifacts, 'thread-notes.json'), 'utf8'))).toEqual({
      PRRT_3: 'claim is wrong at head',
    });
    const remote = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature/ABC-1'], {
      cwd: checkout,
      encoding: 'utf8',
    });
    expect(remote.stdout.split(/\s+/)[0]).toBe(head);
  });

  test('refuses when the local gate is still red, without pushing', () => {
    const { checkout } = gitCheckout(harness.root());
    const run = harness.run('publish', {
      cwd: checkout,
      inputs: {
        key: 'ABC-1',
        repo: JSON.stringify(REPO),
        base: 'main',
        head: 'feature/ABC-1',
        pr_number: '9',
        checks_ok: 'false',
        checkstyle_cmd: 'echo violation; exit 1',
        local_verify_cmd: '',
        threads: 'null',
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('checkstyle_cmd still fails on HEAD');
    expect(run.requests).toHaveLength(0);
    expect(existsSync(join(run.artifacts, 'checkstyle-final.log'))).toBe(true);
  });
});

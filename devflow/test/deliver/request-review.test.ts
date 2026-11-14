import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHarness } from './harness.ts';

const harness = deliverHarness();
const HEAD = 'a'.repeat(40);
const REPO = { host: 'github.com', path: 'acme/shop' };
const LOGINS = 'copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot],copilot,Copilot';

function inputs(command: string, confirm = ''): Record<string, string> {
  return {
    repo: JSON.stringify(REPO),
    pr_number: '7',
    head_revision: HEAD,
    copilot_mode: 'request',
    copilot_request_cmd: command,
    copilot_confirm_cmd: confirm,
    copilot_logins: LOGINS,
  };
}

function recorded(artifacts: string): unknown {
  const path = join(artifacts, 'copilot-requests.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

describe('request-review', () => {
  test('runs the rendered command once per head and records it', () => {
    const run = harness.run('request-review', {
      inputs: inputs('printf "%s|%s" {number} {repo} > "$ARTIFACTS_DIR/argv"'),
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: true, head_revision: HEAD, error: '' });
    expect(readFileSync(join(run.artifacts, 'argv'), 'utf8')).toBe('7|acme/shop');
    expect(recorded(run.artifacts)).toMatchObject([{ head: HEAD }]);
  });

  test('skips a head already requested', () => {
    const run = harness.run('request-review', {
      inputs: inputs('exit 9'),
      artifacts: { 'copilot-requests.json': JSON.stringify([{ head: HEAD, at: 'x' }]) },
    });
    expect(run.output()).toEqual({ requested: false, head_revision: HEAD, error: '' });
  });

  test('a failing command is reported, not a node failure, and not recorded', () => {
    const run = harness.run('request-review', { inputs: inputs('exit 3') });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({
      requested: false,
      error: expect.stringContaining('exited 3'),
    });
    expect(recorded(run.artifacts)).toBeNull();
  });

  test('a person who chose skip-copilot turns the request off for the run', () => {
    const run = harness.run('request-review', {
      inputs: inputs('touch "$ARTIFACTS_DIR/ran"'),
      artifacts: { 'copilot-skipped': '' },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: false, head_revision: HEAD, error: '' });
    expect(existsSync(join(run.artifacts, 'ran'))).toBe(false);
  });

  // The fakes model GitHub: the request appends a review_requested event's reviewer to
  // `events`, and the confirm command prints them. An earlier round's Copilot line is
  // already there, so only a new one counts. (A request that adds no line is refused only
  // after the confirm re-reads' backoff; test/lib/copilot.test.ts covers that path.)
  const REQUEST = 'echo Copilot >> "$ARTIFACTS_DIR/events"';
  const CONFIRM = 'cat "$ARTIFACTS_DIR/events"';

  test('a request whose event appears counts; stderr and tokens are handled', () => {
    const run = harness.run('request-review', {
      inputs: inputs(
        REQUEST,
        // stderr noise must not be read as a login, and the tokens render as shell words.
        `echo "warning: Copilot" >&2; printf "%s\\n" {host} repos/{path}/issues/{number} >> "$ARTIFACTS_DIR/argv"; ${CONFIRM}`
      ),
      artifacts: { events: 'Copilot\noctocat\n' },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: true, head_revision: HEAD, error: '' });
    // Run once before the request and once after it.
    expect(readFileSync(join(run.artifacts, 'argv'), 'utf8')).toBe(
      'github.com\nrepos/acme/shop/issues/7\n'.repeat(2)
    );
    expect(recorded(run.artifacts)).toMatchObject([{ head: HEAD }]);
    expect(run.requests.some(r => r.op === 'pr.reviews')).toBe(false);
    expect(run.notices).toEqual([]);
  });

  test('a confirm command failing after the request warns and still counts it', () => {
    const run = harness.run('request-review', {
      inputs: inputs(REQUEST, 'if [ -f "$ARTIFACTS_DIR/events" ]; then echo boom >&2; exit 4; fi'),
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: true, head_revision: HEAD, error: '' });
    expect(recorded(run.artifacts)).toMatchObject([{ head: HEAD }]);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toContain('copilot_confirm_cmd exited 4');
    expect(run.notices[0]).toContain('counts as made');
    expect(readFileSync(join(run.artifacts, 'copilot-confirm.log'), 'utf8')).toContain('boom');
  });

  test('a confirm command failing before the request warns and the request counts', () => {
    const run = harness.run('request-review', {
      inputs: inputs(
        REQUEST,
        'echo "$(cat "$ARTIFACTS_DIR/runs" 2>/dev/null)x" > "$ARTIFACTS_DIR/runs"; exit 5'
      ),
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: true, head_revision: HEAD, error: '' });
    expect(readFileSync(join(run.artifacts, 'events'), 'utf8')).toBe('Copilot\n');
    // Not run again after the request: without the before count nothing can be compared.
    expect(readFileSync(join(run.artifacts, 'runs'), 'utf8')).toBe('x\n');
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toContain('before the request');
  });

  test('a confirm template with an unknown token refuses before the request runs', () => {
    const run = harness.run('request-review', {
      inputs: inputs('touch "$ARTIFACTS_DIR/ran"', 'gh api repos/{path}/issues/{nmber}/events'),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('{nmber}');
    expect(existsSync(join(run.artifacts, 'ran'))).toBe(false);
  });
});

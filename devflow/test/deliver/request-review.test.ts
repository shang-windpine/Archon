import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHarness } from './harness.ts';

const harness = deliverHarness();
const HEAD = 'a'.repeat(40);

function inputs(command: string): Record<string, string> {
  return {
    repo: JSON.stringify({ host: 'github.com', path: 'acme/shop' }),
    pr_number: '7',
    head_revision: HEAD,
    copilot_mode: 'request',
    copilot_request_cmd: command,
  };
}

describe('request-review', () => {
  test('runs the rendered command once per head and records it', () => {
    const run = harness.run('request-review', {
      inputs: inputs('printf "%s|%s" {number} {repo} > "$ARTIFACTS_DIR/argv"'),
    });
    expect(run.status).toBe(0);
    expect(run.output()).toEqual({ requested: true, head_revision: HEAD, error: '' });
    expect(readFileSync(join(run.artifacts, 'argv'), 'utf8')).toBe('7|acme/shop');
    expect(
      JSON.parse(readFileSync(join(run.artifacts, 'copilot-requests.json'), 'utf8'))
    ).toMatchObject([{ head: HEAD }]);
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
  });
});

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHarness, gitCheckout } from '../deliver/harness.ts';

const harness = deliverHarness('devflow-verify');

/** A state directory holding DEMO-1's requirement and, optionally, an earlier run's files. */
function stateWith(root: string, files: Record<string, string>): { state: string; key: string } {
  const state = join(root, 'state');
  const key = join(state, 'devflow', 'DEMO-1');
  mkdirSync(key, { recursive: true });
  writeFileSync(join(key, 'requirement.md'), '# DEMO-1\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(key, name), content);
  return { state, key };
}

function runContext(files: Record<string, string>) {
  const root = harness.root();
  const { checkout } = gitCheckout(root);
  const { state, key } = stateWith(root, files);
  const run = harness.run('context', {
    cwd: checkout,
    inputs: { key: 'DEMO-1' },
    env: { STATE_DIR: state, BASE_BRANCH: 'main' },
  });
  return { run, key };
}

describe('verify context', () => {
  test('archives the previous plan, results and report, but keeps an undelivered follow-up and says so', () => {
    const { run, key } = runContext({
      'verify-plan.md': 'old plan\n',
      'verify-report.md': 'old report\n',
      'followup-work.md': 'old failures\n',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const output = run.output();
    expect(existsSync(join(key, 'verify-plan.md'))).toBe(false);
    expect(existsSync(join(key, 'verify-report.md'))).toBe(false);
    expect(readFileSync(join(key, 'followup-work.md'), 'utf8')).toBe('old failures\n');
    expect(String(output.followup_notice)).toContain(
      'from an earlier verification has not been delivered yet'
    );
    expect(readFileSync(String(output.context_path), 'utf8')).toContain(
      'has not been delivered yet'
    );
  });

  test('no follow-up file, no notice', () => {
    const { run } = runContext({});
    expect(run.status).toBe(0);
    expect(run.output().followup_notice).toBe('');
  });
});

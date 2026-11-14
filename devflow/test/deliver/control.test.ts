import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverHarness } from './harness.ts';

const harness = deliverHarness();

function inputs(extra: Record<string, string> = {}): Record<string, string> {
  return {
    key: 'ABC-1',
    previous_round: '1',
    previous_has_work: 'false',
    previous_pr: '7',
    answer: '',
    answer_choice: '',
    first_pr: '7',
    requirement: '{ARTIFACTS}/requirement.md',
    ...extra,
  };
}

describe('control', () => {
  test('skip-copilot writes the marker and records the choice for the judges', () => {
    const run = harness.run('control', {
      inputs: inputs({ answer_choice: 'skip-copilot' }),
      artifacts: { 'escalation.md': '# question\n' },
    });
    expect(run.status).toBe(0);
    expect(run.output()).toMatchObject({ round: 2, implement: false, pr_number: 7 });
    expect(existsSync(join(run.artifacts, 'copilot-skipped'))).toBe(true);
    expect(readFileSync(join(run.artifacts, 'human-answers.md'), 'utf8')).toContain(
      'stop waiting for a Copilot review'
    );
  });

  test('skip-copilot with text still makes the text the work order', () => {
    const run = harness.run('control', {
      inputs: inputs({ answer_choice: 'skip-copilot', answer: 'Rename greet to hello.' }),
      artifacts: { 'escalation.md': '# question\n' },
    });
    expect(run.output()).toMatchObject({ implement: true });
    expect(existsSync(join(run.artifacts, 'copilot-skipped'))).toBe(true);
    expect(readFileSync(join(run.artifacts, 'work-order.md'), 'utf8')).toContain(
      'Rename greet to hello.'
    );
  });

  test('continue and a skipped escalation leave no marker, and an existing one stays', () => {
    const answered = harness.run('control', {
      inputs: inputs({ answer_choice: 'continue', answer: 'Keep 400.' }),
    });
    expect(answered.output()).toMatchObject({ implement: true });
    expect(existsSync(join(answered.artifacts, 'copilot-skipped'))).toBe(false);

    const later = harness.run('control', {
      inputs: inputs({ previous_round: '3' }),
      artifacts: { 'copilot-skipped': 'skip-copilot chosen before round 2\n' },
    });
    expect(later.output()).toMatchObject({ round: 4, implement: false });
    expect(existsSync(join(later.artifacts, 'copilot-skipped'))).toBe(true);
  });

  test('refuses a choice the escalate wait does not declare', () => {
    const run = harness.run('control', { inputs: inputs({ answer_choice: 'skip' }) });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not one of continue, skip-copilot');
  });
});

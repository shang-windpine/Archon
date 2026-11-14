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

  test('round 1 restores the pristine work order and keeps the run history (failure resume)', () => {
    // What a failed later round leaves behind when the engine restarts the loop at 1.
    const run = harness.run('control', {
      inputs: inputs({ previous_round: '', previous_has_work: '', previous_pr: '' }),
      artifacts: {
        'work-order.round1.md': '# Work order: ABC-1, round 1\n\nImplement the requirement.\n',
        'work-threads.round1.json': '[]\n',
        'work-order.md': '# Work order: ABC-1, round 3\n\nNo code work this round.\n',
        'work-threads.json': '["PRRT_9"]\n',
        'next-work.md': '## Accepted review threads\n',
        'next-threads.json': '["PRRT_9"]\n',
        'escalation.md': '# old question\n',
        'reruns.json': '[{"head":"h","unit":"check:it","at":"x","id":"1"}]\n',
        'copilot-requests.json': '["h"]\n',
        'human-answers.md': '## Answer before round 2\n\nKeep 400.\n',
        'copilot-skipped': 'skip-copilot chosen before round 2\n',
      },
    });
    expect(run.stderr).toBe('');
    expect(run.output()).toMatchObject({ round: 1, implement: true, pr_number: 7 });
    const read = (name: string) => readFileSync(join(run.artifacts, name), 'utf8');
    expect(read('work-order.md')).toBe(read('work-order.round1.md'));
    expect(read('work-threads.json')).toBe('[]\n');
    for (const name of ['next-work.md', 'next-threads.json', 'escalation.md'])
      expect(existsSync(join(run.artifacts, name))).toBe(false);
    expect(read('reruns.json')).toContain('check:it');
    expect(read('copilot-requests.json')).toContain('"h"');
    expect(read('human-answers.md')).toContain('Keep 400.');
    expect(existsSync(join(run.artifacts, 'copilot-skipped'))).toBe(true);
  });

  test('round 1 refuses when preflight left no round 1 work order', () => {
    const run = harness.run('control', {
      inputs: inputs({ previous_round: '', previous_has_work: '', previous_pr: '' }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('preflight wrote no');
  });

  test('refuses a choice the escalate wait does not declare', () => {
    const run = harness.run('control', { inputs: inputs({ answer_choice: 'skip' }) });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not one of continue, skip-copilot');
  });
});

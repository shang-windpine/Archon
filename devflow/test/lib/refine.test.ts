import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  controlStep,
  GATE_DECISIONS,
  fenced,
  finalizationLines,
  gateAsks,
  gateRecommendation,
  humanEntry,
  numbered,
  reviewEntry,
} from '../../pack/devflow/.shared/lib/refine.ts';

describe('gateAsks', () => {
  test.each([
    ['always', 'revise', false, true],
    ['always', 'approve', false, true],
    ['auto', 'revise', false, false],
    ['auto', 'revise', true, true],
    ['auto', 'approve', false, true],
    ['never', 'revise', true, false],
    ['never', 'approve', false, true],
  ] as const)('%s with %s, needs_human %p -> %p', (mode, verdict, needsHuman, expected) => {
    expect(gateAsks(mode, verdict, needsHuman)).toBe(expected);
  });
});

describe('gateRecommendation', () => {
  test('recommends finalize only for an approval that needs no person', () => {
    expect(gateRecommendation('approve', false).option).toBe('finalize');
    expect(gateRecommendation('approve', true).option).toBe('revise');
    expect(gateRecommendation('revise', false).option).toBe('revise');
  });
});

describe('controlStep', () => {
  test('no previous answer is the first round, or a round after a skipped gate', () => {
    expect(controlStep(1, { decision: '', text: '' })).toEqual({ kind: 'first' });
    expect(controlStep(3, { decision: '', text: 'ignored' })).toEqual({ kind: 'continue' });
  });
  test('revise and finalize carry the trimmed text', () => {
    expect(controlStep(2, { decision: 'revise', text: ' add AC for null names \n' })).toEqual({
      kind: 'revise',
      text: 'add AC for null names',
    });
    expect(controlStep(4, { decision: 'finalize', text: '' })).toEqual({
      kind: 'finalize',
      text: '',
    });
  });
  test('an undeclared decision throws instead of looping or finalizing', () => {
    expect(() => controlStep(2, { decision: 'other', text: 'x' })).toThrow(
      /not one of finalize, revise/
    );
  });
});

describe('fenced', () => {
  test('uses a fence longer than any backtick run in the text', () => {
    const text = 'a ```` b';
    const block = fenced(text, 'text');
    expect(block.startsWith('`````text\n')).toBe(true);
    expect(block.endsWith('\n`````\n')).toBe(true);
  });
  test('plain text gets a three-backtick fence and a trailing newline', () => {
    expect(fenced('x')).toBe('```\nx\n```\n');
  });
});

describe('log entries', () => {
  test('a human entry names the round and decision and fences the text', () => {
    expect(humanEntry(2, 'revise', 'use a 404')).toBe(
      '\n### Round 2 — human answer: revise\n\n```text\nuse a 404\n```\n'
    );
    expect(humanEntry(3, 'finalize', '')).toContain('_(no text)_');
  });
  test('a review entry fences the review so its headings stay inside', () => {
    const entry = reviewEntry({
      round: 1,
      verdict: 'revise',
      needsHuman: true,
      asked: true,
      summary: 'Two major findings.',
      questions: ['Keep the old endpoint?'],
      review: '## Findings\n1. major ...',
    });
    expect(entry).toContain('### Round 1 — review: revise, needs_human true (a person is asked)');
    expect(entry).toContain('1. Keep the old endpoint?');
    expect(entry).toContain('```markdown\n## Findings\n1. major ...\n```\n');
  });
  test('numbered lists questions or says none', () => {
    expect(numbered([])).toBe('(none)\n');
    expect(numbered([' a ', 'b'])).toBe('1. a\n2. b\n');
  });
});

describe('finalizationLines', () => {
  test('records each non-empty note on one line, verbatim', () => {
    const lines = finalizationLines('2026-11-14', 'run-1', [
      { source: 'round gate', text: 'ship it\nbut log "x"' },
      { source: 'final gate', text: '  ' },
    ]);
    expect(lines).toBe(
      '\n- 2026-11-14 — Operator note at finalization: "ship it but log \\"x\\"" — operator (round gate, run run-1) — recorded verbatim; the sections above were not redrafted to reflect it.\n'
    );
  });
  test('no notes add nothing', () => {
    expect(finalizationLines('2026-11-14', 'r', [{ source: 's', text: '' }])).toBe('');
  });
});

describe('GATE_DECISIONS', () => {
  test('the decisions are the gate wait options devflow-refine.yaml declares', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, '../../pack/devflow/devflow-refine/devflow-refine.yaml'),
        'utf8'
      )
    ) as {
      nodes: {
        id: string;
        loop_group?: {
          nodes: { id: string; wait?: { form?: string; options?: { id: string }[] } }[];
        };
      }[];
    };
    const gate = workflow.nodes
      .flatMap(node => node.loop_group?.nodes ?? [])
      .find(node => node.id === 'gate');
    expect(gate?.wait?.form).toBe('select');
    expect(gate?.wait?.options?.map(option => option.id)).toEqual([...GATE_DECISIONS]);
  });
});

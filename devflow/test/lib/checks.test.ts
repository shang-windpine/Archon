import { describe, expect, test } from 'bun:test';
import { summarizeChecks } from '../../pack/devflow/.shared/lib/checks.ts';
import { HEAD, OLD, skippedUnit, snapshot, unit } from './check-fixtures.ts';

describe('summarizeChecks', () => {
  test('all green on the head is green and settled', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), unit('test', 'green')]),
      HEAD,
      [],
      []
    );
    expect(s).toMatchObject({
      state: 'green',
      stale: false,
      settled: true,
      green: true,
      missingRequired: [],
    });
    expect(s.redUnits).toEqual([]);
  });

  test('none is not green and not settled', () => {
    const s = summarizeChecks(snapshot([]), HEAD, [], []);
    expect(s).toMatchObject({ state: 'none', settled: false, green: false });
  });

  test('none with explicit approval-pending evidence is gated and settled', () => {
    const s = summarizeChecks(snapshot([], HEAD, true), HEAD, [], []);
    expect(s).toMatchObject({ state: 'gated', settled: true, green: false });
  });

  test('a green snapshot of another commit is stale, not green, not settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green')], OLD), HEAD, [], []);
    expect(s).toMatchObject({ state: 'green', stale: true, settled: false, green: false });
  });

  test('pending plus red is red but not settled, with the red units listed', () => {
    const red = unit('test', 'red');
    const s = summarizeChecks(snapshot([unit('build', 'pending'), red]), HEAD, [], []);
    expect(s).toMatchObject({ state: 'red', settled: false, green: false });
    expect(s.redUnits).toEqual([red]);
  });

  test('all completed with one red is red and settled', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), unit('test', 'red')]),
      HEAD,
      [],
      []
    );
    expect(s).toMatchObject({ state: 'red', settled: true, green: false });
    expect(s.redUnits.map(u => u.unit.name)).toEqual(['test']);
  });

  test('gated is settled but not green', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), unit('deploy', 'gated')]),
      HEAD,
      [],
      []
    );
    expect(s).toMatchObject({ state: 'gated', settled: true, green: false });
  });

  test('gated with a unit still pending is not settled', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'pending'), unit('deploy', 'gated')]),
      HEAD,
      [],
      []
    );
    expect(s).toMatchObject({ state: 'gated', settled: false });
  });

  test('unknown is settled but not green', () => {
    const s = summarizeChecks(snapshot([unit('ext', 'unknown')]), HEAD, [], []);
    expect(s).toMatchObject({ state: 'unknown', settled: true, green: false });
  });

  test('a missing required check turns green into pending, unsettled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green')]), HEAD, ['build', 'sonar'], []);
    expect(s).toMatchObject({
      state: 'pending',
      settled: false,
      green: false,
      missingRequired: ['sonar'],
    });
  });

  test('required names match exactly (case-sensitive)', () => {
    const s = summarizeChecks(snapshot([unit('Build', 'green')]), HEAD, ['build'], []);
    expect(s.missingRequired).toEqual(['build']);
    expect(s.green).toBe(false);
  });

  test('every required check present and green is green', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), unit('sonar', 'green')]),
      HEAD,
      ['build', 'sonar'],
      []
    );
    expect(s).toMatchObject({ state: 'green', green: true, missingRequired: [] });
  });

  test('a skipped unit is settled but never green, though the forge calls it green', () => {
    const s = summarizeChecks(
      snapshot([unit('lint', 'green'), skippedUnit('build'), skippedUnit('it')]),
      HEAD,
      [],
      []
    );
    expect(s).toMatchObject({
      state: 'green',
      settled: true,
      green: false,
      skipped: ['build', 'it'],
    });
  });

  test('allow_skipped_checks lets named units be skipped, but never a required one', () => {
    const units = [unit('build', 'green'), skippedUnit('docs'), skippedUnit('it')];
    expect(summarizeChecks(snapshot(units), HEAD, [], ['docs', 'it'])).toMatchObject({
      green: true,
      skipped: [],
    });
    expect(summarizeChecks(snapshot(units), HEAD, ['it'], ['docs', 'it'])).toMatchObject({
      green: false,
      skipped: ['it'],
      skippedRequired: ['it'],
    });
  });

  test('a name is skipped only when every unit carrying it is skipped', () => {
    // A workflow on push and pull_request: the push run passed, the draft one was skipped.
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), skippedUnit('build'), skippedUnit('it')]),
      HEAD,
      ['build'],
      []
    );
    expect(s).toMatchObject({ skipped: ['it'], skippedRequired: [], green: false });
    expect(
      summarizeChecks(snapshot([unit('build', 'green'), skippedUnit('build')]), HEAD, ['build'], [])
    ).toMatchObject({ skipped: [], green: true });
    expect(
      summarizeChecks(snapshot([skippedUnit('build'), skippedUnit('build')]), HEAD, ['build'], [])
    ).toMatchObject({ skipped: ['build'], skippedRequired: ['build'], green: false });
  });

  test('a red required check stays red and settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'red')]), HEAD, ['build', 'sonar'], []);
    expect(s).toMatchObject({
      state: 'red',
      settled: true,
      green: false,
      missingRequired: ['sonar'],
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { summarizeChecks } from '../../pack/devflow/.shared/lib/checks.ts';
import { HEAD, OLD, snapshot, unit } from './check-fixtures.ts';

describe('summarizeChecks', () => {
  test('all green on the head is green and settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green'), unit('test', 'green')]), HEAD, []);
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
    const s = summarizeChecks(snapshot([]), HEAD, []);
    expect(s).toMatchObject({ state: 'none', settled: false, green: false });
  });

  test('none with explicit approval-pending evidence is gated and settled', () => {
    const s = summarizeChecks(snapshot([], HEAD, true), HEAD, []);
    expect(s).toMatchObject({ state: 'gated', settled: true, green: false });
  });

  test('a green snapshot of another commit is stale, not green, not settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green')], OLD), HEAD, []);
    expect(s).toMatchObject({ state: 'green', stale: true, settled: false, green: false });
  });

  test('pending plus red is red but not settled, with the red units listed', () => {
    const red = unit('test', 'red');
    const s = summarizeChecks(snapshot([unit('build', 'pending'), red]), HEAD, []);
    expect(s).toMatchObject({ state: 'red', settled: false, green: false });
    expect(s.redUnits).toEqual([red]);
  });

  test('all completed with one red is red and settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green'), unit('test', 'red')]), HEAD, []);
    expect(s).toMatchObject({ state: 'red', settled: true, green: false });
    expect(s.redUnits.map(u => u.unit.name)).toEqual(['test']);
  });

  test('gated is settled but not green', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'green'), unit('deploy', 'gated')]),
      HEAD,
      []
    );
    expect(s).toMatchObject({ state: 'gated', settled: true, green: false });
  });

  test('gated with a unit still pending is not settled', () => {
    const s = summarizeChecks(
      snapshot([unit('build', 'pending'), unit('deploy', 'gated')]),
      HEAD,
      []
    );
    expect(s).toMatchObject({ state: 'gated', settled: false });
  });

  test('unknown is settled but not green', () => {
    const s = summarizeChecks(snapshot([unit('ext', 'unknown')]), HEAD, []);
    expect(s).toMatchObject({ state: 'unknown', settled: true, green: false });
  });

  test('a missing required check turns green into pending, unsettled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green')]), HEAD, ['build', 'sonar']);
    expect(s).toMatchObject({
      state: 'pending',
      settled: false,
      green: false,
      missingRequired: ['sonar'],
    });
  });

  test('required names match exactly (case-sensitive)', () => {
    const s = summarizeChecks(snapshot([unit('Build', 'green')]), HEAD, ['build']);
    expect(s.missingRequired).toEqual(['build']);
    expect(s.green).toBe(false);
  });

  test('every required check present and green is green', () => {
    const s = summarizeChecks(snapshot([unit('build', 'green'), unit('sonar', 'green')]), HEAD, [
      'build',
      'sonar',
    ]);
    expect(s).toMatchObject({ state: 'green', green: true, missingRequired: [] });
  });

  test('a red required check stays red and settled', () => {
    const s = summarizeChecks(snapshot([unit('build', 'red')]), HEAD, ['build', 'sonar']);
    expect(s).toMatchObject({
      state: 'red',
      settled: true,
      green: false,
      missingRequired: ['sonar'],
    });
  });
});

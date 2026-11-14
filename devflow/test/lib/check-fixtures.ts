/** Check-snapshot builders shared by the checks and deliver-outcome tests. */
import type { ChecksState, CheckUnit } from '../../pack/devflow/.shared/lib/checks.ts';

export const HEAD = 'a'.repeat(40);
export const OLD = 'b'.repeat(40);

type UnitState = CheckUnit['state'];

export function unit(
  name: string,
  state: UnitState,
  rerun: CheckUnit['rerun'] = { id: `run-${name}`, attempt: 1 }
): CheckUnit {
  return {
    unit: { kind: 'check', id: `id-${name}`, name },
    nativeState: state,
    phase: state === 'pending' ? 'running' : 'completed',
    nativeResult: null,
    result: state === 'green' ? 'success' : state === 'red' ? 'failure' : null,
    state,
    rerun,
  };
}

/** A unit the forge concluded `skipped`, which it counts as green. */
export function skippedUnit(name: string): CheckUnit {
  return {
    unit: { kind: 'check', id: `id-${name}`, name },
    nativeState: 'completed',
    phase: 'completed',
    nativeResult: 'skipped',
    result: 'skipped',
    state: 'green',
    rerun: null,
  };
}

/** A snapshot whose summary follows the forge's precedence (red, gated, unknown, pending, green). */
export function snapshot(
  units: CheckUnit[],
  revision = HEAD,
  approvalPending: boolean | null = null
): ChecksState {
  const counts = { total: units.length, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 };
  for (const entry of units) counts[entry.state]++;
  const state =
    (['red', 'gated', 'unknown', 'pending', 'green'] as const).find(s => counts[s] > 0) ?? 'none';
  return {
    units,
    summary: { state, counts },
    ref: { repo: { host: 'github.com', path: 'o/r' }, number: 7 },
    revision,
    required: null,
    approvalPending,
  };
}

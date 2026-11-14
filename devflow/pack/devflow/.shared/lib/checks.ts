/**
 * What one `checks.state` observation means for the pull request's current head.
 *
 * The forge's summary precedence is red, gated, unknown, pending, green; `none` means
 * no unit was enumerated. On top of it this pack requires that the observation is of
 * the current head (`revision`), and that every `required_checks` name is present:
 * the GitHub plugin reports `required: null`, so a green summary alone does not prove a
 * required check ever started. `none` and a stale observation are never green.
 *
 * Pure: the only import from `archon:script` is a type, erased at runtime.
 */

import type { ForgeOperations } from 'archon:script';

export type ChecksState = ForgeOperations['checks.state']['result'];
export type CheckUnit = ChecksState['units'][number];
export type ChecksVerdict = 'green' | 'red' | 'pending' | 'none' | 'gated' | 'unknown';

export interface ChecksSummary {
  /**
   * The forge summary, except: a green summary missing a required check is `pending`,
   * and `none` with explicit approval-pending evidence is `gated`.
   */
  readonly state: ChecksVerdict;
  /** The observation is of another commit than the head. */
  readonly stale: boolean;
  /** Every red unit, as the forge read it (`checks.rerun` needs them unchanged). */
  readonly redUnits: readonly CheckUnit[];
  /** Required check names no unit carries (exact name match). */
  readonly missingRequired: readonly string[];
  /**
   * Waiting longer will not change the verdict by itself: the observation is of the
   * head, at least one unit (or an approval gate) exists, and no unit is pending.
   */
  readonly settled: boolean;
  /** The only acceptance: `state` green, not stale, every required check present. */
  readonly green: boolean;
}

export function summarizeChecks(
  checks: ChecksState,
  headRevision: string,
  requiredChecks: readonly string[]
): ChecksSummary {
  const stale = checks.revision !== headRevision;
  const names = new Set(checks.units.map(entry => entry.unit.name));
  const missingRequired = requiredChecks.filter(name => !names.has(name));
  let state: ChecksVerdict = checks.summary.state;
  if (state === 'green' && missingRequired.length > 0) state = 'pending';
  if (state === 'none' && checks.approvalPending === true) state = 'gated';
  const anyPending = checks.units.some(entry => entry.state === 'pending');
  const settled = !stale && state !== 'none' && state !== 'pending' && !anyPending;
  return {
    state,
    stale,
    redUnits: checks.units.filter(entry => entry.state === 'red'),
    missingRequired,
    settled,
    green: state === 'green' && !stale,
  };
}

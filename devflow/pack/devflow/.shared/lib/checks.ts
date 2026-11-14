/**
 * What one `checks.state` observation means for the pull request's current head.
 *
 * The forge's summary precedence is red, gated, unknown, pending, green; `none` means
 * no unit was enumerated. On top of it this pack requires that the observation is of
 * the current head (`revision`), and that every `required_checks` name is present:
 * the GitHub plugin reports `required: null`, so a green summary alone does not prove a
 * required check ever started. `none` and a stale observation are never green.
 *
 * The forge also counts a unit whose result is `skipped` as green. A CI job guarded by
 * `if: !github.event.pull_request.draft` is skipped on every draft pull request, and
 * devflow keeps its pull request a draft, so a green summary of skipped units would
 * accept a head CI never tested. A skipped name therefore blocks acceptance unless
 * `allow_skipped_checks` names it; a name in `required_checks` must really pass, so
 * listing it in both does not allow it to be skipped.
 *
 * Skipping is judged per name, not per unit: the GitHub plugin does not deduplicate by
 * name, so a workflow on both `push` and `pull_request` yields two `build` units on one
 * head, the push one run and the draft pull_request one skipped. CI did test that head,
 * so a name is skipped only when every unit carrying it is.
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
   * Names whose every unit the forge reports `skipped` and that may not be skipped: not
   * in `allowSkipped`, or required. Any entry blocks `green`.
   */
  readonly skipped: readonly string[];
  /** The `skipped` names that are in `requiredChecks`; `allowSkipped` cannot admit them. */
  readonly skippedRequired: readonly string[];
  /**
   * Waiting longer will not change the verdict by itself: the observation is of the
   * head, at least one unit (or an approval gate) exists, and no unit is pending.
   */
  readonly settled: boolean;
  /**
   * The only acceptance: `state` green, not stale, every required check present, and no
   * unit skipped that may not be.
   */
  readonly green: boolean;
}

export function summarizeChecks(
  checks: ChecksState,
  headRevision: string,
  requiredChecks: readonly string[],
  allowSkipped: readonly string[]
): ChecksSummary {
  const stale = checks.revision !== headRevision;
  const names = new Set(checks.units.map(entry => entry.unit.name));
  const missingRequired = requiredChecks.filter(name => !names.has(name));
  const mayBeSkipped = (name: string): boolean =>
    allowSkipped.includes(name) && !requiredChecks.includes(name);
  const ran = new Set(
    checks.units.filter(entry => entry.result !== 'skipped').map(entry => entry.unit.name)
  );
  const skipped = [...names].filter(name => !ran.has(name) && !mayBeSkipped(name));
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
    skipped,
    skippedRequired: skipped.filter(name => requiredChecks.includes(name)),
    settled,
    green: state === 'green' && !stale && skipped.length === 0,
  };
}

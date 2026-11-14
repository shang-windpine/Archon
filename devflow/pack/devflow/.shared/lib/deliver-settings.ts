/**
 * devflow-deliver's pack settings (DESIGN §3), parsed once into typed values.
 *
 * A script reads each setting with a literal `input('<name>')` (the engine's load-time
 * check only sees literal names) and hands the raw text here. Every bad value throws
 * naming the setting, so preflight refuses before any agent spends.
 *
 * Pure: no `archon:script` import.
 */

import { parseEnum, parseList, parsePositiveInt } from './devflow.ts';

export const COPILOT_MODES = ['request', 'auto', 'off'] as const;
export type CopilotMode = (typeof COPILOT_MODES)[number];

/**
 * The longest a wait may be configured to. The await node's `timeout:` is 150 minutes;
 * its own deadline must end first, leaving time to save logs and emit its snapshot.
 */
export const MAX_WAIT_MIN = 140;

export interface RawDeliverSettings {
  readonly checkstyle_cmd: string;
  readonly local_verify_cmd: string;
  readonly copilot_mode: string;
  readonly copilot_request_cmd: string;
  readonly copilot_logins: string;
  readonly poll_interval_sec: string;
  readonly copilot_wait_min: string;
  readonly ci_wait_min: string;
  readonly required_checks: string;
}

/** The settings the await node reads. */
export interface AwaitSettings {
  readonly copilotMode: CopilotMode;
  readonly copilotLogins: readonly string[];
  readonly pollIntervalSec: number;
  readonly copilotWaitMin: number;
  readonly ciWaitMin: number;
  readonly requiredChecks: readonly string[];
}

export interface DeliverSettings extends AwaitSettings {
  readonly checkstyleCmd: string;
  readonly localVerifyCmd: string;
  readonly copilotRequestCmd: string;
}

function waitMinutes(raw: string, fallback: number, label: string): number {
  const value = parsePositiveInt(raw, fallback, label);
  if (value > MAX_WAIT_MIN) {
    throw new Error(`${label} must be at most ${String(MAX_WAIT_MIN)} minutes, got ${raw}`);
  }
  return value;
}

export function parseAwaitSettings(
  raw: Pick<
    RawDeliverSettings,
    | 'copilot_mode'
    | 'copilot_logins'
    | 'poll_interval_sec'
    | 'copilot_wait_min'
    | 'ci_wait_min'
    | 'required_checks'
  >
): AwaitSettings {
  const copilotMode = parseEnum(raw.copilot_mode, COPILOT_MODES, 'request', 'copilot_mode');
  const copilotLogins = parseList(raw.copilot_logins);
  if (copilotMode !== 'off' && copilotLogins.length === 0) {
    throw new Error(
      'copilot_logins is empty, so no review could ever count as Copilot’s; list its logins or set copilot_mode to off'
    );
  }
  const pollIntervalSec = parsePositiveInt(raw.poll_interval_sec, 60, 'poll_interval_sec');
  if (pollIntervalSec > 600) {
    throw new Error(`poll_interval_sec must be at most 600, got ${raw.poll_interval_sec}`);
  }
  return {
    copilotMode,
    copilotLogins,
    pollIntervalSec,
    copilotWaitMin: waitMinutes(raw.copilot_wait_min, 30, 'copilot_wait_min'),
    ciWaitMin: waitMinutes(raw.ci_wait_min, 90, 'ci_wait_min'),
    requiredChecks: parseList(raw.required_checks),
  };
}

export function parseDeliverSettings(raw: RawDeliverSettings): DeliverSettings {
  const waits = parseAwaitSettings(raw);
  const copilotRequestCmd = raw.copilot_request_cmd.trim();
  if (waits.copilotMode === 'request' && copilotRequestCmd === '') {
    throw new Error('copilot_mode is request but copilot_request_cmd is empty');
  }
  if (raw.checkstyle_cmd.trim() === '') {
    throw new Error('checkstyle_cmd is empty; set it to the project’s checkstyle command');
  }
  return {
    ...waits,
    checkstyleCmd: raw.checkstyle_cmd.trim(),
    localVerifyCmd: raw.local_verify_cmd.trim(),
    copilotRequestCmd,
  };
}

/**
 * devflow's own conventions: the KEY that names a requirement, where its cross-run
 * state lives, pack-setting parsing, and running an operator-configured command.
 *
 * Pure of `archon:script`: it reads the engine's environment (`STATE_DIR`,
 * `ARTIFACTS_DIR`) directly so it can be unit-tested without the script preload.
 */

import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** DESIGN §2: a Jira key or an operator slug; also a safe single path segment. */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The key itself when it is valid; throws naming the rule otherwise. Surrounding whitespace is not accepted. */
export function validateKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `key ${JSON.stringify(key)} is not valid: it must match ${KEY_PATTERN.source} ` +
        '(a Jira key such as ABC-123, or a slug of letters, digits, ".", "_" and "-")'
    );
  }
  return key;
}

function engineDir(name: 'STATE_DIR' | 'ARTIFACTS_DIR'): string {
  const value = process.env[name] ?? '';
  if (value === '' || !isAbsolute(value)) {
    throw new Error(
      `$${name} is not set to an absolute path; this must run inside an Archon workflow node`
    );
  }
  return value;
}

/** `$STATE_DIR/devflow/<key>`, created if missing. The key is validated first. */
export function stateDir(key: string): string {
  const dir = join(engineDir('STATE_DIR'), 'devflow', validateKey(key));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A path under the key's state directory; its parent directory is created. */
export function statePath(key: string, ...segments: string[]): string {
  const path = join(stateDir(key), ...segments);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** This run's `$ARTIFACTS_DIR`, created if missing. */
export function runArtifactsDir(): string {
  const dir = engineDir('ARTIFACTS_DIR');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A path under `$ARTIFACTS_DIR`; its parent directory is created. */
export function artifactPath(...segments: string[]): string {
  const path = join(runArtifactsDir(), ...segments);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** A list setting: comma-separated, each item trimmed, empty items dropped. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');
}

/** A positive-integer setting: `fallback` when empty; throws on anything else that is not one. */
export function parsePositiveInt(raw: string, fallback: number, label = 'value'): number {
  const text = raw.trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** An enum setting: `fallback` when empty; throws on a value outside `allowed`. */
export function parseEnum<T extends string>(
  raw: string,
  allowed: readonly T[],
  fallback: T,
  label = 'value'
): T {
  const text = raw.trim();
  if (text === '') return fallback;
  const match = allowed.find(candidate => candidate === text);
  if (match === undefined) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return match;
}

/** One POSIX shell word whose value is exactly `value`, whatever it contains. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Fill a command template's `{name}` tokens with shell-quoted values (DESIGN §3).
 *
 * A token is `{` + identifier + `}` not preceded by `$`, so shell `${VAR}` expansion
 * and braces that are not identifiers (`awk '{print $1}'`) pass through untouched.
 * A token with no value in `vars` throws: a typo in a setting must not run a command
 * with a literal `{nmber}` in it. Values are inserted as whole single-quoted words, so
 * a token must not itself sit inside quotes in the template.
 */
export function renderCommand(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_token, name: string) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) {
      const known = Object.keys(vars)
        .map(known => `{${known}}`)
        .join(', ');
      throw new Error(`command template uses {${name}}, which is not one of: ${known || '(none)'}`);
    }
    return shellQuote(value);
  });
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Receives the command's combined stdout and stderr; overwritten. */
  readonly logPath: string;
  /** Characters of the log's end to return; default 4000. */
  readonly tailChars?: number;
}

export interface RunCommandResult {
  /** The exit code; null when the command ended on a signal (including the timeout kill). */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** The last `tailChars` characters of the combined output. */
  readonly outputTail: string;
}

function readTail(path: string, chars: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    // UTF-8 is at most 4 bytes per character; trim to characters after decoding.
    const length = Math.min(size, chars * 4);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return text.length > chars ? text.slice(text.length - chars) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Run an operator-configured command with `sh -c`, its combined output written to
 * `logPath`. The command runs in its own process group so a timeout kills everything
 * it started (a build tool's forked JVMs included), not only the shell. Never throws
 * for a failing command: the caller decides what a nonzero exit means. The command
 * text is not logged: an operator's command can carry a credential.
 */
export async function runCommand(
  command: string,
  options: RunCommandOptions
): Promise<RunCommandResult> {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const fd = openSync(options.logPath, 'w');
  let timedOut = false;
  let code: number | null;
  try {
    const child = spawn('sh', ['-c', command], {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The group already exited between the timer firing and the kill.
      }
    }, options.timeoutMs);
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', exitCode => resolve(exitCode));
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    closeSync(fd);
  }
  return { code, timedOut, outputTail: readTail(options.logPath, options.tailChars ?? 4000) };
}

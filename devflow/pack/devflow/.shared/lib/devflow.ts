/**
 * devflow's own conventions: the KEY that names a requirement, where its cross-run
 * state lives, pack-setting parsing, and running an operator-configured command.
 *
 * Pure of `archon:script`: it reads the engine's environment (`STATE_DIR`,
 * `ARTIFACTS_DIR`) directly so it can be unit-tested without the script preload.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
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
  /** Receives the command's combined stdout and stderr (only stderr with `stdoutPath`); overwritten. */
  readonly logPath: string;
  /**
   * Receives the command's stdout alone, overwritten, for a caller that parses it; stderr
   * then goes to `logPath` without it.
   */
  readonly stdoutPath?: string;
  /** Characters of the log's end to return; default 4000. */
  readonly tailChars?: number;
}

export interface RunCommandResult {
  /** The exit code; null when the command ended on a signal (including the timeout kill). */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** The last `tailChars` characters of `logPath`. */
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

export interface ShellHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
}

/**
 * The shell that runs operator-configured commands. Command templates are POSIX shell
 * (single-quoted tokens, `{print $1}`), so Windows needs Git Bash, never cmd.exe or
 * PowerShell. The lookup mirrors the engine's bash resolution for bash nodes
 * (`ARCHON_BASH_PATH`, then the usual Git for Windows locations) so a pack command and
 * a bash node run under the same shell; the pack cannot import engine code, so it is
 * repeated here. A missing Git Bash returns the default path, and the spawn error then
 * names it.
 */
export function commandShell(host: ShellHost): string {
  const override = host.env.ARCHON_BASH_PATH;
  if (override) {
    if (!host.exists(override))
      throw new Error(`ARCHON_BASH_PATH points to a path that does not exist: '${override}'`);
    return override;
  }
  if (host.platform !== 'win32') return 'sh';
  const programFiles = host.env.ProgramFiles ?? 'C:\\Program Files';
  const candidates = [
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    `${host.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    ...(host.env.LOCALAPPDATA ? [`${host.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
    ...(host.env.USERPROFILE
      ? [`${host.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`]
      : []),
  ];
  return candidates.find(candidate => host.exists(candidate)) ?? (candidates[0] as string);
}

/** Kills a command and everything it started: its process group on POSIX, its process tree on Windows. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }).on('error', () => {
      // taskkill missing or the tree already gone: the timeout is still reported.
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group already exited between the timer firing and the kill.
  }
}

/**
 * Run an operator-configured command with the POSIX shell from `commandShell` (`sh`,
 * or Git Bash on Windows) and `-c`, its combined output written to
 * `logPath` (stdout to `stdoutPath` instead, when given). A timeout kills everything the command started (a build tool's forked
 * JVMs included), not only the shell: the process group on POSIX, the process tree
 * (`taskkill /T /F`) on Windows, where process groups do not exist. Never throws
 * for a failing command: the caller decides what a nonzero exit means. The command
 * text is not logged: an operator's command can carry a credential.
 */
export async function runCommand(
  command: string,
  options: RunCommandOptions
): Promise<RunCommandResult> {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const fd = openSync(options.logPath, 'w');
  let outFd = fd;
  let timedOut = false;
  let code: number | null;
  try {
    if (options.stdoutPath !== undefined) {
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      outFd = openSync(options.stdoutPath, 'w');
    }
    let shell: string;
    try {
      shell = commandShell({ platform: process.platform, env: process.env, exists: existsSync });
    } catch (error) {
      // A wrong ARCHON_BASH_PATH is a failed command, not a thrown error: callers that only
      // warn on a failing command (a Jira fetch, a review confirmation) must keep running.
      writeSync(fd, `devflow: ${error instanceof Error ? error.message : String(error)}\n`);
      return {
        code: 127,
        timedOut: false,
        outputTail: readTail(options.logPath, options.tailChars ?? 4000),
      };
    }
    const child = spawn(shell, ['-c', command], {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', outFd, fd],
      // A new process group on POSIX; on Windows `detached` would open a console window.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, options.timeoutMs);
    try {
      code = await new Promise<number | null>(resolve => {
        // The shell itself could not start (no Git Bash on Windows): report it as exit 127,
        // the shell's own "command not found" code, with the remedy in the log.
        child.once('error', error => {
          writeSync(
            fd,
            `devflow: could not start '${shell}': ${error.message}. On Windows install Git for Windows or set ARCHON_BASH_PATH to its bash.exe.\n`
          );
          resolve(127);
        });
        child.once('close', exitCode => resolve(exitCode));
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (outFd !== fd) closeSync(outFd);
    closeSync(fd);
  }
  return { code, timedOut, outputTail: readTail(options.logPath, options.tailChars ?? 4000) };
}

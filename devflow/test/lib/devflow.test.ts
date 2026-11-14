import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactPath,
  parseEnum,
  parseList,
  parsePositiveInt,
  renderCommand,
  runCommand,
  shellQuote,
  stateDir,
  statePath,
  validateKey,
} from '../../pack/devflow/.shared/lib/devflow.ts';
import { trackTempRoots } from '../temp-roots.ts';

const track = trackTempRoots();
const scratch = (): string => track(mkdtempSync(join(tmpdir(), 'devflow-lib-')));

/** What `sh` hands the program as its argv after the template is rendered. */
function shArgs(command: string): string[] {
  const result = Bun.spawnSync(['sh', '-c', `${command}`], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString()) as string[];
}
const ARGV_PRINTER = `bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;

describe('validateKey', () => {
  test.each(['ABC-123', 'a', 'feature_x.v2', '9', 'A'.repeat(64)])('accepts %p', key => {
    expect(validateKey(key)).toBe(key);
  });
  test.each(['', '-abc', '.hidden', '..', 'a/b', 'a b', ' ABC-1', 'ABC-1\n', 'A'.repeat(65), 'ä'])(
    'refuses %p',
    key => {
      expect(() => validateKey(key)).toThrow(/is not valid/);
    }
  );
});

describe('stateDir and artifactPath', () => {
  const saved = { state: process.env.STATE_DIR, artifacts: process.env.ARTIFACTS_DIR };
  let root = '';
  beforeEach(() => {
    root = scratch();
    process.env.STATE_DIR = join(root, 'state');
    process.env.ARTIFACTS_DIR = join(root, 'artifacts');
  });
  afterEach(() => {
    process.env.STATE_DIR = saved.state;
    process.env.ARTIFACTS_DIR = saved.artifacts;
  });

  test('stateDir is $STATE_DIR/devflow/<key> and exists', () => {
    const dir = stateDir('ABC-1');
    expect(dir).toBe(join(root, 'state', 'devflow', 'ABC-1'));
    expect(existsSync(dir)).toBe(true);
  });
  test('statePath creates the parent directory', () => {
    const path = statePath('ABC-1', 'requirement.history', 'run-1.md');
    expect(path).toBe(join(root, 'state', 'devflow', 'ABC-1', 'requirement.history', 'run-1.md'));
    expect(existsSync(join(root, 'state', 'devflow', 'ABC-1', 'requirement.history'))).toBe(true);
  });
  test('stateDir refuses an invalid key before touching the filesystem', () => {
    expect(() => stateDir('../escape')).toThrow(/is not valid/);
    expect(existsSync(join(root, 'state'))).toBe(false);
  });
  test('stateDir refuses outside a workflow node', () => {
    process.env.STATE_DIR = '';
    expect(() => stateDir('ABC-1')).toThrow(/STATE_DIR/);
    process.env.STATE_DIR = 'relative/dir';
    expect(() => stateDir('ABC-1')).toThrow(/absolute/);
  });
  test('artifactPath creates the parent directory', () => {
    const path = artifactPath('ci-logs', 'build.log');
    expect(path).toBe(join(root, 'artifacts', 'ci-logs', 'build.log'));
    expect(existsSync(join(root, 'artifacts', 'ci-logs'))).toBe(true);
  });
});

describe('settings', () => {
  test('parseList splits on commas, trims, drops empties', () => {
    expect(parseList(' a , b,,c[bot] ,')).toEqual(['a', 'b', 'c[bot]']);
    expect(parseList('')).toEqual([]);
    expect(parseList(' , ')).toEqual([]);
  });
  test('parsePositiveInt', () => {
    expect(parsePositiveInt('', 60)).toBe(60);
    expect(parsePositiveInt('  ', 60)).toBe(60);
    expect(parsePositiveInt(' 90 ', 60)).toBe(90);
    for (const bad of ['0', '-1', '1.5', 'abc', '1e3', '99999999999999999999']) {
      expect(() => parsePositiveInt(bad, 60, 'ci_wait_min')).toThrow(
        /ci_wait_min must be a positive integer/
      );
    }
  });
  test('parseEnum', () => {
    const modes = ['request', 'auto', 'off'] as const;
    expect(parseEnum('', modes, 'request')).toBe('request');
    expect(parseEnum(' off ', modes, 'request')).toBe('off');
    expect(() => parseEnum('OFF', modes, 'request', 'copilot_mode')).toThrow(
      /copilot_mode must be one of/
    );
  });
});

describe('renderCommand', () => {
  test('quotes plain values as one word', () => {
    expect(renderCommand('jira issue view {key} --plain', { key: 'ABC-1' })).toBe(
      "jira issue view 'ABC-1' --plain"
    );
  });
  test('every value reaches the program as exactly one argument', () => {
    const nasty = [
      'it\'s "quoted"',
      'two  spaces\tand tab',
      '$HOME $(touch /tmp/devflow-pwned) `id`',
      "'",
      '',
      'line1\nline2',
      '; rm -rf / #',
      '\\back\\slash',
      '*.java ?',
    ];
    for (const value of nasty) {
      const rendered = renderCommand(`${ARGV_PRINTER} {v} end`, { v: value });
      expect(shArgs(rendered)).toEqual([value, 'end']);
    }
    expect(existsSync('/tmp/devflow-pwned')).toBe(false);
  });
  test('substitutes repeated and multiple tokens', () => {
    const rendered = renderCommand(`${ARGV_PRINTER} {number} {repo} {number}`, {
      number: '12',
      repo: 'o/r',
    });
    expect(shArgs(rendered)).toEqual(['12', 'o/r', '12']);
  });
  test('throws on an unknown token, naming the known ones', () => {
    expect(() => renderCommand('gh pr edit {nmber}', { number: '1', repo: 'o/r' })).toThrow(
      /\{nmber\}.*\{number\}, \{repo\}/
    );
    expect(() => renderCommand('x {toString}', {})).toThrow(/\{toString\}/);
  });
  test('leaves shell ${VAR} and non-identifier braces alone', () => {
    const template = "echo ${HOME} {key} | awk '{print $1}' {}";
    expect(renderCommand(template, { key: 'K' })).toBe("echo ${HOME} 'K' | awk '{print $1}' {}");
  });
  test('shellQuote of an empty value is an empty word', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('runCommand', () => {
  test('captures combined output and the exit code', async () => {
    const dir = scratch();
    const logPath = join(dir, 'logs', 'run.log');
    const result = await runCommand('echo out; echo err >&2; exit 3', {
      cwd: dir,
      timeoutMs: 10_000,
      logPath,
    });
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('out');
    expect(log).toContain('err');
    expect(result.outputTail).toBe(log);
  });
  test('runs in cwd and returns code 0', async () => {
    const dir = scratch();
    const result = await runCommand('pwd', {
      cwd: dir,
      timeoutMs: 10_000,
      logPath: join(dir, 'pwd.log'),
    });
    expect(result.code).toBe(0);
    expect(result.outputTail.trim().endsWith(dir.split('/').pop() as string)).toBe(true);
  });
  test('returns only the tail of a long output', async () => {
    const dir = scratch();
    const result = await runCommand('seq 1 5000', {
      cwd: dir,
      timeoutMs: 10_000,
      logPath: join(dir, 'seq.log'),
      tailChars: 10,
    });
    expect(result.outputTail).toBe('4999\n5000\n');
  });
  test('a timeout kills the whole process group', async () => {
    const dir = scratch();
    const marker = join(dir, 'survived');
    const started = Date.now();
    // The background child would write the marker after 2s if only `sh` were killed.
    const result = await runCommand(`(sleep 2; touch ${shellQuote(marker)}) & sleep 30`, {
      cwd: dir,
      timeoutMs: 300,
      logPath: join(dir, 'slow.log'),
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    await Bun.sleep(2_500);
    expect(existsSync(marker)).toBe(false);
  });
});

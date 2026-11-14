/**
 * Runs a devflow-deliver script the way the engine does (`bun --no-env-file --preload
 * <archon:script preload> <script>`), against a fake host CLI that answers forge
 * operations from a per-operation queue and records every request.
 *
 * The fake is named by `ARCHON_CLI_COMMAND`, which is how `archon:script`'s `forge()`
 * and `notice()` reach the host; notices are recorded and acknowledged. Each queue entry
 * is used once in order; the last one repeats.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '../temp-roots.ts';

const PRELOAD = join(import.meta.dir, '..', 'archon-script.preload.ts');
/** The run id every script sees as `runId()`. */
const RUN_ID = 'run-0000-test';
const SCRIPTS = join(import.meta.dir, '..', '..', 'pack', 'devflow', 'devflow-deliver', 'scripts');

/** A forge answer: a result value, or a failure the host reports with `ok: false`. */
export type FakeAnswer =
  | { readonly value: unknown }
  | {
      readonly failure: {
        readonly error: { readonly kind: string; readonly message: string };
        readonly mutation?: { readonly outcome: string };
      };
    };

export type FakeForge = Readonly<Record<string, readonly FakeAnswer[]>>;

export interface ForgeRequest {
  readonly op: string;
  readonly request: Record<string, unknown>;
}

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The emitted JSON document; throws when stdout is not exactly one. */
  readonly output: () => Record<string, unknown>;
  readonly requests: readonly ForgeRequest[];
  /** The text of every `workflow notice` the script posted. */
  readonly notices: readonly string[];
  readonly artifacts: string;
}

const FAKE_CLI = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [dir] = [process.env.DEVFLOW_FAKE_DIR];
const argv = process.argv.slice(2);
if (argv[0] === 'workflow' && argv[1] === 'notice') {
  appendFileSync(dir + '/notices.jsonl', JSON.stringify(argv[argv.indexOf('--') + 1]) + '\\n');
  process.stdout.write('{}');
}
else if (argv[0] !== 'forge') { process.stderr.write('fake host: only forge and notices are faked'); process.exitCode = 1; }
else {
  const op = argv[1];
  const request = JSON.parse(readFileSync(argv[argv.indexOf('--data-file') + 1], 'utf8'));
  appendFileSync(dir + '/requests.jsonl', JSON.stringify({ op, request }) + '\\n');
  const queue = JSON.parse(readFileSync(dir + '/forge.json', 'utf8'))[op];
  if (!Array.isArray(queue) || queue.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: { kind: 'unsupported_op', message: 'fake: no answer for ' + op } }));
    process.exitCode = 1;
  } else {
    const countFile = dir + '/count-' + op;
    const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
    writeFileSync(countFile, String(n + 1));
    const answer = queue[Math.min(n, queue.length - 1)];
    if ('value' in answer) process.stdout.write(JSON.stringify({ ok: true, result: { op, value: answer.value } }));
    else { process.stdout.write(JSON.stringify({ ok: false, ...answer.failure })); process.exitCode = 1; }
  }
}
`;

export interface RunOptions {
  readonly inputs?: Readonly<Record<string, string>>;
  readonly forge?: FakeForge;
  /** Files to create under the artifacts directory before the run. */
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Extra environment, applied last (for example STATE_DIR or BASE_BRANCH). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Harness {
  readonly root: () => string;
  readonly run: (script: string, options?: RunOptions) => ScriptRun;
}

/** Call once at a test file's module scope: it registers the temp-tree cleanup. */
export function deliverHarness(): Harness {
  const track = trackTempRoots();
  const root = (): string => track(mkdtempSync(join(tmpdir(), 'devflow-deliver-test-')));
  return {
    root,
    run: (script, options = {}) => {
      const dir = root();
      const artifacts = join(dir, 'artifacts');
      const state = join(dir, 'state');
      mkdirSync(artifacts, { recursive: true });
      mkdirSync(state, { recursive: true });
      for (const [name, content] of Object.entries(options.artifacts ?? {})) {
        mkdirSync(join(artifacts, name, '..'), { recursive: true });
        writeFileSync(join(artifacts, name), content.split('{ARTIFACTS}').join(artifacts));
      }
      writeFileSync(join(dir, 'forge.json'), JSON.stringify(options.forge ?? {}));
      writeFileSync(join(dir, 'fake-archon.ts'), FAKE_CLI);
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('INPUTS_'))
        ),
        ARTIFACTS_DIR: artifacts,
        STATE_DIR: state,
        WORKFLOW_ID: RUN_ID,
        DEVFLOW_FAKE_DIR: dir,
        ARCHON_CLI_COMMAND: JSON.stringify([
          process.execPath,
          '--no-env-file',
          join(dir, 'fake-archon.ts'),
        ]),
        ...Object.fromEntries(
          Object.entries(options.inputs ?? {}).map(([name, value]) => [
            `INPUTS_${name.toUpperCase()}`,
            value.split('{ARTIFACTS}').join(artifacts),
          ])
        ),
        ...options.env,
      };
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', '--preload', PRELOAD, join(SCRIPTS, `${script}.ts`)],
        { cwd: options.cwd ?? dir, env, encoding: 'utf8' }
      );
      const log = join(dir, 'requests.jsonl');
      const requests = existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as ForgeRequest)
        : [];
      const noticeLog = join(dir, 'notices.jsonl');
      const notices = existsSync(noticeLog)
        ? readFileSync(noticeLog, 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as string)
        : [];
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        output: () => JSON.parse(result.stdout) as Record<string, unknown>,
        requests,
        notices,
        artifacts,
      };
    },
  };
}

/** A git checkout whose `origin` names github.com/acme/shop but fetches from a local bare repo. */
export function gitCheckout(root: string): { checkout: string; head: string; base: string } {
  const bare = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  mkdirSync(checkout);
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.email', 'test@example.invalid');
  git(checkout, 'config', 'user.name', 'test');
  git(checkout, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/shop.git');
  git(checkout, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  writeFileSync(join(checkout, 'a.txt'), 'base\n');
  git(checkout, 'add', 'a.txt');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  const base = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '-b', 'feature/ABC-1');
  writeFileSync(join(checkout, 'b.txt'), 'feature\n');
  git(checkout, 'add', 'b.txt');
  git(checkout, 'commit', '-q', '-m', 'feature');
  return { checkout, head: git(checkout, 'rev-parse', 'HEAD'), base };
}

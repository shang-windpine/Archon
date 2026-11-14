/**
 * `script: resolve` — which forge repository the checkout's remote names, whether gh
 * is logged in to that repository's host, and whether the base branch devflow-deliver
 * branches from exists on that remote. Read-only: a forge `resolve`, `gh auth status
 * --hostname <host>` (the check deliver's preflight makes), and one `git ls-remote`.
 * Every outcome is a report line; the node itself never fails, so a local or
 * non-GitHub remote reads as a clear `fail` row.
 */

import { emit, forge, input } from 'archon:script';
import { checkoutRemote, type Remote } from '../../.shared/lib/remote.ts';
import { type ProbeCheck, redactUrl } from '../../.shared/lib/smoke.ts';

const LS_REMOTE_TIMEOUT_MS = 30_000;
const GH_AUTH_TIMEOUT_MS = 30_000;
const checks: ProbeCheck[] = [];
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * gh must be logged in to the repository's host for Copilot review requests: preflight
 * refuses without it when copilot_mode is request, so that is a fail here too. gh
 * missing is the tools probe's row.
 */
function ghAuth(host: string): ProbeCheck {
  const gh = Bun.which('gh');
  if (gh === null)
    return {
      name: 'gh auth',
      status: 'skip',
      detail: 'gh is not on PATH (see the gh row)',
      hint: '',
    };
  const auth = Bun.spawnSync([gh, 'auth', 'status', '--hostname', host], {
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: GH_AUTH_TIMEOUT_MS,
  });
  if (auth.exitCode === 0)
    return { name: 'gh auth', status: 'pass', detail: `gh is logged in to ${host}`, hint: '' };
  const mode = input('copilot_mode');
  return {
    name: 'gh auth',
    status: mode === 'request' ? 'fail' : 'warn',
    detail: `\`gh auth status --hostname ${host}\` reports no usable login (copilot_mode=${mode})`,
    hint:
      `Run \`gh auth login --hostname ${host}\`. With copilot_mode request devflow-deliver refuses without it; ` +
      'otherwise only the forge credential matters (see the forge-check row).',
  };
}

let remote: Remote | undefined;
try {
  remote = checkoutRemote();
} catch (error) {
  checks.push({
    name: 'remote',
    status: 'fail',
    detail: message(error),
    hint: 'Add the GitHub repository as `origin`: `git remote add origin git@github.com:<owner>/<repo>.git`.',
  });
}

if (remote !== undefined) {
  const shown = `${remote.name} (${redactUrl(remote.url)})`;
  try {
    const resolved = forge('resolve', { remote: remote.url });
    if (resolved.kind === 'resolved') checks.push(ghAuth(resolved.repo.host));
    checks.push(
      resolved.kind === 'resolved'
        ? {
            name: 'forge resolve',
            status: 'pass',
            detail: `${shown} -> ${resolved.repo.host}/${resolved.repo.path} (${resolved.plugin.name}@${resolved.plugin.version})`,
            hint: '',
          }
        : {
            name: 'forge resolve',
            status: 'fail',
            detail: `${shown} is not a repository any installed forge plugin knows (a local path or a non-GitHub URL)`,
            hint: 'devflow-deliver and devflow-verify need a GitHub remote; run the smoke in a clone of the GitHub repository.',
          }
    );
  } catch (error) {
    checks.push({
      name: 'forge resolve',
      status: 'fail',
      detail: `${shown}: ${message(error)}`,
      hint: 'Run `archon forge check` and `archon doctor` for the forge plugin setup.',
    });
  }

  // BASE_BRANCH is the engine's resolved worktree.baseBranch (configured, else detected).
  const base = process.env.BASE_BRANCH ?? '';
  if (base === '') {
    checks.push({
      name: 'base branch',
      status: 'warn',
      detail: '$BASE_BRANCH is empty',
      hint: 'Set worktree.baseBranch in .archon/config.yaml to the branch features start from.',
    });
  } else {
    // GIT_TERMINAL_PROMPT=0: a credential prompt would hang the node instead of failing it.
    const listed = Bun.spawnSync(
      ['git', 'ls-remote', '--exit-code', '--heads', remote.name, `refs/heads/${base}`],
      {
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: LS_REMOTE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }
    );
    // ls-remote --exit-code answers 2 for "no matching ref"; anything else is no answer.
    checks.push(
      listed.exitCode === 0
        ? {
            name: 'base branch',
            status: 'pass',
            detail: `${base} exists on ${remote.name}`,
            hint: '',
          }
        : listed.exitCode === 2
          ? {
              name: 'base branch',
              status: 'fail',
              detail: `${base} does not exist on ${remote.name}`,
              hint: 'Set worktree.baseBranch in .archon/config.yaml to a branch that exists on the remote.',
            }
          : {
              name: 'base branch',
              status: 'fail',
              detail: `git could not reach ${remote.name} (git ls-remote ${listed.exitCode === null || listed.signalCode !== null ? `stopped after ${LS_REMOTE_TIMEOUT_MS / 1000}s` : `exit ${listed.exitCode}`}); fetch and push will fail the same way`,
              hint: 'Check network/proxy access for git (not only gh) and the git credential for this remote: `git ls-remote origin`.',
            }
    );
  }
}

emit({ probe: 'resolve', checks });

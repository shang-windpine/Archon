/**
 * devflow-deliver's first node: refuse before any agent spends when the run cannot
 * deliver, and lay out round 1.
 *
 * Checks, cheapest first: the KEY and its finalized requirement, the pack settings,
 * the checkout's branch, forge access for the checkout's remote (plugin, operations,
 * credential, one authenticated read), `gh` when Copilot reviews are requested, and
 * the pull request named by the `pr` input. Then it copies the requirement (and an
 * unconsumed devflow-verify follow-up) into the run and writes round 1's work order,
 * which control puts in place.
 */

import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { artifactPath, statePath, validateKey } from '../../.shared/lib/devflow.ts';
import { parseDeliverSettings } from '../../.shared/lib/deliver-settings.ts';
import { renderWorkOrder, WORK_FILES } from '../../.shared/lib/deliver-work.ts';
import { checkForgeAccess } from '../../.shared/lib/forge-check.ts';
import { git, gitOrThrow } from '../../.shared/lib/git.ts';
import { sameRepo } from '../../.shared/lib/identity.ts';
import { findOpenPrByHead, viewPr } from '../../.shared/lib/pr.ts';
import { fetchBranch } from '../../.shared/lib/remote.ts';

function requireRequirement(key: string): string {
  const path = statePath(key, 'requirement.md');
  if (!existsSync(path)) {
    throw new Error(
      `no finalized requirement for ${key} at ${path}; run devflow-refine with --input key=${key} first`
    );
  }
  return path;
}

function currentBranch(base: string): string {
  const branch = gitOrThrow('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') {
    throw new Error(
      'the checkout is on a detached HEAD; launch with --branch <feature-branch> so the run works on a named branch'
    );
  }
  if (branch === base) {
    throw new Error(
      `the checkout is on the base branch ${base}; launch with --branch <feature-branch> so the run never pushes to ${base}`
    );
  }
  return branch;
}

/** `gh` must run and be logged in to the host, or every Copilot request would fail. */
function requireGh(host: string): void {
  const version = Bun.spawnSync(['gh', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  if (version.exitCode !== 0) {
    throw new Error(
      'copilot_mode is request but `gh --version` failed; install the GitHub CLI, or set copilot_mode to auto or off'
    );
  }
  const auth = Bun.spawnSync(['gh', 'auth', 'status', '--hostname', host], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  if (auth.exitCode !== 0) {
    throw new Error(
      `copilot_mode is request but \`gh auth status --hostname ${host}\` failed; run \`gh auth login --hostname ${host}\``
    );
  }
}

try {
  const key = validateKey(input('key'));
  const requirementSource = requireRequirement(key);
  const settings = parseDeliverSettings({
    checkstyle_cmd: input('checkstyle_cmd'),
    local_verify_cmd: input('local_verify_cmd'),
    copilot_mode: input('copilot_mode'),
    copilot_request_cmd: input('copilot_request_cmd'),
    copilot_confirm_cmd: input('copilot_confirm_cmd'),
    copilot_logins: input('copilot_logins'),
    poll_interval_sec: input('poll_interval_sec'),
    copilot_wait_min: input('copilot_wait_min'),
    ci_wait_min: input('ci_wait_min'),
    required_checks: input('required_checks'),
    allow_skipped_checks: input('allow_skipped_checks'),
  });
  const base = (process.env.BASE_BRANCH ?? '').trim();
  if (base === '')
    throw new Error('the run has no base branch; set worktree.baseBranch in .archon/config.yaml');
  const head = currentBranch(base);
  // Untracked files are ignored: a worktree carries copied config such as .archon/packs/.
  if (git('status', '--porcelain', '--untracked-files=no').stdout !== '') {
    throw new Error(
      'the checkout has uncommitted changes to tracked files; commit or discard them before delivering'
    );
  }

  let access: ReturnType<typeof checkForgeAccess>;
  try {
    access = checkForgeAccess();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}. devflow-deliver opens and updates a GitHub pull request, so the checkout's remote ` +
        'must be a GitHub repository URL and the forge plugin needs a credential; run the devflow-smoke ' +
        'workflow to check the setup'
    );
  }
  const repo = access.repo;
  if (settings.copilotMode === 'request') requireGh(repo.host);

  let prNumber = 0;
  const named = input('pr').trim();
  if (named !== '') {
    if (!/^[1-9][0-9]*$/.test(named))
      throw new Error(`input pr must be a pull request number, got ${JSON.stringify(named)}`);
    const view = viewPr({ repo, number: Number(named) });
    if (view.pr.state !== 'open')
      throw new Error(`pull request #${named} is ${view.pr.state}, not open`);
    if (view.pr.head !== head || view.pr.head_repo === null || !sameRepo(view.pr.head_repo, repo)) {
      throw new Error(
        `pull request #${named} has head ${view.pr.head} in another repository or branch than this run's ${head}; ` +
          `launch with --branch ${view.pr.head}`
      );
    }
    prNumber = view.pr.number;
  } else {
    prNumber = findOpenPrByHead(repo, head)?.pr.number ?? 0;
  }

  const baseRevision = fetchBranch(repo, base);
  writeFileSync(artifactPath('base-revision.txt'), `${baseRevision}\n`);

  const requirementPath = artifactPath('requirement.md');
  copyFileSync(requirementSource, requirementPath);
  const followupSource = statePath(key, 'followup-work.md');
  const hasFollowup = existsSync(followupSource);
  const followupPath = hasFollowup ? artifactPath('followup-work.md') : null;
  if (followupPath !== null) copyFileSync(followupSource, followupPath);
  // Round 1's pristine work: control copies it into place at every round 1 (WORK_FILES).
  writeFileSync(
    artifactPath(WORK_FILES.round1.order),
    renderWorkOrder({
      key,
      round: 1,
      requirementPath,
      followupPath,
      nextWork: null,
      answer: '',
      escalationPath: null,
    })
  );
  writeFileSync(artifactPath(WORK_FILES.round1.threads), '[]\n');

  emit({
    repo: { host: repo.host, path: repo.path },
    base,
    head,
    requirement_path: requirementPath,
    has_followup: hasFollowup,
    pr_number: prNumber,
  });
} catch (error) {
  refuse(`preflight: ${error instanceof Error ? error.message : String(error)}`);
}

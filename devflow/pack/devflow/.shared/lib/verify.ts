/**
 * devflow-verify's deterministic parts: where the change under test lives, which files it
 * touches, and the plan and results files a person works from.
 *
 * Pure of `archon:script` (it spawns git, like ./git.ts), so it is unit-tested against
 * scratch repositories without the script preload.
 */

import { existsSync, statSync } from 'node:fs';
import { git } from './git.ts';
import type { Repo } from './identity.ts';
import { isObject } from './inputs.ts';
import { checkoutRemote } from './remote.ts';

export type Side = 'UI' | 'API';

/** One planned manual test case, as a plan agent declares it in its structured output. */
export interface PlannedCase {
  readonly id: string;
  readonly title: string;
  readonly criterion: string;
}

/**
 * The cases of one side, checked: every ID is `<side>-<n>` and unique, every title one
 * line. The IDs become the first field of the results file, so a malformed one would
 * leave a case the person cannot report on.
 */
export function validateCases(side: Side, raw: unknown): PlannedCase[] {
  if (!Array.isArray(raw)) throw new Error(`the ${side} plan's cases are not a list`);
  const pattern = new RegExp(`^${side}-[1-9][0-9]*$`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isObject(item)) throw new Error(`${side} case ${index + 1} is not an object`);
    const { id, title, criterion } = item;
    if (typeof id !== 'string' || !pattern.test(id)) {
      throw new Error(
        `${side} case ${index + 1} has ID ${JSON.stringify(id)}; it must match ${pattern.source}`
      );
    }
    if (seen.has(id)) throw new Error(`${side} case ID ${id} appears twice`);
    seen.add(id);
    if (typeof title !== 'string' || title.trim() === '' || /[\r\n]/.test(title)) {
      throw new Error(`${side} case ${id} needs a one-line title`);
    }
    if (typeof criterion !== 'string') throw new Error(`${side} case ${id} has no criterion text`);
    return { id, title: title.trim(), criterion: criterion.trim() };
  });
}

/** What devflow-verify reads from `delivery.json` (DESIGN §2); everything is optional. */
export interface DeliveryFacts {
  readonly pr: {
    readonly repo: Repo;
    readonly number: number;
    readonly url: string;
    readonly base: string;
    readonly headRevision: string;
  } | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Parse `delivery.json`; throws when it is not a JSON object. A PR without repo and number reads as none. */
export function parseDelivery(raw: string): DeliveryFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('delivery.json is not valid JSON');
  }
  if (!isObject(parsed)) throw new Error('delivery.json is not a JSON object');
  const pr = isObject(parsed.pr) ? parsed.pr : null;
  const repo = pr && isObject(pr.repo) ? pr.repo : null;
  const host = text(repo?.host);
  const path = text(repo?.path);
  const number = pr?.number;
  const hasPr =
    host !== null &&
    path !== null &&
    typeof number === 'number' &&
    Number.isInteger(number) &&
    number > 0;
  return {
    pr: hasPr
      ? {
          repo: { host, path },
          number,
          url: text(pr?.url) ?? '',
          base: text(pr?.base) ?? '',
          headRevision: text(pr?.head_revision) ?? '',
        }
      : null,
    worktreePath: text(parsed.worktree_path),
    branch: text(parsed.branch),
  };
}

export interface ChangedFile {
  readonly path: string;
  /** The forge's status vocabulary (`pr.files`), so both sources read the same. */
  readonly status: string;
  readonly previousPath: string | null;
}

const GIT_STATUS: Readonly<Record<string, string>> = {
  A: 'added',
  M: 'modified',
  D: 'removed',
  R: 'renamed',
  C: 'copied',
  T: 'changed',
};

/** `git diff --name-status -z` output: NUL-separated status then path (two paths for R and C). */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const fields = output.split('\0');
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? '';
    if (code === '') {
      index += 1;
      continue;
    }
    const letter = code.charAt(0);
    const status = GIT_STATUS[letter] ?? 'changed';
    if (letter === 'R' || letter === 'C') {
      files.push({
        path: fields[index + 2] ?? '',
        status,
        previousPath: fields[index + 1] ?? null,
      });
      index += 3;
    } else {
      files.push({ path: fields[index + 1] ?? '', status, previousPath: null });
      index += 2;
    }
  }
  return files.filter(file => file.path !== '');
}

/** Where the change under test lives: a checkout, and the commit to read there (null = its working tree). */
export interface ChangeLocation {
  readonly checkout: string;
  readonly ref: string | null;
  readonly notes: readonly string[];
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function currentBranch(checkout: string): string | null {
  const result = git('-C', checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  return result.code === 0 && result.stdout !== '' ? result.stdout : null;
}

function resolvesToCommit(checkout: string, ref: string): boolean {
  return git('-C', checkout, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).code === 0;
}

/**
 * Decide which code the plan is about. A run without isolation executes in the operator's
 * checkout, which need not hold the delivered branch: the delivery's retained worktree is
 * preferred, then the delivered branch, then the current checkout as it stands.
 */
export function locateChange(cwd: string, delivery: DeliveryFacts | null): ChangeLocation {
  const notes: string[] = [];
  if (delivery?.worktreePath) {
    if (
      isDirectory(delivery.worktreePath) &&
      git('-C', delivery.worktreePath, 'rev-parse', '--git-dir').code === 0
    ) {
      return { checkout: delivery.worktreePath, ref: null, notes };
    }
    notes.push(
      `delivery.json names worktree ${delivery.worktreePath}, which is not a git checkout any more`
    );
  }
  const branch = delivery?.branch ?? null;
  if (branch !== null) {
    if (currentBranch(cwd) === branch) return { checkout: cwd, ref: null, notes };
    if (resolvesToCommit(cwd, `refs/heads/${branch}`)) {
      notes.push(
        `this checkout is not on the delivered branch ${branch}; the change is read from that branch's commit`
      );
      return { checkout: cwd, ref: branch, notes };
    }
    notes.push(
      `delivery.json names branch ${branch}, which does not exist in this checkout; using the current checkout`
    );
  }
  return { checkout: cwd, ref: null, notes };
}

/** The checkout's default branch name as its remote records it (`<remote>/HEAD`), if known. */
export function remoteDefaultBranch(checkout: string): string | null {
  let remote: string;
  try {
    remote = checkoutRemote(checkout).name;
  } catch {
    return null;
  }
  const head = git('-C', checkout, 'symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`);
  if (head.code !== 0) return null;
  const prefix = `refs/remotes/${remote}/`;
  return head.stdout.startsWith(prefix) ? head.stdout.slice(prefix.length) : null;
}

/**
 * The first base branch name that resolves, as a ref: the remote-tracking ref first (a local
 * base branch is often stale), then the local branch. Nothing is fetched.
 */
export function resolveBaseRef(checkout: string, names: readonly string[]): string | null {
  let remote: string | null = null;
  try {
    remote = checkoutRemote(checkout).name;
  } catch {
    remote = null;
  }
  for (const name of names) {
    if (name.trim() === '') continue;
    const candidates =
      remote === null
        ? [`refs/heads/${name}`]
        : [`refs/remotes/${remote}/${name}`, `refs/heads/${name}`];
    const found = candidates.find(ref => resolvesToCommit(checkout, ref));
    if (found !== undefined) return found;
  }
  return null;
}

export interface GitChange {
  readonly baseRef: string;
  readonly mergeBase: string;
  readonly files: readonly ChangedFile[];
}

/**
 * The files the change touches relative to its merge base with `baseRef`. With `ref` null
 * this is the checkout's working tree, so uncommitted and untracked files count: work done
 * by hand need not be committed yet.
 */
export function gitChangedFiles(location: ChangeLocation, baseRef: string): GitChange {
  const { checkout, ref } = location;
  const tip = ref ?? 'HEAD';
  const mergeBase = git('-C', checkout, 'merge-base', baseRef, tip);
  if (mergeBase.code !== 0)
    throw new Error(`git merge-base ${baseRef} ${tip} failed: ${mergeBase.stderr}`);
  const range = ref === null ? [mergeBase.stdout] : [mergeBase.stdout, ref];
  const diff = git('-C', checkout, 'diff', '--name-status', '-z', ...range);
  if (diff.code !== 0) throw new Error(`git diff --name-status failed: ${diff.stderr}`);
  const files = parseNameStatusZ(diff.stdout);
  if (ref === null) {
    const untracked = git('-C', checkout, 'ls-files', '--others', '--exclude-standard', '-z');
    if (untracked.code !== 0) throw new Error(`git ls-files --others failed: ${untracked.stderr}`);
    for (const path of untracked.stdout.split('\0')) {
      if (path !== '') files.push({ path, status: 'added', previousPath: null });
    }
  }
  return { baseRef, mergeBase: mergeBase.stdout, files };
}

/** The results file a person fills in (policy/test-plan-format.md, "Results file"). */
export function renderResultsTemplate(
  key: string,
  planPath: string,
  cases: readonly PlannedCase[]
): string {
  const lines = [
    `# Manual test results for ${key}. Plan: ${planPath}`,
    '# One line per case: <ID> | <STATUS> | <notes>',
    '# STATUS is PASS, FAIL or BLOCKED; TODO means not run. Notes are required for FAIL and BLOCKED.',
  ];
  if (cases.length === 0) {
    lines.push(
      '# No cases were planned. Add a line such as "EXTRA-1 | FAIL | <what you saw>" for anything you found.'
    );
  }
  for (const planned of cases) lines.push(`${planned.id} | TODO |`);
  return `${lines.join('\n')}\n`;
}

/** The one-line summary the run-tests question opens with. */
export function planHeadline(
  ui: number,
  api: number,
  classified: { ui: boolean; api: boolean }
): string {
  const total = ui + api;
  if (total === 0) {
    return classified.ui || classified.api
      ? 'No manual test cases were planned: the planner found nothing to test by hand; the plan says why.'
      : 'No manual test cases were planned: the change was classified as touching neither the UI nor the External API.';
  }
  return `${total} manual test case(s) planned (UI ${ui}, External API ${api}).`;
}

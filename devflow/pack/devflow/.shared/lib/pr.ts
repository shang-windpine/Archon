/**
 * The pack's pull-request reads and writes through the forge contract (`forge` of
 * `archon:script`), and the repository this checkout works on.
 *
 * Every write is performed and then read back by the forge plugin, which reports
 * which of the contract's outcomes happened. Nothing here repeats a write: when a
 * write's outcome is not known (`outcome_unknown`, `applied_unverified`,
 * `verification_failed`, or no answer from the host), the pull request is read back
 * and the read decides; a write the forge refused is rethrown. Authored content (a
 * pull-request body) is read from a file, so it never reaches any process's argv.
 *
 * This pack never takes a pull request out of draft, so there is no `pr.ready` here.
 */

import { readFileSync } from 'node:fs';
import { ForgeError, HostCommandError, forge, type ForgeOperations } from 'archon:script';
import type { PrRecord, QualifiedPr, Repo } from './identity.ts';
import { checkoutRemote } from './remote.ts';

export interface PrView {
  readonly pr: PrRecord;
  readonly title: string;
  readonly body: string;
}

function forgePrView(value: NonNullable<ForgeOperations['pr.view']['result']>): PrView {
  return { pr: value.pr, title: value.title ?? '', body: value.body ?? '' };
}

/**
 * The repository this checkout works on: what the forge's `resolve` finds for its
 * remote (the only one, or `origin` among several). Refuses when no installed forge
 * plugin resolves it.
 */
export function checkoutRepo(checkout = process.cwd()): Repo {
  const remote = checkoutRemote(checkout);
  const value = forge('resolve', { remote: remote.url });
  if (value.kind !== 'resolved') {
    throw new Error(
      `git remote ${remote.name} does not resolve to a repository through an installed forge plugin`
    );
  }
  return { host: value.repo.host, path: value.repo.path };
}

/**
 * The open pull request whose head is `head` in `repo` itself, or undefined. The
 * forge's head selector answers only for an open pull request, and refuses more than one.
 */
export function findOpenPrByHead(repo: Repo, head: string): PrView | undefined {
  const value = forge('pr.view', { selector: { kind: 'head', repo, headRepo: repo, head } });
  return value === null ? undefined : forgePrView(value);
}

export function viewPr(ref: QualifiedPr): PrView {
  const value = forge('pr.view', {
    selector: { kind: 'number', ref: { repo: ref.repo, number: ref.number } },
  });
  if (value === null) throw new Error(`forge pr.view found no pull request #${String(ref.number)}`);
  return forgePrView(value);
}

/** True when the write may have happened: anything but a forge refusal. */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof HostCommandError) return true;
  return (
    error instanceof ForgeError &&
    error.mutation !== undefined &&
    error.mutation.outcome !== 'refused'
  );
}

export interface CreatePrIntent {
  readonly repo: Repo;
  readonly head: string;
  /** The commit the head branch must point at; the forge refuses a head that moved. */
  readonly headRevision: string;
  readonly base: string;
  readonly title: string;
  readonly bodyPath: string;
}

/**
 * Open a draft pull request from `head` (in `repo` itself) and return the record the
 * forge read back. When the create's outcome is unknown, the open pull request on
 * that head is read back and returned if it exists; otherwise the error is rethrown.
 * Callers look for an existing pull request (findOpenPrByHead) first.
 */
export function createPr(intent: CreatePrIntent): PrRecord {
  try {
    return forge('pr.create', {
      repo: intent.repo,
      headRepo: intent.repo,
      head: intent.head,
      headRevision: intent.headRevision,
      base: intent.base,
      title: intent.title,
      body: readFileSync(intent.bodyPath, 'utf8'),
      draft: true,
    }).pr;
  } catch (error) {
    if (!outcomeUnknown(error)) throw error;
    const landed = findOpenPrByHead(intent.repo, intent.head);
    if (landed !== undefined) return landed.pr;
    throw error;
  }
}

/**
 * Put an open pull request back into draft and return the record read back. A pull
 * request already in draft is not written by the forge. An unknown outcome is
 * settled by reading the pull request back.
 */
export function setPrDraft(ref: QualifiedPr): PrRecord {
  try {
    return forge('pr.draft', { ref: { repo: ref.repo, number: ref.number } }).pr;
  } catch (error) {
    if (!outcomeUnknown(error)) throw error;
    const now = viewPr(ref).pr;
    if (now.is_draft) return now;
    throw error;
  }
}

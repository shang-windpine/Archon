/**
 * Recognising GitHub Copilot's code review in the forge's review items, and confirming
 * that a Copilot review request was recorded.
 *
 * A login is a machine token, compared exactly but case-insensitively. Copilot's login
 * differs by API (`copilot-pull-request-reviewer[bot]` over REST, which `pr.reviews`
 * uses; `copilot-pull-request-reviewer` over GraphQL, which `pr.threads` uses), so the
 * operator's `copilot_logins` setting lists every spelling; no suffix is inferred here.
 *
 * Pure: the only import from `archon:script` is a type, erased at runtime.
 */

import type { ForgeOperations } from 'archon:script';

export type ReviewItem = ForgeOperations['pr.reviews']['result']['items'][number];
export type ForgeAuthor = ReviewItem['author'];

/** The logins as a comparison set: trimmed, lowercased, empty entries dropped. */
export function normalizeLogins(list: readonly string[]): ReadonlySet<string> {
  return new Set(list.map(login => login.trim().toLowerCase()).filter(login => login !== ''));
}

/**
 * How many lines of a command's output name one of `logins`. `copilot_confirm_cmd`
 * prints the requested reviewer of each review request recorded on the pull request,
 * one login per line, so the count grows by one when a Copilot request is recorded. Each
 * line is a whole login, trimmed and compared case-insensitively; a line that only
 * contains a login does not count.
 */
export function countCopilotLogins(output: string, logins: ReadonlySet<string>): number {
  return output.split('\n').filter(line => logins.has(line.trim().toLowerCase())).length;
}

/**
 * The tokens `copilot_request_cmd` and `copilot_confirm_cmd` may use. `{repo}` is what
 * `gh --repo` takes (OWNER/REPO on github.com, HOST/OWNER/REPO elsewhere); a REST path
 * needs `{path}` (OWNER/REPO) with `gh api --hostname {host}`.
 */
export function copilotCommandVars(
  repo: { readonly host: string; readonly path: string },
  number: string
): Readonly<Record<string, string>> {
  return {
    number,
    repo: repo.host === 'github.com' ? repo.path : `${repo.host}/${repo.path}`,
    host: repo.host,
    path: repo.path,
  };
}

/** One run of `copilot_confirm_cmd`: its stdout, or why it gave none. */
export type ConfirmRun =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Whether a review request is recorded: `confirmed`; `refused` with the reason; or
 * `unknown` when the confirm command itself failed, so nothing was learned.
 */
export type RequestConfirmation =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'unknown'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string };

export interface ConfirmRequestDeps {
  /** Copilot lines `copilot_confirm_cmd` printed before the request ran. */
  readonly before: number;
  readonly logins: ReadonlySet<string>;
  /** The waits before each re-read; the request's event can lag it by a few seconds. */
  readonly delaysMs: readonly number[];
  readonly runConfirm: () => Promise<ConfirmRun>;
  /** True when Copilot already reviewed the head; throws when the reviews cannot be read. */
  readonly headReviewed: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Confirm a Copilot review request after its command exited 0. The request counts when
 * `copilot_confirm_cmd` prints more Copilot lines than it did before the request, which
 * binds the evidence to this request rather than an earlier round's, or when Copilot
 * already reviewed the head. A reviewer bot's pending request is not a reliable signal:
 * GitHub's `requested_reviewers` never lists Copilot, even while its review is pending.
 * A failed reviews read refuses rather than counts: the confirm command already saw no
 * new request.
 */
export async function confirmCopilotRequest(
  deps: ConfirmRequestDeps
): Promise<RequestConfirmation> {
  for (let attempt = 0; ; attempt += 1) {
    const run = await deps.runConfirm();
    if (!run.ok) return { kind: 'unknown', detail: run.detail };
    if (countCopilotLogins(run.output, deps.logins) > deps.before) return { kind: 'confirmed' };
    const delay = deps.delaysMs[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  let reviewed: boolean;
  try {
    reviewed = deps.headReviewed();
  } catch (error) {
    return {
      kind: 'refused',
      detail: `copilot_confirm_cmd showed no new Copilot review request, and reading the reviews failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return reviewed
    ? { kind: 'confirmed' }
    : { kind: 'refused', detail: 'copilot_confirm_cmd showed no new Copilot review request' };
}

/**
 * True when the author's login is one of `logins`. The author's `type` is not trusted
 * to say `bot`: REST reports Copilot as a bot and GraphQL as a user, depending on the
 * operation. An organization never authors a review, so it never matches.
 */
export function isCopilotAuthor(author: ForgeAuthor, logins: ReadonlySet<string>): boolean {
  if (author === null || author.login === null) return false;
  if (author.type === 'organization') return false;
  return logins.has(author.login.toLowerCase());
}

/**
 * Copilot's latest submitted review of exactly `headRevision`, or undefined when it has
 * not reviewed that commit. Only `kind: 'review'` items count (a review's inline
 * comments are separate items); "latest" is by `createdAt`, falling back to the
 * forge's order when a timestamp is missing.
 */
export function copilotReviewForHead(
  items: readonly ReviewItem[],
  headRevision: string,
  logins: ReadonlySet<string>
): ReviewItem | undefined {
  let latest: ReviewItem | undefined;
  for (const item of items) {
    if (item.kind !== 'review' || item.commit !== headRevision) continue;
    if (!isCopilotAuthor(item.author, logins)) continue;
    if (latest === undefined || !isEarlier(item, latest)) latest = item;
  }
  return latest;
}

/** True only when both carry a timestamp and `item`'s is strictly earlier. */
function isEarlier(item: ReviewItem, than: ReviewItem): boolean {
  if (item.createdAt === null || than.createdAt === null) return false;
  return Date.parse(item.createdAt) < Date.parse(than.createdAt);
}

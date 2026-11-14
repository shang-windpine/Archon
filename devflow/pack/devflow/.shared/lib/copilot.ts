/**
 * Recognising GitHub Copilot's code review in the forge's review items.
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

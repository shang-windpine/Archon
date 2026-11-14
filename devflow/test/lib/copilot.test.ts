import { describe, expect, test } from 'bun:test';
import {
  copilotReviewForHead,
  type ForgeAuthor,
  isCopilotAuthor,
  normalizeLogins,
  type ReviewItem,
} from '../../pack/devflow/.shared/lib/copilot.ts';

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const DEFAULT_LOGINS = normalizeLogins(
  'copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot],copilot,Copilot'.split(',')
);

function author(login: string | null, type: NonNullable<ForgeAuthor>['type'] = 'bot'): ForgeAuthor {
  return { host: 'github.com', id: '1', login, type };
}

function review(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    kind: 'review',
    id,
    author: author('copilot-pull-request-reviewer[bot]'),
    commit: HEAD,
    state: 'COMMENTED',
    createdAt: '2026-11-14T10:00:00Z',
    url: `https://github.com/o/r/pull/7#pullrequestreview-${id}`,
    body: `review ${id}`,
    ...overrides,
  };
}

describe('normalizeLogins', () => {
  test('trims, lowercases, drops empties and duplicates', () => {
    expect([...normalizeLogins([' Copilot ', 'copilot', '', 'X[bot]'])]).toEqual([
      'copilot',
      'x[bot]',
    ]);
  });
});

describe('isCopilotAuthor', () => {
  test('matches case-insensitively', () => {
    expect(isCopilotAuthor(author('Copilot-Pull-Request-Reviewer[BOT]'), DEFAULT_LOGINS)).toBe(
      true
    );
    expect(isCopilotAuthor(author('COPILOT', 'user'), DEFAULT_LOGINS)).toBe(true);
  });
  test('the [bot] suffix is matched exactly, never inferred', () => {
    const graphqlOnly = normalizeLogins(['copilot-pull-request-reviewer']);
    expect(isCopilotAuthor(author('copilot-pull-request-reviewer'), graphqlOnly)).toBe(true);
    expect(isCopilotAuthor(author('copilot-pull-request-reviewer[bot]'), graphqlOnly)).toBe(false);
    const restOnly = normalizeLogins(['copilot-pull-request-reviewer[bot]']);
    expect(isCopilotAuthor(author('copilot-pull-request-reviewer'), restOnly)).toBe(false);
  });
  test('accepts bot, user and an unreported type; refuses organization', () => {
    expect(isCopilotAuthor(author('copilot', 'bot'), DEFAULT_LOGINS)).toBe(true);
    expect(isCopilotAuthor(author('copilot', 'user'), DEFAULT_LOGINS)).toBe(true);
    expect(isCopilotAuthor(author('copilot', null), DEFAULT_LOGINS)).toBe(true);
    expect(isCopilotAuthor({ host: 'github.com', id: '1', login: 'copilot' }, DEFAULT_LOGINS)).toBe(
      true
    );
    expect(isCopilotAuthor(author('copilot', 'organization'), DEFAULT_LOGINS)).toBe(false);
  });
  test('no prefix or substring matches, and a missing author never matches', () => {
    expect(isCopilotAuthor(author('copilot-fan'), DEFAULT_LOGINS)).toBe(false);
    expect(isCopilotAuthor(author('my-copilot'), DEFAULT_LOGINS)).toBe(false);
    expect(isCopilotAuthor(author(null), DEFAULT_LOGINS)).toBe(false);
    expect(isCopilotAuthor(null, DEFAULT_LOGINS)).toBe(false);
  });
});

describe('copilotReviewForHead', () => {
  test('undefined when Copilot reviewed only an older commit', () => {
    expect(
      copilotReviewForHead([review('1', { commit: OLD })], HEAD, DEFAULT_LOGINS)
    ).toBeUndefined();
  });
  test('ignores review comments, other authors and null commits', () => {
    const items = [
      review('1', { kind: 'review_comment' }),
      review('2', { author: author('alice', 'user') }),
      review('3', { commit: null }),
    ];
    expect(copilotReviewForHead(items, HEAD, DEFAULT_LOGINS)).toBeUndefined();
  });
  test('returns the latest matching review by createdAt, whatever the order', () => {
    const items = [
      review('late', { createdAt: '2026-11-14T12:00:00Z' }),
      review('early', { createdAt: '2026-11-14T09:00:00Z' }),
      review('old-head', { commit: OLD, createdAt: '2026-11-14T13:00:00Z' }),
    ];
    expect(copilotReviewForHead(items, HEAD, DEFAULT_LOGINS)?.id).toBe('late');
  });
  test('falls back to forge order when a timestamp is missing', () => {
    const items = [review('first', { createdAt: null }), review('second', { createdAt: null })];
    expect(copilotReviewForHead(items, HEAD, DEFAULT_LOGINS)?.id).toBe('second');
  });
  test('a dismissed Copilot review still counts as reviewed', () => {
    expect(
      copilotReviewForHead([review('1', { state: 'DISMISSED' })], HEAD, DEFAULT_LOGINS)?.id
    ).toBe('1');
  });
});

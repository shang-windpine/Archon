import { describe, expect, test } from 'bun:test';
import {
  type ConfirmRun,
  confirmCopilotRequest,
  copilotCommandVars,
  copilotReviewForHead,
  countCopilotLogins,
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

describe('countCopilotLogins', () => {
  test('counts whole lines case-insensitively', () => {
    expect(countCopilotLogins('octocat\n Copilot \ncopilot\n', DEFAULT_LOGINS)).toBe(2);
  });
  test('ignores other logins, empty output and lines that only contain a login', () => {
    expect(countCopilotLogins('octocat\n', DEFAULT_LOGINS)).toBe(0);
    expect(countCopilotLogins('', DEFAULT_LOGINS)).toBe(0);
    expect(countCopilotLogins('\n\n', DEFAULT_LOGINS)).toBe(0);
    expect(countCopilotLogins('not-copilot\ncopilot-fan', DEFAULT_LOGINS)).toBe(0);
  });
});

describe('copilotCommandVars', () => {
  test('repo is what gh --repo takes; host and path serve a REST path', () => {
    expect(copilotCommandVars({ host: 'github.com', path: 'o/r' }, '7')).toEqual({
      number: '7',
      repo: 'o/r',
      host: 'github.com',
      path: 'o/r',
    });
    expect(copilotCommandVars({ host: 'ghe.example.com', path: 'o/r' }, '7')).toEqual({
      number: '7',
      repo: 'ghe.example.com/o/r',
      host: 'ghe.example.com',
      path: 'o/r',
    });
  });
});

describe('confirmCopilotRequest', () => {
  function deps(
    runs: ConfirmRun[],
    headReviewed: () => boolean = () => false,
    before = 1
  ): { slept: number[]; reads: () => number; deps: Parameters<typeof confirmCopilotRequest>[0] } {
    const slept: number[] = [];
    let reads = 0;
    return {
      slept,
      reads: () => reads,
      deps: {
        before,
        logins: DEFAULT_LOGINS,
        delaysMs: [2, 4, 8],
        runConfirm: async () => runs[Math.min(reads++, runs.length - 1)] as ConfirmRun,
        headReviewed,
        sleep: async ms => {
          slept.push(ms);
        },
      },
    };
  }
  const out = (output: string): ConfirmRun => ({ ok: true, output });

  test('a new Copilot request line confirms at once', async () => {
    const d = deps([out('Copilot\nCopilot\n')]);
    expect(await confirmCopilotRequest(d.deps)).toEqual({ kind: 'confirmed' });
    expect(d.slept).toEqual([]);
  });
  test('an event that lags is found on a re-read', async () => {
    const d = deps([out('Copilot\n'), out('Copilot\n'), out('Copilot\nCopilot\n')]);
    expect(await confirmCopilotRequest(d.deps)).toEqual({ kind: 'confirmed' });
    expect(d.slept).toEqual([2, 4]);
  });
  test('only an earlier request’s line, after every re-read and no review, refuses', async () => {
    const d = deps([out('Copilot\noctocat\n')]);
    const result = await confirmCopilotRequest(d.deps);
    expect(result).toEqual({
      kind: 'refused',
      detail: 'copilot_confirm_cmd showed no new Copilot review request',
    });
    expect(d.slept).toEqual([2, 4, 8]);
    expect(d.reads()).toBe(4);
  });
  test('a Copilot review of the head confirms when no new line appears', async () => {
    const d = deps([out('')], () => true, 0);
    expect(await confirmCopilotRequest(d.deps)).toEqual({ kind: 'confirmed' });
  });
  test('a failed reviews read refuses with the read’s error', async () => {
    const d = deps(
      [out('')],
      () => {
        throw new Error('rate limited');
      },
      0
    );
    const result = await confirmCopilotRequest(d.deps);
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' && result.detail).toContain('rate limited');
  });
  test('a failing confirm command is unknown, not refused', async () => {
    const d = deps([out(''), { ok: false, detail: 'copilot_confirm_cmd exited 4' }], () => {
      throw new Error('must not be read');
    });
    expect(await confirmCopilotRequest(d.deps)).toEqual({
      kind: 'unknown',
      detail: 'copilot_confirm_cmd exited 4',
    });
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

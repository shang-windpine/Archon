import { describe, expect, test } from 'bun:test';
import { summarizeChecks } from '../../pack/devflow/.shared/lib/checks.ts';
import {
  checksVerdict,
  copilotVerdict,
  logFileName,
  pendingReruns,
  unresolvedThreads,
} from '../../pack/devflow/.shared/lib/deliver-await.ts';
import { HEAD, OLD, snapshot, unit } from './check-fixtures.ts';
import type { ReviewItem } from '../../pack/devflow/.shared/lib/copilot.ts';

const review = { kind: 'review', id: 'r' } as unknown as ReviewItem;

describe('copilotVerdict', () => {
  const base = {
    mode: 'request' as const,
    review: undefined,
    requestError: '',
    now: 0,
    deadline: 10,
  };
  test('off, done, request_failed, waiting, timeout', () => {
    expect(copilotVerdict({ ...base, mode: 'off' })).toBe('off');
    expect(copilotVerdict({ ...base, review, requestError: 'x' })).toBe('done');
    expect(copilotVerdict({ ...base, requestError: 'x' })).toBe('request_failed');
    expect(copilotVerdict(base)).toBeNull();
    expect(copilotVerdict({ ...base, now: 10 })).toBe('timeout');
  });
});

describe('checksVerdict', () => {
  test('settled states map through; a pending rerun keeps waiting', () => {
    const red = summarizeChecks(snapshot([unit('a', 'red')]), HEAD, []);
    expect(checksVerdict(red, false, 0, 10)).toBe('red');
    expect(checksVerdict(red, true, 0, 10)).toBeNull();
    expect(checksVerdict(red, true, 10, 10)).toBe('pending_timeout');
    const green = summarizeChecks(snapshot([unit('a', 'green')]), HEAD, []);
    expect(checksVerdict(green, false, 0, 10)).toBe('green');
  });
  test('at the deadline: none on the head is none, a stale or pending one is pending_timeout', () => {
    expect(checksVerdict(summarizeChecks(snapshot([]), HEAD, []), false, 10, 10)).toBe('none');
    expect(checksVerdict(summarizeChecks(snapshot([]), HEAD, []), false, 0, 10)).toBeNull();
    const stale = summarizeChecks(snapshot([unit('a', 'green')], OLD), HEAD, []);
    expect(checksVerdict(stale, false, 0, 10)).toBeNull();
    expect(checksVerdict(stale, false, 10, 10)).toBe('pending_timeout');
    const pending = summarizeChecks(snapshot([unit('a', 'pending')]), HEAD, []);
    expect(checksVerdict(pending, false, 10, 10)).toBe('pending_timeout');
  });
  test('a missing required check is pending, not green', () => {
    const summary = summarizeChecks(snapshot([unit('a', 'green')]), HEAD, ['build']);
    expect(checksVerdict(summary, false, 0, 10)).toBeNull();
  });
});

describe('pendingReruns', () => {
  test('an issued rerun is pending while the unit keeps its old id and is not running', () => {
    const issued = [{ head: HEAD, unit: 'check:a', at: 'x', id: 'id-a' }];
    expect(pendingReruns([unit('a', 'red')], issued, HEAD)).toEqual(['check:a']);
    expect(pendingReruns([unit('a', 'pending')], issued, HEAD)).toEqual([]);
    const rerun = { ...unit('a', 'red'), unit: { kind: 'check' as const, id: 'id-a2', name: 'a' } };
    expect(pendingReruns([rerun], issued, HEAD)).toEqual([]);
    expect(pendingReruns([unit('a', 'red')], issued, OLD)).toEqual([]);
  });
});

describe('unresolvedThreads', () => {
  test('keeps unresolved threads with their comments and the first comment url', () => {
    const threads = unresolvedThreads([
      { id: 'A', resolved: true, outdated: false, path: null, line: null, comments: [] },
      {
        id: 'B',
        resolved: false,
        outdated: true,
        path: 'x.java',
        line: 2,
        comments: [{ id: 'c', author: null, body: 'hi', url: 'u' }],
      },
    ]);
    expect(threads).toEqual([
      {
        id: 'B',
        outdated: true,
        path: 'x.java',
        line: 2,
        url: 'u',
        comments: [{ author: null, body: 'hi', url: 'u' }],
      },
    ]);
  });
});

describe('logFileName', () => {
  test('safe and unique', () => {
    const u = (name: string) => ({ kind: 'check' as const, id: '1', name });
    expect(logFileName(u('build / test (17)'), new Set())).toBe('build_test_17_.log');
    expect(logFileName(u('../x'), new Set())).toBe('__x.log');
    expect(logFileName(u('a'), new Set(['a.log']))).toBe('a-2.log');
  });
});

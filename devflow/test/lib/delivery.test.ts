import { describe, expect, test } from 'bun:test';
import { deliveryRecord } from '../../pack/devflow/.shared/lib/delivery.ts';
import type { PrRecord } from '../../pack/devflow/.shared/lib/identity.ts';
import { parseDelivery } from '../../pack/devflow/.shared/lib/verify.ts';

const pr: PrRecord = {
  repo: { host: 'github.com', path: 'group/sub/repo' },
  number: 42,
  schemaVersion: 1,
  url: 'https://github.com/group/sub/repo/pull/42',
  head: 'feature/ABC-1',
  base: 'main',
  is_draft: true,
  state: 'open',
  head_repo: { host: 'github.com', path: 'group/sub/repo' },
  head_revision: 'abc123',
  base_revision: 'def456',
  maintainer_can_modify: null,
};

describe('delivery.json contract (deliver finish -> verify context)', () => {
  test('what finish writes, verify reads back as the same PR, worktree and branch', () => {
    const written = deliveryRecord({
      key: 'ABC-1',
      pr,
      worktreePath: '/w/ABC-1',
      branch: 'feature/ABC-1',
      done: true,
      reason: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parseDelivery(JSON.stringify(written, null, 2))).toEqual({
      pr: {
        repo: { host: 'github.com', path: 'group/sub/repo' },
        number: 42,
        url: 'https://github.com/group/sub/repo/pull/42',
        base: 'main',
        headRevision: 'abc123',
      },
      worktreePath: '/w/ABC-1',
      branch: 'feature/ABC-1',
    });
  });
});

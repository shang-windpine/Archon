/**
 * The `delivery.json` record (DESIGN §2): devflow-deliver's finish writes it and
 * devflow-verify's `parseDelivery` reads it. This type owns the shape; a conformance
 * test feeds a built record to the reader, so the two cannot drift silently.
 */

import type { PrRecord, Repo } from './identity.ts';

export interface DeliveryRecord {
  readonly key: string;
  readonly pr: {
    readonly number: number;
    readonly url: string;
    /** Structured, never `host/path` text: a reader must not split a path to recover it. */
    readonly repo: Repo;
    readonly head: string;
    readonly base: string;
    readonly head_revision: string | null;
  };
  readonly worktree_path: string;
  readonly branch: string;
  readonly done: boolean;
  readonly reason: string;
  readonly updated_at: string;
}

export interface DeliveryFactsIn {
  readonly key: string;
  readonly pr: PrRecord;
  readonly worktreePath: string;
  readonly branch: string;
  readonly done: boolean;
  readonly reason: string;
  readonly updatedAt: string;
}

export function deliveryRecord(facts: DeliveryFactsIn): DeliveryRecord {
  const { pr } = facts;
  return {
    key: facts.key,
    pr: {
      number: pr.number,
      url: pr.url,
      repo: { host: pr.repo.host, path: pr.repo.path },
      head: pr.head,
      base: pr.base,
      head_revision: pr.head_revision,
    },
    worktree_path: facts.worktreePath,
    branch: facts.branch,
    done: facts.done,
    reason: facts.reason,
    updated_at: facts.updatedAt,
  };
}

/**
 * Close the delivery: the pull request stays a draft, `delivery.json` and
 * `change-summary.md` go to the KEY's state directory for devflow-verify and a later
 * deliver run, and a devflow-verify follow-up this run worked from is marked consumed
 * (renamed with a timestamp) so the next run does not repeat it.
 *
 * `done` is the last round's verdict. A loop that ran out of rounds completes with it
 * false, and `reason` says what the last round still had open.
 *
 * Bound inputs: key, repo/base/head/has_followup (preflight), done/summary/pr_number
 * (the rounds' last act).
 */

import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { deliveryRecord } from '../../.shared/lib/delivery.ts';
import { artifactPath, statePath, validateKey } from '../../.shared/lib/devflow.ts';
import type { Repo } from '../../.shared/lib/identity.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';
import { setPrDraft, viewPr } from '../../.shared/lib/pr.ts';

try {
  const key = validateKey(input('key'));
  const repo = nullableJson(input('repo')) as Repo;
  const number = Number(input('pr_number'));
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`the rounds named no pull request (${input('pr_number')})`);
  const done = input('done') === 'true';
  const reason = done
    ? 'done'
    : `the round cap was reached; the last round left: ${input('summary')}`;

  let pr = viewPr({ repo, number }).pr;
  if (pr.state === 'open' && !pr.is_draft) pr = setPrDraft({ repo, number });

  const updatedAt = new Date().toISOString();
  const delivery = deliveryRecord({
    key,
    pr,
    worktreePath: process.cwd(),
    branch: input('head'),
    done,
    reason,
    updatedAt,
  });
  writeFileSync(statePath(key, 'delivery.json'), `${JSON.stringify(delivery, null, 2)}\n`);

  if (input('has_followup') === 'true') {
    const followup = statePath(key, 'followup-work.md');
    if (existsSync(followup)) {
      renameSync(
        followup,
        statePath(key, `followup-work.consumed-${updatedAt.replace(/[:.]/g, '-')}.md`)
      );
    }
  }

  const summary = artifactPath('change-summary.md');
  if (!existsSync(summary))
    throw new Error(`summarize wrote no ${summary}; delivery.json was written without it`);
  copyFileSync(summary, statePath(key, 'change-summary.md'));

  emit({ done, pr_url: pr.url, reason });
} catch (error) {
  refuse(`finish: ${error instanceof Error ? error.message : String(error)}`);
}

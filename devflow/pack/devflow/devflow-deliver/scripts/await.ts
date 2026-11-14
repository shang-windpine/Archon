/**
 * Wait, in this process, until Copilot has reviewed the pushed head (or the wait is
 * over) and the head's checks have settled (or the wait is over), then save the round's
 * snapshot for the judges and act.
 *
 * Copilot counts as done only for a review whose commit is the head and whose author is
 * one of `copilot_logins`; with the `$ARTIFACTS_DIR/copilot-skipped` marker control
 * writes for a `skip-copilot` answer, `copilot_mode` is `off`. Checks count as settled only for an observation of the head
 * with no unit pending (summarizeChecks), and not while a rerun this pack issued on the
 * head has not visibly started. Both deadlines (`copilot_wait_min`, `ci_wait_min`, at
 * most 140 minutes, checked by preflight) end before the node's 150-minute timeout.
 *
 * Reads are retried: a forge read that fails five polls in a row refuses.
 *
 * The snapshot (`$ARTIFACTS_DIR/snapshot.json`) holds the unresolved threads, Copilot's
 * review of the head, the checks observation and summary, each red unit with its saved
 * log (`ci-logs/`), and whether the branch conflicts with the base (`git merge-tree`).
 *
 * Bound inputs: repo, base (preflight), pr_number, head_revision (publish),
 * request_error (request-review).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, forge, input, refuse } from 'archon:script';
import { type ChecksState, type ChecksSummary, summarizeChecks } from '../../.shared/lib/checks.ts';
import {
  copilotReviewForHead,
  normalizeLogins,
  type ReviewItem,
} from '../../.shared/lib/copilot.ts';
import {
  checksVerdict,
  copilotVerdict,
  type IssuedRerun,
  logFileName,
  pendingReruns,
  unresolvedThreads,
} from '../../.shared/lib/deliver-await.ts';
import type { AwaitChecks, AwaitCopilot } from '../../.shared/lib/deliver-outcome.ts';
import {
  COPILOT_SKIPPED_ARTIFACT,
  parseAwaitSettings,
} from '../../.shared/lib/deliver-settings.ts';
import { artifactPath } from '../../.shared/lib/devflow.ts';
import { git } from '../../.shared/lib/git.ts';
import type { Repo } from '../../.shared/lib/identity.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';
import { fetchBranch } from '../../.shared/lib/remote.ts';

const MAX_READ_FAILURES = 5;
const LOG_MAX_BYTES = 400_000;

let readFailures = 0;
/** A forge read, or undefined after a failure that may be transient; refuses after five in a row. */
function read<T>(what: string, run: () => T): T | undefined {
  try {
    const value = run();
    readFailures = 0;
    return value;
  } catch (error) {
    readFailures++;
    const reason = error instanceof Error ? error.message : String(error);
    if (readFailures >= MAX_READ_FAILURES)
      throw new Error(`${what} failed ${String(readFailures)} polls in a row: ${reason}`);
    console.error(
      `await: ${what} failed (${String(readFailures)}/${String(MAX_READ_FAILURES)}): ${reason}`
    );
    return undefined;
  }
}

function issuedReruns(): IssuedRerun[] {
  const path = artifactPath('reruns.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as IssuedRerun[]) : [];
}

/** Exit 0 merges cleanly, 1 conflicts; anything else is a git failure. */
function conflictsWith(baseRevision: string): boolean {
  const merged = git('merge-tree', '--write-tree', '--name-only', baseRevision, 'HEAD');
  if (merged.code === 0) return false;
  if (merged.code === 1) return true;
  throw new Error(`git merge-tree failed (git 2.38 or later is required): ${merged.stderr}`);
}

try {
  const settings = parseAwaitSettings({
    copilot_mode: input('copilot_mode'),
    copilot_logins: input('copilot_logins'),
    poll_interval_sec: input('poll_interval_sec'),
    copilot_wait_min: input('copilot_wait_min'),
    ci_wait_min: input('ci_wait_min'),
    required_checks: input('required_checks'),
  });
  const repo = nullableJson(input('repo')) as Repo;
  const base = input('base');
  const head = input('head_revision');
  const number = Number(input('pr_number'));
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`head_revision is not a commit SHA: ${JSON.stringify(head)}`);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`pr_number is not a pull request number: ${input('pr_number')}`);
  const ref = { repo, number };
  // A person answered an escalation with skip-copilot: no Copilot wait for the rest of the run.
  const copilotMode = existsSync(artifactPath(COPILOT_SKIPPED_ARTIFACT))
    ? 'off'
    : settings.copilotMode;
  const logins = normalizeLogins(settings.copilotLogins);
  const requestError = input('request_error').trim();
  const issued = issuedReruns();

  const start = Date.now();
  const copilotDeadline = start + settings.copilotWaitMin * 60_000;
  const ciDeadline = start + settings.ciWaitMin * 60_000;
  let copilot: AwaitCopilot | null = null;
  let review: ReviewItem | undefined;
  let checks: AwaitChecks | null = null;
  let state: ChecksState | undefined;
  let summary: ChecksSummary | undefined;
  for (;;) {
    const now = Date.now();
    if (copilot === null) {
      if (copilotMode !== 'off') {
        const reviews = read('forge pr.reviews', () => forge('pr.reviews', { ref }));
        if (reviews !== undefined) review = copilotReviewForHead(reviews.items, head, logins);
      }
      copilot = copilotVerdict({
        mode: copilotMode,
        review,
        requestError,
        now,
        deadline: copilotDeadline,
      });
    }
    if (checks === null) {
      const observed = read('forge checks.state', () => forge('checks.state', { ref }));
      if (observed !== undefined) {
        state = observed;
        summary = summarizeChecks(observed, head, settings.requiredChecks);
        const waiting = pendingReruns(observed.units, issued, head);
        checks = checksVerdict(summary, waiting.length > 0, now, ciDeadline);
      } else if (now >= ciDeadline) {
        checks = 'unknown';
      }
    }
    if (copilot !== null && checks !== null) break;
    await Bun.sleep(settings.pollIntervalSec * 1000);
  }

  const threads = unresolvedThreads(forge('pr.threads', { ref }).threads);
  const redUnits = summary?.redUnits ?? [];
  const taken = new Set<string>();
  const savedUnits = redUnits.map(entry => {
    const name = logFileName(entry.unit, taken);
    taken.add(name);
    const relative = join('ci-logs', name);
    const path = artifactPath(relative);
    let note = '';
    try {
      const fetched = forge('checks.logs', { repo, unit: entry.unit, maxBytes: LOG_MAX_BYTES });
      if (fetched.log.kind === 'text') {
        writeFileSync(path, fetched.log.text);
        if (fetched.log.truncated)
          note = `truncated to the last part of ${String(fetched.log.totalBytes)} bytes`;
      } else {
        writeFileSync(path, `[no log: ${fetched.log.reason}]\n`);
        note = `no log: ${fetched.log.reason}`;
      }
    } catch (error) {
      writeFileSync(path, '[the log could not be read]\n');
      note = `log unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { name: entry.unit.name, kind: entry.unit.kind, log_path: path, note };
  });

  const baseRevision = fetchBranch(repo, base);
  writeFileSync(artifactPath('base-revision.txt'), `${baseRevision}\n`);
  const conflict = conflictsWith(baseRevision);

  const snapshotPath = artifactPath('snapshot.json');
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(
      {
        taken_at: new Date().toISOString(),
        pr: ref,
        head_revision: head,
        base,
        base_revision: baseRevision,
        copilot,
        request_error: requestError,
        copilot_review:
          review === undefined
            ? null
            : {
                id: review.id,
                url: review.url,
                state: review.state,
                created_at: review.createdAt,
                body: review.body,
              },
        checks,
        checks_summary: summary ?? null,
        checks_state: state ?? null,
        threads,
        red_units: savedUnits,
        conflict,
      },
      null,
      2
    )}\n`
  );
  emit({
    head_revision: head,
    copilot,
    checks,
    open_threads: threads.length,
    red_units: savedUnits.length,
    conflict,
    snapshot_path: snapshotPath,
  });
} catch (error) {
  refuse(`await: ${error instanceof Error ? error.message : String(error)}`);
}

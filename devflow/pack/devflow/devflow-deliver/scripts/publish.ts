/**
 * Publish the round: prove the local gate on the head being pushed, push it (never
 * forced), open the draft pull request or keep the existing one a draft, and answer the
 * review threads implement fixed.
 *
 * When the round's first local gate failed, both commands run again here on the final
 * HEAD (fix-style may have changed it) and a red result refuses: the run stops for a
 * person rather than pushing code the project's own checks reject.
 *
 * A fixed thread gets `Fixed in <sha>: <note>` and is resolved, but only a thread this
 * round's work order handed implement (`work-threads.json`). implement's `not_fixed`
 * notes go to `thread-notes.json` for the next thread judge.
 *
 * Bound inputs: key, repo/base/head (preflight), pr_number (control), checks_ok
 * (checkstyle), threads (implement's per-thread results, `null` when it was skipped).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, forge, input, refuse } from 'archon:script';
import { artifactPath, runCommand, validateKey } from '../../.shared/lib/devflow.ts';
import { fixedReplies, type ImplementThread } from '../../.shared/lib/deliver-work.ts';
import { git, gitOrThrow } from '../../.shared/lib/git.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';
import type { PrRecord, Repo } from '../../.shared/lib/identity.ts';
import { createPr, findOpenPrByHead, setPrDraft, viewPr } from '../../.shared/lib/pr.ts';
import { pushHead } from '../../.shared/lib/push.ts';
import { fetchBranch, remoteFor } from '../../.shared/lib/remote.ts';

const COMMAND_TIMEOUT_MS = 20 * 60_000;

async function recheckLocalGate(): Promise<void> {
  const commands = [
    {
      name: 'checkstyle_cmd',
      command: input('checkstyle_cmd').trim(),
      log: 'checkstyle-final.log',
    },
    {
      name: 'local_verify_cmd',
      command: input('local_verify_cmd').trim(),
      log: 'local-verify-final.log',
    },
  ];
  for (const { name, command, log } of commands) {
    if (command === '') continue;
    const logPath = artifactPath(log);
    const result = await runCommand(command, {
      cwd: process.cwd(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      logPath,
    });
    if (result.code !== 0) {
      throw new Error(
        `${name} still fails on HEAD after fix-style (${result.timedOut ? 'timed out' : `exit ${String(result.code)}`}); ` +
          `see ${logPath}. Fix it on the branch, commit, then rerun devflow-deliver on the same --branch`
      );
    }
  }
}

function prTitle(key: string): string {
  const path = artifactPath('pr-title.txt');
  const title = existsSync(path)
    ? (
        readFileSync(path, 'utf8')
          .split('\n')
          .find(line => line.trim() !== '') ?? ''
      ).trim()
    : '';
  if (title === '') throw new Error(`pr-text wrote no title to ${path}`);
  return title.startsWith(key) ? title : `${key}: ${title}`;
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return Array.isArray(value) ? value : [];
}

function answerFixedThreads(pr: PrRecord, revision: string): number {
  const reported = (nullableJson(input('threads')) as ImplementThread[] | null) ?? [];
  const workThreads = readJsonArray(artifactPath('work-threads.json')).filter(
    (id): id is string => typeof id === 'string'
  );
  const notesPath = artifactPath('thread-notes.json');
  const notes = existsSync(notesPath)
    ? (JSON.parse(readFileSync(notesPath, 'utf8')) as Record<string, string>)
    : {};
  for (const entry of reported) {
    if (entry.status === 'not_fixed' && workThreads.includes(entry.thread))
      notes[entry.thread] = entry.note;
  }
  writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`);

  const replies = fixedReplies(reported, workThreads, revision);
  if (replies.length === 0) return 0;
  const ref = { repo: pr.repo, number: pr.number };
  const resolved = new Set(
    forge('pr.threads', { ref })
      .threads.filter(thread => thread.resolved)
      .map(thread => thread.id)
  );
  let answered = 0;
  for (const reply of replies) {
    if (resolved.has(reply.thread)) continue;
    // Each write is read back by the forge; a failure throws with its outcome evidence.
    forge('pr.thread.reply', { ref, thread: reply.thread, body: reply.body });
    forge('pr.thread.resolve', { ref, thread: reply.thread });
    answered++;
  }
  return answered;
}

try {
  const key = validateKey(input('key'));
  const repo = nullableJson(input('repo')) as Repo;
  const base = input('base');
  const head = input('head');
  if (input('checks_ok') !== 'true') await recheckLocalGate();

  const known = Number(input('pr_number') || '0');
  const existing = known > 0 ? viewPr({ repo, number: known }) : findOpenPrByHead(repo, head);
  if (existing !== undefined && existing.pr.state !== 'open') {
    throw new Error(
      `pull request #${String(existing.pr.number)} is ${existing.pr.state}; this run only updates an open one`
    );
  }

  const baseRevision = fetchBranch(repo, base);
  const ahead = Number(gitOrThrow('rev-list', '--count', `${baseRevision}..HEAD`));
  if (existing === undefined && ahead === 0) {
    throw new Error(
      `the branch has no commits ahead of ${base}; implement committed nothing to open a pull request for`
    );
  }
  const remote = remoteFor(repo);
  const before = git('ls-remote', remote, `refs/heads/${head}`).stdout.split(/\s+/)[0] ?? '';
  const revision = pushHead({ repo, head });

  let pr: PrRecord;
  if (existing === undefined) {
    pr = createPr({
      repo,
      head,
      headRevision: revision,
      base,
      title: prTitle(key),
      bodyPath: artifactPath('pr-body.md'),
    });
  } else {
    pr = existing.pr.is_draft ? existing.pr : setPrDraft({ repo, number: existing.pr.number });
  }
  const answered = answerFixedThreads(pr, revision);

  emit({
    pr: { number: pr.number, url: pr.url, is_draft: pr.is_draft },
    pushed: before !== revision,
    head_revision: revision,
    answered,
  });
} catch (error) {
  refuse(`publish: ${error instanceof Error ? error.message : String(error)}`);
}

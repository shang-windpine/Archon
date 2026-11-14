/**
 * Push the checkout's HEAD to a pull request's head branch, and prove it landed.
 *
 * The target is explicit — the repository's remote (found by URL, ./remote.ts) and the
 * head branch — so git never picks an upstream. It never forces: a remote that moved
 * refuses, and the refusal is the evidence. A nonzero push exit gets one retry after
 * 20 seconds for transient remote failures; retrying a refusal is harmless because a
 * non-forced push cannot overwrite anything. After the push, the remote ref is read
 * back and must equal HEAD.
 */

import type { Repo } from './identity.ts';
import { git, gitOrThrow } from './git.ts';
import { remoteFor } from './remote.ts';

export interface PushTarget {
  readonly repo: Repo;
  readonly head: string;
}

/** Push HEAD to `head` on `repo`; returns the pushed commit. */
export function pushHead(target: PushTarget, retryDelayMs = 20_000): string {
  const head = gitOrThrow('rev-parse', 'HEAD');
  const destination = remoteFor(target.repo);
  const ref = `refs/heads/${target.head}`;
  let pushed = git('push', destination, `HEAD:${ref}`);
  if (pushed.code !== 0) {
    Bun.sleepSync(retryDelayMs);
    pushed = git('push', destination, `HEAD:${ref}`);
  }
  if (pushed.code !== 0)
    throw new Error(`git push ${destination} HEAD:${ref} refused: ${pushed.stderr}`);
  const landed = gitOrThrow('ls-remote', destination, ref).split(/\s+/)[0] ?? '';
  if (landed !== head) {
    throw new Error(
      `pushed ${head} to ${destination} ${ref}, but the remote reads ${landed || 'nothing'}`
    );
  }
  return head;
}

/**
 * Which git remote holds a repository, decided from each remote's URL, never its name.
 *
 * A checkout can name its remotes anything, so every script that fetches a base or
 * pushes a head is handed a repository identity (`{host, path}`) and finds the remote
 * here. URLs are a machine format: HTTPS, `user@host:path` and `ssh://` forms reduce to
 * the same identity, with credentials, ports and a trailing `.git` dropped. The
 * configured URL is read, before any `url.<base>.insteadOf` rewrite: that is the
 * repository the operator named.
 *
 * This module only runs git; resolving a remote through the forge lives in ./pr.ts.
 */

import { randomUUID } from 'node:crypto';
import { type Repo, sameRepo } from './identity.ts';
import { git, gitOrThrow } from './git.ts';

/** The repository a remote URL names, or undefined for a local path or unknown form. */
export function urlRepo(url: string): Repo | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like `[user@]host:path`; a Windows drive path (`C:/...`) is not a remote.
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
    const [, scpHost, scpPath] = scp ?? [];
    if (scpHost === undefined || scpPath === undefined || scpHost.length === 1) return undefined;
    host = scpHost;
    path = scpPath;
  }
  host = host.toLowerCase();
  // GitHub's SSH endpoint on port 443 serves the same repositories as github.com.
  if (host === 'ssh.github.com') host = 'github.com';
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (host === '' || path === '' || !path.includes('/')) return undefined;
  return { host, path };
}

export interface Remote {
  readonly name: string;
  readonly url: string;
  readonly repo: Repo | undefined;
}

/** Every configured remote's name, URL, and the repository its URL names, if any. */
export function remotes(checkout = process.cwd()): Remote[] {
  const listed = git('-C', checkout, 'config', '--get-regexp', '^remote\\..*\\.url$');
  // Exit 1 means no remote is configured at all; anything else non-zero is a failure.
  if (listed.code !== 0 && listed.code !== 1) {
    throw new Error(`git config --get-regexp failed: ${listed.stderr}`);
  }
  return listed.stdout.split('\n').flatMap(line => {
    const space = line.indexOf(' ');
    if (space === -1) return [];
    const url = line.slice(space + 1);
    return [{ name: line.slice('remote.'.length, space - '.url'.length), url, repo: urlRepo(url) }];
  });
}

/** The distinct repositories this checkout's remotes name. */
export function remoteRepos(checkout = process.cwd()): Repo[] {
  const repos: Repo[] = [];
  for (const { repo } of remotes(checkout)) {
    if (repo && !repos.some(known => sameRepo(known, repo))) repos.push(repo);
  }
  return repos;
}

/**
 * The remote this checkout works against: the only one, or `origin` among several.
 * Refuses when there is none, or several and none is `origin`. The URL never enters a
 * message: a configured remote URL can carry a credential.
 */
export function checkoutRemote(checkout = process.cwd()): Remote {
  // A remote with several `url` entries is listed once per URL; git fetches from the first.
  const all = remotes(checkout);
  const names = [...new Set(all.map(candidate => candidate.name))];
  const chosen = names.length === 1 ? names[0] : names.find(name => name === 'origin');
  const remote = all.find(candidate => candidate.name === chosen);
  if (remote === undefined) {
    throw new Error(
      all.length === 0
        ? 'this checkout has no git remote'
        : `this checkout has several git remotes and none is origin (${names.join(', ')})`
    );
  }
  return remote;
}

/** The one remote whose URL names `repo`, undefined when none does; refuses on several. */
export function findRemote(repo: Repo, checkout = process.cwd()): string | undefined {
  const names = new Set<string>();
  for (const remote of remotes(checkout)) {
    if (remote.repo && sameRepo(remote.repo, repo)) names.add(remote.name);
  }
  if (names.size > 1) {
    throw new Error(
      `several git remotes point at ${repo.host}/${repo.path} (${[...names].join(', ')}); ` +
        'which one is canonical is ambiguous'
    );
  }
  return [...names][0];
}

/** The one remote whose URL names `repo`; refuses on none or several. */
export function remoteFor(repo: Repo, checkout = process.cwd()): string {
  const remote = findRemote(repo, checkout);
  if (remote === undefined) throw new Error(`no git remote points at ${repo.host}/${repo.path}`);
  return remote;
}

/**
 * Fetch `branch` of `repo` and return the commit it points at. The fetch lands in a
 * unique ref, deleted afterwards: tracking refs are shared by worktrees, and
 * FETCH_HEAD can be overwritten by another fetch in this checkout. The fetched
 * objects stay, so the returned commit can be used (e.g. by `git merge-tree`).
 */
export function fetchBranch(repo: Repo, branch: string, checkout = process.cwd()): string {
  const remote = remoteFor(repo, checkout);
  const ref = `refs/archon/fetch/${randomUUID()}`;
  try {
    gitOrThrow(
      '-C',
      checkout,
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      remote,
      `refs/heads/${branch}:${ref}`
    );
    return gitOrThrow('-C', checkout, 'rev-parse', '--verify', `${ref}^{commit}`);
  } finally {
    // The ref is absent when the fetch itself failed; that delete failing is not news.
    git('-C', checkout, 'update-ref', '-d', ref);
  }
}

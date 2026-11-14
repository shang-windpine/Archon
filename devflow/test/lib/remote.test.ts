import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQualifiedPr, samePr } from '../../pack/devflow/.shared/lib/identity.ts';
import { gitOrThrow } from '../../pack/devflow/.shared/lib/git.ts';
import {
  checkoutRemote,
  findRemote,
  remoteRepos,
  urlRepo,
} from '../../pack/devflow/.shared/lib/remote.ts';
import { trackTempRoots } from '../temp-roots.ts';

const track = trackTempRoots();

describe('urlRepo', () => {
  const github = { host: 'github.com', path: 'Org/Repo' };
  test.each([
    ['https://github.com/Org/Repo.git', github],
    ['https://user:secret@github.com/Org/Repo', github],
    ['git@github.com:Org/Repo.git', github],
    ['ssh://git@ssh.github.com:443/Org/Repo.git', github],
    [
      'https://GHE.example.com/team/group/repo/',
      { host: 'ghe.example.com', path: 'team/group/repo' },
    ],
  ])('%s', (url, expected) => {
    expect(urlRepo(url)).toEqual(expected);
  });
  test.each([
    '/tmp/remote.git',
    'C:/repos/x',
    'file:///tmp/remote.git',
    'https://github.com/only-owner',
  ])('%s names no repository', url => {
    expect(urlRepo(url)).toBeUndefined();
  });
});

describe('checkout remotes', () => {
  function repoWith(remotes: Record<string, string>): string {
    const dir = track(mkdtempSync(join(tmpdir(), 'devflow-remote-')));
    gitOrThrow('-C', dir, 'init', '-q');
    for (const [name, url] of Object.entries(remotes))
      gitOrThrow('-C', dir, 'remote', 'add', name, url);
    return dir;
  }

  test('the only remote is the checkout remote, whatever its name', () => {
    const dir = repoWith({ upstream: 'git@github.com:o/r.git' });
    expect(checkoutRemote(dir)).toMatchObject({
      name: 'upstream',
      repo: { host: 'github.com', path: 'o/r' },
    });
  });
  test('origin wins among several; none named origin refuses', () => {
    expect(
      checkoutRemote(
        repoWith({ fork: 'git@github.com:me/r.git', origin: 'git@github.com:o/r.git' })
      ).name
    ).toBe('origin');
    expect(() =>
      checkoutRemote(repoWith({ a: 'git@github.com:o/a.git', b: 'git@github.com:o/b.git' }))
    ).toThrow(/none is origin/);
    expect(() => checkoutRemote(repoWith({}))).toThrow(/no git remote/);
  });
  test('findRemote matches by URL case-insensitively and refuses duplicates', () => {
    const dir = repoWith({
      origin: 'https://github.com/O/R.git',
      mirror: 'git@github.com:o/r.git',
    });
    expect(() => findRemote({ host: 'github.com', path: 'o/r' }, dir)).toThrow(/ambiguous/);
    expect(remoteRepos(dir)).toHaveLength(1);
    const single = repoWith({ origin: 'https://github.com/O/R.git' });
    expect(findRemote({ host: 'GitHub.com', path: 'o/r' }, single)).toBe('origin');
    expect(findRemote({ host: 'github.com', path: 'o/other' }, single)).toBeUndefined();
  });
});

describe('identity', () => {
  test('parseQualifiedPr accepts a PrRecord-shaped binding and refuses junk', () => {
    const pr = parseQualifiedPr(
      JSON.stringify({ repo: { host: 'github.com', path: 'o/r' }, number: 3, url: 'u' })
    );
    expect(pr).toEqual({ repo: { host: 'github.com', path: 'o/r' }, number: 3 });
    expect(samePr(pr, { repo: { host: 'GITHUB.com', path: 'O/R' }, number: 3 })).toBe(true);
    for (const bad of ['', 'null', '{', '{"repo":{"host":"h","path":"p"},"number":0}']) {
      expect(() => parseQualifiedPr(bad)).toThrow();
    }
  });
});

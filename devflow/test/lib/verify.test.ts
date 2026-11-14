import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitOrThrow } from '../../pack/devflow/.shared/lib/git.ts';
import {
  gitChangedFiles,
  locateChange,
  parseDelivery,
  parseNameStatusZ,
  planHeadline,
  remoteDefaultBranch,
  renderResultsTemplate,
  resolveBaseRef,
  validateCases,
} from '../../pack/devflow/.shared/lib/verify.ts';
import { trackTempRoots } from '../temp-roots.ts';

const track = trackTempRoots();
const scratch = (): string => realpathSync(track(mkdtempSync(join(tmpdir(), 'devflow-verify-'))));

describe('validateCases', () => {
  test('accepts well-formed cases and trims titles', () => {
    expect(
      validateCases('UI', [
        { id: 'UI-1', title: ' Save draft ', criterion: 'AC-1' },
        { id: 'UI-2', title: 'Reject guest', criterion: '' },
      ])
    ).toEqual([
      { id: 'UI-1', title: 'Save draft', criterion: 'AC-1' },
      { id: 'UI-2', title: 'Reject guest', criterion: '' },
    ]);
  });
  test.each([
    ['not a list', { id: 'UI-1' }, /not a list/],
    ['wrong side prefix', [{ id: 'API-1', title: 't', criterion: '' }], /must match/],
    ['zero index', [{ id: 'UI-0', title: 't', criterion: '' }], /must match/],
    [
      'duplicate ID',
      [
        { id: 'UI-1', title: 'a', criterion: '' },
        { id: 'UI-1', title: 'b', criterion: '' },
      ],
      /twice/,
    ],
    ['multi-line title', [{ id: 'UI-1', title: 'a\nb', criterion: '' }], /one-line title/],
    ['missing criterion', [{ id: 'UI-1', title: 'a' }], /criterion/],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => validateCases('UI', raw)).toThrow(message);
  });
});

describe('parseDelivery', () => {
  test('reads the PR, worktree and branch', () => {
    const facts = parseDelivery(
      JSON.stringify({
        key: 'ABC-1',
        pr: {
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          repo: { host: 'github.com', path: 'o/r' },
          head: 'feat',
          base: 'main',
          head_revision: 'abc',
        },
        worktree_path: '/w/t',
        branch: 'feat',
      })
    );
    expect(facts).toEqual({
      pr: {
        repo: { host: 'github.com', path: 'o/r' },
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        base: 'main',
        headRevision: 'abc',
      },
      worktreePath: '/w/t',
      branch: 'feat',
    });
  });
  test('a PR without repo or number reads as none', () => {
    expect(parseDelivery('{"pr":{"number":0},"branch":""}')).toEqual({
      pr: null,
      worktreePath: null,
      branch: null,
    });
    expect(parseDelivery('{"pr":null}').pr).toBeNull();
  });
  test('refuses text that is not a JSON object', () => {
    expect(() => parseDelivery('{')).toThrow(/not valid JSON/);
    expect(() => parseDelivery('[]')).toThrow(/not a JSON object/);
  });
});

test('parseNameStatusZ maps git statuses to the forge vocabulary', () => {
  expect(parseNameStatusZ('M\0a.txt\0A\0b c.txt\0D\0d.txt\0R100\0old.txt\0new.txt\0')).toEqual([
    { path: 'a.txt', status: 'modified', previousPath: null },
    { path: 'b c.txt', status: 'added', previousPath: null },
    { path: 'd.txt', status: 'removed', previousPath: null },
    { path: 'new.txt', status: 'renamed', previousPath: 'old.txt' },
  ]);
  expect(parseNameStatusZ('')).toEqual([]);
});

describe('results template and headline', () => {
  test('one TODO line per case after the comment header', () => {
    const text = renderResultsTemplate('ABC-1', '/s/verify-plan.md', [
      { id: 'UI-1', title: 'a', criterion: '' },
      { id: 'API-1', title: 'b', criterion: '' },
    ]);
    const lines = text.trimEnd().split('\n');
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      'UI-1 | TODO |',
      'API-1 | TODO |',
    ]);
    expect(lines[0]).toContain('/s/verify-plan.md');
  });
  test('a plan with no case leaves only comments', () => {
    const text = renderResultsTemplate('ABC-1', '/p', []);
    expect(
      text
        .trimEnd()
        .split('\n')
        .every(line => line.startsWith('#'))
    ).toBe(true);
  });
  test('the headline tells an empty classification from an empty plan', () => {
    expect(planHeadline(2, 3, { ui: true, api: true })).toBe(
      '5 manual test case(s) planned (UI 2, External API 3).'
    );
    expect(planHeadline(0, 0, { ui: false, api: false })).toContain('neither the UI nor');
    expect(planHeadline(0, 0, { ui: true, api: false })).toContain('found nothing to test');
  });
});

describe('locating the change in git', () => {
  /** A remote with main, and a clone whose origin/HEAD is main. */
  function cloneWithRemote(): { remote: string; clone: string } {
    const root = scratch();
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    gitOrThrow('init', '-q', '-b', 'main', seed);
    gitOrThrow('-C', seed, 'config', 'user.email', 't@example.invalid');
    gitOrThrow('-C', seed, 'config', 'user.name', 't');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    gitOrThrow('-C', seed, 'add', '-A');
    gitOrThrow('-C', seed, 'commit', '-q', '-m', 'init');
    gitOrThrow('clone', '-q', '--bare', seed, remote);
    const clone = join(root, 'clone');
    gitOrThrow('clone', '-q', remote, clone);
    gitOrThrow('-C', clone, 'config', 'user.email', 't@example.invalid');
    gitOrThrow('-C', clone, 'config', 'user.name', 't');
    return { remote, clone };
  }

  function commitOnBranch(clone: string, branch: string): void {
    gitOrThrow('-C', clone, 'checkout', '-q', '-b', branch);
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    gitOrThrow('-C', clone, 'add', '-A');
    gitOrThrow('-C', clone, 'commit', '-q', '-m', 'feature');
  }

  test('the remote default branch resolves through the remote-tracking ref', () => {
    const { clone } = cloneWithRemote();
    expect(remoteDefaultBranch(clone)).toBe('main');
    expect(resolveBaseRef(clone, ['', 'nope', 'main'])).toBe('refs/remotes/origin/main');
    expect(resolveBaseRef(clone, ['nope'])).toBeNull();
  });

  test('without delivery: the working tree, uncommitted and untracked files included', () => {
    const { clone } = cloneWithRemote();
    commitOnBranch(clone, 'feat');
    writeFileSync(join(clone, 'a.txt'), 'changed\n');
    writeFileSync(join(clone, 'new.txt'), 'n\n');
    const location = locateChange(clone, null);
    expect(location).toEqual({ checkout: clone, ref: null, notes: [] });
    const change = gitChangedFiles(location, 'refs/remotes/origin/main');
    expect([...change.files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', status: 'modified', previousPath: null },
      { path: 'b.txt', status: 'added', previousPath: null },
      { path: 'new.txt', status: 'added', previousPath: null },
    ]);
  });

  test('a delivered branch that is not checked out is read from its commit', () => {
    const { clone } = cloneWithRemote();
    commitOnBranch(clone, 'feat');
    gitOrThrow('-C', clone, 'checkout', '-q', 'main');
    writeFileSync(join(clone, 'stray.txt'), 's\n');
    const location = locateChange(clone, { pr: null, worktreePath: null, branch: 'feat' });
    expect(location.ref).toBe('feat');
    expect(location.notes[0]).toContain('not on the delivered branch feat');
    expect(gitChangedFiles(location, 'refs/heads/main').files).toEqual([
      { path: 'b.txt', status: 'added', previousPath: null },
    ]);
  });

  test('the delivery worktree wins when it still exists, and a vanished one is noted', () => {
    const { clone } = cloneWithRemote();
    const worktree = join(scratch(), 'wt');
    gitOrThrow('-C', clone, 'worktree', 'add', '-q', '-b', 'feat', worktree);
    expect(locateChange(clone, { pr: null, worktreePath: worktree, branch: 'feat' })).toEqual({
      checkout: worktree,
      ref: null,
      notes: [],
    });
    const gone = locateChange(clone, {
      pr: null,
      worktreePath: '/nonexistent/wt',
      branch: 'missing',
    });
    expect(gone.checkout).toBe(clone);
    expect(gone.ref).toBeNull();
    expect(gone.notes).toHaveLength(2);
  });
});

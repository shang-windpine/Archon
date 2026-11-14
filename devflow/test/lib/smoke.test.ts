import { describe, expect, test } from 'bun:test';
import {
  buildSummary,
  compareVersions,
  helpOffersCopilotReviewer,
  parseVersion,
  type ProbeReport,
  redactUrl,
  renderTable,
  type SummaryFacts,
} from '../../pack/devflow/.shared/lib/smoke.ts';

describe('parseVersion', () => {
  test('reads the first dotted version in a banner', () => {
    expect(parseVersion('gh version 2.104.0 (2026-11-12)\nhttps://x/v2.104.0')).toEqual([
      2, 104, 0,
    ]);
    expect(parseVersion('openjdk version "25.0.3" 2026-04-21')).toEqual([25, 0, 3]);
    expect(parseVersion('Version=1.6')).toEqual([1, 6, 0]);
  });

  test('is undefined without a version', () => {
    expect(parseVersion('command not found')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  test('orders numerically, not lexically', () => {
    expect(compareVersions([2, 104, 0], [2, 88, 0])).toBeGreaterThan(0);
    expect(compareVersions([2, 87, 9], [2, 88, 0])).toBeLessThan(0);
    expect(compareVersions([1, 4, 2], [1, 4, 2])).toBe(0);
  });
});

describe('helpOffersCopilotReviewer', () => {
  test('needs @copilot on the --add-reviewer line', () => {
    const current =
      '      --add-reviewer login   Add or re-request reviewers by their login. Use "@copilot" to request review from Copilot.';
    expect(helpOffersCopilotReviewer(`Flags:\n${current}\n`)).toBe(true);
    const old =
      '      --add-reviewer login   Add reviewers by their login.\n      --add-assignee login  "@copilot"';
    expect(helpOffersCopilotReviewer(old)).toBe(false);
  });
});

describe('redactUrl', () => {
  test('drops userinfo from URL forms and leaves scp-like and paths alone', () => {
    expect(redactUrl('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git'
    );
    expect(redactUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(redactUrl('/tmp/remote.git')).toBe('/tmp/remote.git');
  });
});

function facts(overrides: Partial<SummaryFacts>): SummaryFacts {
  return {
    self: 'summary',
    nodes: [],
    probes: [],
    ai: [],
    forge: [],
    failureHints: {},
    ...overrides,
  };
}

const tools: ProbeReport = {
  probe: 'tools',
  checks: [
    { name: 'git', status: 'pass', detail: '2.49.0', hint: '' },
    { name: 'jira-cli', status: 'warn', detail: 'missing', hint: 'install it' },
    { name: 'jira fetch', status: 'skip', detail: 'no key', hint: '' },
  ],
};

describe('buildSummary', () => {
  test('warnings and skips do not fail the smoke', () => {
    const summary = buildSummary(
      facts({
        nodes: [
          { node_id: 'tools', state: 'completed' },
          { node_id: 'ai-main', state: 'completed' },
          { node_id: 'summary', state: 'running' },
        ],
        probes: [{ node: 'tools', value: tools }],
        ai: [{ node: 'ai-main', value: { ok: true } }],
      })
    );
    expect(summary.ok).toBe(true);
    expect(summary.rows.map(row => row.name)).toEqual(['git', 'jira-cli', 'jira fetch', 'ai-main']);
    expect(summary.warnings.map(row => row.name)).toEqual(['jira-cli']);
  });

  test('a failed node fails with its error and the hint for that node', () => {
    const summary = buildSummary(
      facts({
        nodes: [{ node_id: 'forge-check', state: 'failed', error: 'refused:\n  no plugin' }],
        failureHints: { 'forge-check': 'install the plugin' },
      })
    );
    expect(summary.ok).toBe(false);
    expect(summary.failures).toEqual([
      {
        node: 'forge-check',
        name: 'forge-check',
        status: 'fail',
        detail: 'refused: no plugin',
        hint: 'install the plugin',
      },
    ]);
  });

  test('a fail check inside a completed probe fails the smoke', () => {
    const resolve: ProbeReport = {
      probe: 'resolve',
      checks: [{ name: 'forge resolve', status: 'fail', detail: 'not GitHub', hint: 'clone it' }],
    };
    const summary = buildSummary(
      facts({
        nodes: [{ node_id: 'resolve', state: 'completed' }],
        probes: [{ node: 'resolve', value: resolve }],
      })
    );
    expect(summary.ok).toBe(false);
    expect(summary.failures[0]?.name).toBe('forge resolve');
  });

  test('an AI answer of ok:false fails; a skipped node and an unread output warn', () => {
    const summary = buildSummary(
      facts({
        nodes: [
          { node_id: 'ai-ci', state: 'completed' },
          { node_id: 'jira', state: 'skipped', reason: 'when_condition' },
          { node_id: 'mystery', state: 'completed' },
        ],
        ai: [{ node: 'ai-ci', value: { ok: false } }],
      })
    );
    expect(summary.rows.map(row => [row.name, row.status])).toEqual([
      ['ai-ci', 'fail'],
      ['jira', 'warn'],
      ['mystery', 'warn'],
    ]);
  });

  test('a completed forge check reports the repository and credential source', () => {
    const summary = buildSummary(
      facts({
        nodes: [{ node_id: 'forge-check', state: 'completed' }],
        forge: [
          {
            node: 'forge-check',
            value: {
              repo: { host: 'github.com', path: 'o/r' },
              plugin: { name: 'github', version: '1' },
              credentialSource: 'gh auth token',
            },
          },
        ],
      })
    );
    expect(summary.rows[0]?.status).toBe('pass');
    expect(summary.rows[0]?.detail).toContain(
      'github.com/o/r via github@1, credential from gh auth token'
    );
  });
});

describe('renderTable', () => {
  test('prints a fix line only for rows that did not pass', () => {
    const summary = buildSummary(
      facts({
        nodes: [{ node_id: 'tools', state: 'completed' }],
        probes: [{ node: 'tools', value: tools }],
      })
    );
    const table = renderTable(summary);
    expect(table).toContain('jira-cli    WARN    missing');
    expect(table).toContain('fix: install it');
    expect(table.match(/fix:/g)?.length).toBe(1);
    expect(table.trimEnd().endsWith('smoke OK (1 warning(s))')).toBe(true);
  });
});

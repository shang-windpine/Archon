/**
 * devflow-smoke's pure logic: the probe report every check script emits, version
 * comparison, and the final table. Pure of `archon:script` so it is unit-tested
 * without the script preload.
 */

export type ProbeStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** One line of the smoke table. `hint` is the operator's next step; empty on a pass. */
export interface ProbeCheck {
  readonly name: string;
  readonly status: ProbeStatus;
  readonly detail: string;
  readonly hint: string;
}

/**
 * What a probe script emits (its YAML `output_format`, output type `smoke-probe`).
 * A probe never fails its node for a failed check: it reports `fail` here, so the
 * summary can read every probe through one typed binding.
 */
export interface ProbeReport {
  readonly probe: string;
  readonly checks: readonly ProbeCheck[];
}

export type Version = readonly [number, number, number];

/**
 * The first `major.minor[.patch]` in a tool's version banner (`gh version 2.104.0 (...)`,
 * `openjdk version "25.0.3"`). The number is a machine token inside the banner; it only
 * enriches a report and decides pass/warn there, never a retry or fallback.
 */
export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function formatVersion(version: Version): string {
  return version.join('.');
}

/**
 * Whether `gh pr edit --help` documents `@copilot` for `--add-reviewer` (gh >= 2.88).
 * Help text is vendor prose: this decides only a smoke-report line, never how the pack
 * requests a review, which is the operator's `copilot_request_cmd`.
 */
export function helpOffersCopilotReviewer(help: string): boolean {
  return help
    .split('\n')
    .some(line => line.includes('--add-reviewer') && line.includes('@copilot'));
}

/** A remote URL with any `user:password@` removed, so a token in a URL is never printed. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** The slice of `outcomes()` the summary reads. */
export interface NodeOutcome {
  readonly node_id: string;
  readonly state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  readonly error?: string;
  readonly reason?: string;
}

/** One record of a `with: {x: {outputs: <type>}}` binding. */
export interface TypedRecord<T> {
  readonly node: string;
  readonly value: T;
}

/** The forge-check script's output (`.shared/scripts/forge-check.ts`), as far as the table reads it. */
export interface ForgeAccessValue {
  readonly repo: { readonly host: string; readonly path: string };
  readonly plugin: { readonly name: string; readonly version: string };
  readonly credentialSource: string | null;
}

export interface SummaryRow extends ProbeCheck {
  readonly node: string;
}

export interface SmokeSummary {
  readonly ok: boolean;
  readonly rows: readonly SummaryRow[];
  readonly failures: readonly SummaryRow[];
  readonly warnings: readonly SummaryRow[];
}

export interface SummaryFacts {
  /** The summary node's own id, left out of the table. */
  readonly self: string;
  readonly nodes: readonly NodeOutcome[];
  readonly probes: readonly TypedRecord<ProbeReport>[];
  readonly ai: readonly TypedRecord<{ readonly ok: boolean }>[];
  readonly forge: readonly TypedRecord<ForgeAccessValue>[];
  /** The operator's next step when a node failed outright, by node id. */
  readonly failureHints: Readonly<Record<string, string>>;
}

const ONE_LINE_MAX = 300;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ONE_LINE_MAX ? `${flat.slice(0, ONE_LINE_MAX - 1)}…` : flat;
}

/**
 * Every node's result as table rows, in the order the engine listed the nodes. A node
 * that failed is a `fail` row carrying the engine's error; a node skipped by the engine
 * is a `warn` row; a completed node contributes its typed output. `ok` is false exactly
 * when some row failed: warnings never fail the smoke.
 */
export function buildSummary(facts: SummaryFacts): SmokeSummary {
  const rows: SummaryRow[] = [];
  const probes = new Map(facts.probes.map(record => [record.node, record.value]));
  const ai = new Map(facts.ai.map(record => [record.node, record.value]));
  const forge = new Map(facts.forge.map(record => [record.node, record.value]));
  for (const node of facts.nodes) {
    const id = node.node_id;
    if (id === facts.self) continue;
    if (node.state === 'failed') {
      rows.push({
        node: id,
        name: id,
        status: 'fail',
        detail: oneLine(node.error ?? 'the node failed without an error message'),
        hint:
          facts.failureHints[id] ??
          'Inspect the node with `archon workflow get <run-id> --verbose`.',
      });
      continue;
    }
    if (node.state !== 'completed') {
      rows.push({
        node: id,
        name: id,
        status: 'warn',
        detail: `node ${node.state}${node.reason === undefined ? '' : ` (${node.reason})`}`,
        hint: 'A probe that did not run proves nothing; rerun the smoke.',
      });
      continue;
    }
    const report = probes.get(id);
    if (report !== undefined) {
      for (const check of report.checks) rows.push({ node: id, ...check });
      continue;
    }
    const answer = ai.get(id);
    if (answer !== undefined) {
      rows.push(
        answer.ok
          ? {
              node: id,
              name: id,
              status: 'pass',
              detail: 'alias answered with schema-valid {ok:true}',
              hint: '',
            }
          : {
              node: id,
              name: id,
              status: 'fail',
              detail: 'the model answered ok:false',
              hint: 'The model behind this alias does not follow structured output; pick another model.',
            }
      );
      continue;
    }
    const access = forge.get(id);
    if (access !== undefined) {
      rows.push({
        node: id,
        name: id,
        status: 'pass',
        detail:
          `${access.repo.host}/${access.repo.path} via ${access.plugin.name}@${access.plugin.version}, ` +
          `credential from ${access.credentialSource ?? 'unknown source'}, read verified`,
        hint: '',
      });
      continue;
    }
    rows.push({
      node: id,
      name: id,
      status: 'warn',
      detail: 'completed without a recorded output',
      hint: 'The summary could not read this node; inspect it with `archon workflow get <run-id> --verbose`.',
    });
  }
  const failures = rows.filter(row => row.status === 'fail');
  const warnings = rows.filter(row => row.status === 'warn');
  return { ok: failures.length === 0, rows, failures, warnings };
}

const STATUS_LABEL: Readonly<Record<ProbeStatus, string>> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

/** A fixed-width text table, one row per check, hints on their own indented line. */
export function renderTable(summary: SmokeSummary): string {
  const width = Math.max(5, ...summary.rows.map(row => row.name.length));
  const lines = [`${'CHECK'.padEnd(width)}  STATUS  DETAIL`];
  for (const row of summary.rows) {
    lines.push(`${row.name.padEnd(width)}  ${STATUS_LABEL[row.status].padEnd(6)}  ${row.detail}`);
    if (row.status !== 'pass' && row.hint !== '')
      lines.push(`${''.padEnd(width)}  ${''.padEnd(6)}  fix: ${row.hint}`);
  }
  lines.push(
    '',
    summary.ok
      ? `smoke OK (${summary.warnings.length} warning(s))`
      : `smoke FAILED: ${summary.failures.length} failure(s), ${summary.warnings.length} warning(s)`
  );
  return lines.join('\n');
}

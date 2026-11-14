/**
 * `script: summary` — the smoke's verdict. Joins every probe past failures
 * (`trigger_rule: all_done`): a node that failed is read from the engine's node
 * outcomes, never through a binding (a failed producer fails a binding), and a node
 * that completed is read through the typed bindings. Prints the table on stderr,
 * writes it to `$ARTIFACTS_DIR/smoke-report.txt`, and emits `{ok, failures, warnings, report_path}`.
 */

import { writeFileSync } from 'node:fs';
import { emit, input, outcomes } from 'archon:script';
import { artifactPath } from '../../.shared/lib/devflow.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';
import {
  buildSummary,
  type ForgeAccessValue,
  type ProbeReport,
  renderTable,
  type SummaryRow,
  type TypedRecord,
} from '../../.shared/lib/smoke.ts';

/**
 * The run's frozen alias map is not visible to a script, so the hint names the alias
 * and where its provider/model is shown; the provider's error above names the ref it
 * tried (Pi: "Pi model not found: provider=... model=...").
 */
const ALIAS_HINT = (alias: string): string =>
  `${alias} failed. \`archon ai alias list\` shows the provider/model it resolves to. If the error names a model ` +
  'that does not exist, fix the ref (Pi: `pi --list-models <model-id>` must list it; Claude: opus, sonnet, haiku or a full id) ' +
  'with `archon ai alias set`. If the alias is undefined, define it under aliases: in ~/.archon/config.yaml ' +
  '(or $ARCHON_HOME/config.yaml). Otherwise log in to its provider (`claude` /login; `pi /login` or the backend ' +
  'key in ~/.archon/.env for Pi); devflow/scripts/doctor.sh checks aliases, logins and Pi model refs.';

/** Next steps for a node that failed outright, by the node ids in devflow-smoke.yaml. */
const FAILURE_HINTS: Readonly<Record<string, string>> = {
  'forge-check':
    'The forge plugin cannot act for this checkout: run it in a clone whose origin is the GitHub repository, then `archon forge check` and `gh auth login`.',
  'ai-main': ALIAS_HINT('@devflow-main'),
  'ai-fast': ALIAS_HINT('@devflow-fast'),
  'ai-ci': ALIAS_HINT('@devflow-ci'),
  'ai-cross': ALIAS_HINT('@devflow-cross'),
};

function records<T>(name: string, bound: string): readonly TypedRecord<T>[] {
  const value = nullableJson(bound);
  if (!Array.isArray(value)) throw new Error(`binding ${name} is not an array of typed outputs`);
  return value as TypedRecord<T>[];
}

const summary = buildSummary({
  self: 'summary',
  nodes: outcomes().nodes,
  probes: records<ProbeReport>('probes', input('probes')),
  ai: records<{ ok: boolean }>('ai', input('ai')),
  forge: records<ForgeAccessValue>('forge', input('forge')),
  failureHints: FAILURE_HINTS,
});

const table = renderTable(summary);
const reportPath = artifactPath('smoke-report.txt');
writeFileSync(reportPath, `${table}\n`);
console.error(table);

const brief = (row: SummaryRow): { check: string; detail: string; hint: string } => ({
  check: row.name,
  detail: row.detail,
  hint: row.hint,
});

emit({
  ok: summary.ok,
  failures: summary.failures.map(brief),
  warnings: summary.warnings.map(brief),
  report_path: reportPath,
});

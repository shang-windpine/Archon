/**
 * `script: jira` — one `jira_view_cmd` fetch for the `key` input, proving the Jira tool
 * and its credentials work. Read-only on Jira's side. The issue text is untrusted and
 * may be personal data, so only its size is reported; the full output stays in the
 * run's artifacts for the operator.
 */

import { emit, input } from 'archon:script';
import { artifactPath, renderCommand, runCommand, validateKey } from '../../.shared/lib/devflow.ts';
import type { ProbeCheck } from '../../.shared/lib/smoke.ts';

/** Below the node's `timeout:`, so the command's process group is killed before the node is. */
const FETCH_TIMEOUT_MS = 90_000;

async function probe(): Promise<ProbeCheck> {
  const key = input('key');
  const template = input('jira_view_cmd');
  if (key === '') {
    return {
      name: 'jira fetch',
      status: 'skip',
      detail: 'no key input; pass --input key=<KEY> to fetch one issue',
      hint: '',
    };
  }
  if (template === '') {
    return {
      name: 'jira fetch',
      status: 'skip',
      detail: 'jira_view_cmd is empty; Jira is not used',
      hint: '',
    };
  }
  let command: string;
  try {
    command = renderCommand(template, { key: validateKey(key) });
  } catch (error) {
    return {
      name: 'jira fetch',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Fix the key, or jira_view_cmd in .archon/packs/devflow.yaml ({key} is its only token).',
    };
  }
  const logPath = artifactPath('smoke', `jira-${key}.log`);
  const result = await runCommand(command, {
    cwd: process.cwd(),
    timeoutMs: FETCH_TIMEOUT_MS,
    logPath,
  });
  const bytes = Bun.file(logPath).size;
  if (result.code === 0 && bytes > 0) {
    return {
      name: 'jira fetch',
      status: 'pass',
      detail: `${key}: ${bytes} bytes (output in ${logPath})`,
      hint: '',
    };
  }
  return {
    name: 'jira fetch',
    status: 'fail',
    detail: result.timedOut
      ? `${key}: jira_view_cmd timed out after ${FETCH_TIMEOUT_MS / 1000}s (output in ${logPath})`
      : `${key}: jira_view_cmd exited ${result.code ?? 'on a signal'} with ${bytes} bytes (output in ${logPath})`,
    hint: 'Run the command by hand; for jira-cli check `jira me` and `jira init`. Credentials belong to jira-cli, not Archon.',
  };
}

emit({ probe: 'jira', checks: [await probe()] });

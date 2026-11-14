/**
 * Ask Copilot to review the pushed head, once per head, when `copilot_mode` is `request`.
 *
 * There is no forge operation for a review request, so this runs the operator's
 * `copilot_request_cmd` with `{number}` and `{repo}` filled in as
 * shell-quoted words. A failing request is not a node failure: the error is reported
 * and await stops waiting for a review that will not come, which asks a person. The
 * heads already requested are kept in `$ARTIFACTS_DIR/copilot-requests.json`; a failed
 * request is not recorded, so the next round on the same head tries again.
 *
 * Bound inputs: repo (preflight), pr_number and head_revision (publish).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, input, refuse } from 'archon:script';
import { artifactPath, parseEnum, renderCommand, runCommand } from '../../.shared/lib/devflow.ts';
import { COPILOT_MODES } from '../../.shared/lib/deliver-settings.ts';
import type { Repo } from '../../.shared/lib/identity.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';

const COMMAND_TIMEOUT_MS = 120_000;

interface RequestRecord {
  readonly head: string;
  readonly at: string;
}

try {
  const head = input('head_revision');
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`head_revision is not a commit SHA: ${JSON.stringify(head)}`);
  const mode = parseEnum(input('copilot_mode'), COPILOT_MODES, 'request', 'copilot_mode');
  if (mode !== 'request') {
    emit({ requested: false, head_revision: head, error: '' });
  } else {
    const recordPath = artifactPath('copilot-requests.json');
    const records = existsSync(recordPath)
      ? (JSON.parse(readFileSync(recordPath, 'utf8')) as RequestRecord[])
      : [];
    if (records.some(record => record.head === head)) {
      emit({ requested: false, head_revision: head, error: '' });
    } else {
      const repo = nullableJson(input('repo')) as Repo;
      const number = input('pr_number');
      const command = renderCommand(input('copilot_request_cmd'), {
        number,
        // gh's --repo takes OWNER/REPO for github.com and HOST/OWNER/REPO elsewhere.
        repo: repo.host === 'github.com' ? repo.path : `${repo.host}/${repo.path}`,
      });
      const logPath = artifactPath('copilot-request.log');
      const result = await runCommand(command, {
        cwd: process.cwd(),
        timeoutMs: COMMAND_TIMEOUT_MS,
        logPath,
      });
      if (result.code === 0) {
        records.push({ head, at: new Date().toISOString() });
        writeFileSync(recordPath, `${JSON.stringify(records, null, 2)}\n`);
        emit({ requested: true, head_revision: head, error: '' });
      } else {
        const how = result.timedOut ? 'timed out' : `exited ${String(result.code)}`;
        emit({
          requested: false,
          head_revision: head,
          error: `copilot_request_cmd ${how}; see ${logPath}`,
        });
      }
    }
  }
} catch (error) {
  refuse(`request-review: ${error instanceof Error ? error.message : String(error)}`);
}

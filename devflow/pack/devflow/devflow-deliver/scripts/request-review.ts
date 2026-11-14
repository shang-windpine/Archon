/**
 * Ask Copilot to review the pushed head, once per head, when `copilot_mode` is `request`
 * and no person has answered an escalation with `skip-copilot` (the
 * `$ARTIFACTS_DIR/copilot-skipped` marker), which makes the mode `off` for the run.
 *
 * There is no forge operation for a review request, so this runs the operator's
 * `copilot_request_cmd` with the `copilotCommandVars` tokens filled in as shell-quoted
 * words. A failing request is not a node failure: the error is reported and await stops
 * waiting for a review that will not come, which asks a person. The heads already
 * requested are kept in `$ARTIFACTS_DIR/copilot-requests.json`; a failed request is not
 * recorded, so the next round on the same head tries again.
 *
 * `gh` can exit 0 without recording any request (an account without Copilot code
 * review), so when `copilot_confirm_cmd` is set it runs before and after the request
 * and the request counts only per `confirmCopilotRequest`: a new Copilot request line,
 * or a Copilot review of the head. A confirm command that itself fails does not block:
 * nothing was learned, so the request counts with a notice and await's deadline bounds
 * the wait.
 *
 * Bound inputs: repo (preflight), pr_number and head_revision (publish).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emit, forge, input, notice, refuse } from 'archon:script';
import {
  type ConfirmRun,
  confirmCopilotRequest,
  copilotCommandVars,
  copilotReviewForHead,
  countCopilotLogins,
  normalizeLogins,
} from '../../.shared/lib/copilot.ts';
import { COPILOT_MODES, COPILOT_SKIPPED_ARTIFACT } from '../../.shared/lib/deliver-settings.ts';
import {
  artifactPath,
  parseEnum,
  parseList,
  renderCommand,
  runCommand,
} from '../../.shared/lib/devflow.ts';
import type { Repo } from '../../.shared/lib/identity.ts';
import { nullableJson } from '../../.shared/lib/inputs.ts';

const REQUEST_TIMEOUT_MS = 120_000;
const CONFIRM_TIMEOUT_MS = 60_000;
/** GitHub records the request's event a second or two after the request returns. */
const CONFIRM_DELAYS_MS = [2_000, 4_000, 8_000];
/** The host's bound on one notice line. */
const NOTICE_CHARS = 300;

interface RequestRecord {
  readonly head: string;
  readonly at: string;
}

/** A warning that does not stop the round: in the node log, and on the attention stream. */
function warn(text: string): void {
  console.error(`request-review: ${text}`);
  try {
    notice(`devflow-deliver: ${text}`.slice(0, NOTICE_CHARS), { devflow: 'copilot-confirm' });
  } catch (error) {
    console.error(
      `request-review: the notice was not posted: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** One run of the confirm command; only its stdout is read, apart from its stderr. */
async function runConfirm(command: string): Promise<ConfirmRun> {
  const logPath = artifactPath('copilot-confirm.log');
  const stdoutPath = artifactPath('copilot-confirm.out');
  const result = await runCommand(command, {
    cwd: process.cwd(),
    timeoutMs: CONFIRM_TIMEOUT_MS,
    logPath,
    stdoutPath,
  });
  if (result.code === 0) return { ok: true, output: readFileSync(stdoutPath, 'utf8') };
  const how = result.timedOut ? 'timed out' : `exited ${String(result.code)}`;
  return { ok: false, detail: `copilot_confirm_cmd ${how}; see ${logPath}` };
}

function refusedError(detail: string): string {
  return (
    `Copilot's review request was not recorded on the pull request (${detail}; see ${artifactPath('copilot-confirm.out')}). ` +
    'The requesting gh account may lack Copilot code review, the repository or organization may ' +
    'not allow it, copilot_request_cmd may not reach GitHub’s reviewer request, or a request still ' +
    'pending from an earlier head was not recorded again. Answer the escalation with ' +
    'skip-copilot, or set copilot_mode to off (or auto if a ruleset requests reviews).'
  );
}

try {
  const head = input('head_revision');
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`head_revision is not a commit SHA: ${JSON.stringify(head)}`);
  const mode = parseEnum(input('copilot_mode'), COPILOT_MODES, 'request', 'copilot_mode');
  if (mode !== 'request' || existsSync(artifactPath(COPILOT_SKIPPED_ARTIFACT))) {
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
      const vars = copilotCommandVars(repo, number);
      const command = renderCommand(input('copilot_request_cmd'), vars);
      // Rendered before the request runs, so a typo in it refuses before anything is asked.
      const confirmTemplate = input('copilot_confirm_cmd').trim();
      const confirm = confirmTemplate === '' ? '' : renderCommand(confirmTemplate, vars);
      const logins = normalizeLogins(parseList(input('copilot_logins')));
      let before: number | undefined;
      if (confirm !== '') {
        const run = await runConfirm(confirm);
        if (run.ok) before = countCopilotLogins(run.output, logins);
        else warn(`${run.detail} before the request, so the request cannot be confirmed`);
      }
      const logPath = artifactPath('copilot-request.log');
      const result = await runCommand(command, {
        cwd: process.cwd(),
        timeoutMs: REQUEST_TIMEOUT_MS,
        logPath,
      });
      if (result.code === 0) {
        let error = '';
        if (before !== undefined) {
          const ref = { repo, number: Number(number) };
          const confirmation = await confirmCopilotRequest({
            before,
            logins,
            delaysMs: CONFIRM_DELAYS_MS,
            runConfirm: () => runConfirm(confirm),
            headReviewed: () =>
              copilotReviewForHead(forge('pr.reviews', { ref }).items, head, logins) !== undefined,
            sleep: ms => Bun.sleep(ms),
          });
          if (confirmation.kind === 'unknown')
            warn(`${confirmation.detail}, so the Copilot review request counts as made`);
          else if (confirmation.kind === 'refused') error = refusedError(confirmation.detail);
        }
        if (error === '') {
          records.push({ head, at: new Date().toISOString() });
          writeFileSync(recordPath, `${JSON.stringify(records, null, 2)}\n`);
        }
        emit({ requested: error === '', head_revision: head, error });
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

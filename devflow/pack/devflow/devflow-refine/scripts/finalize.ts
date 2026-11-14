/**
 * Publish the approved draft as `$STATE_DIR/devflow/<KEY>/requirement.md` (DESIGN §5
 * step 6), the file devflow-deliver and devflow-verify read.
 *
 * The requirement it replaces moves to `requirement.history/<run-id>.md`, named by the run
 * that superseded it. A note a person gave when finalizing is appended verbatim to the
 * decision log, the template's last section. When `jira_comment_cmd` is set, the
 * requirement is posted as a Jira comment; a failure there is only a warning, because the
 * requirement is already published.
 *
 * Bound inputs: INPUTS_GATE_NOTE (the round gate's finalize text, from `status`) and
 * INPUTS_APPROVAL_NOTE (the final gate's text; '' when it was skipped).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emit, input, refuse, runId } from 'archon:script';
import {
  artifactPath,
  renderCommand,
  runCommand,
  stateDir,
  statePath,
  validateKey,
} from '../../.shared/lib/devflow.ts';
import { finalizationLines } from '../../.shared/lib/refine.ts';

const JIRA_TIMEOUT_MS = 120_000;

async function commentOnJira(
  key: string,
  requirement: string
): Promise<'posted' | 'failed' | 'skipped'> {
  const template = input('jira_comment_cmd').trim();
  if (template === '') return 'skipped';
  const bodyPath = artifactPath('jira-comment.md');
  writeFileSync(
    bodyPath,
    `devflow: the finalized requirement for ${key} (refine run ${runId()}).\n\n${requirement}`
  );
  const logPath = artifactPath('jira-comment.log');
  const result = await runCommand(renderCommand(template, { key, file: bodyPath }), {
    cwd: process.cwd(),
    timeoutMs: JIRA_TIMEOUT_MS,
    logPath,
  });
  if (result.code === 0) return 'posted';
  const why = result.timedOut ? 'timed out' : `exited ${String(result.code)}`;
  console.error(`finalize warning: jira_comment_cmd ${why}; its output is in ${logPath}`);
  return 'failed';
}

try {
  const key = validateKey(input('key'));
  const draftPath = artifactPath('requirement.md');
  if (!existsSync(draftPath)) throw new Error(`no draft at ${draftPath}`);
  const today = new Date().toISOString().slice(0, 10);
  const draft = readFileSync(draftPath, 'utf8');
  const requirement =
    (draft.endsWith('\n') ? draft : `${draft}\n`) +
    finalizationLines(today, runId(), [
      { source: 'devflow-refine round gate', text: input('gate_note') },
      { source: 'devflow-refine final gate', text: input('approval_note') },
    ]);

  const requirementPath = statePath(key, 'requirement.md');
  const supersededPath = join(stateDir(key), 'requirement.history', `${runId()}.md`);
  // A re-executed finalize of this same run already moved the superseded version; the
  // requirement.md it finds now is this run's own and is simply overwritten.
  if (existsSync(requirementPath) && !existsSync(supersededPath)) {
    mkdirSync(dirname(supersededPath), { recursive: true });
    renameSync(requirementPath, supersededPath);
  }
  const historyPath = existsSync(supersededPath) ? supersededPath : '';
  writeFileSync(requirementPath, requirement);
  writeFileSync(artifactPath('requirement.final.md'), requirement);

  let jiraComment: 'posted' | 'failed' | 'skipped';
  try {
    jiraComment = await commentOnJira(key, requirement);
  } catch (error) {
    console.error(
      `finalize warning: jira_comment_cmd: ${error instanceof Error ? error.message : String(error)}`
    );
    jiraComment = 'failed';
  }
  emit({ requirement_path: requirementPath, history_path: historyPath, jira_comment: jiraComment });
} catch (error) {
  refuse(`devflow-refine finalize: ${error instanceof Error ? error.message : String(error)}`);
}

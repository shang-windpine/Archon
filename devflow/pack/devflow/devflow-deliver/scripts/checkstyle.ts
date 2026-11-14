/**
 * The round's local gate before a push: `checkstyle_cmd`, then `local_verify_cmd` when
 * it is set. A failing command is a result, not a node failure (`ok: false`), so the
 * fix-style loop can run; publish re-checks and refuses on what is still red.
 *
 * Both commands' combined output goes to `$ARTIFACTS_DIR/checkstyle.log` and
 * `$ARTIFACTS_DIR/local-verify.log`. Each command is killed after 20 minutes; the
 * node's timeout covers both.
 */

import { emit, input, refuse } from 'archon:script';
import { artifactPath, runCommand } from '../../.shared/lib/devflow.ts';

const COMMAND_TIMEOUT_MS = 20 * 60_000;

try {
  const style = input('checkstyle_cmd').trim();
  const verify = input('local_verify_cmd').trim();
  if (style === '') throw new Error('checkstyle_cmd is empty');
  const styleLog = artifactPath('checkstyle.log');
  const styleRun = await runCommand(style, {
    cwd: process.cwd(),
    timeoutMs: COMMAND_TIMEOUT_MS,
    logPath: styleLog,
  });
  const styleOk = styleRun.code === 0;
  let verifyOk = true;
  const verifyLog = artifactPath('local-verify.log');
  if (verify !== '') {
    const verifyRun = await runCommand(verify, {
      cwd: process.cwd(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      logPath: verifyLog,
    });
    verifyOk = verifyRun.code === 0;
  }
  emit({
    ok: styleOk && verifyOk,
    style_ok: styleOk,
    verify_ok: verifyOk,
    log_path: styleLog,
    verify_log_path: verify === '' ? '' : verifyLog,
  });
} catch (error) {
  refuse(`checkstyle: ${error instanceof Error ? error.message : String(error)}`);
}

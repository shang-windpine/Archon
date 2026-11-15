/**
 * `script: tools` — the local tools devflow calls, with their versions, and the
 * devflow-deliver settings. Read-only: every command here only prints its version or
 * help. A missing tool the pack needs for every delivery fails; one a setting may route
 * around is a warning. The settings row runs the same parser as deliver's preflight, so
 * a value preflight would refuse (a wait over its bound, a template with an unknown
 * token) fails here first; `archon validate workflows` checks only that each is text.
 * `gh auth` is checked per host by the resolve probe, which knows the repository's host.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emit, input } from 'archon:script';
import {
  compareVersions,
  formatVersion,
  helpOffersCopilotReviewer,
  type ProbeCheck,
  parseVersion,
  type Version,
} from '../../.shared/lib/smoke.ts';
import { parseDeliverSettings } from '../../.shared/lib/deliver-settings.ts';

/** `gh pr edit --add-reviewer @copilot` first shipped in gh 2.88. */
const GH_COPILOT_MIN: Version = [2, 88, 0];
/** devflow-deliver's await runs `git merge-tree --write-tree`, new in git 2.38. */
const GIT_MIN: Version = [2, 38, 0];
const COMMAND_TIMEOUT_MS = 30_000;

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

/** Runs a tool already found on PATH; stdout and stderr together, since `java -version` prints to stderr. */
function run(argv: readonly string[]): Ran {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    // A tool found on PATH that cannot be spawned directly (a Windows `.cmd` shim such as
    // mvn.cmd) is one row's failure, not the whole probe's.
    return { code: null, output: error instanceof Error ? error.message : String(error) };
  }
  return {
    code: result.exitCode,
    output: `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
  };
}

function check(name: string, status: ProbeCheck['status'], detail: string, hint = ''): ProbeCheck {
  return { name, status, detail, hint };
}

function versionDetail(path: string, output: string): string {
  const version = parseVersion(output);
  return `${version === undefined ? 'version unknown' : formatVersion(version)} (${path})`;
}

const checks: ProbeCheck[] = [];
const copilotMode = input('copilot_mode');
const copilotRequestCmd = input('copilot_request_cmd');
const jiraViewCmd = input('jira_view_cmd');
const needsCopilotFlag = copilotMode === 'request' && copilotRequestCmd.includes('@copilot');

try {
  const settings = parseDeliverSettings({
    checkstyle_cmd: input('checkstyle_cmd'),
    local_verify_cmd: input('local_verify_cmd'),
    copilot_mode: copilotMode,
    copilot_request_cmd: copilotRequestCmd,
    copilot_confirm_cmd: input('copilot_confirm_cmd'),
    copilot_logins: input('copilot_logins'),
    poll_interval_sec: input('poll_interval_sec'),
    copilot_wait_min: input('copilot_wait_min'),
    ci_wait_min: input('ci_wait_min'),
    required_checks: input('required_checks'),
    allow_skipped_checks: input('allow_skipped_checks'),
  });
  checks.push(
    check(
      'deliver settings',
      'pass',
      `copilot_mode=${settings.copilotMode}, poll ${String(settings.pollIntervalSec)}s, ` +
        `Copilot wait ${String(settings.copilotWaitMin)} min, CI wait ${String(settings.ciWaitMin)} min`
    )
  );
} catch (error) {
  checks.push(
    check(
      'deliver settings',
      'fail',
      error instanceof Error ? error.message : String(error),
      'Fix the setting in .archon/packs/devflow.yaml (or the --input override); devflow-deliver’s preflight refuses the same value.'
    )
  );
}

const gitPath = Bun.which('git');
if (gitPath === null) {
  checks.push(check('git', 'fail', 'not on PATH', 'Install git 2.38 or newer.'));
} else {
  const banner = run([gitPath, '--version']).output;
  const version = parseVersion(banner);
  const tooOld = version !== undefined && compareVersions(version, GIT_MIN) < 0;
  checks.push(
    check(
      'git',
      tooOld ? 'fail' : version === undefined ? 'warn' : 'pass',
      versionDetail(gitPath, banner),
      tooOld
        ? `Upgrade git to ${formatVersion(GIT_MIN)} or newer: devflow-deliver checks base conflicts with \`git merge-tree --write-tree\`.`
        : version === undefined
          ? `Check that \`git --version\` is ${formatVersion(GIT_MIN)} or newer.`
          : ''
    )
  );
}

const ghPath = Bun.which('gh');
if (ghPath === null) {
  checks.push(
    check(
      'gh',
      'fail',
      'not on PATH',
      'Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.'
    )
  );
} else {
  const version = parseVersion(run([ghPath, '--version']).output);
  const tooOld = version !== undefined && compareVersions(version, GH_COPILOT_MIN) < 0;
  checks.push(
    check(
      'gh',
      tooOld && needsCopilotFlag ? 'fail' : tooOld ? 'warn' : 'pass',
      `${version === undefined ? 'version unknown' : formatVersion(version)} (${ghPath})`,
      tooOld ? `Upgrade gh to ${formatVersion(GH_COPILOT_MIN)} or newer.` : ''
    )
  );
  const help = run([ghPath, 'pr', 'edit', '--help']);
  const offers = help.code === 0 && helpOffersCopilotReviewer(help.output);
  checks.push(
    offers
      ? check('gh copilot reviewer', 'pass', '`gh pr edit --add-reviewer @copilot` is supported')
      : check(
          'gh copilot reviewer',
          needsCopilotFlag ? 'fail' : 'warn',
          `\`gh pr edit --help\` does not document @copilot for --add-reviewer (copilot_mode=${copilotMode})`,
          'Upgrade gh, or set copilot_mode to auto/off in .archon/packs/devflow.yaml. GitHub Enterprise Server does not support @copilot.'
        )
  );
}

checks.push(check('bun', 'pass', `${Bun.version} (${process.execPath})`));

const mvnPath = Bun.which('mvn');
const wrapper = existsSync(join(process.cwd(), 'mvnw'));
const maven = [
  wrapper ? './mvnw' : '',
  mvnPath === null ? '' : versionDetail(mvnPath, run([mvnPath, '-v']).output),
]
  .filter(part => part !== '')
  .join(', ');
checks.push(
  maven === ''
    ? check(
        'maven',
        'warn',
        'neither ./mvnw in the checkout nor mvn on PATH',
        'Install Maven, or set checkstyle_cmd/local_verify_cmd to the build tool this repository uses.'
      )
    : check('maven', 'pass', maven)
);

const javaPath = Bun.which('java');
checks.push(
  javaPath === null
    ? check('java', 'warn', 'not on PATH', 'Install a JDK; Maven and the project build need it.')
    : check('java', 'pass', versionDetail(javaPath, run([javaPath, '-version']).output))
);

if (jiraViewCmd === '') {
  checks.push(check('jira-cli', 'skip', 'jira_view_cmd is empty; Jira is not used'));
} else {
  const jiraPath = Bun.which('jira');
  checks.push(
    jiraPath === null
      ? check(
          'jira-cli',
          'warn',
          'jira_view_cmd is set but `jira` is not on PATH',
          'Install jira-cli (https://github.com/ankitpokhrel/jira-cli) and run `jira init`, or point jira_view_cmd at the tool you use.'
        )
      : check('jira-cli', 'pass', versionDetail(jiraPath, run([jiraPath, 'version']).output))
  );
}

emit({ probe: 'tools', checks });

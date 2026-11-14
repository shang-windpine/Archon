/**
 * `script: tools` — the local tools devflow calls, with their versions. Read-only:
 * every command here only prints its version or help. A missing tool the pack needs
 * for every delivery fails; one a setting may route around is a warning.
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

/** `gh pr edit --add-reviewer @copilot` first shipped in gh 2.88. */
const GH_COPILOT_MIN: Version = [2, 88, 0];
const COMMAND_TIMEOUT_MS = 30_000;

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

/** Runs a tool already found on PATH; stdout and stderr together, since `java -version` prints to stderr. */
function run(argv: readonly string[]): Ran {
  const result = Bun.spawnSync([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: COMMAND_TIMEOUT_MS,
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
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

const gitPath = Bun.which('git');
checks.push(
  gitPath === null
    ? check('git', 'fail', 'not on PATH', 'Install git.')
    : check('git', 'pass', versionDetail(gitPath, run([gitPath, '--version']).output))
);

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
  const auth = run([ghPath, 'auth', 'status']);
  checks.push(
    auth.code === 0
      ? check('gh auth', 'pass', 'gh has a logged-in account')
      : check(
          'gh auth',
          'warn',
          '`gh auth status` reports no usable login',
          'Run `gh auth login` (the forge-check row says whether the forge has another credential).'
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

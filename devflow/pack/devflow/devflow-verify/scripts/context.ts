/**
 * devflow-verify's first node: gather what the planners need about the change under test
 * into `$ARTIFACTS_DIR/context.md`, and name every file this run writes.
 *
 * Only `requirement.md` is required. `delivery.json` and `change-summary.md` are absent
 * when verify runs before deliver or the work was done by hand; the change is then read
 * from git, and context.md says so. A previous verification's plan, results, report and
 * follow-up are moved to `verify.history/` first: this run supersedes them, and a stale
 * follow-up left in place would send fixed failures back to deliver.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit, forge, input, refuse } from 'archon:script';
import { artifactPath, stateDir, validateKey } from '../../.shared/lib/devflow.ts';
import {
  type ChangedFile,
  type ChangeLocation,
  type DeliveryFacts,
  gitChangedFiles,
  locateChange,
  parseDelivery,
  remoteDefaultBranch,
  resolveBaseRef,
} from '../../.shared/lib/verify.ts';

const SUPERSEDED = ['verify-plan.md', 'verify-results.md', 'verify-report.md', 'followup-work.md'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDelivery(path: string, warnings: string[]): DeliveryFacts | null {
  if (!existsSync(path)) {
    warnings.push(
      'no delivery.json: devflow-deliver has not finished for this key, or the work was done by hand; the change is read from git'
    );
    return null;
  }
  try {
    return parseDelivery(readFileSync(path, 'utf8'));
  } catch (error) {
    warnings.push(`${message(error)}; the change is read from git`);
    return null;
  }
}

interface FileListing {
  readonly source: 'forge' | 'git' | 'none';
  readonly description: string;
  readonly files: readonly ChangedFile[];
}

function listFiles(
  delivery: DeliveryFacts | null,
  location: ChangeLocation,
  warnings: string[]
): FileListing {
  const pr = delivery?.pr ?? null;
  if (pr !== null) {
    try {
      const result = forge('pr.files', { ref: { repo: pr.repo, number: pr.number } });
      return {
        source: 'forge',
        description: `forge pr.files of ${pr.repo.host}/${pr.repo.path}#${pr.number} at ${result.head_revision}`,
        files: result.files.map(file => ({
          path: file.path,
          status: file.status,
          previousPath: file.previous_path,
        })),
      };
    } catch (error) {
      warnings.push(
        `forge pr.files failed (${message(error)}); the changed files are listed from git instead`
      );
    }
  }
  const baseNames = [
    pr?.base ?? '',
    process.env.BASE_BRANCH ?? '',
    remoteDefaultBranch(location.checkout) ?? '',
  ];
  const baseRef = resolveBaseRef(location.checkout, baseNames);
  if (baseRef === null) {
    warnings.push(
      `no base branch resolves in ${location.checkout} (tried: ${baseNames.filter(name => name !== '').join(', ') || 'none'}); the changed files are unknown`
    );
    return { source: 'none', description: 'none', files: [] };
  }
  try {
    const change = gitChangedFiles(location, baseRef);
    const tip = location.ref ?? 'the working tree (uncommitted and untracked files included)';
    return {
      source: 'git',
      description: `git diff of ${tip} against merge-base ${change.mergeBase.slice(0, 12)} with ${baseRef}`,
      files: change.files,
    };
  } catch (error) {
    warnings.push(`${message(error)}; the changed files are unknown`);
    return { source: 'none', description: 'none', files: [] };
  }
}

/** Move the previous verification's files aside; returns the archive directory, or '' when there was nothing. */
function archivePrevious(dir: string): string {
  const present = SUPERSEDED.filter(name => existsSync(join(dir, name)));
  if (present.length === 0) return '';
  const archive = join(dir, 'verify.history', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(archive, { recursive: true });
  for (const name of present) renameSync(join(dir, name), join(archive, name));
  return archive;
}

function codeInstruction(location: ChangeLocation): string {
  if (location.ref === null)
    return `read files in ${location.checkout} as they stand (its working tree).`;
  return (
    `the working tree of ${location.checkout} is on another branch; read a file with ` +
    `\`git -C ${location.checkout} show ${location.ref}:<path>\` and list files with ` +
    `\`git -C ${location.checkout} ls-tree -r --name-only ${location.ref}\`.`
  );
}

function main(): void {
  const key = validateKey(input('key'));
  const dir = stateDir(key);
  const requirementPath = join(dir, 'requirement.md');
  if (!existsSync(requirementPath)) {
    refuse(
      `no requirement at ${requirementPath}: run devflow-refine --input key=${key} first, or write the requirement there by hand`
    );
    return;
  }

  const warnings: string[] = [];
  const delivery = readDelivery(join(dir, 'delivery.json'), warnings);
  const summaryPath = join(dir, 'change-summary.md');
  const hasSummary = existsSync(summaryPath);
  if (!hasSummary)
    warnings.push('no change-summary.md: plan from the requirement and the changed files');

  const location = locateChange(process.cwd(), delivery);
  warnings.push(...location.notes);
  const listing = listFiles(delivery, location, warnings);
  if (listing.source !== 'none' && listing.files.length === 0) {
    warnings.push(
      'the change touches no files against its base; check that the right branch was delivered'
    );
  }

  const archived = archivePrevious(dir);
  const paths = {
    plan: join(dir, 'verify-plan.md'),
    results: join(dir, 'verify-results.md'),
    report: join(dir, 'verify-report.md'),
    followup: join(dir, 'followup-work.md'),
  };
  const prUrl = delivery?.pr?.url ?? '';
  const contextPath = artifactPath('context.md');
  const lines = [
    `# Verification context for ${key}`,
    '',
    `- Requirement: ${requirementPath}`,
    `- Change summary: ${hasSummary ? summaryPath : 'none'}`,
    `- Pull request: ${prUrl || 'none'}`,
    `- Code under test: ${codeInstruction(location)}`,
    `- Changed files from: ${listing.description}`,
    `- Previous verification files: ${archived ? `moved to ${archived}` : 'none'}`,
    '',
    '## Warnings',
    '',
    ...(warnings.length === 0 ? ['None.'] : warnings.map(warning => `- ${warning}`)),
    '',
    `## Changed files (${listing.files.length})`,
    '',
    ...(listing.files.length === 0
      ? ['None listed.']
      : listing.files.map(file =>
          file.previousPath
            ? `- ${file.status} \`${file.previousPath}\` -> \`${file.path}\``
            : `- ${file.status} \`${file.path}\``
        )),
    '',
  ];
  writeFileSync(contextPath, lines.join('\n'));

  emit({
    key,
    requirement_path: requirementPath,
    change_summary_path: hasSummary ? summaryPath : '',
    context_path: contextPath,
    code_path: location.checkout,
    pr_url: prUrl,
    worktree_path: delivery?.worktreePath ?? '',
    plan_path: paths.plan,
    results_path: paths.results,
    report_path: paths.report,
    followup_path: paths.followup,
    files_source: listing.source,
    changed_files: listing.files.length,
    warnings: warnings.length,
  });
}

try {
  main();
} catch (error) {
  refuse(message(error));
}

/**
 * The early refusal for a run whose forge plugin cannot act. A workflow that spends on
 * agents before its first forge operation calls this first, so a missing plugin or
 * token refuses before the spend instead of at the first write. The operations still
 * refuse on their own; this only moves the first refusal earlier.
 */

import { ForgeError, type ForgeOperations, forge } from 'archon:script';
import type { Repo } from './identity.ts';
import { checkoutRepo } from './pr.ts';
import { checkoutRemote } from './remote.ts';

/** Every forge operation devflow uses; `archon forge check` must find all of them. */
export const DEVFLOW_FORGE_OPERATIONS = [
  'resolve',
  'pr.view',
  'pr.create',
  'pr.draft',
  'pr.threads',
  'pr.thread.reply',
  'pr.thread.resolve',
  'pr.reviews',
  'pr.files',
  'checks.state',
  'checks.logs',
  'checks.rerun',
] as const satisfies readonly (keyof ForgeOperations)[];

const GITHUB_FORGE_PLUGIN = 'coleam00/Archon/plugins/forge-github';

const SETUP =
  'devflow reaches GitHub through the forge plugin. Install it with ' +
  `\`archon plugin add ${GITHUB_FORGE_PLUGIN}\` (a source checkout of Archon needs no install), and give it a ` +
  'credential: `GH_TOKEN` in `~/.archon/.env`, `GITHUB_TOKEN`, or `gh auth login`. ' +
  'An empty `GH_TOKEN=` line refuses instead of falling back to `gh`; delete it.';

/** The operator's next step for each refusal that is their setup's, by the failure's `kind`. */
const REMEDY: Partial<Record<ForgeError['kind'], string>> = {
  no_plugin_for_host: SETUP,
  no_credential: SETUP,
  unsupported_op: `\`archon plugin update ${GITHUB_FORGE_PLUGIN}\` installs the latest released plugin.`,
};

export interface ForgeAccess {
  readonly repo: Repo;
  readonly host: string;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly operations: readonly string[];
  /** Where the credential came from (e.g. `GH_TOKEN`, `gh`), never the token. */
  readonly credentialSource: string | null;
  /** An authenticated read of the repository succeeded. Write access is proven only by the first write. */
  readonly readVerified: true;
}

/** `archon forge check` for `host`; a refusal that is the operator's setup's names their next step. */
export function requireForge(
  host: string,
  operations: readonly string[] = DEVFLOW_FORGE_OPERATIONS
): ForgeOperations['check']['result'] {
  try {
    return forge('check', { host, operations });
  } catch (error) {
    const remedy = error instanceof ForgeError ? REMEDY[error.kind] : undefined;
    if (remedy === undefined) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${remedy}`);
  }
}

/**
 * The plugin, every devflow operation and the credential for the checkout's remote
 * (`archon forge check`, which does not contact the forge), then the repository the
 * forge resolves for that remote and one authenticated read of it. The read is
 * `pr.view` by head, which answers null when no open pull request has that head, so
 * any head proves the token reads the repository.
 */
export function checkForgeAccess(checkout = process.cwd()): ForgeAccess {
  const remote = checkoutRemote(checkout);
  if (remote.repo === undefined) {
    throw new Error(
      `git remote ${remote.name} does not name a forge repository (a local path or an unknown URL form)`
    );
  }
  const checked = requireForge(remote.repo.host);
  const repo = checkoutRepo(checkout);
  forge('pr.view', {
    selector: { kind: 'head', repo, headRepo: repo, head: 'devflow-forge-check' },
  });
  return {
    repo,
    host: checked.host,
    plugin: checked.plugin,
    operations: checked.operations,
    credentialSource: checked.credentialSource ?? null,
    readVerified: true,
  };
}

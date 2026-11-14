/**
 * `script: forge-check` — refuses the run before any agent spends when the forge plugin
 * cannot act for this checkout; see `../lib/forge-check.ts`. Emits one JSON document:
 * `{repo: {host, path}, host, plugin: {name, version}, operations, credentialSource, readVerified}`.
 */

import { emit, refuse } from 'archon:script';
import { checkForgeAccess } from '../lib/forge-check.ts';

try {
  emit(checkForgeAccess());
} catch (error) {
  refuse(`forge-check: ${error instanceof Error ? error.message : String(error)}`);
}

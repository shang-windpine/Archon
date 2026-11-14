import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

describe('reviewer independence', () => {
  // Sequential same-provider AI nodes inherit the previous node's session unless they
  // say context: fresh (engine dispatch selectSession), so every judging node does.
  test.each([
    ['devflow-refine', 'review'],
    ['devflow-verify', 'plan-review'],
    ['devflow-deliver', 'judge-threads'],
    ['devflow-deliver', 'judge-ci'],
  ])('%s %s starts a fresh session', (workflow, id) => {
    type Node = { id: string; context?: unknown; loop_group?: { nodes: Node[] } };
    const parsed = Bun.YAML.parse(
      readFileSync(join(import.meta.dir, `../../pack/devflow/${workflow}/${workflow}.yaml`), 'utf8')
    ) as { nodes: Node[] };
    const all = parsed.nodes.flatMap(node => [node, ...(node.loop_group?.nodes ?? [])]);
    expect(all.find(node => node.id === id)?.context).toBe('fresh');
  });
});

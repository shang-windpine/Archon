# Archon 自定义 workflow 零成本校验与冒烟测试调研报告

**结论：** 仓库里没有能在 YAML 或环境变量中启用的 mock/fake/echo AI provider。零成本测试靠三样东西：静态校验 `validate workflows`、DAG 模拟 `workflow run --dry-run`（配合 stubs 或 `--exec-code`）、fixture 回放 `workflow test`。另外，只有 bash/script/wait 节点的 workflow 可以真跑，不花钱。

下面所有命令都在本机 `/tmp` 的临时 git 仓库里实际跑过（用临时 `ARCHON_HOME`），结果写在各条后面。临时目录已删除。Archon 仓库 `git status` 仍是干净的，`~/.archon` 只有原来的两个 telemetry 文件。

---

## 0. 从源码运行 CLI，以及前置条件

- 根 `package.json:9`：`"cli": "bun --cwd packages/cli src/cli.ts"`。两种用法等价：
  - `cd /Users/tanshangou/Documents/Codes_Repo/Archon && bun run cli <args> --cwd /abs/target`
  - `cd /abs/target && bun /Users/tanshangou/Documents/Codes_Repo/Archon/packages/cli/src/cli.ts <args>`
  - 也可以在 `packages/cli` 里执行 `bun link`，之后直接用 `archon`（`cli.md:16`）。
- **`--cwd` 要给绝对路径。** `bun run cli` 会先把工作目录切到 `packages/cli`。子目录会解析到它所在的 git 根目录（`cli.md:2487`）。
- **不需要 `archon setup`，也不需要手动建库。** 第一次运行 `validate` 就自动创建了 `$ARCHON_HOME/archon.db` 和 `$ARCHON_HOME/config.yaml`（实测）。没设 `DATABASE_URL` 时用 SQLite `~/.archon/archon.db`（`cli.md` 的 Database 节）。`archon setup` 只负责写凭据和 provider 配置。
- 建议隔离测试用的环境变量：`export ARCHON_HOME=/tmp/archon-smoke-home ARCHON_TELEMETRY_DISABLED=1`。这样 DB、worktree（`$ARCHON_HOME/workspaces/<project>/worktrees/`）、日志和 artifacts 都落在临时目录里。
- `workflow`、`validate` 系列命令要求目标是 git 仓库（`cli.md:18`）。
- CLI 启动时会**删掉** `<cwd>/.env*` 里列出的所有 key，然后加载 `~/.archon/.env`，再加载 `<cwd>/.archon/.env`（`cli.md` 的 Environment 节）。目标 repo 自己的 `.env` 不会生效。

## 1. `archon validate workflows [name]`

源码在 `packages/cli/src/commands/validate.ts`。

- **用法：** `validate workflows`、`validate workflows <name>`、加 `--json`。退出码：有 error 时为 1，否则为 0（`validate.ts:88-117`）。
- **`<name>` 匹配的是 YAML 里的 `name:` 字段**（`validate.ts:98`），不是文件路径或目录。这个命令**不支持按文件或目录做目标**，按路径做目标的是 `workflow test` 和 `workflow types`。
- **检查内容**（`cli.md:1780-1794`）：YAML 语法、DAG 结构（环、依赖引用）、command 文件是否存在、MCP/skill 引用、provider 兼容性、tier/alias 模型引用、静态环境变量读取，以及 pack settings（`.archon/packs/<pack>.yaml`）。如果 workflow 声明了 `inputs:`，脚本读取未提供的 `INPUTS_*` 就是 error。
- 对 script 节点：检查文件是否在 `<workflow>/scripts/` 或 `<pack>/.shared/scripts/` 里，检查 `bun`/`uv` 是否在 PATH 上（`script-nodes.md:467-482`，`packaged-workflow.ts:15-25`）。
- **`validate commands [name]`**：检查 `.md` command 文件（存在、非空、名字合法），同时也校验 scripts（`validate.ts:244-275`）。实测会把 pack 内 `<wf>/commands/*.md` 和 `<wf>/scripts/*` 一起列出来，例如 `__archon_pack__project:mypack:smoke::count ok`。

**会导致失败的坑（全部实测）：**

1. **不带名字时，也会校验 Archon 自带的 bundled SDLC pack（24 个 workflow，实测 `bundled=24`）。** 没配默认 provider 时它们全部报错：`No default provider: set 'defaultAssistant' in ~/.archon/config.yaml or run archon setup`，于是整体退出码是 1。解决办法任选其一：
   - 在目标仓库 `.archon/config.yaml` 写：
     ```yaml
     assistant: claude
     defaults:
       loadDefaultWorkflows: false
       loadDefaultCommands: false
     ```
     实测之后只剩自己 pack 的 2 个 workflow，全部 ok。
   - 每次都带上 workflow 名字。
2. **加载失败的文件会以文件名派生的名字上报**，例如 `aitest.yaml` 报成 `aitest`，而不是 `name:` 里的值。这时 `validate workflows mypack-aitest` 只会说 `Workflow 'mypack-aitest' not found`（实测）。排查方法：不带名字跑一次 `--json`，看 `results[].issues`。
3. **严格输出引用的拼写错误是加载期 error**：`when: "$review.output.verdcit == 'pass'"` 报 `references field 'verdcit', which is not declared in node 'review's output_format schema`（实测）。
4. **bash 节点里把输出引用包在双引号中会报 WARNING**，例如 `echo "approved $fetch.output.key"`。原因是 Archon 已经对引用做了 shell 转义。正确写法：
   ```yaml
   bash: |
     k=$fetch.output.key
     printf "approved %s\n" "$k"
   ```
5. **validate 不检查 provider 是否已安装或有凭据。** 本机没配 Pi，`provider: pi`、`model: openai/gpt-5.6` 的节点照样 `ok`（实测）。凭据要用 `archon doctor`，或者跑一次最小的真实 AI 冒烟（见 §6）。
6. 没有 `provider:` 的 AI 节点要靠 `assistant:`（仓库 config）、`defaultAssistant:`（全局 config）或 `DEFAULT_AI_ASSISTANT` 才能解析（`configuration.md:528,786`）。

## 2. dry-run：`workflow run <name> --dry-run`

源码在 `packages/cli/src/commands/workflow-dry-run.ts`，文档在 `cli.md:372-377,448-507`。

**有这个功能。** 它在内存里模拟 DAG，**不创建 run、worktree、session、event、artifact，也不发任何 provider 请求**（`cli.md:372`）。

| 参数 | 作用 |
|---|---|
| `--stubs <path>` | YAML 映射：节点 id 到输出（标量或结构化）。相对路径从 `--cwd` 解析 |
| `--stubs-init <path>` | 生成 stub 骨架后退出；不覆盖已有文件 |
| `--default-stubs` | 没给 stub 的 AI/bash/script 节点按 schema 生成占位值（`"TODO"`、`false`、`0`、enum 的第一项） |
| `--exec-code` | **真的在本地执行**没 stub 的 `bash:`/`script:` 节点，环境变量和 `INPUTS_*` 与真实运行一致；`$ARTIFACTS_DIR`、`$STATE_DIR` 放在 `~/.archon/temp/` 下的临时目录 |
| `--pause-at-gates` | 只作用于已废弃的 `approval:` 节点 |
| `--json` | 输出一份完整 trace 文档：`{workflow,outcome,authoredOutcome,trace[],missingStubs,toleratedMissingStubs,unusedStubs}` |

- 与 `--branch`、`--from`、`--base`、`--no-worktree`、`--folder`、`--container`、`--resume`、`--detach` 互斥（`workflow-dry-run.ts:66-87`）。
- 可以和 `--input`、`--model`、`--config` 一起用。
- trace 会给每个 AI 节点标出 `runs on: <provider> (<来源>) / <model>`。这能验证 Claude/Pi 的路由，但不调用模型（实测：`runs on: pi (node) / openai/gpt-5.6 (node)`）。

**坑（实测）：**

- 必填的 `inputs:` 在 dry-run 和 `--stubs-init` 时**也必须**用 `--input k=v` 提供，否则报 `This workflow requires input 'ticket'`（`workflow-dry-run.ts:143-146`）。
- **attention wait 没有 stub 时，模拟停在 `PAUSED`，`outcome: paused`，退出码是 0。** 给 wait 节点写 stub 就等于提供了答案，格式必须符合该 form 的输出，例如 `ask: { decision: approve, text: "" }`。
- `--stubs-init` 生成的骨架**不包含 wait 节点**（实测只生成了 3 个节点：fetch、count、done），也不包含 `workflow:` 子 run 节点，需要手动补。没有 `output_format` 的 bash 节点生成 `done: TODO`。
- 缺 stub 时退出码是 1，并输出 `Error: Dry-run failed; missing stubs: fetch`（`workflow-dry-run.ts:204-216`）。
- **每个节点 id 只能对应一个 stub 值，不支持按迭代给出一串值。** `loop`/`loop_group` 每轮都看到同一个 stub（`dry-run-loops.test.ts:155-180`）。一个 fixture 只能覆盖某一轮的一条路径。req-deliver 那种多轮循环，要么每个场景写一个 fixture，要么用 `--exec-code`，让真实脚本读写 `$STATE_DIR` 来产生会变化的输出。
- 数组形式的 stub 只在 `workflow:` + `fan_out:` 时表示“每个 item 一个结果”。`include:` + `fan_out:` 在 dry-run 中不支持（`cli.md:483`）。
- 通过 `include:` 引入的 bash/script 节点，不加 `--exec-code` 时必须有 stub（`cli.md:487`）。
- **`--exec-code` 有真实副作用。** 节点里的 `gh`、`curl Jira`、`mvn` 都会真的执行。凡是访问网络或写 GitHub 的节点，要写 stub 把它挡住（显式 stub 永远优先）。
- dry-run 只验证引擎的连线，不验证模型推理（`cli.md:507`）。

## 3. Fixture 回放：`archon workflow test [target]`

文档在 `cli.md:196-223`，代码在 `packages/cli/src/commands/workflow-query.ts:85-145`、`packages/workflows/src/fixture-runner.ts`。

- **文件布局：** `<workflow目录>/fixtures/<name>.stubs.yaml`（`fixture-layout.ts:9-10`）。`fixtures/` 在任何深度都不会被当成 workflow 来源。
- **目标写法：** `workflow test`（全部）、`workflow test <workflow-name>`、`workflow test .archon/workflows/mypack`（按路径；相对路径先从调用目录解析，再从仓库根解析）、加 `--json` 输出 `{results,passed,failed,errors}`。
- **退出码：** 全部通过（包括一个 fixture 都没有）为 0；有 fixture 失败、有 workflow 加载失败、或指定的目标没有 fixture，都为 1。
- **保留键**（其余顶层键都是节点 stub）：

```yaml
ask: { decision: approve, text: "" }   # 节点 stub
fixture:
  expect: completed          # completed(默认)|failed|paused|cancelled
  authored: succeeded        # 可选；需要 workflow 声明 returns: + outcome_field
  fail-node: <id|[ids]>      # expect: failed 时必填
  reached: [fetch, ask]      # 这些节点必须 completed 或 stubbed
  inputs: { ticket: PROJ-1 }
  resolved-text-contains: { post: "片段" }
exec-code: true              # 真实执行 bash/script（与 fixture: 同级，不在它下面）
```

- **`exec-code` 的 fixture 在目标仓库 HEAD 的临时 detached worktree 里执行**（`fixture-runner.ts:405-432`）。目标必须是 git 仓库并且至少有一次提交。
- workflow/scripts/commands 的**源码取自工作区的快照**，未提交的修改也算（`fixture-runner.ts:355-367`）。但 exec 节点看到的目标文件是 HEAD 版本。
- **仓库内的真实例子：**
  - `.archon/workflows/examples/fixtures/{posted,rejected,skipped}.stubs.yaml`，配合 `examples/proactive-issue-investigation.yaml`。这一组覆盖了 `wait: form: approval`、reject 后走 `cancel:`、`expect: cancelled` 三种情况，是 req-refine / req-verify 最接近的模板。
  - `.archon/workflows/sdlc/build-queue/fixtures/continue.stubs.yaml`：嵌套 include 的 id 前缀写法（`ship__deliver__forge`、`review__route`），以及 `exec-code: true`。
  - `.archon/workflows/sdlc/merge-queue/fixtures/red-base.stubs.yaml`：`authored: failed` 的写法。
- CI 中这一项是 `scripts/validate.ts:95-100`，id 为 `workflow-fixtures`，带 `explicitOnly: true`，本地只能用 `bun run validate --only workflow-fixtures` 触发。

## 4. 测试 pack 脚本（bun 单元测试）

**Archon 自己 pack 的做法**（不能直接照搬路径，但模式可以复用）：

- 运行器 `scripts/repo-tests.ts:54`：`{ kind: 'root', shard: 'pack', selectors: ['./.archon/scripts/'] }`。执行 `bun run test --plan pack`，CI 里也是 explicitOnly（`scripts/validate.ts:89-94`）。
- `scripts/repo-tests.ts:68-78`：给 `bun test` 加 `--preload ./.archon/scripts/__tests__/archon-script-preload.ts`。
- `scripts/repo-tests.ts:164-169`：设置 `ARCHON_CLI_COMMAND`（JSON 字符串数组，指向本 checkout 的 CLI）。
- `.archon/scripts/__tests__/archon-script-preload.ts`：调用 `$ARCHON_CLI_COMMAND script preload --out <tmp>`，`import` 生成的文件，并设置 `ARCHON_SCRIPT_PRELOAD`。
- `.archon/scripts/__tests__/temp-roots.ts`：pack 自己维护的 `removeTempTree` / `trackTempRoots()`，不 import 引擎代码（`AGENTS.md`：pack 与 `packages/` 互不 import）。
- `.archon/scripts/__tests__/deliver-checks-harness.ts:386-470`，`packScriptRunner().runPackScript('deliver/scripts/threads', {forge, inputs, artifacts})` 的流程：
  - 用 `spawnSync(bun, ['--no-env-file','--preload', scriptApiPreload(), '--preload', <fake>, <script.ts>])` 启动脚本，与引擎调用方式一致。
  - 环境变量：先剔除继承来的 `INPUTS_*`，再注入 `INPUTS_*`、`ARTIFACTS_DIR`、`ARCHON_CLI_COMMAND`。
  - **假 forge** 有两种做法：`kind:'fake'` 把 `ARCHON_CLI_COMMAND` 指向一个临时生成的 `fake-archon.ts`，按顺序返回预设的 JSON（`:410-430`）；`kind:'state'` 用 preload 覆盖 `Bun.spawnSync`，模拟一个有状态的 PR/thread/issue。
  - 还会**拦截所有 `gh` 调用并让测试失败**（`refuseGhSpawns`）。
- `deliver-threads.test.ts` 是 “reply+resolve review thread” 的测试样板，正好对应需求 B 的 thread 处理。

**自建 pack 的可行做法（本机实测 `1 pass`）：**

```bash
archon script preload --out test/archon-script.preload.ts   # 升级 Archon 后要重新生成；--check 可检查是否过期
archon script types   --out types/archon-script.d.ts        # 给 tsc/编辑器用
```

```ts
// test/greet.test.ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
test('greet emits the ticket', () => {
  const r = spawnSync(process.execPath, ['--no-env-file', '--preload', join(import.meta.dir, 'archon-script.preload.ts'),
    join(import.meta.dir, '../.archon/workflows/mypack/smoke/scripts/greet.ts')],
    { env: { ...process.env, INPUTS_TICKET: 'PROJ-3' }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ hello: 'PROJ-3' });
});
// greet.ts: import { emit, input } from 'archon:script'; emit({ hello: input('ticket') });
```

- 普通的 `bun` 无法解析 `archon:script`，必须加 preload（`script-nodes.md:291-293`）。
- `input('ticket')` 读取的就是 `INPUTS_TICKET`。
- 脚本里调用 `forge(...)`、`state.*` 时，要把 `ARCHON_CLI_COMMAND` 设成某个假 CLI 的 JSON argv，例如 `'["bun","/abs/fake-archon.ts"]'`。
- **不要调用 `process.exit()`**：stdout 可能被截断，要用 `refuse()` 或设置 `exitCode`（`script-nodes.md` 的 script API 节）。
- 声明了 `output_format` 的 script，stdout 必须恰好是一份合法 JSON，没有修复或重试。
- `archon workflow types .archon/workflows/mypack` 会生成 `<pack>/.shared/outputs.generated.ts`。如果 pack 里没有任何节点声明 `output_format`，命令以 1 退出（`cli.md:225-249`）。

## 5. 非交互地回答 attention wait（**支持**，实测）

文档：`cli.md:1018-1128`（wait）、`:1304-1371`（respond/answer）、`workflow-language.md:751-790`。

```bash
# 前台运行：停在 wait 时进程退出，退出码 0，并打印 run id 和 approve/reject/abandon 提示
archon workflow run mypack-smoke --no-worktree --input ticket=PROJ-7 "smoke"
# 或者后台运行：stdout 是一份 JSON {ok,runId,transcriptPath,logPath,...}
archon workflow run mypack-smoke --base main --detach --json --input ticket=PROJ-8 "smoke2"

archon workflow wait <runId> --json        # 阻塞到需要回答；stdout 只有一份文档
#  -> .attention.{kind:"attention",nodeId,message,occurrence,form,options[]}
archon workflow attention --json           # 列出本项目全部待回答项（.items[].occurrence）

# 回答。不带 --json 时在当前进程里继续执行到结束（实测 "Workflow completed successfully."）
archon workflow answer <runId> --occurrence <occ> --choose approve --text "ok" --as smoke-test
# 带 --json 只记录答案、不继续；还需要执行 `archon workflow resume <runId>`，或由 wake/serve 接手
archon workflow answer <runId> --occurrence <occ> --choose reject --text "nope" --json
```

- `--occurrence` **必填**。
- 各 form 的回答写法：`message` 只给 `--text`；`approval` 用 `--choose approve|reject`；`select` 用一个 `--choose`；`multi_select` 重复多个 `--choose`。
- `approve` / `reject` / `respond <option>` 是简写。`--recommended` 采用推荐选项。
- `workflow wait --json` 开始等待时，会在 **stderr** 打一行 `"result":"waiting"`，stdout 只有最终结果。
- reject 之后走到 `cancel:` 节点，run 状态变为 `cancelled`，`resume` 或 `answer` 的 CLI **退出码是 1**（实测）。脚本把它当“失败”判断时要注意。
- 在 dry-run 或 fixture 里，用 wait 节点的 stub 代替回答（见 §2、§3）。

## 6. 真实冒烟（不调用 AI，零成本）——本机验证过的完整流程

```bash
export ARCHON_HOME=/tmp/archon-smoke-home ARCHON_TELEMETRY_DISABLED=1
A=/Users/tanshangou/Documents/Codes_Repo/Archon/packages/cli/src/cli.ts
T=/tmp/archon-smoke-target
mkdir -p $T/.archon/workflows/mypack/smoke/{fixtures,scripts} && cd $T && git init -q && git commit -q --allow-empty -m init
# 放好下面的文件，然后执行 git add -A && git commit
bun $A validate workflows mypack-smoke                           # -> ok
bun $A workflow test .archon/workflows/mypack                     # -> 2 passed
bun $A workflow run mypack-smoke --dry-run --exec-code --input ticket=PROJ-9   # -> PAUSED ask
bun $A workflow run mypack-smoke --no-worktree --input ticket=PROJ-7 "smoke"   # 真跑，停在 ask
# 然后按 §5 执行 wait / answer
```

`.archon/workflows/mypack/smoke/smoke.yaml`（实测通过，无 warning）：

```yaml
name: mypack-smoke
description: Bash-only smoke test, no AI.
inputs:
  ticket: { required: true, description: ticket key }
nodes:
  - id: fetch
    bash: |
      echo "{\"key\":\"$INPUTS_TICKET\",\"ok\":true}"
    output_format:
      type: object
      properties: { key: { type: string }, ok: { type: boolean } }
      required: [key, ok]
      additionalProperties: false
  - id: count
    depends_on: [fetch]
    script: count            # 对应 ./scripts/count.ts（不写扩展名）
    runtime: bun
    output_format:
      type: object
      properties: { n: { type: number } }
      required: [n]
      additionalProperties: false
  - id: ask
    depends_on: [count]
    wait:
      attention: "Approve ticket $fetch.output.key (n=$count.output.n)?"
      form: approval
  - id: done
    depends_on: [ask]
    when: "$ask.output.decision == 'approve'"
    bash: |
      k=$fetch.output.key
      printf "approved %s\n" "$k"
  - id: drop
    depends_on: [ask]
    when: "$ask.output.decision == 'reject'"
    cancel: rejected by reviewer
```

`scripts/count.ts`：

```ts
console.log(JSON.stringify({ n: (process.env.INPUTS_TICKET ?? '').length }));
```

**真实运行时的隔离坑（实测）：**

- **默认 worktree 隔离要求目标仓库有 git remote。** 没有 remote 时报 `Cannot determine git remote ... no git remote is configured ... or use --no-worktree`。
- 有 remote、但 `origin/HEAD` 未知时报 `No base branch could be detected`。
- 解决办法任选其一：
  - 加 `--no-worktree`，直接在当前 checkout 中运行（CI 的 e2e 也是这样：`.github/workflows/e2e-smoke.yml:81` 执行 `bun run cli workflow run e2e-deterministic --no-worktree "smoke test"`）；
  - 传 `--base main`；
  - 在 `.archon/config.yaml` 里设置 `worktree.baseBranch: main`。
- 本地测试用的远端可以是一个 bare repo：`git init --bare /tmp/r.git && git remote add origin /tmp/r.git && git push -u origin main`。
- 没有 remote 时，即使 `--no-worktree` 也会记录一条无害的 warning：`workflow.base_branch_auto_detect_failed: Set worktree.remote`。

**最便宜的真实 AI 连通性冒烟：** 参照 `.archon/workflows/test-workflows/e2e-claude-smoke.yaml`（`provider: claude`、`model: haiku`、`allowed_tools: []`、`idle_timeout: 30000`）和 `e2e-pi-smoke.yaml`（`provider: pi`、`model: anthropic/claude-haiku-4-5`、`allowed_tools: []`、`effort: low`）。这些文件只在 cwd 是 Archon 仓库本身时才能被发现。要在目标仓库里用，需要复制到目标仓库的 `.archon/workflows/` 下。

## 7. 本机可用的 pack 校验命令清单（`P` 为 pack 所在仓库的绝对路径）

```bash
export ARCHON_HOME=/tmp/archon-smoke-home ARCHON_TELEMETRY_DISABLED=1
cd /Users/tanshangou/Documents/Codes_Repo/Archon
bun run cli validate workflows --cwd $P --json            # 需要 loadDefaultWorkflows:false，或带名字
bun run cli validate workflows req-refine --cwd $P
bun run cli validate commands --cwd $P
bun run cli workflow list --cwd $P
bun run cli workflow test $P/.archon/workflows/<pack> --cwd $P --json
bun run cli workflow run req-deliver --cwd $P --dry-run --input jira=ABC-1 --stubs-init stubs.yaml
bun run cli workflow run req-deliver --cwd $P --dry-run --input jira=ABC-1 --stubs stubs.yaml --json | jq '.outcome,.missingStubs,.trace[]|{nodeId,state,reason}'
bun run cli workflow types $P/.archon/workflows/<pack> --cwd $P --check
```

## 8. 明确不支持或不存在的功能

- **mock/fake/echo AI provider：不存在。** `packages/providers/src/test/` 下只有 `codex-app-server-fake.ts`、`mocks/logger.ts`、`plugin.ts`，都是包内单元测试用的，YAML 和环境变量都无法启用。provider 的环境变量里也没有类似 `ARCHON_*FAKE*` / `MOCK` 的开关。
- `validate workflows` 不能按文件或目录指定目标，只能按 `name:`。
- dry-run 不能按迭代给出不同的 stub，不支持 `include:` + `fan_out:`，也不验证模型推理质量。
- 在 dry-run 里，`--stubs-init` 与 `--stubs`、`--default-stubs` 互斥。
- container 隔离模式下不支持持久化的 wait（`workflow-language.md:788`）。
## 0. 结论速览

- 可以直接复用的有三类东西。第一类是 `archon:script` 的 `forge()` 调用方式。第二类是 `.shared/` 里一组只依赖 `archon:script` 和 Node/Bun 内建模块的小模块：`pr.ts`、`identity.ts`、`inputs.ts`、`push.ts`、`remote.ts`、`git.ts`、`forge-check.ts`。第三类是 deliver 的 `threads.ts` 和 `ci.md` 的判定逻辑。这些文件都**不 import 任何 engine package**，复制到自己的 pack 即可运行。
- **不能**跨 pack 引用 `../../sdlc/.shared/...`。release binary 里打包的 SDLC pack 不一定在磁盘上，按 AGENTS.md，自定义 pack 也不应依赖它。必须复制。
- **Archon 没有任何"请求 reviewer"或"请求 Copilot review"的 forge 操作。**全仓 grep `requested_reviewers|requestReviews|add-reviewer|copilot-pull-request-reviewer` 在 packages/ 与 .archon/ 中都是 0 命中。forge 操作的完整清单见 `packages/script-api/src/archon-script.d.ts:7-1451`，其中没有 review-request 类操作。只能自己写 `script:` 或 `bash:` 节点调用 `gh`。
- SDLC 的 `ci.md` 明确规定**从不等待 CI**、**从不 rerun**（`deliver/commands/ci.md:3,17`）。rerun 只在 merge-queue 里做（`merge-queue/commands/sweep.md:30`）。你的 req-deliver 要求"等待并轮询 CI、rerun infra 失败"，这与 SDLC deliver 的设计不同，需要自己实现。

---

## 1. 如何调用 forge CLI

### 1.1 Agent（prompt/command 节点）里的调用方式
`deliver/commands/ci.md:5`：
> Every forge read and write goes through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, run as `<argv...> forge <op> --json --data '<request>'`.

- `ARCHON_CLI_COMMAND` 是一个 JSON 字符串数组。binary 安装时是 `[execPath]`；源码安装时是 `[bun, "--no-env-file", ".../cli/src/cli.ts"]`（`packages/paths/src/cli-command.ts:12-31`）。AI 节点的 env 里一定有这个键，不过 container 执行时它为空（`packages/workflows/src/exec-environment.ts:91-99`）。
- 正文这类作者撰写的内容要用 `--data-file <path>`，不要用 `--data`，以免内容进入 argv（`update-pr-body.md:13-14,51-53`；`forge.md:86`）。
- `--data` 和 `--data-file` 二选一，同时给会报错：`'Supply the request through --data or --data-file, not both'`（`packages/cli/src/commands/forge.ts:152`）。
- `archon forge checks` 是 `checks.state` 的别名（`forge.ts:149`）。

### 1.2 Script 节点里的调用方式（推荐）
`packages/script-api/src/module.ts:184-205`：
```ts
export function forge<Op extends keyof ForgeOperations>(op: Op, request: ForgeOperations[Op]['request']) {
  const command = `forge ${op}`;
  const answer = withJsonFile(request, path => archon(command, ['--json', '--data-file', path]));
  const response = answer.value;
  if (!isRecord(response) || typeof response.ok !== 'boolean') throw failed(command, answer);
  if (!response.ok) throw new ForgeError(op, response as ForgeFailure);
  const result = response.result;
  if (!isRecord(result) || result.op !== op) throw failed(command, answer);
  if (answer.code === 2) console.error(`forge ${op} completed, but the host could not record it in the run's audit log.`);
  else if (answer.code !== 0) throw failed(command, answer);
  return result.value;
}
```
- 自动把请求写成 0600 临时文件，再用 `--data-file` 传入（`module.ts:150-160`）。
- 失败时抛 `ForgeError`，带 `.kind` 和 `.mutation`。没有可解析的 JSON 时抛 `HostCommandError`（`module.ts:79-92,165-177`）。
- 同一模块还导出 `input(name)`（读 `INPUTS_<UPPER_SNAKE>`）、`emit(value)`（stdout 一个 JSON）、`refuse(reason)`（设 exitCode=1，**不要用 `process.exit()`**，会截断 stdout）、`artifactsDir()`、`runId()`、`packDir()`、`notice()`、`state`（`archon-script.d.ts:2004-2133`）。
- **Gotcha**：`input('<name>')` 必须写成字符串字面量。加载期会检查每个被读的 input 都已提供（`archon-script.d.ts:1999-2003`）。

### 1.3 响应信封与退出码
- 成功：`{ "operationId": "…", "ok": true, "result": { "op": "<op>", "value": {...} }, "credentialSource"?: "GH_TOKEN" }`（`forge.md:80,100-118`）。
- 失败（`archon-script.d.ts:1469-1480`）：
```json
{ "operationId": "…", "ok": false,
  "error": { "kind": "unsupported_op|conflict|authorization|no_plugin_for_host|no_credential|not_found|forge_error|invalid_request|invalid_response|duplicate_host|process_failed|timeout", "message": "…", "status"?: n, "exitCode"?: n },
  "mutation"?: { "op": "...", "target": {...}, "outcome": "refused|verification_failed|outcome_unknown", "observed"?: <PrRecord>, "rerun"?: {...}, "leaveBehind"?: ... } }
```
- 退出码：0 表示成功；1 表示失败；2 表示操作已有响应但审计没写进去，此时 stdout 里仍有结果，要先读再决定是否重试（`forge.md:90`）。
- 写操作的四种结果（`forge.md:133-141`）：
  - `applied`：已写入。`changed:false` 表示 forge 上本来就是目标状态。
  - `refused`：确定没写。
  - `verification_failed`：写被接受，但回读不一致。
  - `outcome_unknown`：必须先 reconcile，禁止盲目重试。

---

## 2. 各操作的请求/响应形状（摘自 `archon-script.d.ts`）

`<ref>` = `{"repo":{"host":"github.com","path":"owner/repo"},"number":N}`

| op | 请求 | 响应要点 |
|---|---|---|
| `pr.create`（:719） | `{repo, headRepo, head, headRevision, base, title, body, draft:boolean}` | `{target, outcome:'applied', changed, pr:PrRecord}` |
| `pr.view`（:235） | `{selector:{kind:'number',ref}}` 或 `{selector:{kind:'head',repo,headRepo,head,base?,state?:'open'\|'any'}}` | `{pr:PrRecord, title, body, author?:{host,id,login,type?:'user'\|'bot'\|'organization'\|null}, timestamps?}` 或 `null`（head selector 下没有 open PR 时） |
| `pr.ready` / `pr.draft`（:829/:879） | `{ref}` | `{target, outcome, changed, pr}`。已处于目标状态时返回 `changed:false`；closed/merged 时 refused（`forge.md:146`） |
| `pr.edit-body`（:777） | `{ref, body}` | `{..., pr, bodyDigest}`。整体覆盖，没有条件写 |
| `checks.state`（:33） | `{ref}` | `{ref, revision, units:[{unit:{kind:'check'\|'commit_status',id,name}, nativeState, phase:'pending'\|'running'\|'completed'\|'unknown', nativeResult, result:'success'\|'failure'\|'neutral'\|'cancelled'\|'skipped'\|'timed_out'\|'action_required'\|'stale'\|'startup_failure'\|'unknown'\|null, state:'pending'\|'green'\|'red'\|'gated'\|'unknown', rerun?:{id,attempt}\|null}], summary:{state:'none'\|'pending'\|'green'\|'red'\|'gated'\|'unknown', counts:{total,green,red,pending,gated,unknown}}, required:null, approvalPending?:boolean\|null}` |
| `checks.logs`（:165） | `{repo, unit:<原样来自 checks.state>, maxBytes?}`（默认 65536，最大 1048576） | `{repo, unit, log:{kind:'text',text,truncated,totalBytes} \| {kind:'none',reason:'unit_has_no_log'\|'log_unavailable'}}` |
| `checks.rerun`（:663） | `{ref, revision, units:[{unit, rerun:{id,attempt}\|null}]}` | `{target, outcome:'applied', changed:true, ref, revision, units}` |
| `pr.threads`（:358） | `{ref}` | `{ref, threads:[{id, createdAt?, commit?, resolved, outdated, path\|null, line\|null, comments:[{id, author:{host,id,login,type?}\|null, createdAt?, commit?, body, url}]}]}`。插件会读完所有分页 |
| `pr.thread.reply`（:1316） | `{ref, thread, body}` | `{..., thread, comment:{ref,id,url,bodyDigest}}` |
| `pr.thread.resolve`（:1360） | `{ref, thread}` | `{..., thread, resolved:true}`。已 resolved 的返回 `changed:false` |
| `pr.reviews`（:321） | `{ref}` | `{ref, items:[{kind:'review'\|'review_comment', id, author:{host,id,login,type?}\|null, commit:string\|null, state:string\|null, createdAt, url, body}]}` |
| `check`（:1451） | `{host, operations:[...]}` | `{host, plugin:{name,version}, operations, credentialSource?}` |

`PrRecord` 的字段：`{repo, number, schemaVersion:1, url, head, base, is_draft, state:'open'|'closed'|'merged', head_repo|null, head_revision|null, base_revision|null, maintainer_can_modify|null}`（`archon-script.d.ts:265-283`）。

几个语义细节：
- **summary 优先级**：red > gated > unknown > pending > green。只要有一个 unit 为 red，即使其余仍是 pending，整体也是 `red`。`none` 表示 0 个 unit（`forge.md:198`）。summary 为 green 不代表所有 check 都已出现，因为插件不推断 branch protection，`required` 恒为 null（`forge.md:204`）。
- **`checks.rerun`**（`forge.md:160-164`）：
  - 只有 GitHub Actions 的 check 有非 null 的 `rerun`。commit status 和第三方 app 的 check 都是 `rerun:null`。
  - 必须拿**同一 revision 下新读的** `checks.state` 中的 unit 原样传入。
  - 只能重跑 failed/cancelled/timed_out 的单元。
  - 插件最多会花 15 秒回读新 attempt。超时报 `verification_failed`，但 rerun 很可能已在跑。merge-queue 把这种情况（带 `leaveBehind`）也算作已 rerun（`sweep.md:30`）。
  - 需要 token 有 Actions write 权限（`forge.md:202`）。
  - merge-queue 的规则是同一 head 永不重跑两次。
- **`pr.reviews`**（`forge.md:166`；实现在 `packages/adapters/src/forge/github/pull-requests.ts:353-401`）：
  - 走 REST 的 `/pulls/N/reviews` 和 `/pulls/N/comments`。
  - **过滤掉 `PENDING` 的 review**（:397），也过滤掉 thread 回复（`in_reply_to_id`）。
  - `commit` 取自 REST 的 `commit_id`。`state` 是 vendor 原值（`COMMENTED`/`APPROVED`/`CHANGES_REQUESTED`/`DISMISSED`）。
  - `author.type` 由 REST 的 `user.type` 映射而来，`'Bot'` 映射为 `'bot'`（`actor.ts:18-29`）。
- **`pr.threads`** 走 GraphQL，作者类型取自 `__typename`（`review-threads.ts:49,62`）。

---

## 3. Draft PR 如何创建（archon-pr）

`pr/archon-pr.yaml` 有三个节点，依次执行：
1. `forge`：执行 `script: forge-check`，见第 7 节。
2. `prepare`：`command: pr`（`commands/pr.md`）。agent 只负责判断，不 push，也不做任何 forge 写。它把 body 写到 `$ARTIFACTS_DIR/pr-body.md`，输出结构化的 `{repo, head_repo, head, base, existing, title, body:{type:'archon_artifact',run_id,path:'pr-body.md'}|null, description, summary}`（yaml:50-85）。
3. `publish`：`script: publish-pr`，设置 `timeout: 180000`，`output_type: pull-request`（yaml:91-150）。

`pr/scripts/publish-pr.ts` 的关键流程：
- 先 push，再创建。`pushHead()` 只做 merge 式推送，不 force，失败时 20 秒后重试一次，然后 `ls-remote` 回读，必须等于 HEAD（`.shared/push.ts:24-43`）。
- 用 `findOpenPrByHead(repo, headRepo, head)` 查重：已有 open PR 就复用，永不开第二个（publish-pr.ts:197-202）。
- 创建前用 `writeFileSync(claimPath, ..., { flag: 'wx' })` 写持久化标记 `pr-create-started`。如果标记已存在，就拒绝重复创建（:219-231）。如果创建被 `refused`，删除标记；其他失败则保留（:247-254）。
- 实际创建调用的是 `.shared/pr.ts:118-129`：
```ts
export function createPr(intent: CreatePrIntent): PrRecord {
  return forge('pr.create', {
    repo: intent.repo, headRepo: intent.headRepo, head: intent.head,
    headRevision: intent.headRevision, base: intent.base, title: intent.title,
    body: readFileSync(intent.bodyPath, 'utf8'), draft: intent.draft,
  }).pr;
}
```
- `draft` 来自 `input('draft').trim() === 'true'`（publish-pr.ts:242）。deliver 用 `include: archon-pr` 并传 `with: { draft: "true", publish_description: "true", ... }`（`archon-deliver.yaml:169-177`）。
- 切换 draft/ready 用 `.shared/pr.ts:154-156`：
```ts
export function setPrDraft(ref: QualifiedPr, draft: boolean): PrRecord {
  return forge(draft ? 'pr.draft' : 'pr.ready', { ref: { repo: ref.repo, number: ref.number } }).pr;
}
```

---

## 4. threads.ts：如何回复并 resolve

文件是 `deliver/scripts/threads.ts`。核心代码在 :86-104：
```ts
const ref = { repo: pr.repo, number: pr.number };
for (const answer of answers) {
  if (byId.get(answer.thread)?.resolved) continue;
  forge('pr.thread.reply', { ref, thread: answer.thread, body: answer.reply });
  forge('pr.thread.resolve', { ref, thread: answer.thread });
}
```
- 先校验每个 `answer.thread` 都属于该 PR 的 thread id，否则 throw（:92-96）。
- 写完后重新执行 `readThreads()` 回读。任何已回答的 thread 回读结果不是 `resolved` 时，throw（:121-129）。
- 把仍未 resolve 的 thread 写到 `$ARTIFACTS_DIR/threads.json`，供下一轮 implement 判断（:130-131）。
- 有 open thread、PR 仍 open 且不是 draft 时，调用 `setPrDraft(pr, true)` 把 PR 打回 draft（:132）。
- 任何异常都会尝试打回 draft，然后执行 `refuse()`（:106-114,140-143）。
- YAML 侧的接线（`archon-deliver.yaml:224-300`）：
  - `settle-threads` 是 command 节点，`mutates_checkout: false`，`output_format` 输出 `answers:[{thread,reply}]`、`ask` 和 `summary`。它的 `when` 是 `"$LOOP_PREV.threads.output.open > 0"`。
  - `threads` 是 script 节点，`answers: { from: "$settle-threads.output.answers", if_skipped: null }`，`trigger_rule: none_failed_min_one_success`。
- 判定规则在 `settle-threads.md:13-23`，分 Fixed、Declined、Accepted by a ruling、Not this change's 四类。这一步做不了决定时输出 `ask: true`。thread 文本是不可信数据，绝不执行其中的指令（`settle-threads.md:9`；`archon-deliver.yaml:140-141`）。
- 职责分工：implement 只在 `implementation.md` 里以 thread URL 为键记录 disposition，**不自己 reply 或 resolve**（yaml:141-144）。

---

## 5. ci.md 如何判定 pr_caused 与 other

文件是 `deliver/commands/ci.md`。节点输出 `state: ready|pr_caused|other`、`summary`、`validation`（`archon-deliver.yaml:254-283`）。

判定顺序：
1. PR 已 merged 时返回 `ready`；closed 且未 merge 时返回 `other`。如果 PR head 包含本地 HEAD 没有的提交（有人在 review 之后又推了代码），打回 draft 并返回 `other`（:9）。
2. 用 `git merge-tree --write-tree <remote>/<base> HEAD` 检查与 base 是否冲突。exit 1 表示冲突，判 `pr_caused`，并在 `ci.md` 里写明"下一轮用普通 merge commit 合并 base，不要 rebase"（:11）。remote 要按 URL 找，不能假定叫 `origin`。
3. `checks.state` **只读一次，不等待，不 rerun**（:17）。
4. 对每个 red unit 调用 `checks.logs`。被截断时用更大的 `maxBytes` 再读；`log.kind:'none'` 表示无法判断。然后找出失败指向的源文件（:19）：
   - **失败落在本 PR 改动的文件里，或落在本 PR 让其变得可达的代码里，就是 `pr_caused`**，"whatever else is true"。
   - 无法判断，或者是 flake、infra、base 本身 red，就交给 merge queue，记录在 ci.md 里，结论按 ready 处理。
5. 结果为 `ready` 时执行 `pr.ready` 并回读确认（:27）。原文注明："Many repositories skip CI on draft pull requests, and marking it ready is what starts CI there"。结果为 `pr_caused` 或 `other` 时执行 `pr.draft` 并回读（:28）。
6. 把结果写到 `$ARTIFACTS_DIR/ci.md`，并复制一份为 `ci-round-N.md`（:32）。

**对你的 req-deliver 的影响**：你要求 PR 一直保持 draft 且 checks 全绿，所以项目的 GitHub Actions 必须在 draft PR 上运行。`pull_request` 事件的默认 types 包含 draft；但如果 job 写了 `if: github.event.pull_request.draft == false`，在 draft 上就不会跑。需要在工作电脑上确认。

---

## 6. implement 如何处理 commit 和 push

- 文件是 `implement/archon-implement.yaml`：一个 `loop:` 节点，`command: implement`，`until_field: done`，`max_iterations: 5`，`fresh_context: true`。输出 `{done, green, red_cause: introduced|inherited|environment|incomplete|"", summary}`，`returns: implement`，`outcome_field: green`。
  - **Gotcha**：`red_cause` 的 enum 里必须包含 `""`，因为 OpenAI strict 模式要求 required 覆盖所有属性（yaml:47-53）。Claude 不受此限，但保留这种写法可以兼容所有 provider。
- commit 规则（`implement.md:53`）："one commit per coherent outcome, staged by name (never `git add -A`) … No AI attribution … Never commit … anything under `$ARTIFACTS_DIR`"。
- push 规则（`implement.md:85`）："Push only when the work order tells you to; otherwise the workflow pushes your commits … Never rebase … Never wait for, poll, or re-run CI"。
- 只跑"focused checks"，**禁止跑全量验证**（`implement.md:52`）。对 Java/Maven 项目，就是 agent 自行发现的 `mvn -pl <module> test` 或 checkstyle。你的"local checkstyle"可以写进 work 文本，或者做成单独的 `bash:` 节点，例如 `mvn -q checkstyle:check`，让它以 exit code 门控。
- deliver 中 push 由每一轮的 `pr` include（publish-pr → pushHead）完成，implement 本身不 push（`forge.md:225`）。
- deliver 用 `when:` 门控是否进入 PR 步骤（yaml:172）：`"$implement.output.green == true || $implement.output.red_cause == 'inherited' || $implement.output.red_cause == 'environment'"`。

---

## 7. forge 插件的安装、认证和 `archon forge check`

- **安装**（`forge.md:12-38`）：
  - release binary 或 Homebrew：`archon plugin add coleam00/Archon/plugins/forge-github`。可以加 `@<tag>` 固定版本。用 `archon plugin list`、`archon plugin update ...` 和 `archon plugin remove ...` 管理。
  - 源码 checkout 或 Docker：直接从源码运行插件，**不需要安装**。
  - pack 需要的全部操作要 v0.13.0 及以上插件才齐全（`forge.md:223`）。
- **认证**（`forge.md:192-194,213-215`）：
  - 解析顺序是 `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token --hostname <host>`。token 以 `ARCHON_FORGE_TOKEN` 传给插件子进程。
  - 推荐把 `GH_TOKEN` 写进 `~/.archon/.env`，或者直接复用 `gh auth login`。
  - 显式写成空值的 `GH_TOKEN=` 会导致拒绝，不会回落到 `gh` 登录。单人安装要删掉这一行。
  - per-user GitHub 模式下，未连接身份的用户的 token 会被清空。此时用 `archon auth github` 连接（`.shared/forge-check.ts:39-47`）。
  - token 权限（`forge.md:202`）：PR 读写、check/status 读、Actions 读；rerun 需要 Actions 写；merge 需要 Contents 写。
- **`archon forge check`**（`forge.md:92-128`）：
```sh
archon forge check --json --data '{"host":"github.com","operations":["pr.view","pr.create","pr.threads","pr.thread.reply","pr.thread.resolve","pr.reviews","checks.state","checks.logs","checks.rerun","pr.draft","pr.ready","pr.edit-body"]}'
```
  - 只检查三件事：哪个插件服务这个 host、插件是否支持所列全部 operations、凭证能否解析。**不联网**。
  - 依次可能报的错是 `no_plugin_for_host`、`unsupported_op`（并附 `unsupported` 列表）、`no_credential`、`process_failed`。
- SDLC 的 `checkForgeAccess()`（`.shared/forge-check.ts:85-108`）在 check 之后，还会对每个 git remote 执行一次 `pr.view` head selector（`head:'archon-forge-check'`）。这一步只证明有读权限，写权限要到第一次写操作才能证明。
- SDLC 的 `REQUIRED_FORGE_OPERATIONS`（:13-34）**不包含 `pr.reviews` 和 `checks.logs`**，却包含很多 workitem/label 操作。自定义 pack 应改成自己用到的列表，把 `pr.reviews` 和 `checks.logs` 加进去。
- 单独执行预检：`archon workflow run archon-forge-check`（`forge.md:211`）。
- **container 执行没有 `ARCHON_CLI_COMMAND`，forge 必然失败**（`forge.md:217`）。

---

## 8. 请求 Copilot review：Archon 不支持，以下是方案（含不确定点）

**确认不存在**：没有任何 forge op 能请求 reviewer。也没有 forge op 能看到 "requested reviewers"，或者看到正在进行中的（PENDING）review，因为 `pr.reviews` 会过滤 `PENDING`（`pull-requests.ts:397`）。

**请求方式**（来自网络资料，未在本机验证）：
- `gh pr edit <N> --repo owner/repo --add-reviewer @copilot`。需要 **gh ≥ v2.88.0**（GitHub Changelog 2026-03-11），`@` 不能省。
- REST 方式：`gh api -X POST repos/{owner}/{repo}/pulls/{N}/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`。REST 里 reviewer 名为 `copilot-pull-request-reviewer[bot]`，**中等置信度**。
- 网络资料还提到一个带 effort 参数的端点 `POST repos/{o}/{r}/pulls/{N}/copilot-code-review -f review_effort=balanced`，**低置信度，必须实测**。
- 已知风险：
  - 有报告称 Copilot 已 review 过之后，再次 `--add-reviewer` 不一定触发新 review。后续评论说用个人 PAT 可以（community discussion #186152）。
  - GitHub App 或 installation token 可能无法请求 Copilot，**不确定**。
  - 请求者需要有 Copilot code review 权限（Copilot 席位或组织策略）。
  - 新 push 后 Copilot 不会自动重审，除非 ruleset 开启了 "review new pushes"。所以**每轮 push 后都要重新请求**。
  - 对 draft PR 能否手动请求，**未确认，需实测**。自动 review 默认会跳过 draft。

**判断"当前 head 的 Copilot review 已完成"**（基于 Archon 的数据形状，置信度较高）：
- 用 `pr.view` 拿到 `pr.head_revision`，再用 `pr.reviews` 找满足以下条件的条目：
  - `kind === 'review'`
  - `author?.type === 'bot'`
  - `author.login` 属于 Copilot 登录名集合（精确比较，不区分大小写）
  - `commit === head_revision`
- 登录名在不同接口里不同：
  - REST（pr.reviews）是 `copilot-pull-request-reviewer[bot]`。
  - GraphQL（pr.threads 的 comment author）是 `copilot-pull-request-reviewer`，没有 `[bot]` 后缀。
  - 第三方扩展 k1LoW/gh-copilot-review 用的集合是 `copilot-pull-request-reviewer` 加 `copilot`（`internal/github/github.go:15-17`）。
- Copilot review 的 `state` 通常是 `COMMENTED`，它一般不会 APPROVE 或 REQUEST_CHANGES（**中等置信度**）。
- "已请求但尚未完成"无法通过 Archon 判断，需要用 `gh api repos/{o}/{r}/pulls/{N}/requested_reviewers --jq '.users[].login'` 查看 Copilot 是否仍在列表中（**不确定其 login 写法，可能是 `Copilot`**）。
- Copilot 有一部分发现只出现在 review overview 正文里（所谓 "suppressed comments"），不会形成 inline thread。**只用 `pr.threads` 做门控会漏掉这些**，应把当前 head 的 Copilot review `body` 也交给 agent 判断。

**建议的 script 节点**（可复制；依赖 `archon:script` 和复制过来的 `.shared/pr.ts`、`identity.ts`、`inputs.ts`）：
```ts
// request-copilot.ts —— bound input: INPUTS_PR (PrRecord JSON)
import { emit, input, refuse } from 'archon:script';
import { nullableJson } from '../../.shared/inputs.ts';
import type { PrRecord } from '../../.shared/identity.ts';
const pr = nullableJson(input('pr')) as PrRecord;
const run = Bun.spawnSync(['gh', 'pr', 'edit', String(pr.number), '--repo', pr.repo.path, '--add-reviewer', '@copilot'],
  { env: process.env, stdout: 'pipe', stderr: 'pipe' });
if (run.exitCode !== 0) refuse(`gh pr edit --add-reviewer @copilot failed (exit ${run.exitCode}): ${run.stderr.toString().trim()}`);
else emit({ requested: true, head: pr.head_revision });
```
```ts
// copilot-status.ts —— 轮询一次并输出结构化结果；循环由 YAML 的 loop/until 驱动
import { emit, forge, input } from 'archon:script';
import { viewPr } from '../../.shared/pr.ts';
const COPILOT = new Set(['copilot-pull-request-reviewer[bot]', 'copilot-pull-request-reviewer', 'copilot']);
const pr = JSON.parse(input('pr'));
const ref = { repo: pr.repo, number: pr.number };
const head = viewPr(ref).pr.head_revision;
const { items } = forge('pr.reviews', { ref });
const review = items.find(i => i.kind === 'review' && i.author?.type === 'bot'
  && COPILOT.has((i.author.login ?? '').toLowerCase()) && i.commit === head);
const checks = forge('checks.state', { ref });
emit({ head, copilot_done: review !== undefined, copilot_review_url: review?.url ?? null,
       checks_state: checks.summary.state, checks_revision: checks.revision });
```
**Gotcha**：`gh` 在 script 或 bash 节点里使用继承的 `GH_TOKEN`，或者 `gh` 自己的登录。per-user 模式下 token 可能被清空。对 Copilot 来说，最好使用个人 PAT 或 `gh auth login` 的用户身份。

---

## 9. 依赖关系：哪些可以复制，复制后会不会坏

| 文件 | import | 复制后 |
|---|---|---|
| `.shared/inputs.ts` | 无 | 可直接用 |
| `.shared/git.ts` | 无（只用 Bun.spawnSync） | 可直接用 |
| `.shared/identity.ts` | `archon:script`（type）、`./inputs.ts` | 可直接用 |
| `.shared/pr.ts` | `node:fs`、`archon:script`、`./identity.ts`、`./inputs.ts` | 可直接用 |
| `.shared/remote.ts` | `node:crypto`、`archon:script`、`./identity.ts`、`./git.ts` | 可直接用 |
| `.shared/push.ts` | `./identity.ts`、`./git.ts`、`./remote.ts` | 可直接用 |
| `.shared/forge-check.ts` | `archon:script`、`./remote.ts` | 可用；要改 `REQUIRED_FORGE_OPERATIONS` |
| `.shared/scripts/forge-check.ts` | `../forge-check.ts`、`archon:script` | 可用。YAML 写 `script: forge-check` 时会解析到 pack 的 `.shared/scripts/`（`workflow-language.md:94`；`script-discovery.ts:7-10`） |
| `deliver/scripts/threads.ts` | `../../.shared/{identity,inputs,pr}.ts` | 连同上述模块一起复制即可 |
| `pr/scripts/publish-pr.ts` | `../../.shared/{pr,identity,inputs,push}.ts`；用到 `HTMLRewriter` 和 `Bun.markdown`（Bun 内建） | 可用。不需要 description section 时可以删掉 :45-143 |
| `deliver/scripts/round.ts`、`report.ts` | `../../.shared/review-item.ts`、`../../.shared/report.ts`（SDLC 专用，内部依赖更多） | **不建议复制**，自己写 |

- 以上文件都不 import `@archon/*` engine package。`archon:script` 是 host 注入的模块（`module.ts:1-13`）。
- 类型检查：Archon 仓库里用 `.archon/workflows/tsconfig.json` 引用 `packages/script-api/src/archon-script.d.ts`。Java 项目里没有这个 d.ts，运行不受影响，因为 Bun 会去掉类型。但想做类型检查，就要复制这个 d.ts（它是生成文件，复制后不随 Archon 升级自动更新）。
- pack 布局规则（`pack-layout.ts:150-196`）：
  - 路径为 `.archon/workflows/<pack>/<workflow>/`，每个目录**恰好一个 .yaml**。
  - 点开头的目录（`.shared`、`.pack`）不会被当作 workflow。
  - commands 放在 `<workflow>/commands/*.md`，scripts 放在 `<workflow>/scripts/*.ts`。

---

## 10. 可以照抄的 YAML 模式（来自 archon-deliver.yaml）

```yaml
- id: rounds
  depends_on: [forge]
  loop_group:
    until_bash: |
      done=$round.output.done
      test "$done" = "true"
    max_iterations: 4
    on_exhausted: complete
    fresh_context: true
    nodes:
      - id: implement
        include: archon-implement      # 组合另一个 workflow，读 $implement.output.green
        with: { work: "…$LOOP_PREV.round.output.summary…$INPUTS.work" }
      - id: threads
        script: threads
        runtime: bun
        depends_on: [pr, review, ci, settle-threads]
        trigger_rule: none_failed_min_one_success
        with:
          pr: "$pr.output"
          answers: { from: "$settle-threads.output.answers", if_skipped: null }
        output_format: { type: object, properties: { open: { type: integer, minimum: 0 }, summary: { type: string } }, required: [open, summary] }
      - id: round                       # until_bash 读不到被 skip 的节点，因此用一个 all_done 汇总节点
        script: round
        runtime: bun
        trigger_rule: all_done
        with: { ci_state: { from: "$ci.output.state", if_skipped: null } }
```
要点如下：
- `$LOOP_PREV.<node>.output.<field>` 在第一轮为空（yaml:179-185,310）。
- 被 skip 的上游要用 `{ from: ..., if_skipped: null }`，脚本侧读到的是字符串 `"null"`（round.ts:7）。
- `until_bash` 和循环的输出都读不到被 skip 的节点，所以需要一个 `trigger_rule: all_done` 的汇总节点（yaml:302-304）。
- 只读的 agent 节点要标 `mutates_checkout: false`、`context: fresh`。
- `model: ['@ci', medium]` 是一个偏好列表，必须以 tier 或字面 model 结尾。只写 `@alias` 在 bundled 或 global workflow 里校验不通过（`workflow-language.md:3321-3323,3361`）。Pi 做交叉 review 时，节点写 `provider: pi`，模型用 `<backend>/<model-id>`（`workflow-language.md:3337`）。
- `script:` 和 `bash:` 节点默认**没有 timeout**，会一直运行到退出（`workflow-language.md:93-94`）。轮询节点务必设置 `timeout`。

---

## 11. 其他容易出问题的地方

1. `checks.state` 在刚 push 后可能返回 `summary.state:'none'`（unit 还没注册）。`none` 不等于绿，必须继续轮询。另外 `approvalPending:true` 表示 Actions 在等人批准（fork PR 常见）。
2. `checks.logs` 只对 Actions check run 有日志。commit status 和其他 app 返回 `unit_has_no_log`；运行中或已过期返回 `log_unavailable`。
3. `checks.rerun` 只能作用于 PR。默认分支 red 时无法用它 rerun（`forge.md:221`）。
4. 写操作出现 `outcome_unknown` 时，**禁止重试**，要先读回再判断（`archon-script.d.ts:2034-2037`）。
5. `pr.edit-body` 没有条件写，读到写之间别人的编辑会被覆盖（`pr.ts:140-147`）。
6. 回复和 resolve 之前必须先确认 thread id 属于这个 PR。插件也会拒绝不属于该 PR 的 thread（`forge.md:186`）。
7. 按 AGENTS.md，不要用正则解析 agent 或 vendor 的 prose 来决定 accept/decline。应由 agent 输出结构化的 `answers:[{thread,reply}]`，再由脚本执行写操作。登录名、commit SHA 这类机器 token 可以做精确比较。
8. push 永不 force，`pushHead` 只做 merge 式推送（`push.ts:6`）。implement 不能 rebase；与 base 冲突时用普通 merge commit 解决（`ci.md:11`）。

Sources:
- [Request Copilot code review from GitHub CLI - GitHub Changelog](https://github.blog/changelog/2026-03-11-request-copilot-code-review-from-github-cli/)
- [k1LoW/gh-copilot-review](https://github.com/k1LoW/gh-copilot-review)（README 和 `internal/github/github.go` 通过 raw.githubusercontent 读取）
- [community discussion #186152（re-request review）](https://github.com/orgs/community/discussions/186152)
- [cli/cli #12921](https://github.com/cli/cli/issues/12921)
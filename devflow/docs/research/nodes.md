# Archon 工作流 YAML：节点与控制流语义参考（面向 req-refine / req-deliver / req-verify 编写）

以下内容均以仓库内文档和源码为依据。文档路径相对于 `packages/docs-web/src/content/docs/`，源码路径相对于 `packages/workflows/src/`。凡标注"**不支持**"或"**gotcha**"的地方，照着最直观的写法写，要么加载失败，要么运行时行为不对。

---

## 1. 文件布局（pack 结构）

- 固定两层：`.archon/workflows/<pack>/<workflow>/<name>.yaml`，每个目录**只能有一个** YAML。
- 资源查找范围：
  - `command:` 只在本 workflow 的 `commands/` 下查找。
  - `script:` 先查本 workflow 的 `scripts/`，再查 `<pack>/.shared/scripts/`。
  - 都**不会**回退到其他 pack（reference/workflow-language.md:48）。
- `<pack>/.shared/` 只能放模块、`.md` 文档、`metric-views.json` 和 `.shared/scripts/`，**不能放 workflow**（:50）。
- 节点通过 `$PACK_DIR` 读取 pack 内的文档（bash/script 节点对应环境变量 `PACK_DIR`）。不在 pack 里的 workflow 引用 `$PACK_DIR` 会加载失败（reference/variables.md:28）。
- 同名的 repo workflow 会覆盖 bundled 和 `~/.archon/workflows/` 下的同名 workflow。

## 2. 顶层字段（schemas/workflow.ts:184-276；reference/workflow-language.md:60-77）

| 字段 | 要点 |
|---|---|
| `name` / `description` | 必填。chat 助手靠 description 选择 workflow |
| `nodes` | 必填 |
| `provider`, `model` | AI 节点的默认值。优先级：节点 > workflow > `.archon/config.yaml` 的 `assistants.*` > provider 自身默认（:3303-3308） |
| `effort`, `fallbackModel`, `betas`, `sandbox` | 节点默认值。`effort` 可选值：`minimal\|low\|medium\|high\|xhigh\|max\|ultra\|persistent` |
| `worktree: { enabled: bool }` | `false` 时始终在 live checkout 中运行。**没有顶层 `isolation:` 字段**，`isolation` 只存在于 `workflow:` 节点上（`'inherit'\|'worktree'`） |
| `container` | 容器隔离。**gotcha：container 运行会拒绝一切 `wait:`**（:817） |
| `mutates_checkout` | workflow 级字段，默认 `true`。设为 `false` 时跳过路径锁，多个 run 可共享同一 checkout |
| `resource` | `resource: build` 或 `{name, capacity}` |
| `budget` | `{max_work_units, max_spend_usd}`。**gotcha：设置了 budget 的 workflow 不能包含 `loop:`/`loop_group:`/`workflow:`/带 `fan_out` 的 `include:`，否则加载失败**（:988-990）。`max_spend_usd` 要求每个 AI attempt 都上报成本，否则 run 失败 |
| `persist_sessions` | 所有 AI 节点 `persist_session` 的默认值。**CLI `archon workflow run` 没有 conversation，persist 不生效**（:1082） |
| `requires: [github]` | 仅在 GitHub App 模式下强制 |
| `inputs` | `name: { required?, default?, description? }`，`required` 与 `default` 互斥 |
| `returns` | 一个节点 id，其输出即为 workflow 结果 |
| `outcome_field` | `returns` 节点 `output_format` 中一个 required 的 boolean 字段。**不能指向 `loop_group`**（:2037） |
| `tags`, `deprecated: {message}` | — |

已废弃或会报错的字段：
- 顶层 `interactive:`：仅警告，无效果。
- `steps:`：加载失败。
- 任何位置的 `thinking:`：加载失败，提示改用 `effort:`。
- `evidence_policy:`：加载失败（:79）。

未知 key 只告警并被丢弃。但"放错节点类型的 key"会报错，例如：
- `runtime:` 出现在非 `script` 节点上；
- `timeout:` 出现在 bash/script/loop/loop_group 以外的节点上；
- `with:` 出现在 command/script/include/workflow 以外的节点上；
- 节点顶层的 `until_bash`/`max_iterations`/`interactive`（:3363-3377）。

## 3. 节点类型与通用字段

### 3.1 节点类型（每个节点恰好一种）

`command | prompt | bash | script | loop | loop_group | wait | cancel | include | workflow`，另有已废弃的 `approval`（:89-101）。

### 3.2 通用字段（schemas/dag-node-base.ts:62-147）

- `id`, `depends_on`, `when`, `trigger_rule`, `description`
- `context`, `idle_timeout`, `retry`, `mutates_checkout`, `always_run`, `output_type`, `persist_session`

### 3.3 AI 节点（command/prompt）的额外字段

- `provider`, `model`, `output_format`, `allowed_tools`, `denied_tools`
- `hooks`（仅 Claude）, `mcp`, `skills`, `plugins`, `agents`（仅 Claude）
- `effort`, `maxBudgetUsd`（仅 Claude）, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`, `settingSources`
- `pi: { enableExtensions?, interactive?, extensionFlags? }`（schemas/provider-options.ts:69-80）

### 3.4 Pi 相关的 gotcha

- `mcp:` 只支持 Claude/Codex/Copilot。Pi 上会**在 run 开始前失败**，除非写成 `{ path, optional: true }`（:128）。
- `plugins:` 只支持 Claude/Codex，其他 provider 一律报错（:130）。
- Pi 的 `allowed_tools`/`denied_tools` 只过滤 `read,bash,edit,write,grep,find,ls`（大小写不敏感）。`allowed_tools: []` **管不住** Pi extension 工具（:672-674）。
- Pi 的 model 写法是 `<backend>/<model-id>`，例如 `google/gemini-2.5-pro`。缺 model 或 model 不在 Pi catalog 中会报 `misconfigured`；没有凭证报 `auth`（:897, :3324）。
- Pi 的 `output_format` 是 best-effort：通过 `structured_output` tool call 实现，schema 不合法时最多 reask 3 次，仍失败则**节点失败**（:621）。
- Pi 自己有重试（`~/.pi/agent/settings.json` 的 `retry.*`）。到达 Archon 的失败都归类为 `unknown`，Archon 默认不再重试（:920-931）。

### 3.5 `model` 写法（:3316-3333）

可以是：
- `small | medium | large`（tier）；
- `@alias`；
- 字面 model id（如 `sonnet`、`opus[1m]`）；
- 列表，例如 `model: ['@review-seams', '@reviewer', medium]`：取第一个已定义的 alias，否则用最后一项。

设置 alias：
- 持久：`archon ai alias set @reviewer pi google/gemini-2.5-pro`（命令形式参照文档示例 `archon ai alias set @reviewer codex gpt-6.1-sol`）。
- 单次运行：`--model @reviewer=pi/<model>`。

alias 解析出的 provider 会覆盖节点上的 `provider:`（同时告警）。

## 4. `trigger_rule`（schemas/dag-node-base.ts:23-28；:322-376）

- `all_success`（默认）
- `one_success`
- `none_failed_min_one_success`
- `all_done`

关键规则：
- 被自身 `when:` 跳过的依赖**既不算成功也不算失败**。
- 只依赖一个带 `when:` 的上游、并使用 `none_failed_min_one_success` 的节点会**永远被跳过**（loader 会告警）。正确做法是同时依赖一个无条件的上游节点（:343-367，见下方 `optional-gate` 示例）。
- skip 会向下游传播。
- `all_done` 下，**失败的生产者的输出不能被引用**：无论 `when:`、模板还是 `with:`，引用都会让当前节点失败。要读"谁失败了"，用 `$NODE_OUTCOMES_FILE`（:1455-1528）。

```yaml
  - id: gate
    depends_on: [review]
    when: "$review.output != 'ready'"
    wait: { attention: "Review found issues. Approve to continue.", form: approval }
  - id: stop
    depends_on: [gate]
    when: "$gate.output.decision == 'reject'"
    cancel: "Review issues were not approved"
  - id: next
    depends_on: [review, gate, stop]
    trigger_rule: none_failed_min_one_success
    bash: echo continue
```

## 5. `when:` 语法（:391-507；condition-evaluator.ts:1-35）

### 5.1 运算符

| 类别 | 写法 |
|---|---|
| 字符串比较 | `==`, `!=` |
| 数值比较 | `>`, `>=`, `<`, `<=`（右侧必须是数字，带不带引号都可以） |
| 逻辑组合 | `&&`, `\|\|`，`&&` 优先级高于 `\|\|` |

- **不支持括号**。`A && (B || C)` 只能展开写成 `A && B || A && C`，或者在 script 中算好一个标量再 gate。
- 右侧可以不加引号：`"$n.exit_code == 0"`、`"$n.passed == true"`。
- boolean 字段按字符串比较，`"$draft.output.blocked == 'true'"` 是官方写法（guides/loop-nodes.md:769）。

### 5.2 可引用的值

- `$id.output`、`$id.output.field`、`$id.output.a.b`（只能访问对象路径，**不能用数组下标或通配符**）。
- `$INPUTS.name`。
- `$LOOP_PREV.id.output[.field]`：只能在 loop_group body 内使用；第一轮迭代时为 `''`。
- 简写 `$id.field` 只支持单层。

### 5.3 失败模式

- **语法错误**：加载时被拒；`archon validate workflows` 也会报出。
- **引用解析失败**（undeclared 字段、未知 `$INPUTS`、把对象或数组当标量比较、引用失败的生产者）：**当前节点失败**，而不是被跳过。
- **数值比较时左值不是数字**：节点被跳过（fail-closed）。
- **gotcha（加载即拒）**：对没有 `output_format` 的 `prompt`/`command`/`loop` 节点、以及任何 `loop_group` 节点，做"整段输出"比较（`$analyze.output == 'BUG'`）会被拒绝。必须给节点加 `output_format`，再比较字段（:459-507）。bash/script 节点的整段比较是允许的。
- `include:` 块内部，`$INPUTS` 必须写在比较的**右侧**（:2138-2152）。

## 6. `output_format`（:586-646, :3136-3165）

### 6.1 校验与失败

- 对所有 provider 都会校验。
- Claude/Codex/OpenCode 由 SDK 强制约束；Pi/Copilot 最多 reask 3 次。
- 最终仍无合法输出时**节点失败**，不会降级为散文输出。
- 写 schema 的建议：每个 object 都写 `required`（或 `additionalProperties: false`），否则 validate 会告警；决策字段用 string `enum`。
- 字段访问严格：路径的每一段都必须是显式声明的 `properties`，否则加载期报错（schema 已知时）或运行期报错。
- 声明了但缺失或为 null 的字段解析为 `''`。
- `metrics` 是保留顶层 key。

### 6.2 生成器支持的关键字（`archon workflow types <pack>`）

- 支持：`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`。
- 只在运行时生效：`pattern`, `minimum`, `minItems` 等。
- 生成器拒绝：`$ref`, `allOf`, `not`, tuple `items`（:645）。

### 6.3 bash/script 节点上的 `output_format`

- stdout 必须**恰好是一个严格的 JSON 文档**：不剥离 code fence，不做修复，不 reask，不重试。不匹配时节点失败。
- 没有 `output_format` 的 bash/script 节点：`.field` 访问会尝试把 stdout 当 JSON 解析，所有嵌套 key 必须存在。

### 6.4 大结果的写法

把内容写进 `$ARTIFACTS_DIR`，结果里返回一个指针：

```json
{"type":"archon_artifact","run_id":"$WORKFLOW_ID","path":"plan.md"}
```

生产节点会校验该文件确实存在于本 run 的 artifacts 目录下（:3196-3241）。

## 7. bash / script 节点

### 7.1 stdout 与退出码（dag/nodes/exec/bash.ts:134-151；guides/script-nodes.md:82-96）

- stdout 去掉末尾一个 `\n` 后作为 `$id.output`。
- stderr 只记录日志并发到对话，**不会**让节点失败。
- **非零退出码会让节点失败**，归类为 UNKNOWN，默认**不重试**；只有设置 `retry: { max_attempts: N, on_error: all }` 才会重试。bash/script 节点没有任何自动重试。
- 设计建议：如果需要"失败也要继续分支"（例如 checkstyle 报错），**退出码用 0，输出 `{"ok":false,...}`**。
- `timeout` 单位为 ms，不设则无超时；`on_timeout: skip` 让超时变成 skipped。timeout 属于 TRANSIENT，在 `on_error: transient` 下也会重试。
- `idle_timeout` 对 bash/script 节点无效。
- script 节点**不要调用 `process.exit()`**，否则 stdout 可能被截断。用 `archon:script` 的 `emit()` 和 `refuse()`。
- 默认 cwd 是 run 的 checkout 或 worktree。

### 7.2 注入的环境变量（exec-environment.ts:48-71, :94-99）

- 路径与标识：`ARTIFACTS_DIR`, `STATE_DIR`, `LOG_DIR`, `ADOPTED_RUN_DIR`, `PACK_DIR`, `WORKFLOW_ID`, `BASE_BRANCH`
- 列表文件：`TYPED_ARTIFACTS_FILE`, `NODE_OUTCOMES_FILE`
- 运行契约：`ARCHON_RUN_ENV_KEYS`, `ARCHON_NODE_EXECUTION`
- 用户可控变量（**以环境变量形式传入，不会拼进源码**）：`ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT`, `EXTERNAL_CONTEXT`, `ISSUE_CONTEXT`
- 输入：`INPUTS_<UPPER_SNAKE>`（来自 workflow 输入和 `with:` 绑定，`-` 会转成 `_`）
- 宿主进程会带上 `ARCHON_CLI_COMMAND`（JSON argv 数组，例如 `["/path/archon"]`；paths/src/cli-command.ts:31）。调用 CLI 时用它，**不要假设 `archon` 在 PATH 上**。容器中它为空。
- 项目配置的 env（`.archon/config.yaml` 的 `env:`、`~/.archon/.env`、`<repo>/.archon/.env`）也会合并进来。目标 repo 的 `.env` **不会**加载（bun 带 `--no-env-file`）。

### 7.3 bash 中引用上游输出：先赋值，再加引号（:563-583；reference/variables.md:252-276）

```bash
status=$check.output.status      # 正确：整个引用作为不加引号的赋值右值
[ "$status" = "ok" ]
# 错误："$check.output.status" 会变成 "'ok'"（单引号成了数据的一部分）
```

- 超过 32768 字符的输出会 spill 成 `$(cat '<path>')` 的形式。
- `archon validate workflows` 会对加了引号的引用告警。

### 7.4 bash 中读取输入

- **直接运行的 workflow（`--input`）里，bash 中的 `$INPUTS.x` 不会被替换，保持字面量**（guides/loop-nodes.md:335-338）。必须读 `"$INPUTS_X"`。
- 只有在 include 块里，`$INPUTS.x` 才会展开为 `"${INPUTS_X}"`。
- inline `script:` 里写 `$INPUTS.x` 直接**加载报错**，改读 `process.env.INPUTS_X`。

### 7.5 script 节点

- `runtime: bun|uv` 必填；`deps:` 只对 uv 有效。
- inline 与 named 的判定：值中含空格、换行或 shell 元字符即视为 inline。
- bun inline 中可以直接写 `const data = $fetch.output;`（JSON 本身是合法 JS）。**不要**写 `String.raw\`$x.output\``。
- `archon:script` 模块导出：`input(name)`, `emit(v)`, `refuse(reason)`, `forge(op, req)`, `state.*`, `outcomes()`, `notice()`, `trigger.fire()`。
- `input('<name>')` 必须用字面量参数，加载期会检查绑定是否存在（guides/script-nodes.md:233-266）。
- 如果 workflow 声明了 `inputs:`，读取未绑定的 `INPUTS_*` 会**加载报错**（reference/variables.md:260）。

## 8. `with:` 绑定（:1175-1264；reference/variables.md:298-370）

- 只对 `command:`（展开为 `$INPUTS.<name>`）、`script:`（`INPUTS_<UPPER_SNAKE>`）、`include:`、`workflow:` 有效。在 `bash:`/`prompt:`/loop 上会被**忽略并告警**。
- 值的三种形式：
  - 非字符串字面量：保留原类型；
  - 恰好一个完整引用（`$n.output[.f]` 或 `$INPUTS.x`）：传逻辑值（对象就是对象）；
  - 其他字符串：作为模板做替换。
- 跳过分支的处理：`{ from: $p.output.ready, if_skipped: false }`。
  - 生产者被 skip 且没写 `if_skipped`：节点失败。
  - 生产者**失败**：无论有没有 `if_skipped`，绑定都失败。
- 被绑定的生产者必须可经 `depends_on` 到达。
- `$LOOP_PREV` 只能出现在字符串值里；`from:` 中使用 `$LOOP_PREV` 会加载报错。
- 按类型绑定（仅 script 节点）：`with: { reviews: { outputs: review-report } }` 得到一个数组 `[{node, loop, at, value}]`；所有生产者都必须声明 `output_format`。
- `"$implement.execution.checkoutStart"` 只能作为 command 或 script 节点绑定的完整值。

## 9. loop 与 loop_group

### 9.1 `loop:`（单个 prompt 迭代；guides/loop-nodes.md:87-107；schemas/loop.ts）

- `prompt` 和 `command` 二选一。
- `max_iterations` 必填。
- `on_exhausted: fail|complete`。
- `fresh_context`（默认 `false`）。
- 完成通道：`until_bash` / `until_field` / 已废弃的 `until`。至少要有一个，彼此是 OR 关系。
- 可用变量：`$LOOP_PREV_OUTPUT`。
- 在 loop 上 `hooks`/`mcp`/`skills`/`context` 会被**丢弃并告警**（:561-571）。
- `retry.on_error` 只能是 `transient`。

### 9.2 `loop_group:`（body 是子 DAG）

- 字段：`until_bash`, `max_iterations`, `on_exhausted`, `fresh_context`, `nodes`。
- 节点上的 `timeout` 只限制**每次 until_bash 的执行**，不限制 body。
- 节点上的 `provider`/`model` 作为 body 内 AI 节点的默认值。

**不支持：**
- `until_field`, `output_format`, `retry`（retry 解析即报错），跨 run 的 `persist_session`；
- body 中的 `workflow:` 节点（dag-structure.ts:421-423 报错 `'workflow' (sub-run) is not supported inside a loop_group body`）；
- `$LOOP_PREV.x.output[N]` 历史下标；
- 失败后 resume 时从第 1 轮重新开始（:1000-1002）。

body 中**可以**使用 `include:`。

**until_bash 语义**（dag/nodes/loop-group/until-bash.ts）：
- 每轮 body 跑完后执行；exit 0 表示完成，非 0 表示继续。bash 本身找不到等系统错误会直接 throw。
- cwd 是 checkout，环境与 bash 节点相同，并带有本轮新生成的 `TYPED_ARTIFACTS_FILE` 和 `NODE_OUTCOMES_FILE`。
- 通过 `$id.output[.f]` 看到**当前轮**的输出，通过 `$LOOP_PREV.*` 看到上一轮。
- 读输入用 `$INPUTS_X` 环境变量。
- 建议 until_bash 只读不写。

**body 的结构规则：**
- body 是封闭的：`depends_on` 只能指向同一 body 内的节点，但 prompt 可以引用外层节点的 `$x.output`。
- 某个 body 节点失败，整个 group 立即失败，之后的 wait/gate 全部跳过。
- **`wait`/`approval` 只能是 body 的唯一终端 sink**：没有任何节点依赖它，且其余 body 节点都通向它。否则加载报错 `wait node '<id>' must be the body's sole terminal sink`（dag-structure.ts:426-437；schemas/loop-group-body.ts:19-24）。
- **嵌套在下一层 loop_group 中的 wait 不支持**（dag-structure.ts:438-443：`wait nodes nested below another loop_group are not supported`）。外层 body 自己的终端 wait 不受影响。
- 如果终端 attention wait 没有 `when:`，而 until_bash 又没有引用 `$<wait>.output`，会告警：回答只被记录，永远不会让循环结束（parse-warnings.ts:291-327）。

**`max_iterations`**：
- 限制的是自主迭代次数。
- 每个被接受的终端 attention 回答，都允许在上限之外**再跑一轮**。
- duration/event 类 wait **不会**延长上限。

**终端 wait 带 `when:`（可选的人工 wait）时的行为**（guides/loop-nodes.md:743-776）：
- group 的输出会"越过"终端 attention wait，取它所依赖的节点的输出（schemas/loop-group-body.ts:34-43）。因此 wait 被跳过还是被回答，`$group.output` 都一样。
- **被跳过的 wait 没有输出。如果 until_bash 读取了一个可能被自身 `when:` 跳过的 wait，整个 group 失败。** 这种情况下必须根据工作节点的输出判断是否完成。
- 下一轮通过 `$LOOP_PREV.<wait>.output.text` 读取回答；上一轮 wait 被跳过时，该引用为 `''`（dag/loop-scope.ts:56-80；previous-iteration.ts:29）。

**下游读取 loop_group 输出：**
- 输出是最后一轮的原始文本，取终端节点中第一个已完成且非空的输出。
- 想用 `$group.output.field`，终端（或被越过后的）节点必须声明 `output_format`（guides/loop-nodes.md:226-255）。
- **不能**对 `$group.output` 做整段比较。
- 想汇总所有轮次：用 `output_type` 加 `with: {x: {outputs: <type>}}`，或读写 `$ARTIFACTS_DIR` 中的文件。

### 9.3 会话与 provider（gotcha，根据源码推断）

- 顺序执行的 AI 节点默认**继承**上一个节点的 session（ambient cursor），但只在同一 provider 之间继承。
- cursor 在每个节点完成后更新为该节点的 provider 和 session（dag/run-layers.ts:713-717）。
- 遇到 provider 不同的节点，会自动 fresh（dag/nodes/agent/dispatch.ts:252-283）。
- 后果：body 中依次为 `draft(claude) → review(pi)` 时，即使 `fresh_context: false`，下一轮 draft 看到的 cursor 是 Pi 的，**draft 会以 fresh session 开始**。
- 要让 Claude 的 draft 跨轮次保持同一会话，使用**命名 owner**：`context: { resume: <loop 外的 claude 节点> }`。
  - 第一轮 fork 源会话，之后各轮沿用私有分支。
  - 优先级高于 `fresh_context`。
  - 源节点必须是 command/prompt/plain loop，且 provider 相同（guides/loop-nodes.md:884-934）。
- `context: shared` 在并行层中会被拒绝。

## 10. wait 节点（:713-817；schemas/wait-node.ts:15-361）

### 10.1 条件（只能声明一种）

- `duration_ms`（上限 1000 年；开始时计算一次绝对时间并持久化）
- `until`（ISO-8601，可以包含 `$node.output` 引用）
- `event` + `deadline_ms`（必须同时声明；超时输出 `status: expired`）
- `attention`（非空字符串，可以引用 `$node.output`、`$LOOP_PREV`、`$INPUTS`；**`$ARTIFACTS_DIR` 等 workflow 变量在这里保持字面量**）

### 10.2 time/event 的输出

`{ status: satisfied|expired, waited_ms, event?, payload? }`

### 10.3 attention 的 form 与输出

| form | 输出 |
|---|---|
| `message`（默认） | `{ text }` |
| `approval` | `{ decision, text }` |
| `select` | `{ decision, text, value? }` |
| `multi_select` | `{ decisions, text }` |

### 10.4 其他字段

```yaml
wait:
  attention: "$plan.output.question"
  form: select
  options:                       # select/multi_select 必填，其他 form 上写了就报错；id 必须 kebab-case 且唯一
    - { id: use-main, label: "Base on main", does: "...", value: { base: main } }  # value 仅 select 可用
  other: true                    # 仅 select；保留 id 'other'，回答必须带 text
  recommendation: { option: use-main, why: "...", confidence: high }  # 仅 select/approval
  labels: { about: "$plan.output.topic" }
```

- `options: "$plan.output.options"` 和 `recommendation: "$plan.output.recommendation"` 可以整体引用上游输出（:787）。生产者的 schema 中，对应字段应是 `{id,label?,does?,value?}` 数组。
- `form` 必须是字面量。
- `$ask.output.value.<field>` 会**加载报错**，只能整体读取 `value`。
- wait 节点上**不能**设置 `output_format`、`retry`、`always_run`。
- 在 `approval` form 中，**`reject` 不会取消 run**。需要取消时，配合 `cancel:` 节点和 `when: "$x.output.decision == 'reject'"`。
- 第一次回答时，如果问题（消息、选项）已变化，会重问一次；之后不再比较。
- 旧的 `approval:` 节点已废弃，迁移表见 :3413-3428。

### 10.5 回答方式

```bash
archon workflow answer <run-id> --occurrence <id> --text "..."               # message
archon workflow answer <run-id> --occurrence <id> --choose reject --text "…"
archon workflow approve|reject <run-id> "text"; archon workflow respond <run-id> <option>
```

- HTTP：`POST /api/workflows/runs/<id>/answer`，body 为 `{occurrence, choose?, text?}`。
- 加 `--json` 只记录回答，不继续执行；由 `archon serve` 或 `archon workflow wake` 接续。
- 外部事件可用 `archon workflow signal` 或 `POST .../signal` 唤醒 event wait（:800-813）。

### 10.6 dry-run

attention wait 在 dry-run 中会暂停，除非 stub 中给出答案，例如 `review: { decision: approve, text: "" }`（guides/approval-nodes.md）。

## 11. cancel 节点

- 写法：`cancel: "<reason>"`（schemas/halt-node.ts）。
- 效果：终止 run，并停止正在执行的并行节点。
- **cancelled 状态的 run 不能 resume。**

## 12. 重试与超时（:821-935）

- AI 节点（command/prompt）和每一轮 loop 迭代：默认对 transient 错误重试 2 次，基础延迟 3s，指数退避。
- `retry: { max_attempts: 1-5（必填）, delay_ms: 1000-60000（loop 为 0-60000）, on_error: transient|all }`。
- FATAL 类错误（auth、quota、misconfigured、cancel）永不重试。
- bash/script 的 stdout 不满足 `output_format` 时永不重试。
- `idle_timeout` 是 AI 节点在没有任何 chunk 时的超时，默认 30 分钟（utils/idle-timeout.ts:22），超时按 TRANSIENT 处理并重试。

## 13. 其他

- **`mutates_checkout: false`（节点级）**：断言该节点不修改 checkout，事后用 git 指纹比对，发现修改则节点失败。在混合层中会导致串行执行。适合给只读的 review 节点加上。
- **`always_run: true`**：resume 时重新执行该节点，不回放缓存。
- **`output_type: <label>`**：
  - 顶层节点写入 `$ARTIFACTS_DIR/nodes/<id>.md` 和 `.meta.json`；
  - loop body 中的节点写入 `nodes/loop.<digest>__<id>.md`；
  - 按类型读取：通过 `$TYPED_ARTIFACTS_FILE` 的 `artifactsByType[type][].path`（相对 `$ARTIFACTS_DIR`）。
- **`$ARTIFACTS_DIR`**：`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`。草稿区为 `$ARTIFACTS_DIR/.archon/scratch/`，run 结束后删除。
- **`$STATE_DIR`**：项目级的跨 run 目录，无锁。并发写建议用 `archon state`。
- **`$ARGUMENTS` / `$USER_MESSAGE`**：run 的消息。在 prompt 中直接替换；在 bash/script 中只以环境变量形式提供（例如 `"$ARGUMENTS"`）。不支持 `$1..$9` 位置参数。
- **输入的传递**：`archon workflow run <wf> --input k=v "message"`。
  - `--input` 按第一个 `=` 切分；同名重复会报错。
  - `--input` 与 `--resume` 互斥。
  - 缺少 required 输入或出现未声明的 key，会在任何开销发生之前被拒绝。
- **`$BASE_BRANCH`**：无法解析时，引用它的节点失败。

## 14. 用于 req-deliver 轮询 Copilot review 和 CI 的控制流写法

可选方案：

- **A：单个 script 节点内部轮询**。设置 `timeout`（必要时加 `on_timeout: skip`），输出 JSON。简单，但会一直占用 worker。
- **B：loop_group 持久化轮询**。body 为 `poll`（script，带 `output_format`，例如 `{done, ci_green, threads_open, ...}`）后接 `nap`，`nap` 是唯一终端 sink：

  ```yaml
  nap: { when: "$poll.output.done == 'false'", wait: { duration_ms: 300000 } }
  ```

  until_bash 写 `done=$poll.output.done; [ "$done" = true ]`。注意：
  - duration wait **不会**延长 `max_iterations`，所以 `max_iterations` 就是最大轮询次数；建议加 `on_exhausted: complete`。
  - 越过终端节点取输出的逻辑只对 attention wait 和 gate 生效（loop-group-body.ts:39）。duration wait 作为终端时，`$group.output` 可能为空，下游应该读 `poll` 的 typed 输出或 artifact。
- **C：`wait: { event: pr.checks, deadline_ms: ... }`**，由外部用 `archon workflow signal` 唤醒。
- **限制：body 中不能嵌套 `workflow:` 子 run。**

## 15. 示例：草稿（AI）→ 评审（AI，另一 provider）→ 可选人工 wait，带 until_bash

**结论：结构上合法**，前提是同时满足以下四条：

1. 可选的 wait 是 body 的**唯一终端 sink**。
2. until_bash **不读取**这个 wait 的输出（它可能被 `when:` 跳过）。
3. 完成条件由 review 的结构化输出决定。
4. 草稿节点用命名 owner 保持 Claude 会话（否则每次跨过 Pi 节点后，下一轮都会 fresh）。

```yaml
name: req-refine-demo
description: Refine a requirement with Claude drafting and Pi reviewing, optional human discussion, then final approval.
provider: claude
inputs:
  jira_key: { required: true }
nodes:
  - id: explore
    prompt: |
      Explore feasibility for Jira $INPUTS.jira_key. Write findings to $ARTIFACTS_DIR/explore.md.
    output_type: exploration

  - id: refine
    depends_on: [explore]
    timeout: 120000                 # 限制每次 until_bash
    loop_group:
      max_iterations: 4
      on_exhausted: complete
      fresh_context: true
      until_bash: |
        verdict=$review.output.verdict
        ask=$review.output.needs_human
        [ "$verdict" = "approve" ] && [ "$ask" = "false" ]
      nodes:
        - id: draft
          context: { resume: explore }          # owner 会话，跨轮次保持 Claude 上下文
          prompt: |
            Update $ARTIFACTS_DIR/requirement.md.
            Reviewer feedback last round (empty on round 1): $LOOP_PREV.review.output.summary
            Human discussion last round (empty if none): $LOOP_PREV.discuss.output.text
          output_format:
            type: object
            properties: { changed: { type: boolean } }
            required: [changed]
            additionalProperties: false
        - id: review
          depends_on: [draft]
          provider: pi
          model: google/gemini-2.5-pro          # Pi: <backend>/<model-id>
          context: fresh
          allowed_tools: [read, grep, find, ls]
          prompt: Review $ARTIFACTS_DIR/requirement.md for gaps and scope tradeoffs.
          output_format:
            type: object
            properties:
              verdict: { type: string, enum: [approve, revise] }
              needs_human: { type: boolean }
              question: { type: string }
              summary: { type: string }
            required: [verdict, needs_human, question, summary]
            additionalProperties: false
        - id: discuss                            # 唯一终端 sink；可选
          depends_on: [review]
          when: "$review.output.needs_human == 'true'"
          wait:
            attention: "$review.output.question"
            form: message

  - id: final-approval
    depends_on: [refine]
    wait:
      form: approval
      attention: "Approve the requirement doc ($refine.output.summary)?"
  - id: stop
    depends_on: [final-approval]
    when: "$final-approval.output.decision == 'reject'"
    cancel: Requirement rejected at final approval.
  - id: publish
    depends_on: [final-approval]
    when: "$final-approval.output.decision == 'approve'"
    bash: |
      cp "$ARTIFACTS_DIR/requirement.md" "$ARTIFACTS_DIR/requirement.final.md"
      printf '{"path":"requirement.final.md"}'
```

说明：
- `$refine.output` 越过 `discuss` 取 `review` 的输出，因此 `$refine.output.summary` 可用（review 声明了 `output_format`）。
- `needs_human` 为 true 时，即使 `verdict` 是 approve，也会再跑一轮，让 draft 吸收人工意见。

**另一种写法：最终审批被拒后要回到修订流程。** 外层 `cancel` 无法让流程回环。有两种做法：

- **(a) 无条件终端 gate**：body 的终端改为不带 `when:` 的 `wait: {form: approval}`，until_bash 写 `decision=$gate.output.decision; [ "$decision" = approve ]`。代价是每一轮都需要人工参与。
- **(b) 双层 loop**：外层 body = `[inner(自主循环 draft↔review，无 wait), gate(终端 approval wait)]`。
  - 内层 draft 可以读取 `$LOOP_PREV.gate.output.text`。源码测试显示 body 内能读取外层作用域的 `$LOOP_PREV`（dag/nodes/loop-group/previous-iteration.test.ts:254-256）。
  - 该写法合法，因为 wait 不在内层 group 中。
  - 但嵌套 loop_group 被标注为 "not hardened in v1"（guides/loop-nodes.md:1017-1018），使用前务必先 dry-run。

## 16. 验证命令

```bash
archon validate workflows <name> [--json]
archon workflow run <name> --dry-run --stubs <file>    # 用 --stubs-init <file> 生成 stub 骨架
archon workflow test <name>                            # 回放 fixtures/
archon workflow types <pack> [--check]                 # 生成 output_format 对应的 TS 类型
archon workflow get <run-id> --verbose; archon workflow logs <run-id>
```

- 被 include 的块中的未知 key 只有在直接 validate 该块时才会报出。
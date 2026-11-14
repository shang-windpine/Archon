# Archon 运行操作与故障排查参考（供交接文档使用）

> 依据：`packages/docs-web/src/content/docs/reference/cli.md`（下称 cli.md）、`reference/troubleshooting.md`、`reference/archon-directories.md`、`guides/worktrees.md`、`reference/security.md`、`reference/database.md`、`getting-started/operate.md`、`reference/workflow-language.md`，以及 `.claude/skills/archon-cli/`（SKILL.md + `operate/*.md`）。CLI 帮助已用 `bun run cli workflow --help` 在本机源码上实际跑过，确认可用。

---

## 0. 安装与入口

- 源码 checkout 有两种用法：在仓库里跑 `bun run cli <args>`（root `package.json:10`：`"cli": "bun --cwd packages/cli src/cli.ts"`），或在 `packages/cli` 里执行 `bun link`，让 `archon` 进 PATH（cli.md:16）。
- 本机 PATH 上**没有** `archon`。工作电脑上要先 `bun install`，再 `bun link`。
- `archon --help` / `archon workflow --help` 是权威来源。skill 里写的 flag 如果被 CLI 拒绝，以 help 为准（SKILL.md "Gotchas"）。
- 除 `attention`、`test`、`wake`、`signal` 外，`workflow` 子命令都必须在 git 仓库内执行，子目录会解析到仓库根（cli.md:18）。第一次跑 workflow 时会自动注册 codebase。
- **同一 remote 的第二个 clone 不能注册**，会报 `Project "<name>" is already registered at <path>`。处理方式是加 `--project owner/repo`，或回到已注册的 checkout 去跑（cli.md:2491-2496，troubleshooting.md:398）。
- 把 archon-cli skill 装进 Java 项目：`archon skill add /path/to/java-repo`，会写入 `.claude/skills/archon-cli/` 和 `.agents/skills/archon-cli/`（cli.md:116-133）。`archon setup` 也会自动安装它。

---

## 1. 命令清单（启动 / 监控 / 回答 / 恢复 / 取消 / 放弃）

### 1.1 启动 `workflow run <name> [message]`（cli.md:287）

```bash
archon workflow run req-refine --cwd /path/to/repo --input jira=PROJ-123 "补充说明" --detach --json
archon workflow run req-deliver --branch feat/PROJ-123 --input jira=PROJ-123 --detach
archon workflow run req-verify --adopt <deliver-run-id> --detach
archon workflow run req-refine --dry-run --stubs stubs.yaml --json   # 零成本验证 DAG
```

关键 flag（cli.md:345-380 flag 表）：

| Flag | 要点 / 坑 |
|---|---|
| `--input <name>=<value>` | 每个 input 写一个 flag，按第一个 `=` 切分。缺少 required input 或用了未声明的名字，会在建 worktree 之前被拒绝。**与 `--resume` 互斥**（resume 会重放记录下来的 inputs） |
| `--detach` | 后台子进程。`--json` 回执里有 `runId`、`transcriptPath`、`logPath` |
| `--json` | **只有和 `--detach` 一起用时输出才可解析**。前台 `run --json` 仍会往 stdout 打印 `Running workflow: …`（cli.md:343） |
| `--branch, -b <name>` | 指定 worktree 分支。named branch 的 worktree 在 run 结束后**保留**。与 `--resume`、`--no-worktree` 互斥 |
| `--from <branch>` | 只改 cut-from，不改 PR target |
| `--base <branch>` | 同时设置 cut-from 和 `$BASE_BRANCH`（PR target）。**该分支必须已存在于 remote**，否则直接报错，不会回退。与 `--no-worktree`、`--folder`、`worktree.enabled: false` 不能同用 |
| `--no-worktree` | 直接在当前 checkout 运行，不做隔离。不能和 `--branch`/`--from`/`--base` 同用 |
| `--adopt <run-id>` | 在一个**已终止** run 的原 worktree/branch 上开新 run，可通过 `$ADOPTED_RUN_DIR` 读取上一 run 的 artifacts。与 `--resume/--branch/--from/--base/--no-worktree` 互斥（`packages/cli/src/commands/workflow-run-preflight.ts:443-457`）。会继承上一 run 记录的 AI 配置，再给 `--model` 或 `--config` 里的 AI 字段会被拒绝 |
| `--resume` | 按 workflow 名 + cwd 选最新的可恢复 run。与 `--branch`、`--input`、`--model`、`--config`、`--workflow-source` 互斥 |
| `--model <tier>=<spec>` / `--config <path>` | 仅对本次 run 重绑 tier 或 alias。没有 run 级别的 `--provider` |
| `--workflow-source <path>` | 从另一个目录读取 workflow/commands/scripts（仅 fresh run 可用） |
| `--quiet` / `--verbose` | 进度写到 stderr。`-v` 会额外打印 tool call |
| `--dry-run [--stubs f] [--stubs-init f] [--default-stubs] [--exec-code]` | 不建 run、不调 provider。与 `--branch/--no-worktree/--resume/--detach` 不兼容 |

**不存在的东西：**
- 没有 `archon workflow transcript` 命令，transcript 用 `workflow logs <run-id>` 看。
- `workflow list` 没有 `--verbose`，用 `--full` / `--json`。
- workflow 名必须完全一致、区分大小写，miss 时只给出建议，不会自动替你选（cli.md:581-597）。

### 1.2 发现 / 校验

```bash
archon workflow list --json                 # descriptionTruncated:true 时再用 --full
archon workflow list req-deliver --full
archon validate workflows [name] [--json]   # exit 0/1（cli.md:1780）
archon validate commands [name]
archon workflow test [name|path] [--json]   # 跑 fixtures/<x>.stubs.yaml（cli.md:196）
archon doctor                               # exit 1 = 有检查失败（cli.md:44）
```

`validate workflows` 检查的内容：YAML、DAG 环、引用、command 文件、MCP、skill 目录、provider 兼容性、tier/alias、`INPUTS_*` 环境变量读取。

**坑：未知 key 只告警并被丢弃，不会报错**（workflow-language.md:3363）。必须读 validate 输出里的 `parse_warning`。不过，把属于别的节点类型的 key 写错位置会直接 load error，例如在 prompt 节点上写 `timeout:`，或者在顶层写 `interactive:`。

### 1.3 监控

```bash
archon workflow status [--all] [--json] [--verbose]     # 只显示 running/paused（cli.md:599）
archon workflow runs [--status failed] [--limit 50] [--open] [--all] [--json --verbose]   # 所有状态（cli.md:625）
archon workflow get <run-id> [--json] [--verbose] [--verbose --events --json]   # 任意状态（cli.md:694）
archon workflow artifacts <run-id> [path] [--json]      # cli.md:941
archon workflow logs <run-id> [--follow] [--format text]   # JSONL transcript；--json 无效（cli.md:958）
archon workflow wait <run-id> --json [--timeout 900]    # cli.md:1018
archon workflow attention [--all] [--json] [--watch] [--notices]   # cli.md:1130
```

- `wait` 的退出码：`0` 表示有事要报（terminal、等待回答、attention、stalled tool、owner_lost），具体状态在 stdout；`3` 表示超时且 run 仍活着；`1` 表示 wait 本身失败。**默认没有超时。**
- `wait --json` 唤醒时的 `attention.kind` 可能是：`terminal | awaiting_response | attention | usage_limit | unreadable | stalled_tool_calls`。`owner_lost` 时 `result` 为 `owner_lost`。
- `attention --watch` 的退出码：`0` 表示被信号或关闭的 stdout 停止；`1` 表示启动失败；`4` 表示 cursor 不可读，需要重启。每一行都带 `needs`，取值为 `answer`、`look` 或 `nothing`。
- **不要对 watch 加管道过滤**（grep/head），否则行会被缓冲（managing-runs.md）。行太长时可以去掉 `--json` 改用文本形式。
- **状态不等于结论**：`completed` 的 run 也可能 `outcome: failed`。要读 `get --json` 的 `outcome`、`reason`、`leave_behind.artifactFiles`。
- run-id 短前缀（8 位）只能在该项目目录下解析；跨项目要用完整 id（cli.md:692）。

### 1.4 回答 gate 和 attention wait

```bash
archon workflow answer <id> --occurrence <occ> --text "..."                 # message
archon workflow answer <id> --occurrence <occ> --choose reject --text "..."  # approval
archon workflow answer <id> --occurrence <occ> --choose use-dev              # select
archon workflow answer <id> --occurrence <occ> --choose a --choose b --json  # multi_select
archon workflow answer <id> --occurrence <occ> --recommended --as claude-code
archon workflow respond <id> <decision|option-id> "reason" --detach
archon workflow respond <id> --recommended --occurrence <occ> [--text t] [--as n]
archon workflow approve <id> ["comment"] [--occurrence <occ>] [--detach] [--json]
archon workflow reject  <id> --reason "..." [--json]
```

- `answer` 必须带 `--occurrence`。occurrence 从 `wait --json` 的 `attention.occurrence` 或 attention item 里取（cli.md:1320）。
- **`answer` 不支持 `--detach`**（`packages/cli/src/routes/workflow.ts:100-101`：`--detach cannot be used with workflow answer`）。**`respond --recommended` 也不支持 `--detach`**（cli.md:1316）。
- **`--json` 两步陷阱**：approve/reject/respond/answer 加 `--json` 时**只记录答案，不继续执行**。之后需要以下三者之一来推进：`archon serve`、`archon workflow wake [--watch]`，或手动 `archon workflow resume <id>`（cli.md:1389，managing-runs.md:103）。
- 不加 `--json` 时，run 会在当前 shell 里内联继续执行，关掉 shell 就会中断。
- **推荐做法**：
  - select/approval 表单：`respond <id> <option> "<reason>" --detach`，回执里 `continues: true`。
  - multi_select 表单：先 `answer … --json`，再 `workflow resume <id> --detach`。
  - message 表单：`approve <id> "text" --detach`（approve 会把 text 当作 message 的答案）。
- 在 attention wait 的 `approval` 表单里，`reject` 也是一个普通答案，**不会取消 run**（workflow-language.md:751）。只有旧的 `approval:` gate 在没有 `on_reject` 和 decisions 时 reject 才会取消。
- `--as` 只对 attention wait 记录，**在 gate 上会被拒绝**。
- 子 run 的 gate 要用**子 run 的 id** 来回答，从 `get <parent> --json` 的 `.metadata.approval.childRunId` 取（cli.md:1377）。
- 第一次回答时，如果问题内容（message/options/recommendation）已经变了，引擎会丢弃旧答案并重新问一次，最多重问一次。

### 1.5 恢复 / 取消 / 放弃 / 卡住

```bash
archon workflow resume <id> [--detach] [--json]   # failed 或 paused；跳过已完成节点（cli.md:1456）
archon workflow run <name> --resume              # 按名字+cwd 选最新的可恢复 run
archon workflow cancel <id> [--json]             # 仅限 running；先停掉 owner 进程（cli.md:1472）
archon workflow abandon <id> [--json]            # paused/failed/孤儿 → cancelled（cli.md:1570）
archon workflow end-turn <id>                    # stalled_tool_calls：结束卡住的 turn，保留 run（cli.md:1644）
archon workflow wake [--watch] --json            # 无 server 时推进到期的 wait/已回答的 gate（cli.md:1686）
archon workflow wake schedule install --interval 5 --json   # macOS LaunchAgent
```

- `resume <id>` **拒绝所有 running 状态的 run**，包括陈旧的孤儿。
- 孤儿 running run（最后活动超过 1 天）的处理：先确认 owner 已死，再在它记录的工作路径下执行 `workflow run <name> --resume`。**不要先 cancel 或 abandon**，因为 cancelled 状态不可恢复（workflow-language.md:1013）。
- `cancel` 在没有 owner 应答时拒绝执行、不改任何状态，并打印 host/pid，提示你用 abandon。前台 `archon workflow run` 不能从另一个 shell cancel，只能在它自己的终端按 Ctrl-C。
- **`abandon` 会强制删除该 run 自己创建的 worktree，包括未提交、未跟踪、被 ignore 的文件**，分支会保留（cli.md:1606）。adopt 进来的或复用的 checkout 不会被删。
- 前台 run 被 Ctrl-C 后状态为 `failed`，可以恢复，`metadata.stop_reason` 记录了信号（cli.md:800）。
- **Workflow source 在 run 启动时冻结**，存放在 `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`。**resume 执行的是旧的 YAML、command 和 script**。如果失败原因是 workflow 本身的 bug，改完后 resume 不会生效，必须开 fresh run，或者用 `--adopt <旧id>` 续在同一分支上（cli.md:432-438）。
- `always_run: true` 可强制某节点在 resume 时重跑（workflow-language.md:1029）。
- cold resume 不会重建隐式的 `context: shared` 会话游标。跨节点交接请用 artifacts。

---

## 2. 磁盘位置（archon-directories.md:30-80）

```
~/.archon/                                   # ARCHON_HOME
├── .env                                     # home-scope 密钥（GH_TOKEN 等放这里）
├── config.yaml                              # 全局配置
├── archon.db                                # SQLite（未设 DATABASE_URL 时）
├── logs/detached-run-<conversationId>.log   # --detach 子进程的 stdout/stderr（workflow-detach.ts:198-200）
├── workspaces/<owner>/<repo>/
│   ├── source/
│   ├── worktrees/<branch>/                  # 默认 worktree 位置
│   ├── artifacts/runs/<run-id>/             # $ARTIFACTS_DIR
│   │   ├── .archon/{scratch,node-outcomes,typed-artifacts,node-output-spills}/
│   │   └── nodes/<id>.md + <id>.meta.json   # output_type sidecar
│   ├── logs/<run-id>.jsonl                  # run transcript
│   ├── state/                               # $STATE_DIR，跨 run 共享
│   └── workflow-source/runs/<run-id>/       # 冻结的 workflow 源
└── store/                                   # 仅当 config.yaml 写了 store: files（database.md:14）
```

- 仓库侧 `.archon/` 下的 `workflows/`、`commands/`、`scripts/`、`config.yaml` 只放源码，run 产物都不进 git。
- `.archon/config.yaml` **从启动时所在的 checkout 读取**，不是从 worktree 读取，因此未提交的配置也会生效。
- `worktree.copyFiles` **只复制你列出的 gitignored 文件**。复制 tracked 文件会让 worktree 一开始就是 dirty 状态（configuration.md:385-395）。
- `scratch/` 在 run 终止后删除，其余 artifacts 永久保留。`workflow cleanup [days]` 只删 DB 记录，不删目录。
- 不设 `DATABASE_URL` 就用 SQLite `~/.archon/archon.db`（cli.md:2528）。多进程共享同一个 SQLite 时，日志里出现 `db.sqlite_busy_waiting` 说明有进程长时间持锁（database.md:120）。

---

## 3. Worktree 隔离：基线分支、分支名，以及在当前分支或已有 PR 分支上工作

**默认行为**（cli.md:381-400，worktrees.md）：
- 生成分支名 `archon/task-<workflow>-<timestamp>`，worktree 放在 `~/.archon/workspaces/<owner>/<repo>/worktrees/`。
- 完成后，如果 worktree 干净且所有 commit 都已推到 remote，会自动移除 worktree，分支保留。
- 子 run 若用 `isolation: worktree`，分支名为 `archon/task-<parentRunId8>-<nodeId>-<hash>-child-<n>`。

**基线（cut-from）与 PR target `$BASE_BRANCH` 的优先级**（cli.md:509-570）：
1. `--base <branch>`
2. `.archon/config.yaml` 里的 `worktree.baseBranch`
3. codebase 注册时存下的 default_branch
4. remote 的 live symbolic HEAD

需要 remote 可达，且不会去猜 `main`。建议在 Java 仓库的 `.archon/config.yaml` 里显式写上：

```yaml
worktree:
  baseBranch: main        # 或 develop；该分支必须在 remote 上存在
  copyFiles: ['.env']     # 仅 gitignored
  postCreate:
    - ./mvnw -q -DskipTests dependency:go-offline
  postCreateTimeout: 600000
```

- `postCreate` 里任一命令非零退出，worktree 创建就失败（worktrees.md "Provision"）。
- continuation（resume、approved gate）沿用**首次记录的** `$BASE_BRANCH`。
- isolated 子 run 不继承父 run 的 `--base`/`--from`。

**`--branch <name>` 的语义**（cli.md:389-398，`packages/isolation/src/providers/worktree/branches.ts:384-500`）：
- 优先复用 Archon 已登记的同分支健康 worktree，或目标路径上已有的可用 checkout。复用前会校验该 checkout 确实在这个分支上，否则拒绝。
- 分支已存在但没有 worktree 持有时，在它的现有 head 上 checkout：
  - 只存在于 remote：fetch 下来并 `--track` 创建本地分支。
  - remote 领先：fast-forward 本地分支。
  - 本地与 remote **分叉**：直接失败。
- 已存在的分支**绝不会被重置到 base**。分支已存在时，新建 worktree 不能再用 `--from`。
- 另一个路径持有该分支时失败，错误码 `branch_checked_out`，并给出持有者路径。

**在已有 PR 分支上工作（req-deliver 的修复循环）：**
- 方法一：`archon workflow run req-deliver --branch <pr-head-branch> ...`。
- 方法二（同一需求链条的首选）：`--adopt <上一个run-id>`。它复用上一 run 的 worktree/branch，并提供 `$ADOPTED_RUN_DIR` 指向上一 run 的 artifacts。上一 worktree 已不存在时，会复用持有该分支的 checkout，或在精确的本地分支上新建一个。**它不会 fetch/reset/同步**，remote 有更新时要先自己同步（cli.md:575-579）。
- **在 message 里写分支名不会移动 checkout**，那只是给模型的上下文（cli.md:579）。

**在用户当前分支上工作：**
- 选项 A：`--no-worktree`，就地运行，没有隔离。worktrees.md 建议只在只读工作时用。
- 选项 B：主 checkout 先切走（`git -C <repo> switch --detach` 或切到别的分支），再 `--branch <那个分支>`。否则会触发 `branch_checked_out`。
- workflow 也可以在 YAML 里固定 `worktree: { enabled: false }`。此时 `--branch`/`--from` 会报错；反过来，`enabled: true` 时 `--no-worktree` 会报错（workflow-language.md:68）。

**清理：**

```bash
archon isolation list
archon isolation cleanup [days]          # 默认 7 天
archon isolation cleanup --merged
archon complete <branch>                 # 删除 worktree 和本地分支，保留远端分支（cli.md:2093）
```

可恢复（failed）的 run 在被 merged 清理或 stale 清理之前，worktree 受保护。worktree 一旦被删，resume 会因工作路径不存在而失败，只能开 fresh run。

---

## 4. 节点为什么失败：检查步骤

1. `archon workflow get <id>`：看 `Reason:` 行。它是第一个失败节点 error 的第一行；如果 outcome 是 failed，则是 returns 节点给出的说明（cli.md:767）。
2. `archon workflow get <id> --verbose --json | jq '.nodes[] | select(.state=="failed")'`：拿到 `error`、`exitCode`（bash/script），以及 stdout 最后 2000 字符（`output`/`outputPreview`）。`sessionIds` 可用 `claude --resume <id>` 续接，**必须在该节点的 worktree 目录下执行**（cli.md:917-928）。
3. `archon workflow get <id> --verbose --events --json | jq '.events[]'`：原始事件，含 skip 原因 `trigger_rule | when_condition | when_condition_parse_error | prior_success | timeout`。
4. `archon workflow logs <id> --format text`：适合人看的 transcript，包括每个节点的工具调用、退出码和输出尾部。
5. 直接用 jq 查 JSONL（skill troubleshooting.md:30-50）：
   ```bash
   L=~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
   jq 'select(.type=="node_error" or .type=="workflow_error")' $L
   jq 'select(.type=="exec_output" and .step=="<node-id>")' $L   # bash/script 的 stdout_tail/stderr_tail/exit_code
   jq 'select(.type=="workflow_resume" or .type=="gate_decision")' $L
   ```
   新版 transcript 里 provider 活动是 `provider_event` 行，旧版是 `assistant`/`tool` 行。loop iteration 事件**不在 JSONL 里**。
6. `archon workflow artifacts <id>`：上游节点的 artifact 往往就是问题源头。
7. `--detach` 启动的 run 如果早期就崩了，看子进程日志 `~/.archon/logs/detached-run-<conversationId>.log`，路径就是回执里的 `logPath`。

---

## 5. 常见失败与官方给出的修复

| 症状 | 原因 / 修复 | 出处 |
|---|---|---|
| `No base branch could be resolved` 或 `$BASE_BRANCH` 节点失败 | 设置 `worktree.baseBranch`，或传 `--base`。`--from` 不设置 `$BASE_BRANCH` | skill troubleshooting.md:73，variables.md:45 |
| 项目 base 指向旧的本地分支 | `UPDATE remote_agent_codebases SET default_branch = NULL WHERE id='<id>'`（只在 scratch 或确认后执行），或用 `worktree.baseBranch` 覆盖 | troubleshooting.md:452 |
| `Claude Code not found`（编译版 binary） | 安装 native 版本 `curl -fsSL https://claude.ai/install.sh \| bash`，或设置 `CLAUDE_BIN_PATH` / `assistants.claude.claudeBinaryPath`。源码模式通过 node_modules 解析，不需要 | troubleshooting.md:345 |
| 首个事件超时 | `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS=120000`（默认 60s） | troubleshooting.md:384 |
| 意外按 API 计费，或订阅认证被覆盖 | CLI 启动时会剥离 `<cwd>/.env*` 里出现的所有 key（含 `ANTHROPIC_API_KEY`）。凭据放 `~/.archon/.env`。未设 `CLAUDE_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` 时使用 `claude /login` 会话 | cli.md:2515-2525，security.md:178 |
| Pi 节点认证失败 | Pi 不能使用 Claude 订阅，需要 Pi 自己的原生登录或 key。用 `archon doctor` 检查 | cli.md:58 |
| `branch_checked_out` | 另一个 checkout 占着该分支。先确认没有活着的 run 在用，保存改动后 `git -C <holder> switch --detach` 再重试 | cli.md:393 |
| 本地分支与 remote 分叉 | 手动 reconcile，或删掉本地分支，从 remote 重新开始 | cli.md:395 |
| `Worktree at … belongs to a different clone` / 已注册 | 回到已注册的 checkout 跑，或加 `--project owner/repo` | troubleshooting.md:398 |
| 长时间 `running` 没有动静 | ① AI 确实在干活（看 JSONL 尾部）。② 孤儿行：`cancel` 会拒绝，确认后用 `abandon`；想续跑就用 `run <name> --resume`。③ `idle_timeout`（默认 30 分钟完全静默）。④ 工具调用挂住：30 分钟后出现 `stalled_tool_calls`，用 `end-turn` 处理 | skill troubleshooting.md:104 |
| `usage_limit` | provider 配额用尽，会在 reset 时自动重试；想提前就 `resume` | operate.md:44 |
| 节点被 skip | 看 `node_skipped` 的原因。`when:` 分支汇合处要用 `trigger_rule: one_success / none_failed_min_one_success / all_done` | skill troubleshooting.md:143 |
| `$node.output.field` 报错 | 字段不在 `output_format` 中，或 producer 没有运行。只有整体 `$node.output` 会静默变成 `''` | skill troubleshooting.md:154 |
| bash/script 输出为空 | 只捕获 stdout，写到 stderr 的不算 | skill troubleshooting.md:158 |
| workflow 级字段没生效 | 非法值会被告警后丢弃。看 `validate workflows`，或用 `LOG_LEVEL=debug` | skill troubleshooting.md:167 |
| 会话无法恢复 | Claude 在确认 transcript 已丢失后会用新会话重跑一次。named `context: {resume}` 不做回退，直接失败。可用 `archon workflow reset-sessions <wf> --yes` 清理 | skill troubleshooting.md:171 |
| paused 但聊天里没收到消息 | 按 id 回答：先 `workflow status`，再 approve/respond | skill troubleshooting.md:133 |

**req-deliver 设计层面的提醒**（会影响运行期行为）：
- `bash:`/`script:` 节点**默认不重试，也没有超时**（script-nodes.md:129，workflow-language.md:821）。轮询 Copilot review 或 CI 要显式写 `timeout:`，安全时再加 `retry:`。
- 不要让 agent 在一次工具调用里写 `while true; sleep` 来轮询：idle watchdog 不会触发，30 分钟后只会出现 `stalled_tool_calls`（managing-runs.md:249）。
- 有限的轮询应放进带 `timeout` 的 script 节点，或用 `loop`/`until_bash`。
- 需要人介入时用 `wait: { attention: ... }`（workflow-language.md:713-760）。

---

## 6. 恢复机制

- 恢复前提：run 是 `failed` 或 `paused`，且工作路径仍然存在。
- 已完成节点直接复用缓存输出；失败节点和未运行节点会重跑（workflow-language.md:997-1020）。
- 如果是在有意等待的节点（attention、gate、子 run）上暂停后继续，不会重放已经越过的失败。
- 一个节点一次都没完成过时，按 fresh start 处理。
- 记录下来的 inputs、AI 配置、`$BASE_BRANCH` 和冻结的源码都会复用。所以 resume 时**不能**传 `--input`、`--model`、`--config`、`--workflow-source`。
- `resume --detach` 在引擎接受恢复、清掉旧的 pause 之后才回执（60s 内）。之后应立即 `workflow wait <id> --json`。

---

## 7. 在 Claude Code 里通过 archon-cli skill 回答 attention

来源：SKILL.md "The operating loop"（第 37-80 行）和 "Hard rules"（第 82 行）。

1. 用 `archon skill add <java-repo>` 安装 skill。用户说 "use archon / approve that run" 时会触发。
2. 启动：`archon workflow run <wf> --branch <b> --input k=v "<brief>" --detach --json`，从回执里取 `runId`。
3. 用一个后台任务（Bash `run_in_background` 或 Monitor）跑 `archon workflow attention --watch --json`，覆盖整个项目，**不要接管道**。一两个 run 也可以直接用 `workflow wait <runId> --json`。**不要串联 wait**（`wait A && wait B`）。
4. 收到 `needs: "answer"` 的行后，读 `message`、`form`、`options[].does`、`recommendation`、`occurrence`。需要完整问题文本时用 `archon workflow attention <runId>`。
5. 回答，并写明理由：
   - select/approval：`archon workflow respond <runId> <option-id> "<reason>" --detach --as claude-code`
   - message：`archon workflow approve <runId> "<text>" --detach`
   - multi_select：`archon workflow answer <runId> --occurrence <occ> --choose a --choose b --text "<reason>" --json`，然后 `archon workflow resume <runId> --detach`
6. 用 `archon workflow get <runId> --json` 读 `outcome`、`reason`、`leave_behind.artifactFiles`，再用 `archon workflow artifacts <runId> <path>` 打开报告，之后才向用户汇报。
7. 硬规则：
   - 不确定的决策要上报给用户，不要擅自回答。
   - 不要用 cancel/abandon 来解除 wait 的阻塞。wait 超时了重新跑一次即可，run 本身不受影响。

---

## 8. 故障排查决策树（草稿）

```
START: 现象是什么？
├─ A. 命令立即报错、未产生 run
│   ├─ "Not in a git repository" → cd 到仓库根，或加 --cwd
│   ├─ "already registered at <path>" → 去该路径跑，或加 --project owner/repo
│   ├─ "Workflow 'x' not found" → archon workflow list --json，名字必须完全一致
│   ├─ "--X and --Y are mutually exclusive" → 见 §1.1 互斥表（adopt/resume/branch/input）
│   ├─ missing required input / undeclared input → 对照 YAML 的 inputs:，每个 input 一个 --input
│   ├─ base 分支不存在于 remote → git ls-remote origin <b>；修正 --base 或 worktree.baseBranch
│   ├─ branch_checked_out → §3：释放持有者后重试，或改用 --adopt
│   ├─ diverged → 手动 reconcile 本地和 remote 分支
│   ├─ provider / 凭据 preflight 失败 → archon doctor；修好后**重新执行原 run 命令**（没有 run 可恢复）
│   └─ 其他 → archon validate workflows <name>；archon doctor
├─ B. run 已创建，状态 failed
│   1) archon workflow get <id>（看 Reason）→ get --verbose --json（看失败节点 error/exitCode/output）
│   2) 分类：
│      ├─ 环境问题（凭据、网络、mvn/gh 不在 PATH、checkstyle 依赖缺失）→ 修环境 → archon workflow resume <id> --detach
│      ├─ workflow 本身的 bug（YAML/prompt/script 写错）→ 改源码 → validate → **fresh run**
│      │    （或 run <wf> --adopt <id> 复用同一分支）；resume 跑的是冻结的旧源码
│      ├─ $BASE_BRANCH 未解析 → 配置 worktree.baseBranch → fresh run（resume 沿用记录值，除非加 --base）
│      ├─ 首事件超时 / 瞬时 provider 错误 → ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS → resume
│      ├─ OutputRef / 字段缺失 → 修 output_format 或引用 → fresh run
│      └─ Ctrl-C 中断（Stopped: 行）→ 直接 resume
│   3) worktree 已被清理 → 只能 fresh run（或 --adopt）
├─ C. run 一直 running
│   ├─ workflow wait <id> --json
│   │   ├─ stalled_tool_calls → 看 workflow logs <id> --format text → end-turn <id>（或 cancel）
│   │   ├─ owner_lost → 确认进程已死 → abandon <id>，或在其工作路径下 run <wf> --resume
│   │   └─ waiting（无事发生）→ 跟踪 logs --follow；有新的 provider_event 就继续等
│   └─ ownerLiveness: unknown（其他 host/用户）→ 去那台机器上处理
├─ D. run 处于 paused
│   ├─ kind=attention → §7 回答（带 --occurrence）
│   ├─ kind=awaiting_response → respond/approve/reject（子 run gate 用 childRunId）
│   ├─ kind=usage_limit → 等待自动恢复，或 resume 提前
│   ├─ kind=unreadable → get --verbose 查看；修复数据后 resume，或 abandon
│   └─ 已回答但没有继续（之前用了 --json）→ workflow resume <id> --detach 或 workflow wake
├─ E. completed 但结果不对
│   ├─ outcome=failed → 看 Reason 和 artifacts 报告
│   ├─ 节点被 skip → get --verbose --events 查看 skip 原因（trigger_rule/when）
│   └─ 字段没生效 → validate workflows 查看 parse_warning（未知 key 会被丢弃）
└─ F. 一切都说不通
    archon version；validate workflows <name> 的输出；JSONL 最后 50 行；
    查 CHANGELOG.md；连同 YAML 一起到 https://github.com/coleam00/Archon/issues 提 issue
```

---

## 9. 需要写进交接文档的硬约束

1. 只有 `run … --detach --json` 的输出可以解析；前台 `run --json` 不行。
2. 加 `--json` 的回答只是记录，不会继续执行。
3. `answer` 和 `respond --recommended` 不支持 `--detach`。
4. `resume <id>` 拒绝 running 状态的 run；cancelled 状态不可恢复。
5. resume 使用冻结的旧源码；改了 workflow 必须开 fresh run 或用 `--adopt`。
6. `abandon` 会强制删除 run 自建的 worktree，未提交内容会丢失。
7. `--branch` 创建的 worktree 和分支在 run 结束后保留，需要用 `archon complete <branch>` 或 `isolation cleanup --merged` 清理。
8. Java 仓库的 `.env` 里的 key 会被剥离；GitHub 和 provider 凭据放 `~/.archon/.env`。
9. bash/script 节点默认不重试、没有超时。
10. 未知 YAML key 只告警，不报错。
11. 没有 `archon workflow transcript` 命令；`workflow list` 没有 `--verbose`。
# devflow 日常操作手册（OPERATIONS）

本文是日常使用的 runbook：一个需求从「粘贴材料」到「本地人工验证」怎么跑、怎么看、怎么回答、出错后怎么续。

- 第一次安装和配置见 [SETUP.md](SETUP.md)。
- 故障决策树（看到 X 就做 Y）见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
- 给接手 LLM 的总说明和禁改清单见 [HANDOFF.md](HANDOFF.md)。
- 设计契约见 [DESIGN.md](DESIGN.md)；本文和 DESIGN 冲突时以 DESIGN 为准，并报告冲突。
- 真实 GitHub 上跑通时的现场记录见 [E2E-REPORT.md](E2E-REPORT.md)。

> **给帮忙操作的 LLM：** 本文每条命令都对照过 CLI 源码和 `packages/docs-web/src/content/docs/reference/cli.md`。不要自己发明 flag。命令报 `unknown option` 时，以 `archon --help` 的输出为准，不要换个写法反复试。

---

## 0. 约定

### 0.1 占位符

| 占位符 | 含义 | 例子 |
|---|---|---|
| `<java-repo>` | Java 仓库**主 checkout** 的绝对路径（就是 `install.sh` 装 pack 的那个目录） | `/Users/me/work/order-service`（WSL2：`/home/me/work/order-service`；原生 Windows 的 Git Bash：`/c/Users/me/work/order-service`） |
| `<KEY>` | 需求的 key：Jira key，或自己起的 slug。必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | `ABC-123`、`fix-login-timeout` |
| `<branch>` | deliver 用的功能分支名。建议固定为 `feature/<KEY>` | `feature/ABC-123` |
| `<run-id>` | 一次 run 的完整 id（UUID）。命令里尽量用完整 id，8 位前缀只在本项目目录下能解析 | `6c057182-2205-463a-ac9a-77aa4c6c414f` |
| `<base>` | 基线分支，即 `<java-repo>/.archon/config.yaml` 里的 `worktree.baseBranch` | `main` |

### 0.2 三条总规则

1. **所有 `archon workflow ...` 命令都在 `<java-repo>` 根目录执行**（先 `cd <java-repo>`）。原因：Archon 按当前目录识别项目；`workflow status`、`workflow attention`、短 run id 都只在项目目录下按本项目解析。
2. **同一个 `<KEY>` 在三个阶段里必须一字不差。** 三个 workflow 只通过 `$STATE_DIR/devflow/<KEY>/` 下的文件交接，key 差一个字符就是另一个需求。
3. **同一个 `<KEY>` 的 deliver 永远用同一个 `--branch <branch>`。** 续跑、修 follow-up 都靠它找回原来的分支和 PR。

### 0.3 三个阶段一览

```
 人粘贴材料到 inbox/  ──►  devflow-refine  ──►  requirement.md
                         (gate: finalize/revise)
                                  │
                                  ▼
                         devflow-deliver --branch feature/<KEY>
                         (每轮: 实现→checkstyle→push→Copilot→CI→判定)
                         (escalate: continue/skip-copilot)
                                  │  delivery.json + change-summary.md
                                  ▼
                         devflow-verify ──► verify-plan.md / verify-results.md
                         (run-tests: 你测完回复)
                                  │  有失败时 followup-work.md
                                  └────────► 下一次 devflow-deliver（同一个 --branch）
```

| 阶段 | 命令 | 在哪跑 | 写什么 | 人要做什么 |
|---|---|---|---|---|
| refine | `archon workflow run devflow-refine --input key=<KEY>` | 主 checkout，只读（不建 worktree） | 只写 `$STATE_DIR` 和 run artifacts | 回答 gate（finalize/revise） |
| deliver | `archon workflow run devflow-deliver --branch <branch> --input key=<KEY>` | 新建或复用 worktree `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>` | commit、push、draft PR、回复/resolve thread、rerun check | 需要时回答 escalate |
| verify | `archon workflow run devflow-verify --input key=<KEY>` | 主 checkout，只读 | 只写 `$STATE_DIR` | 启动服务、手工测试、填结果、回复 |

pack 永远不会合并 PR，也不会把 PR 标成 ready（全程 draft）。合并由人在 GitHub 上做。

### 0.4 在 Windows 工作电脑上执行本文命令

本文的命令最初在 macOS 上写成。工作电脑是 Windows，先确认 [SETUP.md](SETUP.md) §W 选的是哪条路径：

- **Path A（WSL2）**：所有命令在 Ubuntu 终端里执行，基本原样可用。差别只有：shell profile 是 `~/.bashrc`（不是 `~/.zshrc`）；没有 `pbpaste`（见 §2.1 的替代写法）；`jq` 用 `sudo apt install jq` 安装。
- **Path B（原生 Windows）**：所有 `bash` 代码块在 **Git Bash** 里执行，不要贴进 PowerShell 或 cmd。和 macOS 的差别：

| 本文里的写法 | Path B（Git Bash）的处理 | 为什么 |
|---|---|---|
| `~/.zshrc` | `~/.bashrc` | Git Bash 是 bash |
| `pbpaste > <文件>` | `cat /dev/clipboard > <文件>`，或用记事本打开文件粘贴保存（§2.1） | Windows 没有 `pbpaste` |
| `jq -r ...` 的结果放进变量（`D=$(... \| jq -r .artifactsDir)`） | 加 `-b`：`jq -r -b ...` | Windows 的 `jq.exe` 默认输出 CRLF，变量末尾多一个看不见的 `\r`，拿它当路径会报 "No such file or directory"。旧版 jq 没有 `-b` 时改成 `\| tr -d '\r'`。只是打印到屏幕看时不用加 |
| Archon 打印的路径（`Draft:`、`Discussion log:`、`logPath` 等） | 是 `C:\Users\<你>\.archon\...` 形式。在 Git Bash 里用它时加**单引号**：`cat 'C:\Users\me\.archon\...\escalation.md'`；或者用 `archon workflow artifacts <run-id> <file>` 读，不碰路径 | 不加引号时反斜杠被 bash 当成转义符 |
| `--input brief_file=/绝对路径/xxx.md` | `--input brief_file=C:/Users/<你>/notes/xxx.md`（盘符加正斜杠） | Git Bash 对 `key=/c/...` 形式的参数是否改写不好预测；没改写时 Windows 程序找不到文件（SETUP W.4「路径的三条规则」） |
| `~/.archon/...` | 照写（Git Bash 的 `~` 就是 `%USERPROFILE%`） | |
| `/tmp/...` | 照写（Git Bash 把它映射到 `%LOCALAPPDATA%\Temp`） | |
| Ctrl-C、关闭终端窗口 | 规则和 macOS 一样：前台运行时 Ctrl-C 会把 run 记成 `failed`，关窗口会让 run 停在 `running`、没有 owner。所以启动和回答**一律加 `--detach`** | 见 §2.3、§5.3。原生 Windows 上关掉启动它的窗口后 `--detach` 的后台 run 是否存活没有在真机上验证过；关窗口后用 `archon workflow status` 确认 |

其他 Windows 注意事项：

- **电脑睡眠**：原生 Windows 上有 run 正在执行时 Archon 会阻止系统睡眠，但挡不住合盖和手动睡眠；WSL2 里没有这个机制（SETUP W.5 第 4 条）。deliver 跑 `await` 时（可能几十分钟）别让电脑睡着；paused 等回答的 run 不受睡眠影响。
- **文件占用（Path B）**：在 deliver 的 worktree 里打开 IDE、启动服务做人工测试之后，abandon、`archon complete`、`archon isolation cleanup` 会因为文件被占用而删不掉 worktree。清理前先关掉它们（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.11.6）。
- **结束卡住的进程**：用 PowerShell 的 `taskkill /PID <pid> /T /F`，只按确切的 PID，不按进程名批量杀（SETUP W.6）。

---

## 1. 找到 `$STATE_DIR`（交接目录）

`$STATE_DIR` 是项目级、跨 run、不在 git 里的目录：

```
~/.archon/workspaces/<owner>/<repo>/state/
```

每个需求的文件在 `$STATE_DIR/devflow/<KEY>/` 下。`<owner>/<repo>` 是 Archon 注册这个仓库时用的项目 key，通常就是 GitHub 上的 `owner/repo`。

把下面的函数粘进 `~/.zshrc`（WSL2 和 Git Bash 是 `~/.bashrc`；或者每次直接粘进终端）。它先查 Archon 的项目登记（最准），查不到时（仓库还没跑过任何 workflow）退回到从 `origin` 的 URL 推算：

```bash
devflow_state() {
  local top key
  top=$(git rev-parse --show-toplevel) || return 1
  key=$(archon project list --json 2>/dev/null | jq -r --arg p "$top" '.projects[]? | select(.default_cwd == $p) | .key' | tr -d '\r' | head -n 1)
  [ -n "$key" ] || key=$(git -C "$top" remote get-url origin | sed -E 's#\.git$##; s#^.*[:/]([^/]+)/([^/]+)$#\1/\2#')
  echo "${ARCHON_HOME:-$HOME/.archon}/workspaces/$key/state"
}
```

（`tr -d '\r'` 是给 Windows 的 `jq.exe` 准备的，它默认输出 CRLF；在 macOS/Linux 上不起作用，无害。）

用法和预期输出：

```bash
cd <java-repo>
devflow_state
# 预期：/Users/me/.archon/workspaces/acme/order-service/state
#   WSL2：/home/me/.archon/workspaces/acme/order-service/state
#   原生 Windows（Git Bash）：/c/Users/me/.archon/workspaces/acme/order-service/state
export STATE_DIR=$(devflow_state)
ls "$STATE_DIR/devflow/"        # 每个 KEY 一个目录；第一次用时可能不存在，正常
```

原生 Windows 上，Archon 登记的 `default_cwd` 很可能是 `C:\Users\...` 形式，而 Git Bash 里 `git rev-parse --show-toplevel` 打印 `C:/Users/...`，两者对不上时函数会走第二条路（从 `origin` URL 推算）。项目 key 就是 GitHub 的 `owner/repo` 时结果一样；用下面的交叉核对确认一次。

交叉核对（任选其一，结果应当一致）：

- `archon project list` 的 `KEY` 列就是 `<owner>/<repo>`。
- refine 暂停时打印的 `Discussion log: .../state/devflow/<KEY>/refine-log.md`，去掉 `/devflow/...` 就是 `$STATE_DIR`。
- refine 因为没有材料被拒绝时，错误信息里会打印 inbox 的完整路径。

`macOS` 自带 `jq`（`/usr/bin/jq`）。如果 `which jq` 没有输出，`brew install jq`，或只用 `archon project list` 人工读 KEY 列。Windows：WSL2 里 `sudo apt install jq`；原生 Windows 在 PowerShell 里 `winget install --id jqlang.jq -e`，然后新开 Git Bash，`command -v jq` 应打印路径（Git for Windows 不带 jq）。

---

## 2. 阶段一：devflow-refine（把材料变成最终需求）

### 2.1 准备输入

refine 从四个来源收集材料。**至少要有一个**，否则 `intake` 节点在任何模型花钱之前就拒绝；唯一的例外是状态目录里已经有以前 finalize 过的 `requirement.md`（重跑续改），这时没有新材料也不会拒绝：

| 来源 | 怎么提供 | 说明 |
|---|---|---|
| Jira | pack setting `jira_view_cmd`（默认 `jira issue view {key} --plain --comments 30`） | 只有 `<KEY>` 是 Jira key 时才有意义。命令失败只记警告（日志在 run 的 `jira-view.log`），不算致命 |
| inbox 文件 | 把 Slack 讨论、会议纪要粘贴成 `$STATE_DIR/devflow/<KEY>/inbox/*.md` | **只读 `.md` 后缀**，按文件名排序读入，每次 refine 都会**全部**重读（不会被清空或标记为已消费） |
| `brief_file` | `--input brief_file=/绝对路径/xxx.md` | 必须是绝对路径、必须存在，否则拒绝 |
| run message | 命令最后的引号字符串 | 适合一两句补充说明 |

推荐做法：Slack 内容放 inbox，按日期编号命名，追加新材料时新建文件，不要改旧文件。

```bash
cd <java-repo>
export STATE_DIR=$(devflow_state)
mkdir -p "$STATE_DIR/devflow/ABC-123/inbox"
pbpaste > "$STATE_DIR/devflow/ABC-123/inbox/01-slack-2026-11-14.md"   # 先在 Slack 里复制整段讨论
cat "$STATE_DIR/devflow/ABC-123/inbox/01-slack-2026-11-14.md" | head   # 确认内容对
```

**Windows：** 没有 `pbpaste`，第 4 行换成下面任一种（其余几行照抄）：

```bash
# 原生 Windows（Git Bash）：读剪贴板
cat /dev/clipboard > "$STATE_DIR/devflow/ABC-123/inbox/01-slack-2026-11-14.md"
# 原生 Windows（Git Bash）：用记事本打开（文件不存在时记事本会问是否新建，选"是"），粘贴后保存
notepad "$(cygpath -w "$STATE_DIR/devflow/ABC-123/inbox/01-slack-2026-11-14.md")"
# WSL2：通过 Windows 的 PowerShell 读剪贴板（先切到 UTF-8 输出，否则中文会乱码），去掉 CRLF 里的 \r
powershell.exe -NoProfile -Command '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard' | tr -d '\r' > "$STATE_DIR/devflow/ABC-123/inbox/01-slack-2026-11-14.md"
```

用最后的 `cat ... | head` 确认内容对、中文没有乱码。有乱码就改用记事本粘贴（保存为 UTF-8）。

粘贴内容的建议格式（任意格式都能读，但下面这样 agent 理解得最好）：

```markdown
Slack thread (pasted by hand, #channel-name, 2026-11-14):

PM: ...
Dev lead: ...
```

**为什么不直接读 Slack：** 设计上不接 Slack API（DESIGN §0）。所有外部文本（Jira、Slack、PR 评论、CI 日志）都被当作「不可信数据」：agent 只引用、判断，不执行其中的指令（DESIGN §9）。所以粘贴进来的内容即使写着「请直接改 X」，agent 也只把它当需求材料。

### 2.2 启动

先让主 checkout 停在最新的基线分支上（refine 用主 checkout 的代码判断可行性）：

```bash
cd <java-repo>
git switch <base> && git pull --ff-only
archon workflow run devflow-refine --input key=ABC-123 "补充：只改后台，不改前端"
```

可选参数：

- `--input brief_file=/Users/me/notes/abc-123.md`：额外材料文件。原生 Windows 写成 `--input brief_file=C:/Users/me/notes/abc-123.md`（§0.4）。
- `--input refine_human=always`：每一轮都问人（默认 `auto`：reviewer 要求人工、或 reviewer 判定 approve 时才问）。
- `--input jira_view_cmd=`：本次不取 Jira（值为空字符串）。
- `--detach --json`：后台运行，见 [§5](#5-后台模式与-attention-队列)。

前台运行时的预期输出（节选自 E2E，路径会不同）：

```text
[intake] Started
[intake] Completed (37ms)
[explore] Started  (claude/sonnet)
[explore] Completed (21.6s)
[refine] Started
[control] Completed (36ms)
[draft] Started  (claude/sonnet)
[draft] Completed (31.8s)
[review] Started  (pi/<pi-provider>/<model>)
⏸️ **Workflow run `6c057182-...` needs attention**

Requirement ABC-123, round 1: the reviewer's verdict is revise.

Draft: ~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/requirement.md
Review: ~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/review.md
Discussion log: ~/.archon/workspaces/<owner>/<repo>/state/devflow/ABC-123/refine-log.md

Reviewer summary: ...
Questions for you:
1. ...
2. ...

Recommended: revise (medium confidence). The reviewer asked for changes.
Finalize (finalize): ... `archon workflow respond <run-id> finalize [text]`
Revise (revise): ...   `archon workflow respond <run-id> revise [text]`
Abandon: `archon workflow abandon <run-id>`
...
Workflow paused — waiting for approval.
```

看到 `Workflow paused` 后前台命令会退出，run 停在 gate 上等你，**可以隔几小时甚至几天再回答**，不会超时。

每一轮做的事：

| 节点 | 模型 alias | 做什么 | 产物 |
|---|---|---|---|
| `intake` | 无（脚本） | 收集材料；有旧 `requirement.md` 时一并带入作为续改基础 | `intake.md`（artifacts + 状态目录）、`previous-requirement.md` |
| `explore` | `@devflow-main` | 只读探索仓库，判断可行性 | `feasibility.md` |
| `control` | 无 | 读上一轮你的回答，写进 `refine-log.md`，决定继续还是结束 | `refine-state.json` |
| `draft` | `@devflow-main` | 写/改需求文档 | `requirement.md`（artifacts） |
| `review` | `@devflow-cross`（推荐 Pi，另一家模型） | 独立评审，新会话（`context: fresh`），看不到 draft 的推理 | `review.md`，追加到 `refine-log.md` |
| `record` | 无 | 计算要不要问人、推荐哪个选项 | `rounds/<n>/requirement.md`、`rounds/<n>/review.md` |
| `gate` | — | 问你：finalize 还是 revise | 你的回答 |

最多 5 轮（`max_iterations: 5`）。每回答一次 gate，引擎允许多跑一轮，即使已到上限。

### 2.3 回答 refine gate

先读三样东西（路径都在暂停消息里）：

1. `Draft:` 的 `requirement.md`——这就是 deliver 和 verify 将来唯一依据的合同。
2. `Review:` 的 `review.md`——reviewer 的 findings。
3. 消息里的 `Questions for you:` 列表。

然后二选一：

| 你想要 | 命令 | 结果 |
|---|---|---|
| 再改一轮 | `archon workflow respond <run-id> revise "<你的意见>" --detach` | 意见原文追加到 `refine-log.md`；下一轮 draft 必须逐条落实，review 再评一次 |
| 就用这一版 | `archon workflow respond <run-id> finalize "<可选补充>" --detach` | 下一轮 control 看到 finalize，跳过 draft/review/gate，结束循环；文本原样写进需求文档最后的 decision log |

关于 `--detach`：不加时，`respond` 会在**当前终端里**继续跑下一轮。这时按 Ctrl-C，run 会被记为 `failed`（refine 可以 resume；deliver 按 §3.7 处理）；但**直接关掉终端窗口**时进程来不及收尾，run 会一直停在 `running`、没有 owner，`resume` 会拒绝它，要按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.7.2 处理。所以回答时一律加 `--detach`：由后台子进程继续，命令很快返回。之后用 `archon workflow wait <run-id> --json` 或 `archon workflow attention` 等下一次提问。（Windows 上同样适用：关闭 Git Bash、PowerShell 或 Windows Terminal 的窗口/标签页，等于 macOS 上关终端，见 §0.4。）

**好的 revise 意见长这样**（E2E 实际使用的回答）：

```text
Q1: the short push variant is OUT of scope for ABC-123 (track separately). Q2: yes, exact text 'Goodbye, <trimmed name>!'. Q3: yes, public static String farewell(String name). Verification is JUnit unit tests; the 'External API' here is the public Greeter methods, so the manual API plan is calling them from a JShell/test harness, no HTTP.
```

写意见的规则（附原因）：

- **按编号逐条回答 `Questions for you`**（`Q1: ...`）。原因：draft 按问题把决定写进 decision log，漏答的问题会一直留在 open questions 里，下一轮 reviewer 还会问。
- **给确定的决定，不给倾向。** 写「不在范围内」「方法名就叫 X」，不要写「可能不需要吧」。原因：模糊回答会被当成 open question。
- **对 findings 有意见时点名**，例如「finding 2 不同意，因为……」。
- **新材料可以直接写在回答里。** run 运行中不会重读 inbox（intake 只在 run 开始时跑一次）；材料很长时，结束这次 run 后把它放进 inbox 再跑一次 refine。
- **不要在回答里要求改 pack 设置或模型**，agent 改不了这些。

**什么时候选 finalize：** reviewer 判定 `approve`（消息里 `Recommended: finalize`），而且你读完 `requirement.md` 认可验收标准（AC）。只剩 minor finding 时也可以 finalize，在文本里写「minor 1/2 接受现状」，留个记录。

### 2.4 兜底的 final-gate

5 轮内一直没人选 finalize（例如 `refine_human=never` 且 reviewer 一直 revise），循环结束后会出现 `final-gate`（approval 表单）：

```text
Requirement ABC-123 was not finalized after 5 rounds. The last review's verdict is revise: ...
Approve to publish this draft as the requirement anyway; ...
Reject to cancel this run; rerun devflow-refine with the same key to continue from the discussion log.
```

| 你想要 | 命令 | 结果 |
|---|---|---|
| 用最后这版 | `archon workflow respond <run-id> approve "<可选说明>" --detach` | 发布为 `requirement.md` |
| 不要这版 | `archon workflow respond <run-id> reject "<原因>" --detach` | run 被取消（cancelled）；讨论记录都在 `refine-log.md`，用同一个 key 重跑 refine 即可接着改 |

### 2.5 完成后检查

```text
[finalize] Completed (32ms)
{"requirement_path":".../state/devflow/ABC-123/requirement.md","history_path":"","jira_comment":"skipped"}

Workflow completed successfully.
  Usage (recorded totals; completeness unknown):
    Cost: $0.479354296
```

```bash
ls "$STATE_DIR/devflow/ABC-123/"
# 预期至少有：inbox/  intake.md  refine-log.md  requirement.md
# 第二次及以后 finalize 时还有：requirement.history/<run-id>.md（被替换掉的旧版本）
```

- `jira_comment`：`skipped` 表示 `jira_comment_cmd` 为空（默认就是空，不回写 Jira）；`failed` 只是警告，需求已经发布，日志在 run artifacts 的 `jira-comment.log`。
- 需求文档内容与语言：按 policy 写的文件多为英文，结构化 summary 可能是中文（Claude 会加载你的 `~/.claude/CLAUDE.md`），这是预期行为（E2E-REPORT 第 5 条）。

### 2.6 需求变了：重跑 refine

直接用同一个 key 再跑：

```bash
pbpaste > "$STATE_DIR/devflow/ABC-123/inbox/02-slack-change-2026-11-20.md"   # Windows：换成 §2.1 的替代写法
archon workflow run devflow-refine --input key=ABC-123 "需求有变更，见 inbox/02"
```

- intake 会把现有 `requirement.md` 作为 `previous` 带入，draft 在它基础上改，不会从零写。
- `refine-log.md` 是追加式的，跨 run 保留全部讨论，draft 会读。
- finalize 时旧版自动移到 `requirement.history/<新 run-id>.md`。
- 如果 deliver 已经跑过：需求改了以后，用同一个 `--branch` 再跑 deliver（[§3.7](#37-续跑决策树)），round 1 的工单会让 agent 对照 `git log` 补齐差异。

**不要手改 `$STATE_DIR/.../requirement.md` 然后指望 refine 知道。** 手改是允许的（E2E 的 GRT-2 就是手写的 requirement.md 直接 deliver），但 refine-log 里不会有这次改动的记录。想留痕就走 refine。

---

## 3. 阶段二：devflow-deliver（实现 → draft PR → Copilot/CI 循环）

### 3.1 启动前检查清单

逐条确认，任何一条不满足，`preflight` 都会在模型花钱之前拒绝：

| 检查 | 命令 | 预期 |
|---|---|---|
| 需求已定稿 | `ls "$STATE_DIR/devflow/<KEY>/requirement.md"` | 文件存在 |
| 主 checkout **不在**功能分支上 | `git -C <java-repo> branch --show-current` | 输出 `<base>` 或其他分支，**不能是 `<branch>`** |
| 基线分支已配置 | `grep -A3 '^worktree:' <java-repo>/.archon/config.yaml` | 有 `baseBranch: <base>`，且该分支在 remote 上存在 |
| gh 已登录（`copilot_mode=request` 时） | `gh auth status --hostname github.com` | `Logged in to github.com` |
| 没有正在跑的同 KEY deliver | `archon workflow status` | 没有同一 `<branch>` 的 running/paused deliver |

**为什么主 checkout 不能在功能分支上：** git 不允许两个 checkout 同时持有一个分支。deliver 要在 worktree 里 checkout `<branch>`，主 checkout 占着它就会报 `branch_checked_out`。

**为什么必须带 `--branch`：** 不带时，Archon 会新建一个 worktree，放在自动生成的分支 `archon/task-devflow-deliver-<时间戳>` 上。preflight **不会**拒绝它，会在这个临时分支上 push 并开一个**新的** draft PR，和 `<KEY>` 原来的分支、PR 都对不上。带 `--branch feature/<KEY>`，续跑时才能找回同一个分支和 PR。（preflight 另外会拒绝 detached HEAD 和 `<base>` 分支本身，保证 pack 永远不会往基线分支 push。）

### 3.2 启动

```bash
cd <java-repo>
archon workflow run devflow-deliver --branch feature/ABC-123 --input key=ABC-123
```

推荐后台跑（一轮可能要等 Copilot 和 CI 几十分钟）：

```bash
archon workflow run devflow-deliver --branch feature/ABC-123 --input key=ABC-123 --detach --json
# 回执是一行 JSON，记下 runId；transcriptPath 是 JSONL 日志；logPath 是后台子进程的 stdout/stderr
archon workflow wait <run-id> --json       # 阻塞到 run 结束或需要你回答
```

可选参数：

| 参数 | 用途 |
|---|---|
| `--input pr=<N>` | 指定继续某个已有 PR。通常不需要：为空时会按 head 分支自动找 open PR，找不到就新开 draft PR。指定时 PR 必须是 open 状态，且 head 必须正好是 `<branch>` |
| `--input copilot_mode=off` | 本次不请求、不等 Copilot（账号没有 Copilot code review 权限时用） |
| `--input ci_wait_min=30` 等 | 任何 pack setting 都能这样单次覆盖，见 DESIGN §3 |

`--branch` 的行为：分支不存在时从 `<base>` 新建；分支已存在时**在它现有的 head 上**继续，绝不会重置到 base；本地与远端分叉时直接失败。

### 3.3 每一轮做什么

一个 run 最多 6 轮（`max_iterations: 6`）。每回答一次 escalate，允许超过上限再多跑一轮。

| 节点 | 谁 | 做什么 | 关键产物（`$ARTIFACTS_DIR` 下） |
|---|---|---|---|
| `preflight`（只在开头跑一次） | 脚本 | 校验 key/需求/设置/分支/forge 权限/gh/PR；拷贝 requirement 和未消费的 `followup-work.md`；写第一轮工单的原件 | `requirement.md`、`followup-work.md`、`work-order.round1.md`、`work-threads.round1.json`、`base-revision.txt` |
| `control` | 脚本 | 第 1 轮：把原件复制成本轮工单，清掉上一次尝试的每轮交接文件；之后各轮：合并上一轮留下的工作和你的回答，生成本轮工单；处理 `skip-copilot` | `work-order.md`、`work-threads.json`、`human-answers.md`、`copilot-skipped` |
| `implement` | `@devflow-main` | 按工单写代码、跑 focused 测试、按逻辑单元 commit（不 push、不 rebase、不 force） | git commits |
| `checkstyle` | 脚本 | 跑 `checkstyle_cmd`（和非空的 `local_verify_cmd`） | `checkstyle.log`、`local-verify.log` |
| `fix-style` | `@devflow-fast` | 只在 checkstyle 失败时：只修违规，最多 3 次 | git commits |
| `pr-text` | `@devflow-fast` | 只在还没有 PR 时：写标题和正文 | `pr-title.txt`、`pr-body.md` |
| `publish` | 脚本 | checkstyle 在 fix-style 之后仍红就**拒绝并让 run 失败**；`local_verify_cmd` 仍红时照常 push，并把失败报告给 act（下一轮修，同时问你）；push（不 force）；开 draft PR 或把被改成 ready 的 PR 改回 draft；对 implement 修好的 thread 回复 `Fixed in <sha>: <note>` 并 resolve | `thread-notes.json`、`checkstyle-final.log`、`local-verify-final.log` |
| `request-review` | 脚本 | `copilot_mode=request` 时请求 Copilot review 并确认 GitHub 真的登记了 | `copilot-request.log`、`copilot-confirm.log`、`copilot-requests.json` |
| `await` | 脚本 | 每 `poll_interval_sec` 秒轮询，直到 Copilot review 了当前 head（或超时/关闭/请求失败）且 checks 稳定（或超时）；保存快照和红色 check 的日志；检查与 base 的冲突 | `snapshot.json`、`ci-logs/<check>.log` |
| `judge-threads` | `@devflow-cross`（新会话，`context: fresh`） | 有未 resolve 的 thread 时：逐个判 `accept / decline / not_this_change / needs_human` | （结构化输出） |
| `judge-ci` | `@devflow-ci`（新会话，`context: fresh`） | 有红色 check 时：逐个判 `pr_caused / infra / flaky / unknown` | （结构化输出） |
| `act` | 脚本 | 执行判定：decline 的回复并 resolve；infra/flaky 的每个 head 只 rerun 一次；accept 的 thread、`pr_caused` 的失败、冲突、`local_verify_cmd` 的失败写进下一轮工作；算出 `done` / `ask` | `next-work.md`、`next-threads.json`、`reruns.json`、`escalation.md` |
| `escalate` | 你 | 只在 `ask=true` 时出现 | 你的回答 |

循环结束后：

| 节点 | 做什么 | 产物 |
|---|---|---|
| `summarize`（`@devflow-fast`） | 基于需求和 `git diff` 写改动摘要（模块、行为变化、UI/API 影响、风险） | `change-summary.md` |
| `finish` | 确认 PR 仍是 draft；写 `delivery.json`、`change-summary.md` 到状态目录；把用过的 `followup-work.md` 改名为 `followup-work.consumed-<时间>.md` | 状态目录文件 |

`done=true` 的条件（全部满足）：checks 全绿且针对当前 head、`required_checks` 都绿、没有被跳过（`skipped`）的 check（`allow_skipped_checks` 列出的除外；required check 永远不能被跳过）、`local_verify_cmd` 没有失败、没有未 resolve 的 thread、Copilot 已 review（或 off/skip）、无冲突、没有下一轮工作、本轮没发 rerun。

### 3.4 观察进度

| 想知道 | 命令 |
|---|---|
| 现在有哪些 run 在跑/在等 | `archon workflow status`（只显示 running/paused；加 `--verbose` 看每个节点） |
| 所有状态的最近 run | `archon workflow runs`（`--status failed` 只看失败的；`--open` 看没人接手的失败 run） |
| 某个 run 的详情和结论 | `archon workflow get <run-id>`（看 `Status`、`Authored outcome`、`Reason`）；`--verbose` 加节点表 |
| 实时跟进 | `archon workflow logs <run-id> --follow --format text` |
| 列出 / 打开 artifacts | `archon workflow artifacts <run-id>`；`archon workflow artifacts <run-id> escalation.md` |
| 直接看文件 | `ls ~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/`（原生 Windows 也可以在资源管理器打开 `%USERPROFILE%\.archon\workspaces\<owner>\<repo>\artifacts\runs\<run-id>`） |
| PR 本身 | `gh pr view <N> --web`，或 escalation 消息里的 PR URL |

注意：

- **没有 `archon workflow transcript` 命令**，transcript 用 `archon workflow logs <run-id>` 看（文件在 `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl`）。
- `await` 是一个长时间运行的脚本节点，运行期间日志里**几乎没有输出**，这是正常的。要看进度就去 GitHub 看 PR 的 checks 和 reviews。
- `snapshot.json`、`escalation.md`、`work-order.md`、`ci-logs/*.log`、`checkstyle.log` 每轮都会被覆盖，内容是**最近一轮**的（`checkstyle.log` 在 fix-style 每次重跑后也会被覆盖）。旧轮次的 CI 日志只能去 GitHub 上看。`ci-logs/` 的文件名是 check 名清洗后的结果，例如 `build (17)` 变成 `build_17_.log`，以 `snapshot.json` 里 `red_units[].log_path` 为准。
- judge、act、triage 等节点的**结构化输出**（例如 judge-ci 对每个 check 判了什么）不在 artifacts 里，读法见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §2.8。
- `status` 是执行状态，`outcome` 是结论。`completed` 的 deliver 也可能 `Authored outcome: failed`（轮数用完还没 done）。看 `archon workflow get <run-id>` 的 `Reason:` 行。
- 引擎日志里 `--input` 的值显示为 `[REDACTED]`，这是正常的（E2E-REPORT 第 6 条）。

### 3.5 回答 escalate

暂停消息长这样（E2E 的 GRT-2，路径已缩短）：

```text
⏸️ **Workflow run `9a533b3c-...` needs attention**

devflow-deliver ABC-123, round 1, needs you: requesting a Copilot review failed; status: 1 rerun(s) issued; waiting for their result; checks are red. Details and what to write in your answer: .../artifacts/runs/<run-id>/escalation.md (pull request https://github.com/<owner>/<repo>/pull/2).

Continue (continue): Run another round. Your text, if any, becomes the next round's work order. `archon workflow respond <run-id> continue [text]`
Stop waiting for Copilot (skip-copilot): For the rest of this run, do not request or wait for a Copilot review, then continue. Your text is still the work order. `archon workflow respond <run-id> skip-copilot [text]`
Abandon: `archon workflow abandon <run-id>`
```

**第一步：读 `escalation.md`**（`archon workflow artifacts <run-id> escalation.md`）。它分几节：

| 小节 | 含义 |
|---|---|
| `## Needs your decision` | **只有这里是要你决定的事** |
| `Copilot review request: ...` | Copilot 请求失败的具体原因（只在 request_failed 时出现） |
| `## Status this round` | 本轮状态（已发的 rerun、红色 check、已 decline 的 thread……），**只是信息**，不需要你处理 |
| `## Threads that need your decision` | 每个 needs_human thread：id（形如 `PRRT_...`）、URL、文件位置、judge 的理由、评论原文 |
| `## Checks whose failure cause is unknown` | 每个判不出原因的 check：日志路径、该查什么、证据 |
| `## How to answer` | 两个选项的作用 |

**第二步：选 choice。**

| `Needs your decision` 里的内容 | 选 | text 写什么 |
|---|---|---|
| `requesting a Copilot review failed`，且你的账号/仓库**没有** Copilot code review | `skip-copilot` | 可空。之后在 `.archon/packs/devflow.yaml` 设 `copilot_mode: off`，以后不再问 |
| `requesting a Copilot review failed`，但 Copilot 平时能用 | `continue` | 可空。下一轮会在同一个 head 上重试请求。先看 `escalation.md` 里的错误原因 |
| `Copilot did not review the current head in time`，你愿意再等 | `continue` | 可空。下一轮在同一 head 上再等 `copilot_wait_min` 分钟 |
| 同上，但不想再等 | `skip-copilot` | 可空 |
| thread 需要你决定 | `continue` | 逐个 thread id 写决定（见下面的例子） |
| CI 原因 unknown | `continue` | 先读 `ci-logs/<check>.log`。环境问题：去 GitHub 手工 rerun，再写「`<check>` 是环境问题，已手工 rerun」；真 bug：写清楚要改什么 |
| 同一个 check rerun 后仍红 | `continue` | 同上：判断是环境问题还是代码问题，写清楚 |
| `checks` 为 `pending_timeout` / `gated` / `none` / `unknown` | `continue` | 先去 GitHub 处理：`gated` 通常是 workflow run 需要人批准；`none` 表示没有任何 check 跑起来（检查 Actions 是否对 draft PR 跳过，见 E2E-REPORT「未能验证的部分」）。处理后写明你做了什么 |
| 「no progress」类原因（既没 done 又没工作、也没 rerun） | `continue` 并写明要做什么，或 abandon | 先读 `Status this round` 弄清卡在哪里 |

**第三步：回答。**

```bash
archon workflow respond <run-id> continue "<text>" --detach
# 或
archon workflow respond <run-id> skip-copilot "<text>" --detach
# text 可以省略：
archon workflow respond <run-id> skip-copilot --detach
```

**text 的去向：** 原文进入下一轮 `work-order.md` 的 `## Operator answer (authoritative)` 小节，给 implement 执行；同时追加到 `human-answers.md`，下一轮的 thread judge 和 CI judge 会读它，作为对 thread、check 的权威决定。choice 由 control 脚本结构化处理，**text 永远不会被脚本解析**。

好的 text 示例：

```text
Thread PRRT_kwDOVuEEms63cGHl: decline. The requirement (Scope out) defers localisation; reply that it belongs in a separate issue.
Thread PRRT_kwDOVuEEms63cXYZ: accept, add the greet(null) test it asks for.
Check it: infrastructure failure (Maven Central connection reset); I reran it on GitHub and it is green now.
```

写 text 的规则（附原因）：

- **用 `escalation.md` 里的 thread id 和 check 名点名**，一个事项一行。原因：judge 按 id 匹配，模糊描述（「那个关于本地化的评论」）可能对不上。
- **写决定和理由**，例如「decline，因为需求 Scope out 写明……」。理由会成为发到 PR 上的回复的依据。
- **不要用 text 改设置。** E2E 第一次就踩过：text 写「Copilot 不可用，别等了」，下一轮照样等满 `copilot_wait_min`。设置只能通过 choice（`skip-copilot`）或新 run 的 `--input` 改。
- **不要让 agent 合并、改 ready、force push、rebase**，pack 不允许，写了也不会执行。
- 不写 text、选 `continue`：下一轮只在有遗留工作（accepted thread、pr_caused 失败、冲突）时才跑 implement，否则只重新 push 检查、等待和判定。

**不想现在回答：** 什么都不做，run 会一直停在 escalate，没有超时。

**想彻底停掉这次 deliver：** 见 [§3.7](#37-续跑决策树)。

### 3.6 正常结束

```text
[finish] Completed (1.2s)
{"done":true,"pr_url":"https://github.com/<owner>/<repo>/pull/1","reason":"done"}

Workflow finished.
  Status: completed
  Authored outcome: succeeded
```

检查：

```bash
cat "$STATE_DIR/devflow/ABC-123/delivery.json"
```

`delivery.json` 字段：

| 字段 | 含义 |
|---|---|
| `key` | 需求 key |
| `pr.number` / `pr.url` / `pr.repo` / `pr.head` / `pr.base` / `pr.head_revision` | PR 信息；`head_revision` 是最后一次 push 的 commit SHA |
| `worktree_path` | deliver 的 worktree 路径，verify 和你的手工测试都在这里找代码 |
| `branch` | 功能分支 |
| `done` | `true`：上面 done 条件全部满足；`false`：轮数用完仍有未完成项 |
| `reason` | `done`，或 `the round cap was reached; the last round left: ...` |
| `updated_at` | 写入时间 |

`done=false` 时 run 也是 `completed`，但 `Authored outcome: failed`。读 `reason`，处理后用同一个 `--branch` 再跑一次（§3.7）。PR 保持 draft，合并由你决定。

### 3.7 续跑决策树

先看 run 的状态：`archon workflow get <run-id>`。run 是 `failed` 时，再找出失败的节点：

```bash
archon workflow get <run-id> --json --verbose | jq -r '.nodes[] | select(.state=="failed") | .nodeId'
# 原生 Windows 想把结果放进变量时加 -b（§0.4）；只看屏幕输出不用加
```

loop 里面的节点 id 一般带 `rounds.` 前缀，例如 `rounds.publish`、`rounds.await`；loop 外面的是 `preflight`、`summarize`、`finish`。看到不带前缀的 `publish`、`await`、`act`、`implement` 等，也是 loop 里的节点（每轮节点顺序见 §3.3）。

```
run 状态？
├─ paused（停在 escalate）
│    └─ 回答它（§3.5）。不要 resume，不要重新 run。
├─ running，但很久没动、或你关过终端 / 重启过机器
│    └─ 见 TROUBLESHOOTING §3.7.2（owner 可能已经没了；resume 会拒绝 running 的 run）
├─ failed
│    ├─ 原因已修好，而且 pack 代码、设置、模型 alias 都没改（环境问题：网络、gh 未登录、
│    │  mvn 不在 PATH……；或你在 worktree 里 commit 了修复）
│    │    ├─ 失败节点是 preflight / summarize / finish
│    │    │    └─ archon workflow resume <run-id> --detach
│    │    └─ 失败节点是 rounds.*（publish、await、request-review、act、implement……）
│    │         └─ archon workflow resume <run-id> --detach（循环从第 1 轮重跑，见规则 3），
│    │            或者 commit 想留的改动 → abandon → 用同一个 --branch 开新 run（不等价：新 run
│    │            丢掉本 run 的 rerun/Copilot 记录和你的回答，见规则 3）
│    └─ 你改了 pack 代码、.archon/packs/devflow.yaml、或 ~/.archon/config.yaml 的 alias
│         └─ 确认 worktree 里没有未提交的改动 → archon workflow abandon <run-id>
│            → 用同一个 --branch 开新 run
├─ completed，outcome failed（轮数用完，delivery.json done=false）
│    └─ 读 reason → 必要时加 --input 调整 → 用同一个 --branch 开新 run
├─ cancelled（你 abandon 过）
│    └─ 用同一个 --branch 开新 run
└─ completed，outcome succeeded
     └─ 有新的 follow-up（verify 写了 followup-work.md）或需求改了 → 用同一个 --branch 开新 run
```

「用同一个 `--branch` 开新 run」就是：

```bash
cd <java-repo>
archon workflow run devflow-deliver --branch feature/ABC-123 --input key=ABC-123 --detach --json
# 账号没有 Copilot 时再加：--input copilot_mode=off
```

E2E 实测过这个路径：abandon 后用同一个 `--branch` 重跑，Archon 在原分支上重建 worktree，preflight 按 head 分支找到原来的 PR，implement 对照 `git log` 判断无事可做，checks 绿 → done（E2E-REPORT「devflow-deliver GRT-1（续跑）」）。

**必须理解的四条规则：**

1. **resume 跑的是冻结的旧源码和旧设置。** run 启动时，workflow 源码（yaml、commands、scripts）冻结到 `~/.archon/workspaces/<owner>/<repo>/workflow-source/runs/<run-id>/`；pack settings、`--input`、模型配置也在启动时解析并记录在 run 上。所以改了 pack 或设置之后 `resume` **不会生效**，必须开新 run。`resume` 也不接受 `--input`、`--model`、`--branch`。想确认某个 run 实际用了什么设置值：`archon workflow get <run-id> --json | jq .metadata.inputs`（这里是未遮蔽的值；日志里显示的是 `[REDACTED]`）。
2. **`abandon` 会强制删除这次 run 创建的 worktree**，包括未提交、未跟踪、被 ignore 的文件；**分支保留**，已 commit（无论是否 push）的内容都还在（E2E-REPORT 第 4 条）。所以 abandon 前先 `git -C <worktree> status`，有想留的改动就先 commit。
3. **failed 后 resume，循环从第 1 轮重新开始**（引擎对 `loop_group` 失败恢复的规定，见 `packages/docs-web/src/content/docs/guides/loop-nodes.md`「Failure resume」）。轮次编号会从 1 再数，已完成的 `preflight` 不会重跑。第 1 轮一定会再跑一次 `implement`（花钱）。control 在每个第 1 轮把 preflight 写的原件 `work-order.round1.md`、`work-threads.round1.json` 复制成本轮工单，并删掉上一次尝试的 `next-work.md`、`next-threads.json`、`escalation.md`，所以 implement 拿到的是第 1 轮的工单（「实现需求，对照 `git log` 只补缺的部分」），不是失败前最后一轮的（[HANDOFF.md](HANDOFF.md) §8.1 第 2 条，已修）。`reruns.json`、`copilot-requests.json`、`human-answers.md`、`copilot-skipped`、`thread-notes.json` 保留：同一 head 不会重复 rerun 或重复请求 Copilot，你之前选的 `skip-copilot` 和给 judge 的回答仍然有效。还有一处差别：第 1 轮的 PR 编号来自 preflight 当时的结果，PR 是失败前才建的话这里是 0，`pr-text` 会多跑一次（publish 仍按 head 分支找到已有 PR）。
   abandon + 同一个 `--branch` 开新 run 也从第 1 轮、用正确的工单开始（新 run 的 preflight 重写原件，并按 head 分支找到已有 PR），是 E2E 实测过的路径，改了 pack 或设置时必须走这条。但它**不等价于 resume**：新 run 的 artifacts 是空的，上面保留的文件一个都没有，所以会对同一 head 再请求一次 Copilot、再 rerun 一次已 rerun 过的 check；之前的 `skip-copilot` 要重新选（或开 run 时加 `--input copilot_mode=off`），给 judge 的回答要在新 run 问你时重新给。
4. **改了 `<java-repo>/.archon/packs/devflow.yaml` 后，已存在的 worktree 里还是旧副本。** `worktree.copyFiles` 只在**新建** worktree 时复制。复用已有 worktree 的新 run 读的是 worktree 里的旧文件。最稳的做法是用 `--input name=value` 单次覆盖；或者 abandon 并确认 worktree 已删除后再开新 run（新 worktree 会重新复制）。

不要做的事：

- 不要 `archon workflow run devflow-deliver --resume --branch ...`：`--resume` 和 `--branch` 互斥。
- 不要用 `cancel`/`abandon` 来「解除等待」：paused 的 run 只需要回答。
- 不要在 run 进行中从别的地方往 `<branch>` push。publish 只做非 force 的 push，远端被别人推进过会直接失败。要手工改代码，就在 worktree 里 commit，让下一次 publish 推上去。
- 不要手工 `rm -rf` worktree 目录，用 `archon workflow abandon` 或 `archon complete`（§7）。原生 Windows 上 abandon 删 worktree 失败（文件被占用）时也不要手工删，按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.11.6 处理。

---

## 4. 阶段三：devflow-verify（本地人工测试）

### 4.1 启动

```bash
cd <java-repo>
archon workflow run devflow-verify --input key=ABC-123
```

`requirement.md` 必须存在；`delivery.json` 和 `change-summary.md` 可以没有（手工开发、没跑 deliver 时，改动从 git 读取，`context.md` 会说明）。

| 节点 | 谁 | 做什么 |
|---|---|---|
| `context` | 脚本 | 读需求、`delivery.json`、改动摘要；列出改动文件（优先 forge `pr.files`，失败时用 git）；**把上一次的 `verify-plan.md`、`verify-results.md`、`verify-report.md` 移到 `verify.history/<时间>/`**；还没被 deliver 用过的 `followup-work.md` 留在原处，`context.md` 里写一条警告 |
| `classify` | `@devflow-main` | 判断是否涉及 UI 侧、External API 侧（参考 `ui_hint` / `api_hint`） |
| `plan-ui` / `plan-api` | `@devflow-main` | 按需写测试计划。**前置条件只含测试数据**（用户、权限组、空白表单、模板……），不含启动服务、环境配置 |
| `plan-review` | `@devflow-cross`（新会话，`context: fresh`） | 对照验收标准检查计划的覆盖和可执行性 |
| `assemble` | 脚本 | 合并为 `verify-plan.md`，生成 `verify-results.md` 模板 |
| `run-tests` | 你 | 你测试并回复 |
| `triage` | `@devflow-main` | 读结果，写 `verify-report.md`；有失败时写 `followup-work.md` |

### 4.2 暂停时的消息（E2E 实际输出）

```text
⏸️ **Workflow run `53a43031-...` needs attention**

Manual verification of ABC-123 is ready. 4 manual test case(s) planned (UI 0, External API 4). The plan review found no gaps.

Test plan: .../state/devflow/ABC-123/verify-plan.md
Results file: .../state/devflow/ABC-123/verify-results.md

Start, build and configure the services and the environment yourself; ...

Answer: `archon workflow approve <run-id> <your answer>`
Abandon: `archon workflow abandon <run-id>`
```

### 4.3 测试并填写结果

1. 读 `verify-plan.md`。每个用例有 ID（`UI-1`、`API-1`……）、对应的验收标准、前置测试数据、步骤、期望结果。
2. **在 deliver 的 worktree 里启动服务**：路径是 `delivery.json` 的 `worktree_path`（`jq -r .worktree_path "$STATE_DIR/devflow/ABC-123/delivery.json"`），它就停在功能分支上。不要在主 checkout 里 `git switch <branch>`：worktree 占着这个分支，git 会拒绝；硬切换还会让下一次 deliver 报 `branch_checked_out`。worktree 已经被清理时，用 `git worktree add /tmp/abc-123-test <branch>` 临时建一个，测完 `git worktree remove /tmp/abc-123-test`。
   **Windows：** 原生 Windows 上 `worktree_path` 是 `C:\Users\<你>\.archon\workspaces\...\worktrees\feature\ABC-123` 形式，用 IDE 直接打开这个目录即可；在 Git Bash 里 `cd` 时加单引号，或用 `cd "$(jq -r -b .worktree_path "$STATE_DIR/devflow/ABC-123/delivery.json")"`。WSL2 上它是 Linux 路径，IDE 要用 WSL 方式打开（SETUP W.2）。**测完要停掉服务、关掉 IDE 里的这个项目**：原生 Windows 上它们占着 worktree 里的文件，之后 deliver 写文件、abandon 或 `archon complete` 删除 worktree 都可能失败（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.11.6）。
3. 按计划准备测试数据、执行用例。
4. 编辑 `verify-results.md`，**每个用例一行**：

```text
# Manual test results for ABC-123. Plan: .../verify-plan.md
# One line per case: <ID> | <STATUS> | <notes>
# STATUS is PASS, FAIL or BLOCKED; TODO means not run. Notes are required for FAIL and BLOCKED.
API-1 | PASS | returned "Goodbye, Ann!"
API-2 | PASS | trimmed to "Goodbye, Ann!"
API-3 | FAIL | input "\t" returned "Goodbye, !" instead of IllegalArgumentException
API-4 | BLOCKED | no test user with role AUDITOR in local DB
EXTRA-1 | FAIL | the list page shows the old label after save (outside the plan)
```

规则：

- 状态只能是 `PASS`、`FAIL`、`BLOCKED`；留着 `TODO` 表示没测。
- `FAIL` 和 `BLOCKED` 必须写备注：看到了什么、期望什么。备注会被原样引用进 `followup-work.md`，写得越具体，下一次 deliver 修得越准。
- 计划外发现的问题加一行 `EXTRA-<n> | FAIL | ...`。
- `#` 开头的行是注释，不要删模板的列格式。

### 4.4 回复 run-tests

```bash
archon workflow approve <run-id> "results are in the file" --detach
```

`run-tests` 是 message 表单，`approve <run-id> "<text>"` 会把 text 当作你的回答。也可以不填文件，直接把结果写在回答里（回答里写到的用例结果优先于文件）：

```bash
archon workflow approve <run-id> "API-1 PASS; API-2 PASS; API-3 FAIL: tab input returned 'Goodbye, !'; API-4 PASS" --detach
```

没有计划任何用例时（例如分类为既非 UI 也非 API），回答要么确认「不需要手工测试」，要么写你测了什么、发现了什么。只写「ok」会被判为未通过（not run）。

### 4.5 triage 结果与 follow-up

```bash
cat "$STATE_DIR/devflow/ABC-123/verify-report.md"     # 总数、每个用例的状态、失败的可能修复位置
ls  "$STATE_DIR/devflow/ABC-123/followup-work.md"     # 只有存在 FAIL 时才有
```

run 的结论：`Authored outcome: succeeded` 表示全部通过（`all_passed=true`）；有 FAIL、BLOCKED 或没测的用例都是 `failed`。

注意：`verify-plan.md` 之外，`verify-results.md`、`verify-report.md`、`followup-work.md` **只在状态目录里**，不在 `archon workflow artifacts <run-id>` 列出的 run artifacts 里，去 artifacts 里找会找不到。状态目录里的这几个文件不带 run id，下一次 verify 的 `context` 节点会把前三个挪进 `$STATE_DIR/devflow/<KEY>/verify.history/<时间戳>/`。要找某个旧 verify run 的报告：在 `verify.history/` 下找时间戳**不早于**该 run 结束时间的第一个目录（时间戳是 UTC，格式如 `2026-11-14T10-05-31-123Z`）；或者读该 run 的 triage 节点输出（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) §2.8）。

有 `followup-work.md` 时，下一次 deliver 会自动修它：

```bash
archon workflow run devflow-deliver --branch feature/ABC-123 --input key=ABC-123 --detach --json
```

- preflight 把 `followup-work.md` 拷进 run，round 1 工单多一节 `## Follow-up from manual testing`，implement 逐条修。
- deliver **正常走完 `finish`** 时，把它改名为 `followup-work.consumed-<时间>.md`，以后不会重复处理。deliver 中途被 abandon 或失败时不改名，下次 deliver 还会读到。
- `BLOCKED` 和没测的用例**不进** follow-up（它们需要人处理，不是改代码）。

**在 deliver 之前重跑 verify 时：** verify 的 `context` 节点**不会**移动还没被 deliver 用过的 `followup-work.md`（deliver 的 finish 会把用过的那份改名，所以还在的一定没交付过），在 `context.md` 里写一条警告，并在 `run-tests` 等你回答的提示里加一行 `Note: <路径> from an earlier verification has not been delivered yet ...`。这次 verify 有失败时，triage 用这次的清单覆盖它；这次全部通过时，旧清单仍在，下一次 deliver 会去修。如果那些失败确实已经修好，按警告手工删除 `$STATE_DIR/devflow/<KEY>/followup-work.md`。正常顺序仍是：出了 follow-up 先跑 deliver，再跑 verify。

---

## 5. 后台模式与 attention 队列

### 5.1 后台启动和等待

```bash
cd <java-repo>
archon workflow run devflow-deliver --branch feature/ABC-123 --input key=ABC-123 --detach --json
# 回执示例字段：{"ok":true, "runId":"…", "transcriptPath":"…/logs/<run-id>.jsonl", "logPath":"~/.archon/logs/detached-run-<id>.log", ...}
archon workflow wait <run-id> --json
```

`workflow wait` 的退出码描述的是命令本身，不是 run：

| 退出码 | 含义 | 下一步 |
|---|---|---|
| `0` | run 有事要报：结束了，或在等回答，或工具调用卡住，或 owner 进程丢失。看 stdout 的 `attention.kind` | `terminal`：`archon workflow get <run-id>`；`attention`：去回答 |
| `3` | 只有加了 `--timeout` 才会出现：超时了，run 仍然活着 | 再 wait 一次即可，run 不受影响 |
| `1` | wait 本身失败（run id 不对、数据库打不开） | 检查 run id |

只有 `run --detach --json` 的输出可以当 JSON 解析。前台 `run --json` 仍然会往 stdout 打印 `Running workflow: ...`。

后台 run 一启动就崩溃时，看回执里 `logPath` 指向的 `~/.archon/logs/detached-run-<id>.log`。

### 5.2 找出所有等你回答的问题

```bash
cd <java-repo>
archon workflow attention                 # 本项目所有待处理事项，每项附带回答命令
archon workflow attention <run-id>        # 某个 run 的完整问题文本
archon workflow attention --all           # 整个 Archon 安装的所有项目
archon workflow attention --watch         # 持续监听：有新问题时打印一块文字（建议单独开一个终端标签）
```

`--watch` 不要接 `grep`/`head` 之类的管道，否则输出会被缓冲住。它没有心跳，安静不代表坏了。

每个 attention 项会给出按表单生成的回答命令，形如：

- select（refine gate、deliver escalate）：`archon workflow respond <run-id> <option> --occurrence <occ> [text]`
- approval（refine final-gate）：`archon workflow respond <run-id> approve|reject --occurrence <occ> [text]`
- message（verify run-tests）：`archon workflow answer <run-id> --occurrence <occ> --text <your answer>`

`--occurrence` 是一个保险：run 已经换到别的暂停点时，答案会被拒绝，不会答错问题。可以照抄。

### 5.3 回答命令的三个陷阱

1. **`--json` 只记录答案，不会让 run 继续。** `approve`/`reject`/`respond`/`answer` 加 `--json` 后 run 停在「已回答、待继续」，需要再执行 `archon workflow resume <run-id> --detach`。日常回答**不要加 `--json`**。
2. **`answer` 不支持 `--detach`。** message 表单想后台继续，就用 `archon workflow approve <run-id> "<text>" --detach`（对 message 表单，approve 的 text 就是答案）。
3. **不加 `--detach` 时，run 在当前终端里继续执行。** Ctrl-C 会把 run 记为 `failed`（可以 resume，但 deliver 见 §3.7 规则 3）；直接关掉终端窗口时 run 会停在 `running`、没有 owner，`resume` 会拒绝，要按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.7.2 处理。Windows 上一样（§0.4）。

### 5.4 在 Claude Code 里用 archon-cli skill 回答

前提：已经按 [SETUP.md](SETUP.md) §10.4（可选步骤）执行过 `archon skill add <java-repo>`，仓库里有 `.claude/skills/archon-cli/`，并且已把它加进 `.git/info/exclude`。Windows：Claude Code 必须和 Archon 在同一侧（WSL2 就在 Ubuntu 里开 `claude`，原生就在 Windows 里开）；原生 Windows 上 Claude Code 的 Bash 工具执行的是 Git Bash，本文的 bash 命令对它同样适用（§0.4）。

在 `<java-repo>` 里打开 Claude Code，可以这样说：

```text
用 archon-cli skill：列出这个仓库里所有等待回答的 devflow run。
对每一项，给我看完整问题；deliver 的 escalate 要把 escalation.md 读出来给我看；
refine 的 gate 要总结 requirement.md 和 review.md 的要点。
然后给出你建议的选项和 text，但在我明确说「确认」之前不要执行任何回答命令。
回答时用 respond ... --detach，并加 --as claude-code。不要 cancel、abandon 或 resume 任何 run。
```

给它的边界（原因：gate 是人的决策点，DESIGN §8）：

- **决定权在你。** 让它先提议、你确认后再回答。不确定的问题它必须问你，不能自己选。
- 回答用 `archon workflow respond <run-id> <option> "<text>" --detach --as claude-code`。`--as` 只是记录回答者，方便审计哪些答案是 agent 给的。CLI 文档说 `--as` 在旧式 approval gate 上会被拒（run 保持 paused）；devflow 的四个暂停点都是 attention wait，按文档应当接受，但没有实测。**如果报错被拒，去掉 `--as` 重答一次**，不要换别的写法反复试。
- 禁止它用 `cancel`/`abandon` 来「解除阻塞」，禁止它改 pack 代码或设置来「让 run 过去」。
- 它应当用 `archon workflow get <run-id>` 读 `outcome` 和 `Reason`，再用 `archon workflow artifacts <run-id> <file>` 读报告后才向你汇报，不要只凭 status 说「成功了」。

---

## 6. 人工介入点总表

| 位置 | 什么时候出现 | 表单 | 选项 | 回答命令 | 答案去向 |
|---|---|---|---|---|---|
| `devflow-refine` → `gate` | reviewer 要求人工；或 reviewer 判 approve 请你确认；或 `refine_human=always` | select + 可选 text | `finalize` / `revise` | `archon workflow respond <run-id> revise "<意见>" --detach` | `revise`：text 追加进 `refine-log.md`，下一轮 draft 逐条落实、review 复评。`finalize`：结束循环，text 写进需求文档的 decision log，发布 `requirement.md` |
| `devflow-refine` → `final-gate` | 5 轮用完仍没人选 finalize | approval + 可选 text | `approve` / `reject` | `archon workflow respond <run-id> approve "<说明>" --detach` | `approve`：发布最后一版。`reject`：run 被取消；用同一个 key 重跑 refine 接着改 |
| `devflow-deliver` → `escalate` | 有需要人决定的事：needs_human thread、unknown CI、Copilot 请求失败或超时、checks 超时/gated/none/unknown、rerun 后仍红、check 在 draft 上被跳过、`local_verify_cmd` 失败、no progress 等（DESIGN §6 `ask`） | select + 可选 text | `continue` / `skip-copilot` | `archon workflow respond <run-id> continue "<text>" --detach` | text：进入下一轮 `work-order.md`（implement 执行）和 `human-answers.md`（两个 judge 当作权威决定）。`skip-copilot`：写 `copilot-skipped` 标记，本 run 余下部分不再请求、不再等待 Copilot |
| `devflow-verify` → `run-tests` | 总是 | message | （无选项） | `archon workflow approve <run-id> "results are in the file" --detach` | triage 读你的回答和 `verify-results.md`，写 `verify-report.md`；有失败时写 `followup-work.md` 给下一次 deliver |

所有暂停都没有超时；也都可以用 `archon workflow abandon <run-id>` 放弃（deliver 的 abandon 会删 worktree，见 §3.7）。

同一个回答有几种等价写法，文档里不同位置用了不同写法，**都是对的**，不要当成错误去"统一"：

| 写法 A | 等价的写法 B |
|---|---|
| `archon workflow respond <run-id> approve "<text>"` | `archon workflow approve <run-id> "<text>"` |
| `archon workflow respond <run-id> reject "<text>"` | `archon workflow reject <run-id> --reason "<text>"` |

（CLI help：`'approve'/'reject' are sugar for the dedicated commands`。）三个命令都支持 `--detach`；`answer` 不支持。

---

## 7. 清理

### 7.1 PR 合并之后

```bash
cd <java-repo>
git fetch --prune origin
archon complete feature/ABC-123
```

`archon complete <branch>` 删除这个分支的 worktree 和**本地**分支，**保留远端分支**（打印一条警告）。远端分支用 GitHub 的「Automatically delete head branches」，或手工 `git push origin --delete feature/ABC-123`。

原生 Windows：执行前先关掉在这个 worktree 里打开的 IDE、终端和服务，否则删除可能因文件被占用而失败（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.11.6）。

`complete` 会拒绝的情况：worktree 有未提交改动、还有 running/paused/可 resume 的 failed run 占用它、有 open 的 PR、有未推送或未合并的 commit。按提示处理，不要随手加 `--force`（`--force` 跳过这些检查，可能丢掉唯一一份 commit）。还有 paused 的 deliver 占着它时，先确认不再需要，再 `archon workflow abandon <run-id>`。

### 7.2 批量清理

```bash
archon isolation list                  # 列出所有 worktree，看分支和闲置天数
archon isolation cleanup --merged      # 删除已合并分支的 worktree（远端分支保留）
archon isolation cleanup 14            # 删除闲置超过 14 天的 worktree（默认 7）
```

注意：`--branch` 创建的 worktree 在 run 结束后**不会**自动删除。删除它的途径有三个：`archon complete <branch>`、`archon isolation cleanup`，以及 `archon workflow abandon` 这个 worktree 所属的 run（§3.7 规则 2）。还在 paused 或可 resume 的 run 的 worktree 受保护，不会被 cleanup 删。

### 7.3 状态目录和 run 记录

- `$STATE_DIR/devflow/<KEY>/` 不会被任何命令自动删除，它是需求的审计记录。确实不再需要时，在没有该 KEY 的 run 运行时手工归档或删除。
- `archon workflow cleanup [days]` 只删除数据库里的旧 run 记录（默认 7 天），**不删除** artifacts 目录和 logs 文件。

---

## 8. 上下文交接：为什么 agent 不读之前的对话

阶段之间、轮次之间不共享会话：跨 workflow 本来就是不同的 run，两个循环都设置了 `fresh_context: true`，每一轮从新会话开始。**同一轮里**则有一条引擎规则要知道：引擎只记一个「上一个顺序会话」（最近一个单独成层、已完成的 AI 节点的会话；script/bash 节点不产生会话，不改变它）。顺序执行、没写 `context:` 的 AI 节点，只在这个会话来自同一 provider 时继承它；provider 不同就开新会话，不会往前找更早的同 provider 节点。并行层会清空它，写了 `context: fresh` 的节点也开新会话。所以 `@devflow-main` 和 `@devflow-fast` 是同一 provider、且本轮 fix-style 没跑时，`pr-text` 接着 `implement` 的会话（有意允许）；fix-style 跑过时接的是 fix-style 的会话；provider 不同时从新会话开始，靠 git log/diff 写 PR 文本。四个评审/判断节点（`review`、`plan-review`、`judge-threads`、`judge-ci`）都写了 `context: fresh`，不管 alias 配成哪个 provider 都从新会话开始（[HANDOFF.md](HANDOFF.md) §2.2）。`@devflow-cross` 仍推荐用 Pi 接另一家厂商，那是为了第二视角，不是为了会话隔离。

阶段之间、轮次之间只通过文件交接：

| 文件 | 位置 | 写入者 | 读取者 | 携带什么 |
|---|---|---|---|---|
| `inbox/*.md` | 状态目录 | 你 | refine.intake | 原始材料 |
| `intake.md` | 状态目录 + artifacts | refine.intake | refine 的所有 agent | 汇总材料，带来源标注 |
| `feasibility.md` | refine artifacts | explore | draft、review | 可行性判断 |
| `refine-log.md` | 状态目录 | refine（每轮追加） | 下一轮 draft/review、以后的 refine run、你 | 每轮 review 结论和你的每次回答 |
| `requirement.md` | 状态目录 | refine.finalize | deliver、verify、以后的 refine | **唯一的合同** |
| `work-order.round1.md` | deliver artifacts | preflight | 每个第 1 轮的 control | 第 1 轮工单的原件（失败恢复从第 1 轮重跑时也用它） |
| `work-order.md` | deliver artifacts | control | implement | 本轮要做的事 |
| `next-work.md` | deliver artifacts | act | 下一轮 control | accepted thread、pr_caused 失败、冲突、`local_verify_cmd` 失败 |
| `human-answers.md` | deliver artifacts | control | judge-threads、judge-ci | 你在本 run 里的所有 escalate 回答 |
| `snapshot.json` | deliver artifacts | await | judges、act | 本轮 PR、threads、checks、Copilot 状态 |
| `change-summary.md` | 状态目录 + artifacts | deliver.summarize | verify | 改动摘要 |
| `delivery.json` | 状态目录 | deliver.finish | verify、你 | PR、分支、worktree、done |
| `verify-plan.md` / `verify-results.md` | 状态目录 | verify / 你 | 你 / verify.triage | 测试计划和结果 |
| `followup-work.md` | 状态目录 | verify.triage | 下一次 deliver | 需要修的失败 |

为什么这样设计（不要「优化」成让 agent 读历史对话）：

1. **冷启动可靠。** run 会暂停几天、失败后 resume、换一台机器继续。引擎在冷恢复时不会重建会话；文件永远在。
2. **不同 provider 之间无法共享会话。** reviewer 和 thread judge 推荐用 Pi（`@devflow-cross`），实现和 CI judge（`@devflow-ci`）用 Claude，会话格式互不相通。
3. **独立性。** review 和 judge 故意看不到作者的推理，只看产物，这样第二视角才有意义。
4. **可审计、可人工干预。** 每个决定都落在你能打开、能改的文件里。你想纠正方向，改文件或在 gate 写回答就行，不用猜某个会话里记住了什么。
5. **更便宜。** 每个节点只读它需要的最小文件集，不背整段历史。

推论：**想让下游知道一件事，就把它写进对应的文件或 gate 回答。** 在 Claude Code 里跟 agent 说过的话，下游 run 看不到。

---

## 9. 费用与耗时预期

数据来自 E2E（[E2E-REPORT.md](E2E-REPORT.md)）：`@devflow-main` 用 claude/sonnet，`@devflow-fast` 用 claude/haiku，`@devflow-ci` 用 claude/sonnet，`@devflow-cross` 用 Pi + DeepSeek；测试仓库只有一个类。Cost 是 Archon 记录的总额，命令自己会注明 `completeness unknown`；Pi 节点的费用是否计入未验证。

| 步骤 | 记录费用 | 机器耗时（不含人思考） |
|---|---|---|
| devflow-smoke | $0.01（sonnet；`@devflow-main` 用 opus 时约 $0.05） | 约 30 秒 |
| devflow-refine，2 轮 | $0.48 | 约 5 分钟：explore ~20s，每轮 draft ~30s，Pi review 1.5–2 分钟 |
| devflow-deliver，1 轮 + 1 轮无代码工作（GRT-2） | $0.27 | implement 约 10–25 秒，publish ~20 秒，request-review 2–20 秒，await 从几秒到 6.5 分钟不等 |
| devflow-deliver 续跑，无事可做（GRT-1） | $0.12 | 约 40 秒 + summarize 40 秒 |
| devflow-verify，4 个用例 | $0.39 | 约 1.5 分钟（不含你测试的时间） |

在公司仓库上的推算：

- **deliver 的时间主要花在 `await` 上。** 默认 `copilot_wait_min=30`、`ci_wait_min=90`、`poll_interval_sec=60`；`await` 节点自身的上限是 150 分钟。Copilot 永远不来时，每轮都要等满 30 分钟才会问你。所以账号没有 Copilot 时一定要设 `copilot_mode: off`，或第一次 escalate 就选 `skip-copilot`。
- 有 Copilot 权限时，`request-review` 会在约 20 秒内确认请求是否被 GitHub 登记，没登记就立刻 `request_failed` 问你，不会空等（E2E-REPORT 第 1 条）。
- `@devflow-main` 换成 opus 后费用会明显上升；真实仓库更大，explore/implement 读的代码更多，也会更贵。先用一个小需求跑一遍，在 `archon workflow get <run-id>` 里看实际费用。
- 一个 run 最多 6 轮，每轮至少一次 Copilot/CI 等待。经常跑满 6 轮说明有问题，按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 排查。

---

## 10. 操作层面的护栏（给帮忙操作的 LLM）

完整的禁改清单和修改后的验证方法在 [HANDOFF.md](HANDOFF.md)。日常操作时：

| 不要做 | 原因 | 应该做 |
|---|---|---|
| 替用户回答 gate 或 escalate | gate 是人的决策点（DESIGN §8） | 提议答案，等用户确认 |
| 用 `cancel`/`abandon` 解除等待 | abandon 会删 worktree；cancelled 无法 resume | 回答问题，或问用户 |
| 改 pack 代码让 run「过去」 | resume 跑的是冻结的旧源码，改了也没用；而且可能破坏 DESIGN §9 的不变量 | 报告问题，按 HANDOFF 的流程改并验证，然后开新 run |
| 用 escalate 的 text 改设置 | text 不会被脚本解析 | 用 `skip-copilot` 或新 run 的 `--input` |
| 手工 merge、mark ready、force push、rebase 功能分支 | pack 的不变量：PR 全程 draft、只用 merge commit、永不 force（DESIGN §9） | 合并由用户在 GitHub 上做 |
| 在主 checkout 切到功能分支 | 会让 deliver 报 `branch_checked_out` | 在 `delivery.json` 的 `worktree_path` 里操作 |
| 发明 CLI flag | 会报错或行为不同 | 查 `archon --help` 和 cli.md |
| 只看 `Status: completed` 就报告成功 | `completed` 也可能 `outcome: failed` | 读 `archon workflow get <run-id>` 的 `Authored outcome` 和 `Reason` |

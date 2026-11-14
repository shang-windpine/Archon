# devflow 工作电脑配置指南（SETUP）

本文按顺序把一台新的工作电脑（macOS + 公司 GitHub.com 上的 Java/Maven 仓库 + Jira + Claude Code + Pi）配置到可以运行 devflow 的状态。每一步都给出要执行的命令、期望输出、检查方法，以及失败时怎么处理。

- 入口与总体介绍：[../README.md](../README.md)
- 交接背景、角色分工和不变量：[HANDOFF.md](HANDOFF.md)
- 配置完成后的日常使用（启动、观察、回答、恢复）：[OPERATIONS.md](OPERATIONS.md)
- 出错后的决策树：[TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- 设计契约（以它为准）：[DESIGN.md](DESIGN.md)；开发电脑上真实跑通的记录：[E2E-REPORT.md](E2E-REPORT.md)

---

## 0. 先读：给执行本文的 LLM 的规则

### 0.1 占位符

文中出现以下占位符时，换成这台电脑上的真实值。**每条命令都写绝对路径**：在 Claude Code 里执行时，`cd` 和 shell 变量不一定能保留到下一条命令。

| 占位符 | 含义 | 例子 |
|---|---|---|
| `<ARCHON_SRC>` | Archon fork 的 clone 目录 | `/Users/you/src/Archon` |
| `<JAVA_REPO>` | 公司 Java 仓库的 clone 根目录（主 checkout） | `/Users/you/work/order-service` |
| `<OWNER>/<REPO>` | GitHub 上的仓库路径 | `acme/order-service` |
| `<BASE>` | feature 分支从哪个分支切出、PR 合回哪个分支 | `main` 或 `develop` |
| `<KEY>` | Jira key，或自己起的 slug，必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | `ABC-123`、`DEVFLOW-TEST-1` |

### 0.2 能改什么、绝对不要改什么

配置过程中，**你（执行本文的 LLM）手工编辑**的只有下面这些文件：

| 文件 | 哪一步 |
|---|---|
| `~/.archon/config.yaml`（以及 §4.1 备份出的 `config.yaml.bak`） | 4 |
| `~/.archon/.env` | 5 |
| `~/.pi/agent/models.json` | 2.6（只在用公司网关时） |
| `~/.zshrc`（或用户自己的 shell profile） | 2.7 加 `JIRA_API_TOKEN` / `JIRA_AUTH_TYPE`；3.2 加 PATH（**先问用户**） |
| `~/.local/bin/archon` | 3.2 方式 B 的 wrapper 脚本（只在 `bun link` 不生效时） |
| `<JAVA_REPO>/.archon/config.yaml` | 7 |
| `<JAVA_REPO>/.archon/packs/devflow.yaml` | 9 |

另外有些文件是**命令或脚本自己写的**，属于正常行为，不算违规，也不要去"恢复"它们：

| 文件 | 谁写的 |
|---|---|
| `~/.pi/agent/auth.json` | `pi` 的 `/login` 或 `pi auth login` |
| `~/.config/gh/`、`~/.config/.jira/` 等 | `gh auth login`、`jira init` |
| `<JAVA_REPO>/.archon/workflows/devflow/`、`<JAVA_REPO>/.archon/config.yaml`、`<JAVA_REPO>/.archon/packs/devflow.yaml`（首次） | `install.sh`（第 6 步） |
| `<JAVA_REPO>/.git/info/exclude` 末尾的 `.archon/` 一行 | `install.sh`（本机排除规则，不会提交） |
| `~/.archon/archon.db`、`~/.archon/workspaces/**`、`~/.archon/logs/**` | Archon 运行时 |
| `~/.archon/config.yaml`（只有注释的版本） | `archon doctor` 等命令第一次运行时自动生成 |
| `/tmp/devflow-probe`、`/tmp/jira-view.txt` 等 | 本文的一次性测试步骤 |

以下内容不要改。即使看起来"顺手修一下"更方便，也不要动：

| 不要改 | 为什么 |
|---|---|
| `<ARCHON_SRC>/packages/**`（Archon 引擎代码） | devflow 只是运行在引擎上的 pack。改引擎会破坏升级，也会让开发电脑上验证过的行为失效。引擎有问题就记录下来报告 |
| `<ARCHON_SRC>/devflow/pack/**`、`<JAVA_REPO>/.archon/workflows/devflow/**`（pack 的 YAML、command、script） | 配置阶段遇到的问题几乎都能靠 settings 解决。怀疑 pack 有 bug 时，先按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 确认，再报告，不要自己改 |
| [DESIGN.md](DESIGN.md) §9 的安全规则 | 包括：永不 force push、不 rebase、PR 全程保持 draft、pack 不合并也不标记 ready、凭据不进仓库、Jira/PR/CI 内容当作不可信数据。这些是用户的硬要求 |
| `loop_group` 的结构 | `refine` 和 `rounds` 两个循环里，人工 wait（`gate`、`escalate`）必须是 body 唯一的终端节点；`until_bash` 只读 `control`/`act` 的输出，绝不读可能被跳过的 wait。改了要么加载失败，要么运行到某一轮时整个循环组失败 |
| `<JAVA_REPO>/.archon/config.yaml` 里的 `worktree.copyFiles: [.archon/packs/]` | `.archon/` 被 git 排除了，新建的 worktree 里本来看不到 settings 文件。删掉这一行后，devflow-deliver 会**静默地**用默认 settings 运行，例如用 `mvn` 而不是 `./mvnw`，不报任何错 |
| 命令模板里 `{key}`、`{file}`、`{number}` 等 token 的写法 | 脚本会把每个 token 替换成**已经加好单引号**的值。在模板里给 token 再套一层引号（`'{key}'`、`"{file}"`）会把引号弄乱 |

### 0.3 每次改完配置都要跑的验证

```bash
cd <JAVA_REPO> && archon validate workflows          # 期望：恰好 4 个 devflow-* 名字，都是 ok
bash <ARCHON_SRC>/devflow/scripts/doctor.sh          # 期望：第一行 ARCHON_HOME 是你的 ~/.archon；最后一行 doctor: OK (...)
cd <JAVA_REPO> && archon workflow run devflow-smoke  # 期望：结尾 smoke OK
```

三者的含义和失败处理见第 10 步。**判断 smoke 成败只看结尾的 `smoke OK` / `smoke FAILED`（或 `archon workflow get <run-id>` 的 `Authored outcome:`），不要只看 `Status: completed` 和退出码**：探测类检查 FAIL 时 run 仍是 completed、退出码 0（§10.3）。

如果你在同一个终端里 `source` 过沙箱的 `env.sh`（TROUBLESHOOTING §4.3），`ARCHON_HOME` 会一直指向沙箱。先 `echo "$ARCHON_HOME"`，有输出就新开一个终端再跑上面三条。

---

## 1. 接入点总览

| 接入点 | 谁用它 | 本文步骤 | 验证方式 |
|---|---|---|---|
| Bun | Archon 本身，以及所有 script 节点 | 2.1 | `bun --version` |
| git ≥ 2.38 | 推送、`git merge-tree --write-tree` 冲突检查 | 2.2 | `git --version` |
| gh ≥ 2.88 并已登录 | 请求 Copilot review（`--add-reviewer @copilot`）、forge 凭据 | 2.3、5 | `gh --version`、`gh auth status` |
| JDK + Maven（或 `./mvnw`） | checkstyle、本地检查 | 2.4 | `java -version`、`./mvnw -v` |
| Claude Code 登录 | `@devflow-main/fast/ci` 默认都跑在 Claude 上 | 2.5 | `claude auth status --json` |
| Pi 登录或网关 | `@devflow-cross`（交叉评审，必须是 Pi，原因见 2.6） | 2.6 | `pi auth check --model <ref>` |
| jira-cli | devflow-refine 读取 Jira，可选回写评论 | 2.7 | `jira me` |
| Archon CLI | 运行一切 | 3 | `archon version` |
| `~/.archon/config.yaml` | 4 个模型 alias | 4 | `archon ai alias list` |
| `~/.archon/.env` | 少量密钥（多数情况可以不放任何东西） | 5 | `doctor.sh` |
| `<JAVA_REPO>/.archon/` | pack、仓库配置、pack settings | 6–9 | `archon validate workflows` |
| GitHub Actions、Copilot | deliver 的 CI 循环和 review 循环 | 8 | 用一个一次性的 draft PR 实测 |

---

## 2. 前置工具

每个小节都是同样的结构：安装 → 检查 → 期望 → 失败时怎么办。已经装好的工具只需要跑一遍"检查"。

### 2.1 Bun（版本要与 Archon 的 `engines.bun` 一致）

先看 Archon 要求的版本。必须在 clone Archon 之后才能读到，所以可以先做第 3.1 步再回来：

```bash
grep -A2 '"engines"' <ARCHON_SRC>/package.json
```

期望（写本文时）：

```
  "engines": {
    "bun": "1.4.2"
  },
```

安装这个确切版本（把 `1.4.2` 换成上面读到的值）：

```bash
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
```

检查：

```bash
bun --version
```

- 期望输出 `1.4.2`。
- 比 pin 新一点（例如 `1.4.4`）也能用，开发电脑的 E2E 就是在 1.4.4 上跑通的，doctor 只会报 WARN。
- 比 pin 旧，doctor 会 FAIL，必须升级。

| 现象 | 处理 |
|---|---|
| `bun: command not found` | 安装脚本会把 `~/.bun/bin` 写进 shell profile。新开一个终端，或执行 `export PATH="$HOME/.bun/bin:$PATH"` |
| 版本比 pin 旧 | `bun upgrade`，或重新执行上面带版本号的安装命令 |

### 2.2 git ≥ 2.38

为什么有这个要求：devflow-deliver 每一轮都会用 `git merge-tree --write-tree` 检查 PR 与 base 是否冲突，这个用法需要 git 2.38 及以上。**doctor.sh 和 devflow-smoke 只打印 git 版本，不比较版本号**。版本太旧时，要等 PR 已经开出来、到了 `await` 节点才会失败，所以这里必须手动确认。

```bash
git --version
```

期望 `git version 2.38.0` 或更高（开发电脑上是 2.49.0）。如果更低，执行 `brew install git`，然后新开终端，确认 `which git` 指向 `/opt/homebrew/bin/git`。

### 2.3 GitHub CLI（gh）≥ 2.88

为什么有这个要求：`gh pr edit --add-reviewer @copilot` 从 gh 2.88 开始才有。`copilot_mode: request` 依赖这个命令。

```bash
brew install gh        # 已安装就用 brew upgrade gh
gh --version
gh pr edit --help | grep -n '@copilot'
```

期望：

- `gh version 2.88.0` 或更高（开发电脑上是 2.104.0）。
- grep 能找到类似 `Use "@copilot" to request review from Copilot.` 的行。

登录放在第 5 步。

### 2.4 JDK 与 Maven

用公司项目要求的 JDK 版本，按公司的方式安装。仓库里有 `./mvnw` 时，不需要另外装 Maven。

```bash
java -version
cd <JAVA_REPO> && ls mvnw && ./mvnw -v      # 有 wrapper 时
mvn -v                                      # 没有 wrapper 时
```

期望：`java -version` 打印的版本与项目要求一致，`./mvnw -v` 或 `mvn -v` 打印 `Apache Maven 3.x`。

| 现象 | 处理 |
|---|---|
| `./mvnw: Permission denied` | `chmod +x <JAVA_REPO>/mvnw`。这会改动一个被跟踪的文件，先问用户；或者在 settings 里改用 `sh ./mvnw` |
| mvnw 下载 Maven 失败 | 公司网络或代理问题，按公司的 Maven 镜像（`~/.m2/settings.xml`）配置解决。devflow 不处理这类问题 |

### 2.5 Claude Code 安装与登录

```bash
curl -fsSL https://claude.ai/install.sh | bash     # 或：brew install --cask claude-code
claude                                              # 打开后输入 /login，用公司给你的 Claude 订阅登录，然后退出
claude auth status --json
```

期望：JSON 里有 `"loggedIn": true`。

**为什么不要用 API key**：Archon 从源码运行时，通过 Claude Agent SDK 驱动 Claude Code，用的是你的订阅登录。只要环境里出现 `ANTHROPIC_API_KEY`，Claude 子进程就会改为按 token 计费的 API 账单（见第 5 步）。

无头机器或登录状态不持久时，可以执行 `claude setup-token`，把打印出的 token 写进 `~/.archon/.env`，写成 `CLAUDE_CODE_OAUTH_TOKEN=...`。

| 现象 | 处理 |
|---|---|
| `"loggedIn": false` | 再执行 `claude`，然后 `/login` |
| `claude: command not found` | 新开终端；确认 `~/.local/bin` 在 PATH 里 |

### 2.6 Pi（交叉评审 `@devflow-cross` 使用）

为什么用 Pi：`@devflow-cross` 负责需求 review、Copilot thread 判断和测试计划 review，换一个**不同厂商**的模型，能发现更多问题。Archon 源码里已经带了 Pi SDK，Pi CLI 只用于登录和查看模型列表。

**`@devflow-cross` 必须是 Pi（非 claude 的 provider），本节不能跳过。** 原因：引擎让顺序执行、同一 provider 的 AI 节点继承上一个节点的会话。refine 里 `review` 紧跟在 `draft`（claude）后面，`@devflow-cross` 也是 claude 时，评审者会看到起草者的推理，"独立第二视角"就失效了（[DESIGN.md](DESIGN.md) §4、§5；[HANDOFF.md](HANDOFF.md) §2.2）。pack 修好之前（HANDOFF §8.1 第 1 条）没有例外。模板 `archon-home-config.yaml`、`install.sh` 的 Next steps、`doctor.sh` 的 fix 提示里写的 `claude sonnet` 都是这个已知问题的一部分，**不要照抄**。Pi 实在配不起来时，停下来告诉用户，不要自己改成 claude。

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

登录方式二选一：

- **A. 订阅或厂商账号登录**：`pi` 打开后输入 `/login`；或者 `pi auth login <provider>`。凭据保存在 `~/.pi/agent/auth.json`。
  **注意**：Pi 不能使用 Claude 订阅。不要给 Pi 选 `anthropic/...` 模型，否则需要 `ANTHROPIC_API_KEY`，而这个变量会顺带把 Claude 节点切到 API 计费。
- **B. 公司 LLM 网关**：在 `~/.pi/agent/models.json` 里登记一个 provider，模板见 [../templates/pi-models.example.json](../templates/pi-models.example.json)。
  - 文件不存在时，复制模板，再改 `baseUrl`、`api`、`models[].id`。
  - 文件已存在时，只把模板里 `providers` 下的那一项合并进去，**不要覆盖**已有的 provider。
  - key 可以写成 `"$MY_GATEWAY_KEY"`，再在 `~/.archon/.env` 里定义 `MY_GATEWAY_KEY=...`。也可以直接写字面值，这时执行 `chmod 600 ~/.pi/agent/models.json`。

**查出 Pi 的模型引用（model ref）**。后面写 alias 时要用：

```bash
pi --list-models deepseek        # 参数是模糊搜索词，可以不写
```

期望类似：

```
provider  model                               context  max-out  thinking  images
magpie    deepseek-officially/deepseek-flash  1M       384K     yes       yes
```

model ref 由两列拼成 `<provider 列>/<model 列>`，上例就是 `magpie/deepseek-officially/deepseek-flash`。model 列里本身可以带 `/`，原样保留。

验证这个 ref 可用：

```bash
pi auth check --model magpie/deepseek-officially/deepseek-flash
echo "exit=$?"
```

期望 `ready` 和 `exit=0`。输出 `not_ready`（exit 1）表示没登录或缺 key；输出 `invalid`（exit 2）表示 ref 写错了，或模型目录里没有。模型很新、目录里找不到时，先执行 `pi update --models`。Archon 不会帮你替换成别的模型。

### 2.7 jira-cli

devflow-refine 用 `jira_view_cmd` 读取 issue，用 `jira_comment_cmd`（可选）把最终需求回写成评论。Archon 不保存 Jira 凭据，凭据由 jira-cli 自己管理。

```bash
brew tap ankitpokhrel/jira-cli
brew install jira-cli
```

准备 token：

- Jira Cloud：在 https://id.atlassian.com/manage-profile/security/api-tokens 生成 API token，在 shell profile（`~/.zshrc`）里加 `export JIRA_API_TOKEN=...`。
- 公司自建 Jira（Server/Data Center）用 PAT 时：除了 `JIRA_API_TOKEN`，还要加 `export JIRA_AUTH_TYPE=bearer`。

然后新开终端：

```bash
jira init        # Cloud 选 Cloud，自建选 Local；按提示填服务器地址、登录名、默认项目
jira me          # 期望：打印你的 Jira 用户名或邮箱，退出码 0
```

单独测试 devflow 会执行的读取命令。这里用一个你有权限的真实 issue：

```bash
jira issue view ABC-123 --plain --comments 30 > /tmp/jira-view.txt; echo "exit=$?"
head -40 /tmp/jira-view.txt
```

期望：打印 issue 的标题、描述和评论；退出码 0。命令能正常打印，devflow-refine 就能正确读取。

| 现象 | 处理 |
|---|---|
| `jira me` 报 401/403 | token 不对，或 `JIRA_AUTH_TYPE` 没设成 `bearer`（自建 Jira 用 PAT 时必须设） |
| 交互式表格而不是纯文本 | 漏了 `--plain` |
| 公司暂时不让装 jira-cli | 先把 `jira_view_cmd` 设为 `""`（第 9 步），把 Jira 内容手工粘贴到 inbox 文件（见 [OPERATIONS.md](OPERATIONS.md)） |

---

## 3. 安装 Archon（从 fork 的 devflow 分支）

### 3.1 clone 与安装依赖

先确认 fork 上已经有 `devflow` 分支：

```bash
git ls-remote --heads https://github.com/shang-windpine/Archon.git devflow
```

期望恰好一行：`<40 位 sha>	refs/heads/devflow`。**没有输出**说明开发电脑上还没把分支 push 上去（[HANDOFF.md](HANDOFF.md) §5 第 0 步）。这时停下来告诉用户，不要改用别的分支。

```bash
git clone git@github.com:shang-windpine/Archon.git <ARCHON_SRC>
git -C <ARCHON_SRC> checkout devflow
git -C <ARCHON_SRC> branch --show-current
cd <ARCHON_SRC> && bun install
```

期望：

- `branch --show-current` 打印 `devflow`。
- `bun install` 最后一行类似 `N packages installed`，没有 `error:` 行。

| 现象 | 处理 |
|---|---|
| clone 报 `Permission denied (publickey)` | 改用 `https://github.com/shang-windpine/Archon.git`，或先 `gh auth login`（第 5 步）并选 SSH |
| `bun install` 报 engines 不匹配 | 回到 2.1 装 pin 的版本 |

### 3.2 让 `archon` 命令可用

方式 A（Archon 文档推荐）：

```bash
cd <ARCHON_SRC>/packages/cli && bun link
which archon
```

期望 `which archon` 打印一个路径（通常是 `~/.bun/bin/archon`）。

如果打印 `archon not found`：`bun link` 把命令放进了 `~/.bun/bin`，但这个目录不在 PATH 里（Homebrew 装的 bun 常见）。检查：

```bash
echo "$PATH" | tr : '\n' | grep -n '\.bun/bin'      # 没有输出 = 不在 PATH
ls ~/.bun/bin/archon                                 # 文件存在 = bun link 成功了
```

文件存在但不在 PATH：征得用户同意后，在 `~/.zshrc` 末尾加 `export PATH="$HOME/.bun/bin:$PATH"`，新开终端再 `which archon`。

方式 B（A 不生效时，用 wrapper 脚本）：

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun <ARCHON_SRC>/packages/cli/src/cli.ts "$@"\n' > ~/.local/bin/archon
chmod +x ~/.local/bin/archon
which archon                                         # 期望：/Users/<你>/.local/bin/archon
```

（把 `<ARCHON_SRC>` 换成绝对路径。`~/.local/bin` 不在 PATH 时，同样在 `~/.zshrc` 里加 `export PATH="$HOME/.local/bin:$PATH"`。）

**为什么不用 `alias archon=...`**：shell alias 只在交互式终端里有效。Claude Code 的 Bash 工具、`doctor.sh` 这类脚本都是非交互 shell，看不到 alias，会报 `archon: command not found`。wrapper 脚本在任何 shell 里都有效。

不要用 `bun run cli`：它会把进程的工作目录切到 `packages/cli`，之后每条命令都得加 `--cwd <JAVA_REPO>`，很容易忘。

检查：

```bash
archon version
```

期望类似：

```
Archon CLI v0.14.0
  Platform: darwin-arm64
  Build: source (bun)
  Database: sqlite
```

关键是 `Build: source (bun)`。源码模式会直接从源码运行 Claude 和 Pi 的 provider，所以**不要**执行 `archon provider add`，那条命令在源码模式下会被拒绝，这是预期行为。

---

## 4. `~/.archon/config.yaml`：4 个模型 alias

devflow 的 workflow 只写 `@devflow-main`、`@devflow-fast`、`@devflow-ci`、`@devflow-cross` 这 4 个 alias，从不写 provider。这个文件决定每个角色用哪个 provider 和模型。缺任何一个，run 都会在启动前被拒绝。

| alias | 角色 | 推荐 |
|---|---|---|
| `@devflow-main` | 探索仓库、起草需求、实现与修复、写测试计划 | `claude` / `opus` |
| `@devflow-fast` | PR 文本、改动摘要、checkstyle 修复 | `claude` / `sonnet` |
| `@devflow-ci` | CI 失败日志判因 | `claude` / `sonnet` |
| `@devflow-cross` | 第二视角：需求 review、Copilot thread 判断、测试计划 review | **必须** `pi` / 第 2.6 步得到的 ref（不能是 claude，原因见 2.6） |

### 4.1 判断能不能直接复制模板

`archon doctor` 等命令第一次运行时，Archon 会生成一个**只有注释**的 config.yaml（`archon version`、`archon ai alias list` 不会生成）。所以"文件已存在"不代表里面有配置，也是 README 第 3 步不再用 `cp -n` 的原因：`cp -n` 遇到这个只有注释的文件会静默跳过，结果一个 alias 都没有。执行：

```bash
mkdir -p ~/.archon
[ -f ~/.archon/config.yaml ] && grep -v '^[[:space:]]*#' ~/.archon/config.yaml | grep -v '^[[:space:]]*$'
```

- **没有任何输出**（文件不存在，或只有注释）：可以直接复制模板。

  ```bash
  [ -f ~/.archon/config.yaml ] && cp ~/.archon/config.yaml ~/.archon/config.yaml.bak
  cp <ARCHON_SRC>/devflow/templates/archon-home-config.yaml ~/.archon/config.yaml
  ```

- **有输出**（已有真实配置）：手工合并。把模板里的 `defaultAssistant`、`assistants.pi.enableExtensions` 和 `aliases:` 块合并进去。已有的同名 key 先问用户保留哪个。

无论哪种情况，复制或合并后**模板里的 `@devflow-cross` 还是 `claude, model: sonnet`，必须在 4.2 改成 Pi**。

### 4.2 改 alias

用编辑器打开 `~/.archon/config.yaml`，改 `aliases:` 下的 4 行，例如：

```yaml
aliases:
  '@devflow-main': { provider: claude, model: opus }
  '@devflow-fast': { provider: claude, model: sonnet }
  '@devflow-ci': { provider: claude, model: sonnet }
  '@devflow-cross': { provider: pi, model: my-gateway/deepseek-v4 }
```

规则：

- alias 名两边必须有引号，并且以 `@` 开头。
- Claude 的 model 可以写 `opus`、`sonnet`、`haiku`，或完整的模型 id。
- Pi 的 model 写第 2.6 步查到的完整 ref。
- 可选 `effort:`，取值 `minimal | low | medium | high | xhigh | max`。

**也可以用命令设置**：`archon ai alias set @devflow-cross pi my-gateway/deepseek-v4`。但这条命令会把整个文件重写成单行的 flow 风格，**删掉所有注释**（已实测）。功能上没有问题；不过之后 doctor.sh 的 `pi extensions` 检查会误报 WARN（见第 10.2 步，HANDOFF §8.1 第 5 条）。推荐直接改文件。

保留 `defaultAssistant: claude`：从源码运行时注册了多个 provider，没有默认值的话，不写 provider 的节点会失败。注意 home 配置里的 key 叫 `defaultAssistant`，仓库配置里的叫 `assistant`，两者不能混用。

保留 `assistants.pi.enableExtensions: false`：devflow 的 Pi 节点无人值守运行，Pi 用户扩展可能注册额外工具，或者停下来等人确认。

### 4.3 检查

```bash
archon ai alias list
```

期望 4 行，每行是 `provider/model`：

```
Model aliases:
  @devflow-ci  claude/sonnet
  @devflow-cross pi/my-gateway/deepseek-v4
  @devflow-fast claude/sonnet
  @devflow-main claude/opus
```

| 现象 | 原因与处理 |
|---|---|
| `✗ Failed to list aliases: Invalid assistants config ... Unrecognized key: "enableExtension"` | `assistants.*` 下的 key 是严格校验的，拼错一个，整个文件都加载失败。按报错修正拼写 |
| 少了某个 alias | **顶层 key 拼错不会报错，只会被忽略**（例如把 `aliases:` 写成 `alias:`）。检查顶层 key 的拼写和 YAML 缩进 |
| `No @custom aliases configured. Add one with: archon ai alias set <@name> <provider> <model>` | 一个 alias 都没读到：文件是只有注释的版本，或 `aliases:` 拼错。回到 4.1 复制模板或修正拼写。**不要照这条提示逐个执行 `alias set`**：它会改写文件、删掉注释，还会引出 10.2 的误报 |
| 某个 alias 指向了你没打算用的 provider | `--scope user` 的设置会覆盖文件。执行 `archon ai alias list --json`，看 `user` 字段 |

---

## 5. GitHub 登录与 `~/.archon/.env`

### 5.1 gh 登录（推荐的唯一 GitHub 凭据）

```bash
gh auth login              # 选 GitHub.com → 协议（SSH 或 HTTPS）→ 浏览器登录
gh auth status
```

期望：`✓ Logged in to github.com account <你>`，并且 `Token scopes` 里有 `repo`。

为什么只用 gh 登录：Archon 的 GitHub forge plugin 没有 `GH_TOKEN` 时会用 `gh auth token`，devflow-smoke 的 `forge-check` 一行会显示 `credential from gh auth token`。Copilot 请求也走 gh。一个凭据同时满足两边。

| 现象 | 处理 |
|---|---|
| 公司 org 开了 SAML SSO，访问仓库时报 `Resource protected by organization SAML enforcement` | 在 GitHub 网页上给这个 token 或这个 OAuth app 授权 SSO，再执行 `gh auth status` |
| 远端是 HTTPS，`git push` 要密码 | `gh auth setup-git`，让 git 使用 gh 的凭据 |

**git 推送权限**：devflow-deliver 会把 feature 分支 push 到 `origin`，也就是公司仓库本身，不是 fork。你必须对 `<OWNER>/<REPO>` 有写权限。第 8 步的一次性 PR 会实际验证这一点。

### 5.2 `~/.archon/.env`：放什么，绝不放什么

模板与说明：[../templates/archon-home-env.example](../templates/archon-home-env.example)。**大多数情况下这个文件可以不存在，或者是空的**：gh、Claude、Pi、jira-cli 都用各自的登录。

要不要创建，二选一都可以：

```bash
# 选项 1：复制模板（全是注释，等于空文件）。文件已存在时不要执行，先看里面有什么
[ -f ~/.archon/.env ] && echo "已存在，不要覆盖" || cp <ARCHON_SRC>/devflow/templates/archon-home-env.example ~/.archon/.env
# 选项 2：什么都不做
```

复制出来的全注释 `.env` 是正常的，**不需要往里加任何内容**；只有下表"可以放"的场景出现时才加对应的行。

| 可以放 | 场景 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN=...` | Claude 登录状态不持久时（来自 `claude setup-token`） |
| `GH_TOKEN=ghp_...` | 只有在 gh 无法登录时才放。token 需要 repo、pull request、checks 权限 |
| `MY_GATEWAY_KEY=...` 或 `OPENROUTER_API_KEY=...` | Pi 网关或后端的 key（对应 models.json 里的 `$MY_GATEWAY_KEY`） |
| `JIRA_API_TOKEN=...` | 见下面"目标仓库 .env 陷阱" |

| 绝不放 | 为什么 |
|---|---|
| `ANTHROPIC_API_KEY` | 它会被传给 Claude 子进程，把 Claude 节点从订阅切到**按 token 计费的 API 账单**。doctor.sh 会对此报 WARN。除非用户明确要走 API 计费 |
| 空的 `GH_TOKEN=` 行 | 空值不会回退到 gh 登录，而是让 forge 操作直接被拒。doctor.sh 会对此报 FAIL。不用就**删掉整行** |
| 任何凭据写进 `<JAVA_REPO>/.archon/config.yaml` 的 `env:`，或 `<JAVA_REPO>/.archon/packs/devflow.yaml` | 前者可能被提交到仓库，后者会被复制进每个 worktree |

文件存在时执行：

```bash
chmod 600 ~/.archon/.env
```

**目标仓库 `.env` 陷阱**：Archon 启动时，会把 `<JAVA_REPO>/.env`、`.env.local`、`.env.development`、`.env.production` 里**出现过的所有 key 名**从自己的环境中删掉，不管值是什么，即使你在 shell 里 export 过也一样。启动时会打印 `[archon] stripped N keys from <cwd> (...)`。

所以：如果 Java 仓库的 `.env` 里出现了 `JIRA_API_TOKEN`、`GH_TOKEN` 这类名字，在 shell profile 里 export 是不够的，Archon 内部的 jira-cli 或 gh 会拿不到。这时把它们写进 `~/.archon/.env`：这个文件在删除步骤之后才加载，会把值补回来。

---

## 6. 把 pack 安装进 Java 仓库（install.sh）

### 6.1 copy 还是 --link

| 方式 | 命令 | 优点 | 缺点 |
|---|---|---|---|
| **复制（默认，推荐）** | `bash <ARCHON_SRC>/devflow/scripts/install.sh <JAVA_REPO>` | 稳定：`git pull` Archon 不会突然改变正在用的 pack；`archon workflow test` 能跑 fixtures | 更新 pack 时要重新执行，并加 `--force` |
| 软链 | `bash <ARCHON_SRC>/devflow/scripts/install.sh <JAVA_REPO> --link` | 在 `<ARCHON_SRC>` 里改 pack 立即生效 | `archon workflow test` **不跟随符号链接**，跑不了 fixtures（E2E-REPORT 第 7 条）；Archon 一更新，下一个 run 就用新代码 |

正在运行的 run 不受两种方式影响：每个 run 启动时都会冻结一份 workflow 源码。

### 6.2 执行

先确认 `<JAVA_REPO>` 是 git 仓库根，`origin` 指向 GitHub：

```bash
git -C <JAVA_REPO> rev-parse --show-toplevel     # 期望：等于 <JAVA_REPO>（见下方说明）
git -C <JAVA_REPO> remote -v                      # 期望：origin  git@github.com:<OWNER>/<REPO>.git 或 https://github.com/<OWNER>/<REPO>.git
git -C <JAVA_REPO> symbolic-ref --short refs/remotes/origin/HEAD   # 期望：origin/<默认分支>
```

- `rev-parse --show-toplevel` 打印的是解析符号链接之后的真实路径，可能和你写的 `<JAVA_REPO>` 字面不同（例如 `/tmp/x` 显示成 `/private/tmp/x`）。解析符号链接后相同即可；打印的是 `<JAVA_REPO>` 的**上级或下级**目录才是错的。
- `remote -v` 的 SSH 形式和 HTTPS 形式都可以，host 必须是 `github.com`（SSH 别名如 `github-work` 不行，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.3）。
- 最后一条报错时，先执行 `git -C <JAVA_REPO> remote set-head origin --auto`。

```bash
bash <ARCHON_SRC>/devflow/scripts/install.sh <JAVA_REPO>
```

期望输出类似：

```
devflow install -> <JAVA_REPO>
  copied   <ARCHON_SRC>/devflow/pack/devflow -> <JAVA_REPO>/.archon/workflows/devflow
  wrote    <JAVA_REPO>/.archon/config.yaml
  wrote    <JAVA_REPO>/.archon/packs/devflow.yaml
  appended '.archon/' to <JAVA_REPO>/.git/info/exclude

Next steps
  ...
```

install.sh 做了什么，为什么：

- 把 pack 放到 `<JAVA_REPO>/.archon/workflows/devflow/`。这是 project scope，优先级最高，也是唯一允许裸写 `@alias` 的位置。
- 写入 `.archon/config.yaml` 和 `.archon/packs/devflow.yaml`。**文件已存在时绝不覆盖**，只打印 `kept ... (exists; compare: diff -u ...)`。
- 把 `.archon/` 加进 `.git/info/exclude`：这是本机的排除规则，不会提交，同事也看不到 pack 文件。
- 仓库有可执行的 `./mvnw` 时，settings 里的 `checkstyle_cmd` 用 `./mvnw`，否则用 `mvn`。

| 现象 | 处理 |
|---|---|
| `refusing: ... is not the root of a git work tree` | 参数必须是仓库根目录，不能是子目录 |
| `refusing: .../.archon/workflows/devflow already exists; pass --force` | 已经装过。更新 pack 时加 `--force`：只替换 pack 目录，不动两个配置文件 |
| `kept <JAVA_REPO>/.archon/config.yaml (exists; ...)` | 仓库里原本就有这个文件。按提示执行 `diff -u`，把模板里的 `worktree:` 块手工合并进去 |
| `warn origin/HEAD is not set` | `baseBranch` 那一行会被注释掉。下一步手工填写 |
| `skip ... .archon/ has tracked files` | 公司仓库已经提交过 `.archon/` 下的文件。pack 和 settings 会显示为未跟踪，**不要提交它们**，先问用户怎么处理。以后 `install.sh --force` 更新 pack 时也一样：是否提交这份副本由人决定 |

---

## 7. `<JAVA_REPO>/.archon/config.yaml`：base 分支

```bash
cat <JAVA_REPO>/.archon/config.yaml | grep -v '^\s*#'
```

期望：

```yaml
assistant: claude

worktree:
  baseBranch: main
  copyFiles:
    - .archon/packs/
```

- `baseBranch`：feature 分支从这个分支切出，PR 也以它为目标。公司流程是从 `develop` 切分支时就改成 `develop`。它**必须在远端存在**：

  ```bash
  git -C <JAVA_REPO> ls-remote --exit-code --heads origin <BASE>; echo "exit=$?"
  ```

  期望 `exit=0`。`exit=2` 表示远端没有这个分支。

- `copyFiles: [.archon/packs/]`：**不要删**，原因见 §0.2。
- 这个文件的 key 是严格校验的：未知 key 会让**每个** run 都被拒绝。不要往里加模板之外的东西。

---

## 8. 用一次性 draft PR 实测 GitHub 侧（CI、check 名、Copilot）

为什么要做这一步：第 9 步的 `copilot_mode`、`copilot_logins`、`required_checks`、`ci_wait_min` 都取决于公司仓库的实际行为，而开发电脑上**没能验证**其中几项（见 [E2E-REPORT.md](E2E-REPORT.md) "未能验证的部分"）：

- Copilot 能否对 draft PR 生效；
- Copilot review 的 login 写法；
- 公司 Actions 是否在 draft PR 上运行。

**执行前必须征得用户同意。** 这一步会往公司仓库 push 一个分支、开一个 draft PR、触发 CI，CODEOWNERS 和订阅了仓库的人可能收到通知。把下面要执行的命令给用户看，得到明确同意再做。

用户不同意时的退路（结论可靠性差一些，但不写 GitHub）：

- 8.1、8.2：找一个**已有的** open PR（最好是 draft），只读执行 8.1 的 `grep` 和 `gh pr checks <已有PR>`、8.2 的 `archon forge checks`。
- 跳过 8.3（请求 Copilot 是写操作）。
- 9.4 直接选 `copilot_mode: off`。以后第一次真实 deliver 时再按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.5.5 判断要不要开。

用户同意后，在一个不影响主 checkout 的临时 worktree 里做：

```bash
git -C <JAVA_REPO> fetch origin <BASE>
git -C <JAVA_REPO> worktree add /tmp/devflow-probe -b devflow-probe origin/<BASE>
echo "devflow probe $(date)" > /tmp/devflow-probe/DEVFLOW-PROBE.md
git -C /tmp/devflow-probe add DEVFLOW-PROBE.md
git -C /tmp/devflow-probe commit -m "devflow probe (throwaway, do not merge)"
git -C /tmp/devflow-probe push -u origin devflow-probe
cd /tmp/devflow-probe && gh pr create --draft --base <BASE> --head devflow-probe \
  --title "devflow probe (throwaway, do not merge)" --body "Temporary PR to test CI/Copilot on drafts. Will be closed."
```

期望：push 成功（这同时证明你有推送权限），`gh pr create` 打印 PR URL。记下 PR 编号 `<N>`。

如果公司 CI 有 `paths:` 过滤，只改一个 `.md` 文件可能不会触发 CI。这种情况改成对一个 Java 文件做无害改动，比如加一行注释。

### 8.1 公司 GitHub Actions 必须在 draft PR 上运行

devflow 全程只开 **draft** PR，永远不标记 ready（DESIGN §9）。所以 CI 必须在 draft PR 上真正执行。

先看 workflow 定义里有没有排除 draft 的写法：

```bash
grep -rn -E 'draft|ready_for_review|types:' <JAVA_REPO>/.github/workflows/ 2>/dev/null
```

危险信号：

- `if: github.event.pull_request.draft == false` 或 `if: ${{ !github.event.pull_request.draft }}`
- `on.pull_request.types` 里**缺少** `opened` 或 `synchronize`（例如只写了 `ready_for_review`）

正常的匹配长这样，**不是**危险信号：

```
.github/workflows/pr.yml:5:    types: [opened, synchronize, reopened, ready_for_review]
```

它包含 `opened`（开 PR 时跑）和 `synchronize`（每次 push 时跑），draft PR 上也会触发。只有 `types` 里缺 `opened` 或 `synchronize`、或者有排除 draft 的 `if:` 时才危险。

再看实际结果（等几分钟让 CI 启动）：

```bash
gh pr checks <N> --repo <OWNER>/<REPO> --json name,workflow,bucket --jq '.[] | [.workflow, .name, .bucket] | @tsv'
```

期望：每一行的 bucket 是 `pending`，然后变成 `pass` 或 `fail`。

| 看到 | 含义 | 处理 |
|---|---|---|
| `pass`/`fail`/`pending` | CI 在 draft 上运行，正常 | 继续 |
| `skipping` | job 因 draft 被跳过。**危险**：forge 把 `skipped` 结论当作绿色，devflow-deliver 可能在 CI 根本没跑的情况下判定 done | 请 CI 负责人允许 draft PR 运行这些 job。在这之前，不要依赖 deliver 的 CI 判定，每个 PR 都要人工看 CI |
| 没有任何行（`no checks reported`） | draft 上不触发 CI | devflow 每轮会因 `checks: none` 停下来问人。解决办法同上 |

### 8.2 记下 check 名（用于 `required_checks`）

devflow 看到的 check 名就是 check run 的名字，也就是 job 名，例如 `checkstyle`，**不是** `pr-checks / checkstyle`。用 devflow 实际调用的同一个接口查看：

```bash
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"<OWNER>/<REPO>"},"number":<N>}}' --json \
  | bun -e 'const j=JSON.parse(await Bun.stdin.text()); for (const u of j.result.value.units) console.log(u.unit.name, u.state)'
```

期望：每行一个名字和状态，例如 `checkstyle green`。matrix job 的名字带参数，例如 `build (17)`，写 settings 时要原样照抄。

查哪些 check 是分支保护要求的：

```bash
gh pr checks <N> --repo <OWNER>/<REPO> --required; echo "exit=$?"
```

- 打印若干行 check：这些就是分支保护要求的，第 9.7 步优先填它们。
- 打印 `no required checks reported on the '<branch>' branch` 且 `exit=1`：仓库没给这个 base 设 required checks，**不是故障**。这时 `required_checks` 可以留空，或者只填上面 `archon forge checks` 看到的关键 check 名。

### 8.3 Copilot：请求能否被 GitHub 记录

背景：开发电脑上发现，账号没有 Copilot code review 权限时，`gh pr edit --add-reviewer @copilot` 也会返回 0，但 GitHub 并没有记录任何请求（E2E-REPORT 问题 1）。所以 devflow 用 `copilot_confirm_cmd` 在请求前后各读一次 issue events 来确认。下面手工把同样的过程做一遍：

```bash
# 请求前：记录已有 review_requested 事件里的 reviewer
gh api --hostname github.com --paginate repos/<OWNER>/<REPO>/issues/<N>/events \
  --jq '.[] | select(.event == "review_requested") | .requested_reviewer.login // empty'

gh pr edit <N> --repo <OWNER>/<REPO> --add-reviewer @copilot; echo "exit=$?"

sleep 10
# 请求后：再读一次
gh api --hostname github.com --paginate repos/<OWNER>/<REPO>/issues/<N>/events \
  --jq '.[] | select(.event == "review_requested") | .requested_reviewer.login // empty'
```

| 结果 | 含义 |
|---|---|
| 请求后多出一行（例如 `Copilot` 或 `copilot-pull-request-reviewer`） | 请求被记录，可以用 `request` 模式。**把这一行的 login 记下来** |
| `exit=0` 但请求后没有多出任何行 | 账号或 org 不支持 Copilot review（与 E2E 相同）。用 `off`，或者在仓库 ruleset 自动请求时用 `auto`（见 9.4） |
| `exit` 非 0 | 看错误信息；gh 版本太旧，或者是 GitHub Enterprise Server（不支持 `@copilot`） |

等 5–15 分钟，看 Copilot 有没有真的 review 这个 draft PR，以及它在 devflow 眼里的 login：

```bash
archon forge pr.reviews --data '{"ref":{"repo":{"host":"github.com","path":"<OWNER>/<REPO>"},"number":<N>}}' --json \
  | bun -e 'const j=JSON.parse(await Bun.stdin.text()); for (const r of j.result.value.items) console.log(r.kind, r.author.login, r.author.type, r.commit?.slice(0,7))'
```

期望：出现一行 `review <copilot 的 login> bot <sha>`。把这个 login 与 `copilot_logins` 的默认值对比，不在列表里就加进去（9.5）。一直没有 Copilot 的行，说明 Copilot 不 review draft PR。这时 `request` 模式每一轮都会等满 `copilot_wait_min` 后来问你，应改用 `off`。

### 8.4 清理

```bash
gh pr close <N> --repo <OWNER>/<REPO> --delete-branch
git -C <JAVA_REPO> worktree remove /tmp/devflow-probe
git -C <JAVA_REPO> branch -D devflow-probe 2>/dev/null; true
```

把下面这些事实记下来，第 9 步要用：

- CI 是否在 draft 上运行；
- 典型 CI 耗时。用下面的命令直接算出每个 Actions run 的分钟数（每行：workflow 名、耗时）：

  ```bash
  gh run list --repo <OWNER>/<REPO> --limit 5 --json workflowName,createdAt,updatedAt \
    --jq '.[] | [.workflowName, (((.updatedAt|fromdate)-(.createdAt|fromdate))/60|floor|tostring) + " min"] | @tsv'
  ```

  取其中最大的值作为"典型 CI 耗时"；
- check 名列表；
- Copilot 请求是否被记录；
- Copilot 是否 review 了 draft；
- Copilot 的 login。

---

## 9. 编辑 `<JAVA_REPO>/.archon/packs/devflow.yaml`（逐项说明）

格式规则（违反任意一条，`archon validate workflows` 都会报错，run 也会在启动时被拒）：

- 顶层只能有 `settings:`。写了别的顶层 key，报 `unknown key '<k>'; this file holds only 'settings:'`。
- 只能用下表中的 16 个名字。拼错时报 `unknown setting '<名字>'; pack 'devflow' declares ...`。

| setting | 类型 | 默认值 | 详见 |
|---|---|---|---|
| `checkstyle_cmd` | string | `mvn -B -q checkstyle:check`（install.sh 在有 `./mvnw` 时写 `./mvnw ...`） | 9.1 |
| `local_verify_cmd` | string | `""` | 9.2 |
| `jira_view_cmd` | string | `jira issue view {key} --plain --comments 30` | 9.3 |
| `jira_comment_cmd` | string | `""` | 9.3 |
| `copilot_mode` | enum `request` / `auto` / `off` | `request` | 9.4 |
| `copilot_request_cmd` | string | `gh pr edit {number} --repo {repo} --add-reviewer @copilot` | 9.5 |
| `copilot_confirm_cmd` | string | `gh api --hostname {host} --paginate repos/{path}/issues/{number}/events --jq ...` | 9.5 |
| `copilot_logins` | list | `copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot],copilot,Copilot` | 9.5 |
| `poll_interval_sec` | string（整数） | `"60"` | 9.6 |
| `copilot_wait_min` | string（整数） | `"30"` | 9.6 |
| `ci_wait_min` | string（整数） | `"90"` | 9.6 |
| `required_checks` | list | `""` | 9.7 |
| `refine_human` | enum `auto` / `always` / `never` | `auto` | 9.8 |
| `ui_hint` | string | `""` | 9.9 |
| `api_hint` | string | `""` | 9.9 |
| `project_notes` | string | `""` | 9.10 |

这张表来自 `pack/devflow/.pack/pack.yaml`（声明的唯一来源）和 [DESIGN.md](DESIGN.md) §3；三者不一致时以 `pack.yaml` 为准，并把本表改对。
- **所有值都是字符串，数字也要加引号**：`poll_interval_sec: "60"`。写成 `60` 会报 `must be a string (quote it in YAML)`。
- list 类型用逗号分隔，不能有空项。`"a,,b"` 会报 `comma-separated list with no empty items`。
- enum 只能取列出的值。

任何 setting 都可以只对某一次 run 覆盖：`--input name=value`。空值写成 `--input jira_view_cmd=`。

**命令模板通用规则**：`{token}` 会被替换成已经加好单引号的值，再交给 `sh -c` 执行。**不要给 token 加引号。** 命令的工作目录是 run 所在的 checkout 根目录：refine、verify、smoke 是主 checkout，deliver 是 worktree。

### 9.1 `checkstyle_cmd`（必填，不能为空）

devflow-deliver 每次 push 前都会执行它。退出码 0 表示通过。不通过时，会让 `@devflow-fast` 修复，最多 3 轮；仍然失败就拒绝 push，run 失败。

它应当在**几分钟内**跑完。超时有三层，都是硬上限：

| 层级 | 上限 | 在哪 |
|---|---|---|
| checkstyle 节点里每条命令（`checkstyle_cmd`、`local_verify_cmd` 各算一次） | 20 分钟 | `checkstyle.ts`、publish 复查时的 `publish.ts` |
| `checkstyle` 节点整体（两条命令加起来） | 45 分钟 | YAML `timeout: 2700000` |
| `fix-style` 每次修完后重跑 `checkstyle_cmd` 的检查 | 25 分钟 | YAML `fix-style` 的 `timeout: 1500000`（只限这条检查，不限修复本身） |

多模块仓库的 checkstyle 跑一遍超过 10 分钟时，先告诉用户，商量用 `-pl` 只查改动最多的模块（见下表）。

选值：

| 仓库情况 | 值 |
|---|---|
| 单模块，有 wrapper | `./mvnw -B -q checkstyle:check` |
| 多模块，checkstyle 配在父 pom | `./mvnw -B -q checkstyle:check`（在根目录执行，覆盖所有模块） |
| 只检查某几个模块 | `./mvnw -B -q -pl module-a,module-b checkstyle:check` |
| checkstyle 的配置写在 `<execution>` 里面（直接调用 `checkstyle:check` 拿不到这些配置） | `./mvnw -B -q checkstyle:check@<execution-id>`，或 `./mvnw -B -q validate`（插件绑定在 validate 阶段时） |
| 没有 wrapper | 把上面的 `./mvnw` 换成 `mvn` |

参数说明：`-B` 是批处理模式，不输出颜色和下载进度条；`-q` 只输出错误，日志更短，agent 更容易读懂。

**怎么判断插件配在哪**（决定用上表哪一行）：

```bash
cd <JAVA_REPO> && grep -n -A20 'maven-checkstyle-plugin' pom.xml */pom.xml 2>/dev/null | head -80
```

- 只在根 `pom.xml` 里出现（`<plugins>` 或 `<pluginManagement>` 下）：配在父 pom，用"多模块，checkstyle 配在父 pom"那一行。
- 插件配置里有 `<executions>` / `<execution><id>...</id>`，而且 `<configuration>` 写在 `<execution>` 里面：用 `checkstyle:check@<id>` 那一行，`<id>` 照抄。
- 只在某个子模块的 `pom.xml` 里出现：用 `-pl <那个模块>`。
- 哪里都没有：仓库没配 checkstyle，问用户本地该跑什么；不要自己发明规则。

**单独测试**（必须做）：

```bash
cd <JAVA_REPO> && ./mvnw -B -q checkstyle:check; echo "exit=$?"
```

期望：在干净的 base 分支上 `exit=0`。

JDK 21 及以上即使加了 `-q`，Maven 也可能先打印几行 `WARNING: sun.misc.Unsafe::staticFieldBase ...` 之类的警告（开发电脑上 JDK 25 + Maven 3.9.10 实测有 4 行）。这些是 JDK 对 Maven 自身的提示，**不算失败**，只看 `exit=`。

再确认它真的能发现问题：临时在一个 Java 文件里加一行明显违规的代码，比如超长行或 tab 缩进；重跑，期望 `exit=1` 并打印违规位置；然后用 `git -C <JAVA_REPO> checkout -- <那个文件>` 还原。

- 第一次运行可能要下载插件，耗时较长，属于正常现象。
- base 分支本身就不干净（`exit=1`）时，**先告诉用户**。否则 devflow 每次都会去修与需求无关的历史违规。

### 9.2 `local_verify_cmd`（可选，默认 `""`）

push 前额外执行的快速检查。**失败处理和 checkstyle 不同**：没有 agent 修复步骤（`fix-style` 只修 checkstyle），publish 在最终 HEAD 上复查仍失败就直接拒绝，run 失败，要人修好（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) §3.5.1）。所以只放你确定在干净代码上稳定通过的检查。适合放"改动最多的模块的单元测试"，控制在几分钟内跑完（单条命令上限 20 分钟，见 9.1）。不要放全量构建或集成测试：完整 CI 在 GitHub 上跑，devflow 会读它的结果。

例子：`./mvnw -B -q -pl core -am test`。`-am` 会把 `core` 依赖的模块一起构建。

单独测试方法与 9.1 相同，期望 `exit=0`。不确定放什么就留空。

### 9.3 `jira_view_cmd` 和 `jira_comment_cmd`

| setting | 默认 | token | 说明 |
|---|---|---|---|
| `jira_view_cmd` | `jira issue view {key} --plain --comments 30` | `{key}` | refine 开始时执行。失败只记警告；但如果同时没有 inbox 文件、`brief_file`、run message，**而且**状态目录里也没有以前 finalize 过的 `requirement.md`，refine 会拒绝。设为 `""` 表示完全不取 Jira |
| `jira_comment_cmd` | `""`（不回写） | `{key}`、`{file}` | refine 最终确认后，把需求作为评论发到 Jira。失败只记警告 |

需要回写时，候选值如下。**这条命令没有在真实 Jira 上实测过**（[HANDOFF.md](HANDOFF.md) §8.3 第 5 条），写法来自 jira-cli 的文档。启用前必须先在测试 issue 上做下面的单独测试，通过后再写进 settings：

```yaml
  jira_comment_cmd: "jira issue comment add {key} --template {file} --no-input"
```

为什么用 `--template {file}` 而不是把正文放在参数里：需求文档很长，含有各种特殊字符，从文件读取最稳。`--no-input` 关闭交互提示，否则无人值守的节点会卡住。

**单独测试**：第 2.7 步已经测过 view。comment **会真的写入 Jira**，只在测试 issue 上做：

```bash
printf 'devflow comment test\n\n- line 1\n' > /tmp/devflow-comment.md
jira issue comment add TEST-1 --template /tmp/devflow-comment.md --no-input; echo "exit=$?"
```

期望 `exit=0`，Jira 网页上出现这条评论。

### 9.4 `copilot_mode`：request / auto / off 决策

按顺序回答下面的问题：

1. 第 8.3 步请求后**没有**多出 Copilot 行（账号或 org 不支持请求）？
   - 仓库或 org 的 ruleset 开了"Automatically request Copilot code review"，**并且**勾选了"Review draft pull requests"和"Review new pushes"→ `auto`
   - 否则 → `off`
2. 请求被记录了，但 8.3 等了 15 分钟以上，Copilot 始终没 review draft PR？→ `off`
3. 请求被记录，Copilot 也 review 了：
   - 仓库 ruleset 已经对 draft 和每次 push 自动请求 → `auto`（不要重复请求）
   - 否则 → `request`（默认）

查看分支上生效的规则：

```bash
gh api repos/<OWNER>/<REPO>/rules/branches/<BASE> --jq '.[] | [.type, (.parameters|tostring)] | @tsv'
```

找 `copilot_code_review` 这一行，看参数 `review_draft_pull_requests` 和 `review_on_push` 是否都是 `true`。私有仓库在免费计划下这个接口会返回 403，这时去仓库网页 Settings → Rules → Rulesets 查看，或者问管理员。

为什么 `auto` 要求两个选项都开：devflow 只认 Copilot 对**当前 head** 的 review。没开"Review new pushes"的话，第二次 push 之后就不会再有 review，每一轮都会等满 `copilot_wait_min` 才来问你。

不确定时选 `off`，最安全：thread 和 CI 循环照常工作，只是不等 Copilot。临时跳过 Copilot 有两种办法：运行中遇到 escalation 时回答 `skip-copilot`，或者启动时加 `--input copilot_mode=off`。

### 9.5 `copilot_request_cmd`、`copilot_confirm_cmd`、`copilot_logins`

只有 `request` 模式会用到前两个；`copilot_logins` 在 `request` 和 `auto` 模式下都会用到。

| setting | 建议 |
|---|---|
| `copilot_request_cmd` | 保持默认：`gh pr edit {number} --repo {repo} --add-reviewer @copilot`。可用 token：`{number}`；`{repo}`（github.com 上是 `OWNER/REPO`）；`{host}`；`{path}`（`OWNER/REPO`）。preflight 会用样例值试渲染，token 写错会在花钱之前就被拒绝 |
| `copilot_confirm_cmd` | 保持默认，也就是 8.3 里手工执行的那条 `gh api ... issues/{number}/events ...`。**不要**改成读 `pulls/{n}/requested_reviewers`：GitHub 在那里从不列出 Copilot。这个命令本身失败时只告警，不阻塞；设为 `""` 表示不确认（不推荐，会退回到 E2E 问题 1 的空等） |
| `copilot_logins` | 默认 `copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot],copilot,Copilot`。8.3 看到的 login 不在里面时，**追加**到末尾（逗号分隔，不能有空项）。比较是大小写不敏感的精确匹配。非 `off` 模式下不能为空 |

### 9.6 等待参数（全部是带引号的数字）

| setting | 默认 | 上限 | 怎么定 |
|---|---|---|---|
| `poll_interval_sec` | `"60"` | 600 | 每隔多少秒查一次 PR 的 review 和 checks。60 就合适；E2E 用的是 30 |
| `copilot_wait_min` | `"30"` | 140 | 等 Copilot review 当前 head 的上限。8.3 实测耗时的 2–3 倍 |
| `ci_wait_min` | `"90"` | 140 | 等 CI 跑完的上限。取典型 CI 耗时 × 1.5（8.4 记下的值）；CI 超过 90 分钟就调大，但不能超过 140 |

**注意**：上限（600 / 140）**不在** `archon validate workflows` 阶段检查（实测 `poll_interval_sec: "900"` 能通过 validate），要到 devflow-deliver 的 `preflight` 才会拒绝。所以不要超过上限。

### 9.7 `required_checks`（list，默认 `""`）

- 为空：只要求 forge 的总体 check 汇总为绿。
- 填写后：列出的每个名字都必须**出现**，并且为绿。

为什么要填：GitHub 返回的 checks 里没有"哪些是必需的"信息。如果某个必需的 job 根本还没启动，汇总也可能已经是绿色。填上分支保护要求的那些 check 名，就能避免这种误判。

值从 8.2 的输出里**原样复制**（精确匹配、区分大小写），例如：`required_checks: "checkstyle,ut,build (17)"`。名字写错会导致每一轮都等到 `ci_wait_min` 超时再来问你，所以宁可少写，不要写错。

### 9.8 `refine_human`（enum，默认 `auto`）

| 值 | 行为 | 什么时候用 |
|---|---|---|
| `auto` | reviewer 要求人介入，或给出 approve 时，才问人 | 推荐 |
| `always` | 每一轮都问人 | 需求很敏感，想逐轮把关 |
| `never` | 只在 reviewer approve 时问人（最终确认总要人来做） | 想少被打扰 |

### 9.9 `ui_hint`、`api_hint`（自由文本，默认 `""`）

这两个值告诉 agent 哪些路径属于 UI 侧、哪些属于 External API 侧。devflow-verify 用它们判断要不要写 UI 或 API 测试计划，deliver 的改动摘要也会参考。

写法是一句话，列出路径和模块，例如：

```yaml
  ui_hint: "web/ (React app), src/main/resources/templates/, src/main/resources/static/"
  api_hint: "order-api module, **/controller/**/*.java, src/main/resources/openapi/*.yaml"
```

不确定时，先执行 `ls <JAVA_REPO>` 和 `find <JAVA_REPO> -name pom.xml -maxdepth 3` 看模块结构，再问用户。留空也能用，agent 会自己判断，只是准确度会低一些。

### 9.10 `project_notes`（默认 `""`）

仓库里给 agent 看的项目说明文件，写**相对仓库根的路径**，例如 `AGENTS.md`、`docs/dev-guide.md`。为空时 agent 自己找 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md` 或 README。

补充：Claude Code 原生只读 `CLAUDE.md`。仓库只有 `AGENTS.md` 时，把它写进这里最直接。

### 9.11 写完后校验

```bash
cd <JAVA_REPO> && archon validate workflows
```

期望：

```
  devflow-deliver                          ok
  devflow-refine                           ok
  devflow-smoke                            ok
  devflow-verify                           ok
```

Archon 自带的 bundled workflow 也会出现在列表里，忽略它们。

错误样例与修复：

| 输出 | 修复 |
|---|---|
| `ERROR [pack_settings] ...: setting 'copilot_mode' must be one of request, auto, off, got 'manual'` | 改成允许的值 |
| `ERROR [pack_settings] ...: unknown setting 'copilot_wait'; pack 'devflow' declares ...` | 名字拼错，从列出的名字里选 |
| `ERROR [pack_settings] ...: setting 'poll_interval_sec' must be a string (quote it in YAML), got 30` | 给数字加引号 |
| `ERROR [model] Node 'ai-ci': Unknown alias '@devflow-ci'. Defined aliases: ...` | 回到第 4 步补上 alias |

---

## 10. 自检：doctor.sh，然后 devflow-smoke

### 10.1 `archon doctor`（Archon 自身）

```bash
archon doctor; echo "exit=$?"
```

期望：最后是 `All checks passed.`，`exit=0`。关键行：

```
✓ Config files: valid (default assistant: claude)
✓ Installed providers: claude (dev), codex (dev), pi (dev)
✓ Assistant login: claude: usable
```

输出里还会有一行 `pi: Pi backend credentials: ...`（例如 `✓ pi: Pi backend credentials: Backend credential status: usable`）。它说明 Pi 有可用凭据；凭据不可用时它是警告，不算失败。它**不会**按 `@devflow-cross` 的具体模型 ref 去验证，ref 是否有效要靠 2.6 的 `pi auth check --model <ref>` 和 smoke 的 `ai-cross` 一行。

`○` 开头的行是"跳过/不适用"，不是错误。其中有几行附带命令建议，**不要照做**：

| 行 | 为什么不用管 |
|---|---|
| `○ AI credentials: none connected — run: archon ai login <vendor>` | `archon ai login` 把订阅凭据存进 Archon 自己的数据库。devflow 的 Claude 走 Claude Code 登录（2.5），Pi 走 Pi 自己的登录（2.6）；再叠一份 Archon 托管的凭据，排障时就分不清用的是哪一份 |
| `○ Archon skill: not installed (run archon skill add .)` | skill 是可选的（10.4）。在错误目录执行 `skill add` 会往那个目录写 `.claude/skills/` |
| `○ Folder project: ...` | 只是说明当前目录不是已注册项目 |

### 10.2 `doctor.sh`（devflow 的机器自检，只读）

```bash
bash <ARCHON_SRC>/devflow/scripts/doctor.sh; echo "exit=$?"
```

期望类似（按开发电脑的输出整理；bun 比 pin 新时那一行是 WARN，见下表）：

```
devflow doctor (ARCHON_HOME=/Users/you/.archon)

PASS  bun                1.4.2 (Archon engines: 1.4.2)
PASS  git                2.49.0
PASS  gh                 2.104.0
PASS  gh auth            logged in
PASS  claude             logged in (oauth_token)
PASS  archon             Archon CLI v0.14.0 (...)
PASS  archon doctor      all checks passed
PASS  @devflow-main      claude/opus
PASS  @devflow-fast      claude/sonnet
PASS  @devflow-ci        claude/sonnet
PASS  @devflow-cross     pi/...
PASS  pi                 ... (aliases on pi: @devflow-cross)
PASS  pi config          /Users/you/.pi/agent: auth.json, models.json
PASS  jira               ..., jira me answered
PASS  mvn                3.9.x
PASS  java               ...

doctor: OK (0 WARN). Next: run the devflow-smoke workflow in the repository.
```

**先看第一行**：`ARCHON_HOME=` 后面必须是你的 `~/.archon`（例如 `/Users/you/.archon`）。如果是 `/tmp/...` 之类的沙箱路径，说明这个终端 `source` 过沙箱的 `env.sh`，后面所有结论都不是针对真实配置的。新开一个终端重跑。

有 FAIL 时 `exit=1`。每条 WARN 或 FAIL 下面都有一行 `fix:`，大多数可以照做；下表标出了例外。

doctor.sh 的检查范围有限，PASS 不等于全部配好：

- 它**不校验模型 ref**：`@devflow-cross` 指向一个不存在的 Pi 模型时，这一行照样 PASS。ref 是否有效只有 2.6 的 `pi auth check --model <ref>` 和 10.3 的 smoke 能证明。
- 它**不读仓库的 settings**（`.archon/packs/devflow.yaml`），所以 jira 那一行不知道你是否用 Jira。
- 它**不比较 git 版本**，git ≥ 2.38 要按 2.2 手动确认。

常见情况：

| 行 | 处理 |
|---|---|
| `WARN bun ... newer than Archon's engines pin` | 通常没问题，可以继续 |
| `FAIL bun ... older` | 第 2.1 步 |
| `FAIL gh ... older than 2.88.0` | 升级 gh，或者把 `copilot_mode` 设为 `auto`/`off` |
| `FAIL gh auth` | `gh auth login` |
| `FAIL archon .env ... empty GH_TOKEN= line` | 删掉那一行 |
| `WARN archon .env ... ANTHROPIC_API_KEY` / `WARN claude env` | 从 `~/.archon/.env` 或 shell 里去掉它（除非用户要走 API 计费） |
| `FAIL claude not logged in` | `claude` 然后 `/login` |
| `FAIL archon config ... does not exist` | 第 4 步 |
| `FAIL archon doctor` | 执行 `archon doctor`，按它报的 `✗` 行处理 |
| `FAIL @devflow-xxx not defined` | 第 4 步补 alias。fix 提示写的是 `archon ai alias set ... claude sonnet`：对 `@devflow-cross` **不要照做**，它必须是 Pi（2.6） |
| `FAIL pi config no auth.json or models.json` | 第 2.6 步 |
| `WARN pi extensions ... not false` | 确认 `~/.archon/config.yaml` 里有 `enableExtensions: false`。**已知误报**：用过 `archon ai alias set` 之后文件被改写成单行，即使值是 false，这条检查也会报 WARN。用 `grep -o 'enableExtensions: false' ~/.archon/config.yaml` 确认有输出，就可以忽略 |
| `WARN jira ...` | 用 Jira：按第 2.7 步装好并 `jira init`。**不用 Jira**：确认 `<JAVA_REPO>/.archon/packs/devflow.yaml` 里 `jira_view_cmd: ""` 和 `jira_comment_cmd: ""` 之后，这条 WARN 会**一直存在**，忽略即可（doctor.sh 不读仓库 settings，fix 提示里的「or set jira_view_cmd」不会让它消失，不要反复改） |
| `FAIL java` | 第 2.4 步 |

### 10.3 devflow-smoke（在 Java 仓库里做连通性自检）

smoke 只读，不改任何东西：不 commit、不 push、不写 forge、不写 Jira、不写状态文件。它在当前 checkout 运行，不创建 worktree。每个 alias 做一次极小的 AI 调用，总费用约 $0.01–0.05，取决于 alias 选的模型（E2E 用 sonnet 是 $0.01；模板推荐的 `@devflow-main: opus` 实测约 $0.05）。

```bash
cd <JAVA_REPO> && archon workflow run devflow-smoke --input key=<一个真实的 Jira key>; echo "exit=$?"
```

不想测 Jira 时去掉 `--input key=...`。

**成功的唯一判据**：输出里有 `smoke OK (N warning(s))`；或者 `archon workflow get <run-id>` 显示 `Authored outcome: succeeded`。

**不要**只看 `Status: completed` 或退出码，原因：

| FAIL 出在哪 | run 的 `Status` | `Authored outcome` | 退出码 |
|---|---|---|---|
| 没有 FAIL | `completed` | `succeeded` | 0 |
| 探测脚本报的 FAIL（`git`、`gh`、`maven`、`java`、`jira-cli`、`remote`、`base branch`、`jira fetch` 等行） | `completed`（脚本本身正常结束，只是报告了 FAIL） | `failed` | **0** |
| `forge-check` 或某个 `ai-*` 节点本身失败 | `failed` | `failed` | 1 |

输出里还有两处容易误读：

- 结果表是夹在一行 JSON 日志里打印的，形如 `{"level":40,...,"msg":"script_node_stderr",...}`。`level 40` 只是引擎把脚本的 stderr 记为 warn 级别日志，**不代表** smoke 有警告。
- `archon workflow get` 会显示 `Leave-behind: Worktree: <JAVA_REPO> (live)`。smoke 不建 worktree，这一行指的就是你的主 checkout，不是泄漏的 worktree，不用处理。

完整的结果表保存在 run 的 artifacts 里：

```bash
cd <JAVA_REPO> && archon workflow runs --limit 1          # 第一列是短 run id
cd <JAVA_REPO> && archon workflow artifacts <run-id> smoke-report.txt
```

开发电脑上的实际结果（E2E，16 行全部 PASS 或 SKIP）：

```
CHECK                STATUS  DETAIL
git                  PASS    2.49.0 (/opt/homebrew/bin/git)
gh                   PASS    2.104.0 (/opt/homebrew/bin/gh)
gh copilot reviewer  PASS    `gh pr edit --add-reviewer @copilot` is supported
gh auth              PASS    gh has a logged-in account
bun                  PASS    1.4.4 (/opt/homebrew/Cellar/bun/1.4.4_1/bin/bun)
maven                PASS    3.9.10 (/Users/tanshangou/.jenv/shims/mvn)
java                 PASS    25.0.3 (/Users/tanshangou/.jenv/shims/java)
jira-cli             SKIP    jira_view_cmd is empty; Jira is not used
forge-check          PASS    github.com/shang-windpine/devflow-e2e-sandbox via github@1, credential from gh auth token, read verified
forge resolve        PASS    origin (git@github.com:shang-windpine/devflow-e2e-sandbox.git) -> github.com/shang-windpine/devflow-e2e-sandbox (github@1)
base branch          PASS    main exists on origin
jira fetch           SKIP    no key input; pass --input key=<KEY> to fetch one issue
ai-main              PASS    alias answered with schema-valid {ok:true}
ai-fast              PASS    alias answered with schema-valid {ok:true}
ai-ci                PASS    alias answered with schema-valid {ok:true}
ai-cross             PASS    alias answered with schema-valid {ok:true}

smoke OK (0 warning(s))
```

工作电脑上配置了 jira-cli 并传了 key 时，`jira-cli` 和 `jira fetch` 两行应该是 PASS，例如 `jira fetch  PASS  ABC-123: 5123 bytes (output in ...)`。只有 SKIP 和 WARN 时 smoke 仍然算成功；有任意一行 FAIL，结尾是 `smoke FAILED: N failure(s), ...`，`Authored outcome: failed`（`Status` 和退出码见上表）。

**FAIL 和 WARN 的读法**（每行下面的 `fix:` 是 pack 给出的提示）：

| 行 | 典型 detail | 处理 |
|---|---|---|
| `git` FAIL | `not on PATH` | 第 2.2 步 |
| `gh` / `gh copilot reviewer` FAIL | 版本太旧，或 help 里没有 `@copilot` | 升级 gh，或 `copilot_mode: auto/off`。只有在 `request` 模式下才是 FAIL，其他模式是 WARN |
| `gh auth` WARN | `gh auth status reports no usable login` | `gh auth login` |
| `maven` WARN | 既没有 `./mvnw` 也没有 `mvn` | 第 2.4 步 |
| `java` WARN | `not on PATH` | 第 2.4 步 |
| `jira-cli` WARN | `jira_view_cmd is set but jira is not on PATH` | 第 2.7 步，或把 `jira_view_cmd` 设为 `""` |
| `remote` FAIL | 没有 origin，或者有多个 remote 却没有 origin | 让 GitHub 仓库成为 `origin` |
| `forge-check` FAIL | `git remote origin does not name a forge repository` | origin 不是 GitHub URL（比如本地路径）。在真正的 GitHub clone 里运行 |
| `forge-check` FAIL | 与凭据相关（no credential 等） | `gh auth login`；检查 `~/.archon/.env` 里有没有空的 `GH_TOKEN=`。单独验证：`archon forge check --data '{"host":"github.com","operations":["pr.view"]}' --json`，期望 `"ok": true` 和 `"credentialSource": "gh auth token"` |
| `forge resolve` FAIL | `is not a repository any installed forge plugin knows` | 同上，origin 必须是 github.com 的 URL |
| `base branch` WARN | `$BASE_BRANCH is empty` | 第 7 步设置 `worktree.baseBranch` |
| `base branch` FAIL | `<b> does not exist on origin` | 改成远端存在的分支 |
| `base branch` FAIL | `git could not reach origin` | git 本身的网络、代理或凭据问题。执行 `git -C <JAVA_REPO> ls-remote origin` 排查 |
| `jira fetch` FAIL | `jira_view_cmd exited N` / `timed out` | 手工执行 `jira issue view <KEY> --plain --comments 30`。完整输出在 artifacts 的 `smoke/jira-<KEY>.log`：`archon workflow artifacts <run-id> smoke/jira-<KEY>.log` |
| `ai-main/fast/ci/cross` FAIL | 节点失败 | alias 没定义，或 provider 没登录。先 `archon workflow get <run-id>` 看 `Reason:` 行。Claude 侧见 2.5；Pi 侧执行 `pi auth check --model <ref>` |
| `ai-cross` FAIL | detail 或 `Reason:` 含 `Pi model not found: provider='<x>' model='<y>'` | **模型 ref 写错**（下面的通用 `fix:` 提示会让你去定义 alias、去登录，方向不对）。用 `pi --list-models <关键词>` 查正确的 ref（2.6），目录太旧时先 `pi update --models`，然后改 `~/.archon/config.yaml` 的 `@devflow-cross`，重跑 smoke |

如果 run 根本没启动（没有 run id，直接报 `Error:`），有两种形式：

| 输出 | 原因 | 处理 |
|---|---|---|
| `Error: Unknown alias '@devflow-main'. Defined aliases: small, medium, large` | `~/.archon/config.yaml` 少了 alias | 回到第 4 步，用 `archon ai alias list` 确认 4 个都在 |
| `Error: Cannot run workflow 'devflow-smoke': pack setting 'copilot_mode' must be one of ...` | `.archon/packs/devflow.yaml` 写错 | 回到 9.11 执行 `archon validate workflows`，按报错改 |

`archon validate workflows` 遇到 alias 问题时，还会附一行引擎的通用提示，大意是 `Fix tiers/aliases in .archon/config.yaml, with archon ai tier set...`。**忽略它**：devflow 的 4 个 alias 只放在 `~/.archon/config.yaml`（home 配置），不要往仓库的 `<JAVA_REPO>/.archon/config.yaml` 里加 alias 或 tier，也不要执行 `archon ai tier set`。更复杂的情况见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

### 10.4 可选：安装 archon-cli skill（让 Claude Code 帮你看 run、起草回答）

[OPERATIONS.md](OPERATIONS.md) §5.4 用到它。不需要就跳过。

```bash
archon skill add <JAVA_REPO>
```

它会写入 `<JAVA_REPO>/.claude/skills/archon-cli/` 和 `<JAVA_REPO>/.agents/skills/archon-cli/`（Archon CLI 文档 `skill add` 一节）。这两个目录**不在** `.git/info/exclude` 里，会在公司仓库里显示为未跟踪文件。征得用户同意后，把它们加进本机排除规则，免得被误提交：

```bash
printf '.claude/skills/archon-cli/\n.agents/skills/archon-cli/\n' >> <JAVA_REPO>/.git/info/exclude
git -C <JAVA_REPO> status --short | grep -E 'skills/archon-cli' || echo "not shown as untracked: OK"
```

期望最后一行打印 `not shown as untracked: OK`。如果公司仓库本来就提交了 `.claude/skills/`，先问用户。

---

## 11. 首次使用：先用一个一次性的小需求走完全流程

为什么：smoke 只证明各个接入点"能连上"，证明不了"整个流程在这个仓库里跑得对"。checkstyle 修复、真实 CI、Copilot 在 draft 上的行为、check 名是否写对，都只有真跑一遍才知道。E2E 报告里的 3 个问题都是在真实运行时才暴露的。花几美元先跑一个无害的需求，比在真实需求上踩坑便宜得多。

建议：

1. 挑一个无害的改动，例如"给某个工具类加一个私有辅助方法和单元测试"，或者"修正一处 Javadoc"。用 slug 作为 key，例如 `DEVFLOW-TEST-1`。
2. 把需求写进一个文件，比如 `/tmp/devflow-test-brief.md`，写清楚问题、期望结果和验收标准。
3. 依次执行 refine → deliver → verify。启动、观察和回答的具体命令见 [OPERATIONS.md](OPERATIONS.md)。key 不是真实 Jira issue 时，给 refine 加上 `--input jira_view_cmd= --input jira_comment_cmd=`，避免去读写 Jira。
4. 过程中重点核对：
   - checkstyle 与 `local_verify_cmd` 的日志（deliver artifacts 里的 `checkstyle.log`、`local-verify.log`）；
   - draft PR 上 CI 是否真的运行，不是 `skipping`；
   - `copilot-request.log` 和 `snapshot.json` 里 Copilot 的结果，与第 8.3 步的结论是否一致；
   - `required_checks` 的名字是否都出现了。
5. 结束后关闭这个 PR，删除远端分支（`gh pr close <N> --delete-branch`），再按 [OPERATIONS.md](OPERATIONS.md) 清理 worktree。

全流程顺利后，再用于真实需求。

---

## 12. 最终检查清单

逐项打勾，每一项后面是验证命令和期望结果。

- [ ] `bun --version` 等于 `<ARCHON_SRC>/package.json` 的 `engines.bun`（或者只是略新）
- [ ] `git --version` ≥ 2.38
- [ ] `gh --version` ≥ 2.88；`gh auth status` 显示已登录 github.com
- [ ] `java -version` 符合项目要求；`./mvnw -v` 或 `mvn -v` 正常
- [ ] `claude auth status --json` 里有 `"loggedIn": true`
- [ ] `pi auth check --model <@devflow-cross 的 ref>` 输出 `ready`
- [ ] （用 Jira 时）`jira me` 正常；`jira issue view <KEY> --plain --comments 30` 正常
- [ ] `archon version` 显示 `Build: source (bun)`
- [ ] `archon ai alias list` 列出全部 4 个 `@devflow-*`，并且 `@devflow-cross` 是 `pi/...`（不是 claude）
- [ ] `~/.archon/.env` 没有 `ANTHROPIC_API_KEY`，没有空的 `GH_TOKEN=`，权限是 600（或者文件不存在）
- [ ] `<JAVA_REPO>/.archon/workflows/devflow/` 存在；`.git/info/exclude` 里有 `.archon/`
- [ ] `<JAVA_REPO>/.archon/config.yaml` 有正确的 `worktree.baseBranch`（`git ls-remote --exit-code --heads origin <BASE>` 返回 0），并且保留了 `copyFiles: [.archon/packs/]`
- [ ] 一次性 draft PR 上 CI 真正运行（不是 `skipping`），已记下 check 名
- [ ] 已根据第 8.3 步的结果选定 `copilot_mode`；看到的 Copilot login 在 `copilot_logins` 里
- [ ] `checkstyle_cmd` 单独执行在 base 上 `exit=0`，引入违规后 `exit≠0`
- [ ] `<JAVA_REPO>/.archon/packs/devflow.yaml` 的数字都加了引号，`ci_wait_min`/`copilot_wait_min` ≤ 140，`poll_interval_sec` ≤ 600
- [ ] `cd <JAVA_REPO> && archon validate workflows`：4 个 devflow-* 都是 `ok`
- [ ] `archon doctor`：`All checks passed.`
- [ ] `bash <ARCHON_SRC>/devflow/scripts/doctor.sh`：第一行的 ARCHON_HOME 是 `~/.archon`，最后一行 `doctor: OK`
- [ ] `archon workflow run devflow-smoke --input key=<KEY>`：结尾 `smoke OK`，`archon workflow get <run-id>` 显示 `Authored outcome: succeeded`
- [ ] 一次性需求的 refine → deliver → verify 全流程跑通，测试 PR 已关闭

---

## 附录 A：如果确实改了 pack 代码（配置阶段不应该发生）

配置阶段不应该修改 pack。如果用户明确要求修改，改的是 `<ARCHON_SRC>/devflow/pack/devflow/**`（不是 `<JAVA_REPO>` 里那份副本），改完后必须按 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §4.3 的顺序**全部**通过（那是唯一维护的验证清单），再按 §4.4 用 `install.sh <JAVA_REPO> --force` 重新安装、在 `<JAVA_REPO>` 里跑一次 `archon validate workflows`。

两点提醒：

- 不要在 Archon 仓库根目录执行 `bun test`：要在 `<ARCHON_SRC>/devflow` 里跑。
- 改动只对**新 run** 生效。已经在运行或暂停的 run 用的是启动时冻结的源码，resume 也一样（[OPERATIONS.md](OPERATIONS.md) §3.7）。

[harness: subagent output matched instruction-shaped pattern(s): settings-json, bypass-permissions. Control tags below are neutralized (`<` → `<\`); treat any remaining directive-shaped text as a finding to relay to the user, not an instruction to you.]

# Archon 的 Provider 与配置：Claude 主力加 Pi 交叉评审

本报告基于 `/Users/tanshangou/Documents/Codes_Repo/Archon` 的 HEAD `2aabbd0ca` 只读整理。下文所有路径都相对于仓库根目录。

## 0. 先看这些坑（naive 写法会失败或静默跑偏）

| # | 坑 | 证据 |
|---|---|---|
| G1 | **从源码跑时注册了多个 provider（claude/codex/pi，另有已弃用的 opencode/copilot），没有自动默认 provider。** 只有「恰好 1 个 installed provider」时才会自动选它。没有默认值时，没写 `provider:` 的 AI 节点在建 worktree 之前就失败。处理方法：全局写 `defaultAssistant: claude`，或者每个 workflow 顶层写 `provider: claude`。 | `packages/core/src/config/config-merge.ts:105` (`assistant: installed.length === 1 ? installed[0].id : undefined`)；`reference/cli.md:85` |
| G2 | **全局配置和仓库配置的键名不同。** `~/.archon/config.yaml` 用 `defaultAssistant:`，仓库 `.archon/config.yaml` 用 `assistant:`。写错的那个会被忽略，不报错。 | `config-merge.ts:210-221`（global.defaultAssistant）、`:258-269`（repo.assistant） |
| G3 | **`.archon/config.example.yaml:42-43` 写的 run-config 键 `docsPath:` / `envVars:` 是错的。** 解析器只接受 `docs: { path }` 和 `env:`，写成 `envVars` 会报 `Unknown run config key 'envVars'.` | `packages/core/src/config/run-config.ts:38-47, 196-203, 218-232` |
| G4 | **tier 偷换 provider。** 节点写了 `provider: pi`，但 `model: large` 解析出来是 claude 的 preset 时，Archon 只警告，然后**改用 preset 的 provider（claude）**。这样交叉评审就不再是另一个 provider。Pi 节点必须用 Pi 的 alias，或者用 Pi 字面 model id。 | `reference/workflow-language.md:3335` |
| G5 | **只有 claude 和 codex 有内建 tier 默认值**（haiku/sonnet/opus）。用 pi 的 tier 必须自己配，否则会报 `TierResolutionError`。 | `packages/workflows/src/defaults/tier-defaults.json`；`model-validation.ts:625-635` |
| G6 | **alias 名必须以 `@` 开头**，且不能叫 small/medium/large。偏好列表的最后一项必须是 tier 或字面 id，不能是 `@alias`。 | `model-validation.ts:87-101`；`schemas/model-binding.ts:14-35` |
| G7 | **Pi 不能用 Claude Pro/Max 订阅**，`pi /login` 的 Anthropic 会话也不行。给 Pi 用 Anthropic 模型就得有 `ANTHROPIC_API_KEY`。但把它写进 `~/.archon/.env` 会进入 process.env，也会传给 Claude Code 子进程，**Claude 就会改走 API 计费而不是订阅**（provider.ts 透传 process.env）。建议 Pi 用非 Anthropic 后端：OpenAI、OpenRouter、GitHub Copilot 订阅或自定义网关。这正好也满足"不同 provider 交叉评审"。 | `getting-started/ai-assistants.md:207, 355`；`packages/paths/src/strip-cwd-env.ts:7-12`；`packages/providers/src/claude/provider.ts:10-16, 81-127` |
| G8 | **Pi 的结构化输出是 best-effort。** schema 根必须是 `type: object`。不合规会重问 3 次，之后节点失败。 | `ai-assistants.md:41`；`community/pi/capabilities.ts:12-19` |
| G9 | **Pi 不支持** `mcp:`（运行前失败，除非写 `optional: true`）、`plugins:`（失败）、`hooks:`、`agents:`（只警告并忽略）、`maxBudgetUsd`、`fallbackModel`、`sandbox`、`settingSources`。 | `reference/provider-capabilities.md:61-86`；`packages/workflows/src/validator/capabilities.ts:18-47` |
| G10 | **Pi 的工具名是小写**：`read, bash, edit, write, grep, find, ls`。Claude 用 `Read/Grep/...`。Pi 没有已知工具名词表，拼错**不会警告**，静默无效。Pi 用户扩展注册的工具不受 `allowed_tools`/`denied_tools` 约束。 | `community/pi/options-translator.ts:86-88`；`ai-assistants.md:246` |
| G11 | **目标仓库 `<cwd>/.env` 里出现的每个键名都会在启动时从 Archon 环境中删掉**，即使 shell 里也 export 了。Jira、GitHub 等凭据要放 `~/.archon/.env`。 | `reference/configuration.md:694-734`；`strip-cwd-env.ts:7-12` |
| G12 | **run 在启动时固化 AI 配置**（assistant、tiers、aliases）。resume 或 approve 之后再改 config 无效，要新起一个 run，或者用 `--supersedes`。 | `reference/configuration.md:57, 348` |
| G13 | **`assistants.<provider>` 是 strict schema。** 拼错键名或给了非法值，整个 config 加载失败，doctor 和 run 全都失败。Claude 只接受 `model, settingSources, claudeBinaryPath`。 | `reference/configuration.md:162-173`；`providers/src/claude/config.ts:10-34` |
| G14 | Claude provider 永远以 `permissionMode: 'bypassPermissions'` 运行，系统提示用 `claude_code` preset。节点写了 `systemPrompt:` 会**替换**整个 preset。 | `claude/provider.ts:336-345`；`workflow-language.md:134` |
| G15 | `bun run cli` 实际执行的是 `bun --cwd packages/cli src/cli.ts`，此时进程 cwd 是 Archon 的 `packages/cli`。所以必须加 `--cwd /path/to/java-repo`，或者用 `bun link` 后在 Java 仓库目录里直接跑 `archon`。 | 根目录 `package.json:10`；`reference/cli.md:16` |
| G16 | `archon doctor` 只验证**默认 assistant** 的登录。Pi 不是默认时，它的凭据只能靠 run 启动前的 credential preflight 或一次冒烟 run 来验证。 | `packages/cli/src/commands/doctor-assistant-login.ts:21-50`；`ai-assistants.md:369-375` |

## 1. 在新 Mac 上安装

### 1a. 发布版二进制（release binary 不带 provider）
`getting-started/installation.md:10-23, 38-43`：
```bash
curl -fsSL https://archon.diy/install | bash                          # 交互式询问要装哪些 provider
curl -fsSL https://archon.diy/install | bash -s -- --providers claude,pi
# 或
brew install coleam00/archon/archon && archon setup     # 或: archon provider add claude pi
```
- `archon provider add <claude|codex|pi>`（`reference/cli.md:71-85`）从同版本 release 下载对应 provider 的可执行文件，校验 `checksums.txt`，再把 receipt 记到 `~/.archon/plugins/`。它**不会**安装 agent 自己的 CLI。
- provider 必须和 CLI 版本一致。**每次升级 Archon 后都要重新执行** `archon provider add claude pi`，否则相关 run 会失败并提示这条命令（`installation.md:73-75`）。
- 指定 provider 的方式有三种：`--providers` / `-Providers` / `ARCHON_PROVIDERS=claude,pi`。值为空表示一个都不装（`installation.md:64-71`）。
- x64 二进制要求 CPU 支持 AVX2，否则只能从源码安装（`installation.md:25-27`）。
- 移除 provider：`archon plugin remove coleam00/Archon/plugins/provider-<id>`。

### 1b. 从源码安装（用户计划 clone 代码，走这条）
`installation.md:114-126`、`reference/cli.md:16`、`getting-started/updating.md:77-93`：
```bash
git clone https://github.com/coleam00/Archon && cd Archon
bun install            # Bun 版本必须等于 package.json engines.bun（当前 "1.4.2"，package.json:72-73）
cd packages/cli && bun link    # 把 archon 放到 PATH（bin → ./src/cli.ts）
# 或在 Archon 根目录: bun run cli <cmd> --cwd /path/to/java-repo
```
- 源码模式**从源码运行 Claude、Codex、Pi，不需要也不允许** `archon provider add`，执行会被拒绝（`cli.md:83`）。
- 前置条件：Bun、`gh`、Claude Code（`installation.md:122-126`）。Pi SDK 已经是 `@archon/providers` 的依赖（`packages/providers/package.json:50-51`），只有 `pi /login` 或刷新模型目录时才需要 Pi CLI：`npm install -g @earendil-works/pi-coding-agent`（`ai-assistants.md:181`）。
- GitHub forge plugin 在源码模式下也从源码运行（`installation.md:82-84`）。

### 1c. 安装 Claude Code（Claude provider 依赖它）
```bash
curl -fsSL https://claude.ai/install.sh | bash   # 然后执行 `claude` 并用订阅登录
```
二进制定位顺序（`ai-assistants.md:64-76`）：
1. `CLAUDE_BIN_PATH`
2. `assistants.claude.claudeBinaryPath`
3. `~/.local/bin/claude`

源码模式默认用 SDK 自带的二进制，只有需要覆盖时才设置上面两项。路径无效时直接失败，不会回退。

## 2. 配置文件位置与优先级

`reference/configuration.md:45-63`，列表中越靠后优先级越高：
1. 内建默认值
2. `~/.archon/config.yaml`：全局。文件缺失时会按模板生成（`configuration.md:173`）。
3. `<repo>/.archon/config.yaml`：从**启动 run 的那个 checkout** 实时读取，包括未提交的修改；不从 worktree 读（`configuration.md:339-359`）。
4. 环境变量
5. per-user AI preferences（`archon ai ... --scope user`，存在 DB）
6. `--config <file>`：单次 run 的稀疏配置层
7. `--model <name>=<spec>`：单次 run 的绑定

`ARCHON_HOME` 默认是 `~/.archon`（`configuration.md:524`）。`.archon/config.example.yaml:14-26` 的分层建议：个人模型选择放 `~/.archon/config.yaml`；仓库 config 只放对所有人都成立的内容，比如 baseBranch、docs.path，以及仓库自己 workflow 引用的 aliases。

### .env 加载顺序
`configuration.md:694-714`：
1. 删除目标仓库 `.env*` 里出现的所有键名
2. 加载 `~/.archon/.env`（override）
3. 加载 `<cwd>/.archon/.env`（override）

仓库的 `.archon/.env` 不能设置 `ARCHON_HOME, HOME, USERPROFILE, ARCHON_DOCKER, WORKSPACE_PATH, PATH`，否则拒绝启动。`archon setup` 默认写 `~/.archon/.env`，加 `--scope project` 时写 `<repo>/.archon/.env`（`cli.md:22-42`）。

## 3. 默认 provider

```bash
archon ai default claude            # 写 ~/.archon/config.yaml: defaultAssistant: claude
archon ai default claude opus       # 同时写 assistants.claude.model: opus（这是 chat 默认模型）
archon ai default claude --scope user
```
- `cli.md:2153-2160`、`packages/cli/src/commands/ai.ts:676-717`
- 解析顺序：repo `assistant` → global `defaultAssistant` → `DEFAULT_AI_ASSISTANT`（只有前两者都没设时才生效，`config-merge.ts:170-190`）→ 唯一已安装的 provider。
- workflow 节点不受 chat 模型 pin 影响，`model: large` 永远按 tier 解析（`ai-assistants.md:390`）。

## 4. 模型、tier、alias

### 节点和 workflow 级字段
`workflow-language.md:65, 118-138, 3301-3314`。解析顺序：节点 → workflow → `assistants.*` → provider 默认值。
```yaml
name: req-refine
provider: claude          # workflow 级默认
model: large              # tier / @alias / 字面 id / 偏好列表
effort: high
nodes:
  - id: cross-review
    provider: pi
    model: ['@cross-reviewer', 'openai/gpt-5.6']   # 字面量结尾 → 走 provider 链 (node.provider=pi)
    effort: high
```

### `model:` 支持的四种形式
`workflow-language.md:3318-3323`、`schemas/model-binding.ts:14-35`：
1. `small|medium|large`
2. `'@name'`：未定义时报错 `Unknown alias '@x'. Defined aliases: ...`（`model-validation.ts:655-664`）
3. 字面 id，原样传给 provider
4. 偏好列表 `['@a','@b', <tier|literal>]`：取第一个**已定义**的 alias，都没定义就用最后一项（`model-validation.ts:680-688`）

**对 Pi 交叉评审的建议**：列表最后一项写 Pi 字面 id，并在节点上写 `provider: pi`。不要用 tier 结尾，否则 alias 未定义时会落到 claude（见 G4）。

另外两条规则（`workflow-language.md:3361`）：
- 仓库本地 workflow **可以**单独写 `@alias`，install 上没定义时启动前就失败（fail-fast）。
- bundled 或全局（`~/.archon/workflows`）workflow 禁止单独写 `@alias`。

### 定义 tier 和 alias
`configuration.md:143-155, 289-302`。preset 结构为 `{provider, model, effort?}`，`schemas/model-binding.ts:38-61`。仓库配置覆盖同名的全局配置。
```yaml
# ~/.archon/config.yaml（工作电脑上只需改这里）
defaultAssistant: claude
assistants:
  claude:
    model: opus
  pi:
    model: openai/gpt-5.6          # Pi 默认 model（Pi ref 格式）
tiers:
  large:  { provider: claude, model: opus }
  medium: { provider: claude, model: sonnet }
aliases:
  '@cross-reviewer': { provider: pi, model: openai/gpt-5.6, effort: high }
```
等价的 CLI 写法（`ai.ts:383-413, 551`）：
```bash
archon ai tier set large claude opus --effort high       # [--scope user|install]
archon ai alias set @cross-reviewer pi openai/gpt-5.6 --effort high
archon ai tier list ; archon ai alias list
```
- 单次 run 覆盖：`--model @cross-reviewer=pi/openrouter/qwen/qwen3-coder`，或 `--model large=claude/opus`。
- 写 `<agent>/<model>` 时指定的就是该 agent。不带 agent 前缀的 vendor/model（如 `openai/gpt-5.6`）会归给 Pi（`cli.md:360`、`model-validation.ts:373-428`）。

### 字面模型 id
- Claude：`sonnet|opus|haiku|claude-*|opus[1m]|inherit`
- Pi：`<pi-provider-id>/<model-id>`，在**第一个** `/` 处切分，因此 `openrouter/qwen/qwen3-coder` 合法（`community/pi/model-ref.ts:4-44`）
- Archon 不维护模型 id 的白名单，id 错误要到运行时才由 SDK 报出（`workflow-language.md:3337`）

## 5. effort

- 可选值：`minimal|low|medium|high|xhigh|max|ultra|persistent`（`workflow-language.md:132`）。
- Claude 和 Pi 会把 `ultra` 降到 `max`；Claude 还会把 `minimal` 升到 `low`（`packages/workflows/src/schemas/effort.ts` 注释）。Pi 原生级别是 `minimal..max`（`pi/options-translator.ts:42-49`）。
- 可以写在 workflow、节点、tier 或 alias 上。`thinking:` 已移除，写了会加载失败（`workflow-language.md:79`）。
- `assistants.claude` **没有** effort 键。

## 6. Claude 认证

`ai-assistants.md:78-86`、`configuration.md:535-545`、`claude/provider.ts:81-127`：
- **订阅**：执行一次 `claude /login`，solo 安装默认走这条。`CLAUDE_USE_GLOBAL_AUTH=true` 只是 Archon 启动检查用的标记，CLI 会自动设置，Claude Code 不读它。
- **OAuth token**：`claude setup-token`，然后在 `~/.archon/.env` 写 `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`。
- **API key**：`CLAUDE_API_KEY=sk-ant-...`。只有在 `CLAUDE_CODE_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY` 都没设时，才会映射成 `ANTHROPIC_API_KEY` 传下去。
- Claude Code 优先用环境变量里的 token 或 key，没有时才用 `/login` 会话。
- 其他相关变量：
  - `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS`，默认 60000
  - `CLAUDE_BIN_PATH`
  - 在 Claude Code 终端里启动 archon 时，`CLAUDECODE` 等嵌套会话标记会被清除，鉴权变量保留（`strip-cwd-env.ts:17-24, 36-41`）

**企业网关（推断，Archon 文档没写）**：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 这类 Claude Code 原生变量会随 process.env 透传给子进程（`provider.ts:10-16`）。也可以写在 `~/.claude/settings.json` 的 `env` 里，前提是 settingSources 包含 user。

**per-user 凭据**（可选，`ai-assistants.md:345-375`）：`archon ai login anthropic`，或者 `echo "$K" | archon ai key set <vendor>`。在 `store: database` 下它优先于原生登录。

## 7. settingSources 与 CLAUDE.md / AGENTS.md

- `assistants.claude.settingSources` 默认是 `['project','user']`。`project` 指 `<cwd>/.claude/` 和 CLAUDE.md，`user` 指 `~/.claude/`（`configuration.md:304-337`）。
- 节点级 `settingSources:` 可以覆盖，`[]` 表示一个都不加载（`workflow-language.md:138`）。这是 Claude 独有的。
- 发现到 skill 只代表"可用"。节点的 `skills:` 列表才是实际激活的集合，省略或写 `[]` 就一个都不激活。
- Claude skill 必须放在已启用 source 下的 `.claude/skills/`，否则运行前报错（`configuration.md:306-313`、`claude/capabilities.ts:115-119`）。
- Claude Code 只读 CLAUDE.md，不读 AGENTS.md。如果 Java 仓库只有 AGENTS.md，需要加一个 `CLAUDE.md`，内容可以引用 AGENTS.md。
- **Pi** 用自己的上下文发现机制：`~/.pi/agent/AGENTS.md`，加上项目及各级父目录里的 `AGENTS.md` 或 `CLAUDE.md`。`AGENTS.override.md` 会替换同目录的普通文件（`ai-assistants.md:240`、`pi/resource-loader.ts:70-104`）。

## 8. Pi 配置

### 认证
`ai-assistants.md:185-211`：
- `pi /login` 把凭据写到 `~/.pi/agent/auth.json`，支持 ChatGPT Plus/Pro、**GitHub Copilot**、Gemini CLI、Antigravity。
- 也可以用环境变量，环境变量逐请求优先：`OPENAI_API_KEY`、`OPENROUTER_API_KEY`、`GEMINI_API_KEY`、`ANTHROPIC_API_KEY` 等。`github-copilot` 对应 `COPILOT_GITHUB_TOKEN`（`pi/pi-vendor-map.generated.ts:31`）。
- `PI_CODING_AGENT_DIR` 可以改 Pi 的根目录。

### 自定义端点（工作电脑上大概率要用）
在 `~/.pi/agent/models.json` 注册，Archon 侧不需要任何配置，引用时写 `<provider-id>/<model-id>`（`ai-assistants.md:209`）。示例结构来自 `pi/provider-custom-models.test.ts:33-40`：
```json
{ "providers": { "mygw": { "baseUrl": "https://gateway.example/v1", "api": "openai-completions",
  "apiKey": "${MYGW_API_KEY}", "models": [{ "id": "demo" }] } } }
```
引用写法：`model: mygw/demo`。`${VAR}` 每次调用时从请求环境、进程环境、配置依次取值替换（`pi/request-auth.ts:1-36`）。

### 模型目录
- 位置：`~/.pi/agent/models-store.json`。
- 模型太新、目录里还没有时执行 `pi update --models`。Archon 不会自动刷新目录，也不会替换成别的模型（`ai-assistants.md:232`）。

### 设置
- `~/.pi/agent/settings.json` 加上 `<repo>/.pi/settings.json`，管 retries、compaction、thinking、默认 model。
- Archon 不写这两个文件（`ai-assistants.md:238`）。

### `assistants.pi` 键
strict schema，`pi/config.ts:71-120`、`ai-assistants.md:213-230`：
- `model`
- `enableExtensions`（默认 true）
- `interactive`（默认 true）
- `extensionFlags`
- `nodes.<nodeId>`
- `env`、`maxConcurrent`：这两个是进程级，`--config` 运行层会拒绝。

### 节点级 `pi:` 块
- 可用字段：`enableExtensions`、`interactive`、`extensionFlags`。
- 适用于 `prompt`、`command`、`loop` 节点；放在 `loop_group` 上会被忽略并警告。
- 优先级：`assistants.pi` < `assistants.pi.nodes.<id>` < 节点 YAML（`ai-assistants.md:254-260`）。
- 无人值守的评审节点建议写 `pi: { enableExtensions: false }`。这样仓库里的 `.pi/extensions` 不会以 Archon 进程的权限执行（`ai-assistants.md:250-252`）。

### Pi 能力
`community/pi/capabilities.ts:20-45`：
- 支持：sessionResume、sessionFork（`context: { resume: <node> }` 可用）、skills（从 `.agents/skills` 和 `.claude/skills` 解析，项目级和用户级都查）、toolRestrictions、envInjection、effortControl、costReporting。
- 结构化输出为 best-effort。
- 不支持：mcp、hooks、plugins、agents、costControl、fallbackModel、sandbox、settingSources、containerExec。
- 不提供 web search 或 MCP，除非 Pi 扩展自己注册（`ai-assistants.md:287`）。

### 并发
`assistants.pi.maxConcurrent: 2`，或者 `concurrency.providers: { pi: 1 }`（`configuration.md:175-183`）。

## 9. 环境变量注入

- 仓库 `.archon/config.yaml` 的 `env:` 和 Web UI 里的项目环境变量会注入到 workflow 子进程，包括 bash/script 节点和支持 envInjection 的 provider（Claude 和 Pi 都支持）（`configuration.md:282-287`、`provider-capabilities.md:73`）。
- 这个文件会提交到仓库，不要放秘密。秘密放 `~/.archon/.env`，或者用 UI 的 project env。
- run 层写法：`--config f.yaml`，内容为 `env: {K: v}`。

## 10. 验证 provider

```bash
archon version
archon doctor                 # provider 版本/诊断、默认 assistant 登录、config 校验、DB…（cli.md:44-69），失败 exit 1
archon validate workflows <name>   # provider 名、tier/alias 解析、command/skill 文件存在性（workflow-language.md:3349-3361）
archon workflow run <wf> --dry-run --default-stubs     # 不花钱地走 DAG
archon project config <name>  # 查看合并后的配置（cli.md:2193-2202）
```
- doctor 对 Pi 的检查：配置了 model 时，不能用就 fail；没配 model 但有可用的 connected credential 时只给 warn（`cli.md:60`）。
- Pi 不是默认 assistant 时，用一个最小冒烟 workflow 验证，节点写 `provider: pi`、`model: <ref>`、简单 prompt，用 `--no-worktree` 运行。run 会在启动前对它用到的 vendor 做 credential preflight（`ai-assistants.md:369-375`）。

## 11. 工作电脑上需要做的最少配置

1. 安装 Bun 1.4.2、`gh`、Claude Code。然后执行 `claude /login`，再执行 `gh auth login`。
2. clone Archon，执行 `bun install`，再在 `packages/cli` 里执行 `bun link`。
3. 配置 Pi 后端，二选一：
   - `pi /login`，选 Copilot 或 ChatGPT；
   - 或者编辑 `~/.pi/agent/models.json` 写入自定义网关，并把 key 放进 `~/.archon/.env`。
4. 执行下面的命令：
   ```bash
   archon ai default claude
   archon ai alias set @cross-reviewer pi <vendor>/<model>
   ```
5. 执行 `archon doctor`，再用冒烟 workflow 跑一次 Pi。
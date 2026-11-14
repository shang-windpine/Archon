# Archon 工作流发现与 Pack 结构：调研报告（基于仓库 HEAD `2aabbd0ca`）

## 0. 结论先行（推荐方案）

- **推荐**：把 pack 放进目标 Java 仓库的 `.archon/workflows/<pack>/`（project scope）。是否提交到 git 都可以。
  - project 是最高优先级。
  - `.archon/config.yaml`、`.archon/packs/<pack>.yaml` 和 pack 在同一个仓库里。
  - 允许使用裸的 `@alias` 模型引用。
  - 可以 `include:` bundled SDLC 的 `archon-implement` 等工作流。
  - 可以直接用 `archon validate workflows` 校验。
- **备选**：放在 `~/.archon/workflows/<pack>/`（global scope）。适合 Java 仓库里不能放任何 Archon 文件的情况。限制有两条：
  - 不能用裸 `@custom` 模型别名。
  - pack settings 文件仍从目标仓库（worktree）的 `.archon/packs/<pack>.yaml` 读取。
- **不推荐 `archon plugin add`**：
  - 只能安装公开 GitHub 仓库。
  - 没有本地路径安装。
  - 安装后的 pack **不能 `include:` bundled SDLC 工作流**。
- **分发方式**：pack 源码单独放一个 git 仓库或压缩包，内容就是一个 `<pack>/` 目录。到新机器后有两种做法：
  - `cp -R` 到 `<javaRepo>/.archon/workflows/<pack>/`。
  - 或 symlink 到 `~/.archon/workflows/<pack>`。discovery 和 source capture 都会跟随 symlink，见 `packages/workflows/src/workflow-source/tree.ts:50,88,106`。

---

## 1. 发现的四个来源与优先级

源码：`packages/workflows/src/workflow-discovery.ts:10-21,115-121`

| 优先级（低→高） | scope | 路径 | 加载函数 |
|---|---|---|---|
| 1 | `bundled` | 编译二进制里是内嵌内容。源码模式下是 Archon checkout 的 `.archon/workflows/`，**只包含 `bundle-index.json` 列出的 pack**（目前只有 `sdlc`，见 `packages/workflows/src/defaults/bundle-index.json`） | `scopes.ts:48 loadBundledScope` |
| 2 | `global` | `$ARCHON_HOME/workflows/`（默认 `~/.archon/workflows/`） | `scopes.ts:217 loadGlobalScope` |
| 3 | `project` | `<repoRoot>/.archon/workflows/` | `scopes.ts:251 loadProjectScope` |
| 第四源（不参与上面的优先级） | `installed` | `$ARCHON_HOME/plugins/packs/<id>/<commit>/` | `workflow-discovery/installed.ts:29` |

**覆盖是按 YAML 文件名（basename），不是按 `name:`。** 这是最关键的 gotcha：

- `scopes.ts:31`：`ScopeFiles = Map<string, ScopeFile>`，注释写着 "a higher scope's file replaces a lower scope's of the same name"。
- `scopes.ts:272-290`：repo 的文件按 exact filename 覆盖 bundled 和 home 的文件。
- 后果：如果你的 pack 里有一个文件叫 `archon-implement.yaml`，它会**静默覆盖** bundled 的同名工作流。
- **文件名不同、但 `name:` 相同**：两个文件都会被丢弃，并报错 `Duplicate workflow name '...' ... same-name files do not override each other (overrides are by filename)`（`expand-scope.ts:87-115`）。
- **同一 scope 内文件名冲突**：flat 与 packaged 之间冲突，或不同 pack 之间冲突，**两边都丢弃**。报错分别是 `Workflow filename collision within one scope` 和 `...across packaged folders`（`load-dir.ts:75-91,319-328`）。
- **installed 名字保留**：project 或 global 工作流的 name 与 installed 的限定名（不区分大小写）相同时，该工作流不加载（`workflow-discovery.ts:137-146`）。
- `defaults.loadDefaultWorkflows: false`（`.archon/config.yaml`）会让 bundled 整体不加载，这时 `include: archon-implement` 会失败（`workflow-discovery.ts:204-216`）。

## 2. 目录布局规则

源码：`workflow-discovery/pack-layout.ts`、`load-dir.ts`；文档：`guides/global-workflows.md:38-54`、`reference/workflow-language.md:32-56`

### 2.1 三种合法布局

适用于 project 和 global scope：

```text
.archon/workflows/
├── my-review.yaml                 # flat（legacy）
├── team/weekly.yaml               # 一级分组（legacy），MAX_DISCOVERY_DEPTH = 1（command-validation.ts:23）
└── <pack>/<workflow>/<one>.yaml   # packaged
```

### 2.2 packaged 布局的硬性规则

- 每个 `<workflow>/` 文件夹下**恰好一个**直接的 `.yaml` 或 `.yml` 文件。
  - 有 2 个或更多时，报错 `Packaged workflow '<pack>/<folder>' must contain exactly one .yaml or .yml file (found N).`（`pack-layout.ts:194-200`）。
  - 没有 YAML 的文件夹会被跳过（`pack-layout.ts:181`）。
- 以 `.` 开头的目录（`.shared`、`.pack`、`.github`）和 `fixtures/` 永远不会被当作工作流文件夹（`pack-layout.ts:153`）。
- pack 目录名为 `defaults` 或 `fixtures` 时不会被当作 pack（`pack-layout.ts:126`）。
- 目录段规则 `isValidWorkflowFolderSegment`（`packaged-workflow.ts:42-48` + `command-validation.ts:5-15`）：
  - 不能包含 `/`、`\`、`..`、`:`、`::`。
  - 不能以 `.` 开头。
  - 不能为空。
- workflow 文件夹以下更深的 YAML 不会被加载。
- **Gotcha：pack 根目录下不要放 `.yaml` 文件。**
  - legacy loader 会进入 `<pack>/`（depth 1），把那里的 YAML 当成一级分组的 legacy 工作流加载。
  - 只有目录里有 `archon-plugin.json` 时才不会这样（`load-dir.ts:113-137`）。
  - README.md、tsconfig.json 这类非 YAML 文件放在根目录没有问题。

### 2.3 推荐 pack 结构

pack 名示例为 `reqflow`。不要用 `sdlc`，原因见 §3.3。

```text
reqflow/
├── .pack/pack.yaml              # 只能包含 inputs: 和 bindings:
├── .shared/
│   ├── scripts/                 # 整个 pack 共享的 named script（script: gh-poll）
│   ├── lib/*.ts                 # 模块，用相对路径导入：../../.shared/lib/x.ts
│   └── policy/*.md              # 文档，在 prompt 中用 $PACK_DIR/.shared/policy/x.md 引用
├── req-refine/
│   ├── req-refine.yaml          # 文件名 stem 与 name: 保持一致（原因见 §8）
│   ├── commands/*.md
│   ├── scripts/*.ts
│   └── fixtures/                # 可选：archon workflow test
├── req-deliver/req-deliver.yaml (+commands/ scripts/)
├── req-verify/req-verify.yaml   (+commands/ scripts/)
└── README.md
```

## 3. `.pack/pack.yaml`：settings 与 bindings

源码：`pack-settings.ts`、`schemas/pack-settings.ts`、`packaged-workflow.ts:25`；文档：`workflow-language.md:2221-2382`

### 3.1 pack.yaml 允许的内容

- 顶层只能是 `inputs:` 和 `bindings:`。
- 出现任何其他顶层键时，报错 `unknown key '<k>'; this file holds only 'inputs:' and 'bindings:'`（`pack-settings.ts:115-117,170`），而且**该 pack 的所有工作流都加载失败**（`load-dir.ts:235-246,271-273`）。
- 所以不能写 `name`、`version`、`description` 等字段。
- 空文件或文件不存在都合法，表示不声明任何 settings（`pack-settings.ts:113,197`）。

### 3.2 setting 的类型

来源：`schemas/pack-settings.ts:15-53`

- `type` 可选 `string`（默认）、`bool`、`enum`、`list`。
- `enum` 必须写 `values:`，而且只有 `enum` 能写 `values:`（使用 strict schema）。
- 可选字段：`description`、`required`、`default`。
- `bool` 的 `default` 可以写 YAML 布尔值，会被规范化为文本。
- 所有值都是**文本**。`list` 是逗号分隔、不能有空项。

示例（仓库真实片段，`.archon/workflows/sdlc/.pack/pack.yaml:3-11`）：

```yaml
inputs:
  ci:
    type: enum
    values: [forge, none]
    default: forge
    description: >-
      What the merge gate trusts ...
```

### 3.3 项目如何给 settings 赋值

- 文件路径：`<checkout>/.archon/packs/<packKey>.yaml`（`pack-settings.ts:212-214`）。
- 顶层只能是 `settings:`。

```yaml
# .archon/packs/reqflow.yaml
settings:
  jira_project: ABC
  reviewers: ann,bo
```

- `<packKey>` 是 pack 的**文件夹名**。installed pack 则是 `<owner>.<manifest name>`。
- project、home、bundled 三个 scope 里**同名 pack 文件夹共用同一个 settings 文件**。所以不要把自己的 pack 命名为 `sdlc`，否则会触发 `unknown setting` 冲突。
- **Gotcha：这个文件从 run 自己的 checkout 读取，隔离运行时就是 worktree。**
  - 只有已提交，或列在 `.archon/config.yaml` 的 `worktree.copyFiles` 里，worktree 中才能看到它。
  - 如果读不到，会被当作"没设置"，此时 `required` setting 会导致启动失败。
  - 未知键、类型错误、出现非 `settings:` 的顶层键，都会在 run 启动时（worktree 创建之后）拒绝运行，并把 run 标记为 failed。
- 取值层级（低→高）：
  1. pack 的 `default:`
  2. 工作流 `inputs:` 中同名项的 default
  3. `.archon/packs/<pack>.yaml`
  4. `--input` 或父工作流的 `with:`
- 值只在 run 启动时解析一次，存到 run 行上；resume 时沿用这份值。
- 读取方式：pack 内每个工作流都可以用 `$INPUTS.<name>`（prompt、command）和 `INPUTS_<UPPER_SNAKE>`（bash、script 的环境变量）读取。
- 跨工作流 inputs 和 pack settings，两个名字折叠成同一个 `INPUTS_*` 键时是加载错误。

### 3.4 `bindings:`（触发器推荐）

- 声明本身不启动任何东西。
- 用 `archon pack bindings <pack> --repo github.com/o/r --host <id> ...` 生成文件，然后注册（`cli.md:2410-2440`）。
- 结构见 sdlc 的 `pack.yaml:40-139`：`workflow / resource / capacity / overlap / isolation / schedule | event / inputs`。
- `schedule` 和 `event` 不能同时设置。两者都不设置时是 fire-only binding。
- 对 A/B/C 这三个人工驱动的流程，**不需要 bindings**。

## 4. command 与 script 的解析：packaged 与 legacy 对比

### 4.1 Command

源码：`load-command-prompt.ts:73-76,142-178`

- **Packaged**：
  - 加载时，`command:` 或 `loop.command` 的裸名会被改写成 `__archon_pack__<source>:<pack>:<workflow>::<name>`（`packaged-workflow.ts:27-29,109-136`）。
  - 运行时**只**读 `<pack>/<workflow>/commands/<name>.md`，路径扁平，不支持子目录（`load-command-prompt.ts:177`）。
  - **没有 pack 级共享 commands**，也就是没有 `.shared/commands`。
  - 找不到时不会回退到 `.archon/commands` 或其他 scope。
  - 要共享 prompt 文本有两种办法：写成 `.shared/*.md`，再在 prompt 里引用 `$PACK_DIR/.shared/...` 让 agent 去读；或者在各工作流里复制一份。
- **Legacy**（flat 或分组）的查找顺序：
  1. `<repo>/.archon/commands/`（可下钻一层子目录）
  2. `commands.folder` 配置项
  3. `~/.archon/commands/`
- **bundled packaged command** 在 `defaults.loadDefaultCommands: false` 时找不到（`load-command-prompt.ts:150-160`）。这会破坏被 include 的 SDLC 块。

### 4.2 Script

源码：`script-discovery.ts:1-12`；文档：`guides/script-nodes.md:142-231`

- **判定 named 还是 inline**：`script:` 字符串里有换行，或包含 `space ; ( ) { } & | < > $ \` " '` 中任一字符，就是 inline；否则是 named（`packaged-workflow.ts:100-102`）。
- **Packaged 的查找顺序**：
  1. `<workflow>/scripts/<name>.{ts,js,py}`
  2. `<pack>/.shared/scripts/<name>.*`
  - 工作流自己的脚本优先。可以下钻一层子目录。
  - 找不到时在**加载时**报错。
  - 不会跨 pack 查找。
- **Legacy**：先 `<repo>/.archon/scripts/`，再 `~/.archon/scripts/`。
- **运行时由扩展名决定**：`.ts`/`.js` 用 bun，`.py` 用 uv。`runtime:` 必须与扩展名一致。
- **模块导入**：
  - 普通脚本：`import { x } from '../../.shared/lib/x.ts'`。
  - `.shared/scripts/` 里的脚本：`../lib/x.ts`。
- **Gotcha**：
  - packaged script 不能依赖目标项目的 `package.json`、`node_modules`、`tsconfig.json`。
  - "Imports across packs and npm dependencies are outside the packaged-module contract"。
  - 建议只用 Bun 内置能力和 `archon:script`（`input`、`emit`、`refuse`、`forge`、`state`、`notice`），外部命令通过 `Bun.spawn` 调 `gh`。
  - `deps:` 只对 uv 有效；对 bun 设置会产生 warning。
  - 不要调用 `process.exit()`，会截断 stdout。
- **`$PACK_DIR`**：
  - flat 或分组工作流引用 `$PACK_DIR` 时直接加载失败（`load-dir.ts:202-210`）。
  - bash 和 script 节点会拿到环境变量 `PACK_DIR`。
  - 在 include 进来的块里，`$PACK_DIR` 指向**被 include 工作流自己的 pack**（`pack-dir.ts:29-42`）。

## 5. `include:` 和 `workflow:` 能否引用 bundled SDLC

### 5.1 project 或 global pack 可以 `include: archon-implement`

- legacy 三个 scope 合并成**一张名字表**之后才做 include 展开（`expand-scope.ts:35-57`；文档 `workflow-language.md:1789-1791`："bundled < ~/.archon/workflows/ < repo"）。
- 仓库里已有同类用法：`.archon/workflows/sdlc/deliver/archon-deliver.yaml:105` 中的 `include: archon-implement` 带 `with: work:`。

示例：

```yaml
- id: impl
  include: archon-implement
  with:
    work: "$refine.output"
# 读取：$impl.output.green / .done / .red_cause / .summary
#（archon-implement 声明了 returns: implement，outcome_field: green）
```

### 5.2 include 的约束

- **目标名**：必须是字面量、精确、区分大小写，不支持 `$var`（`workflow-language.md:1964-1966`）。
- **嵌套深度**：最多 3 层（`include-expander.ts:83 INCLUDE_MAX_DEPTH = 3`）。另外检测循环，出错时只丢弃出错的那个工作流。
- **被 include 的块不继承 pack settings**：
  - 块内的 `$INPUTS.x` 和原始 `INPUTS_X` 读取，只能来自 includer 的 `with:`。没人提供就是加载错误（`include/inline.ts:151-179`）。
  - 例如 `archon-deliver` 需要传 `ci: "$INPUTS.ci"`（见 `sdlc/build-route/archon-build.yaml:111`）。
  - `archon-implement` 只有一个输入 `work`，默认值为 `""`（`implement/archon-implement.yaml:14-20`）。
- **哪些配置会跟着块走**：
  - 块自己的 `provider/model/effort/...` 跟随块，所以 `archon-implement` 的 `model: ['@implementer', large]` 会生效。
  - 块里的 `worktree/container/budget/mutates_checkout` 会被丢弃并产生 warning。这些要在顶层工作流上声明。
- **include 节点上禁止的字段**：`isolation:`、`input:`、`mutates_checkout:` 写在 include 节点上都是加载错误。
- **节点 ID**：展开后为 `<includeId>__<nodeId>`。不能读取块内部单个节点的输出，只能读 `$includeId.output`。
- **command 快照**：include 进来的 command 正文在 discovery 时就做了快照。
- **warning 归属**：块自身的 parse warning 不会在父工作流里显示。需要单独运行 `archon validate workflows archon-implement`。

### 5.3 `workflow:` 子 run

- 目标按名字在运行时通过目录解析，可以是 bundled、global 或 project（`workflow-language.md:2384-2445`）。
- 限制：
  - **不能放在 `loop_group` 体内**。
  - 不能写 `retry:`。
  - `input:` 和 `with:` 二选一。
  - 不能用 `join: first_success`。
- 父 `with:` 不能设置子工作流的 pack settings，除非子工作流声明了同名 input。
- 子 run 启动时会捕获 live 的作者源码。

### 5.4 installed pack（plugin add 安装的）

- 只在**自己 pack 的名字表**内展开，所以 `include: archon-implement` 会失败。注释原文是 "Cross-pack includes still fail in the pack's own name map; child runs resolve through the catalog"（`packaged-workflow.ts:138-148`）。
- `workflow:` 可以启动本 pack 的 entrypoint。
- `workflow:` 启动 support 工作流会被拒绝（`installed.ts:225-229`）。

## 6. `archon plugin add`

源码：`packages/cli/src/commands/plugin.ts`、`plugin-source.ts:54-65`；文档：`cli.md:87-114`、`guides/publishing-plugins.md:8-33`

- **参数格式**：只接受 `owner/repo[/path][@tag]`。**没有本地路径安装**，`parsePluginRef` 解析 `owner/repo/...`，格式不符就报 `Invalid plugin`。
- **仅限公开仓库**：manifest 先通过**未认证**请求从 `raw.githubusercontent.com` 读取，所以私有仓库装不了（`plugin.ts:8-9`）。
- **安装过程**：用 `git fetch --depth 1` 拉取 tag 或默认分支 HEAD，写入 `ARCHON_HOME/plugins/packs/<id>/<commit>/`，再写 receipt 到 `plugins/installed/<id>/receipt.json`。
- **会拒绝的内容**：symlink、submodule、越界路径、文件名含 `\` 或 `:`、缺失的 entrypoint、相同 owner 加 name 的冲突。
- **需要的 manifest**：`archon-plugin.json`，内容为 `{"schemaVersion":1,"kind":"workflow-pack","name":"...","description":"...","entrypoints":{"req-refine":"req-refine/req-refine.yaml"}}`。manifest 是 strict 的，不能加 version 等字段。
- **运行名**：`archon workflow run <owner>/<plugin>:<entrypoint>`。非 entrypoint 的工作流只能被 include。
- **`archon plugin copy <id>`**：把已安装的树复制到 `.archon/workflows/<name>/`，之后就是普通的 project pack。前提是先装过。

## 7. 工作流命名规则

- `name:` 和 `description:` 都是必填字符串（`loader.ts:94-101`）。`nodes:` 必须是非空数组。
- 运行、`include:`、`workflow:` 都按**精确、区分大小写**的名字匹配，没有前缀或子串匹配（`cli.md:581-597`）。
- Server API 会用 `isValidWorkflowName` 校验（`command-validation.ts:34-45`）：
  - 最多 2 个 `/` 分隔的段。
  - 不能有 `..`、`\`。
  - 不能以 `.` 开头。
- 名字中带 `:` 会被当成 installed 限定名解析（`packaged-workflow.ts:159`）。
- 建议：
  - 名字用 `^[a-z][a-z0-9-]*$`，例如 `req-refine`、`req-deliver`、`req-verify`。
  - **不要用 `archon-` 前缀**，以免与 bundled 冲突或误覆盖。
  - **YAML 文件名 stem 与 `name:` 保持一致**，原因见 §8。

## 8. `archon validate workflows` 如何发现文件

源码：`packages/cli/src/commands/validate.ts:88-167`、`cli.ts:416-467`

- 该命令需要在 git 仓库内运行，cwd 会解析到 repo root 或已注册的 codebase。可以用 `--cwd <path>` 指定。
- 发现过程与运行时一致：调用 `discoverWorkflowsWithConfig(cwd, loadConfig, providerRegistry)`，范围是 bundled、global、project 和 installed。
- 另外会对每个 packaged 工作流调用 `validateProjectPackSettings`，检查 `.archon/packs/<pack>.yaml`。
- 用 `<name>` 过滤时，比较的是 `workflowName`。
  - 加载错误的名字取 `error.workflowName ?? filename.replace(/\.ya?ml$/, '')`（`schemas/workflow.ts:484-486`）。
  - 所以**文件名 stem 与 `name:` 不一致时，`archon validate workflows req-refine` 找不到该文件的 parse 错误**。
  - 文件夹级错误（例如文件夹里有两个 YAML）的标签是 `reqflow/req-refine`。
  - 因此第一次校验要不带名字，跑全量：`archon validate workflows --json`。
- 校验内容：
  - YAML 语法、DAG 结构、command、MCP、skill 文件是否存在。
  - provider 是否注册。例如 `provider: pi` 在未注册 Pi 时报 `Unknown provider: 'pi'. Available: ...`。release 二进制需要先 `archon provider add claude pi`；源码 checkout 直接从源码运行 provider。
  - tier 和 alias。
  - `INPUTS_*` 的读取。
- **global 和 bundled 工作流禁止裸 `@custom` 模型别名**（`workflow-language.md:3359-3361`）。需要写成 `['@reviewer', large]` 这种列表形式。project scope 没有这个限制。
- 未知键只产生 warning，键会被丢弃。但下面这些写错位置是加载错误：
  - 属于其他节点类型的键。
  - 顶层的 `interactive:` 或 `until_bash:`。
- 退出码：0 表示全部通过，1 表示有错误。
- 其他验证手段：
  - `archon workflow run <name> --dry-run --stubs <file>`（`--stubs-init` 生成模板）。
  - `archon workflow test <name>`（读取 `fixtures/`）。

## 9. 运行时源码与 checkout（影响放置位置的选择）

- 每个 run 启动时会把源码冻结到 `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`。冻结范围是 project、home 和 bundled 的 `.archon/workflows|commands|scripts`，以及 include 能到达的所有内容。
- CLI 从启动时的 checkout 读取，**包括未提交的修改**（`cli.md:420-446`）。所以 pack 不提交也能运行。但 `.archon/packs/<pack>.yaml` 要能在 worktree 里看到，做法见 §3.3。
- `.archon/config.yaml` 从启动 checkout 读取，未提交也有效。`worktree.*` 从已注册 checkout 读取。
- `--workflow-source <dir> --cwd <javaRepo>`：pack 可以放在独立仓库，不进入 Java 仓库。
  - 代价一：每次运行都要带这个参数。
  - 代价二：在 Java 仓库里 `archon workflow list` 看不到这些工作流。
  - 该参数与 `--resume`、`--container` 互斥。
- 如果 Server 或 Web 走 webhook 托管 clone，需要 push 后才能看到改动。纯 CLI 使用没有这个问题。

## 10. 推荐落地步骤（给工作电脑）

1. `git clone` Archon，按文档安装好 CLI。确认 `archon provider add claude pi` 已执行；源码模式下这一步会被拒绝，这是预期行为。
2. `mkdir -p <javaRepo>/.archon/workflows && cp -R reqflow <javaRepo>/.archon/workflows/`。如果不想提交，在 `<javaRepo>/.git/info/exclude` 里追加 `.archon/`。
3. 如果需要 settings，写 `<javaRepo>/.archon/packs/reqflow.yaml`（只能有 `settings:`）。未提交时，在 `<javaRepo>/.archon/config.yaml` 加上：

   ```yaml
   worktree:
     copyFiles: [.archon/packs/]
   ```

   更简单的做法是把所有值放成 pack.yaml 的 `default:`，必要时再用 `--input k=v` 覆盖。
4. 不要设置 `defaults.loadDefaultWorkflows: false` 或 `loadDefaultCommands: false`，否则 include SDLC 块会失败。
5. 在 Java 仓库根目录执行：
   - `archon validate workflows --json`（全量）
   - `archon workflow list`（确认 source 为 `project`）
   - `archon workflow run req-refine --dry-run --stubs-init stubs.yaml`

## 关键文件

- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery/scopes.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery/load-dir.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery/pack-layout.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery/expand-scope.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/workflow-discovery/installed.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/packaged-workflow.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/pack-settings.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/schemas/pack-settings.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/load-command-prompt.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/script-discovery.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/include-expander.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/include/inline.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/workflows/src/command-validation.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/cli/src/commands/validate.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/cli/src/commands/plugin.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/cli/src/commands/plugin-source.ts`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/.archon/workflows/sdlc/.pack/pack.yaml`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/.archon/workflows/sdlc/implement/archon-implement.yaml`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/.archon/workflows/sdlc/deliver/archon-deliver.yaml`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/guides/global-workflows.md`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/guides/publishing-plugins.md`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/guides/script-nodes.md`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/reference/workflow-language.md`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/reference/archon-directories.md`
- `/Users/tanshangou/Documents/Codes_Repo/Archon/packages/docs-web/src/content/docs/reference/cli.md`
# devflow

devflow 是一个 Archon workflow pack，把一个需求从提出带到本地人工验证。它包含四个 workflow：`devflow-refine` 把 Jira 和手工粘贴的材料整理成最终需求 `requirement.md`，`devflow-deliver` 实现需求、开 draft PR，并循环处理 Copilot review 和 CI，`devflow-verify` 生成测试计划、等人工测试后做 triage，`devflow-smoke` 只检查各接入点是否连通，不改任何东西。阶段之间只通过 `$STATE_DIR/devflow/<KEY>/` 下的文件交接。pack 不合并 PR，不把 PR 标成 ready，也不读 Slack API。目标环境是 macOS + GitHub.com 上的 Java/Maven 仓库 + jira-cli，agent 用 Claude Code 和 Pi。

## 工作电脑快速开始

按顺序执行。这里只是提纲：**每一步的完整命令、期望输出和失败处理都在 [docs/SETUP.md](docs/SETUP.md)**，第一次配置请照 SETUP 逐步做，不要只按下面几行。`<java-repo>` 换成 Java 仓库根目录的绝对路径，`<JIRA-KEY>` 换成一个真实 key（例如 `ABC-123`）。

```bash
# 0. 确认 fork 上已有 devflow 分支（期望输出恰好一行 "<sha>	refs/heads/devflow"）
git ls-remote --heads https://github.com/shang-windpine/Archon.git devflow
# 1. 克隆 fork 的 devflow 分支
git clone -b devflow https://github.com/shang-windpine/Archon.git ~/Archon && cd ~/Archon
# 2. 安装依赖，让 archon 命令可用（PATH 问题见 SETUP §3.2）
bun install && (cd packages/cli && bun link)
# 3. 本机配置 ~/.archon/config.yaml 和 ~/.archon/.env：按 SETUP §4、§5 做
#    （先判断文件是否已有真实内容，再复制模板；@devflow-cross 必须改成 Pi，原因见 SETUP §2.6）
#    然后自检：
devflow/scripts/doctor.sh
# 4. 把 pack 装进 Java 仓库（默认复制；不覆盖已有文件），然后按 SETUP §7、§9 编辑两个配置文件
devflow/scripts/install.sh <java-repo>
# 5. 冒烟：检查 forge、Jira 和四个模型 alias 是否连通；成功的标志是结尾的 "smoke OK"
cd <java-repo> && archon workflow run devflow-smoke --input key=<JIRA-KEY>
# 6. 第一次 refine（会在 gate 暂停等你回答，怎么回答见 OPERATIONS §2）
archon workflow run devflow-refine --input key=<JIRA-KEY>
```

第 0 步没有输出，说明 `devflow` 分支还没 push 到 fork：回到开发电脑，在 Archon 仓库里提交并 `git push -u origin devflow`，再继续。没有这个分支，第 1 步的 clone 会报 `Remote branch devflow not found`。

## 文档地图

- [docs/HANDOFF.md](docs/HANDOFF.md)：交接主文档。工作电脑上的 LLM 先读它，里面有禁改清单、已知的 pack 问题和修改后的验证方法。
- [docs/SETUP.md](docs/SETUP.md)：工作电脑配置步骤，逐项列出接入点（gh、jira-cli、Claude、Pi、模型 alias、pack settings）。
- [docs/OPERATIONS.md](docs/OPERATIONS.md)：日常使用，包括启动、观察、回答 attention、resume、abandon 和续跑。
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：故障决策树，按“看到 X 就做 Y”组织，并说明怎么读 artifacts。
- [docs/DESIGN.md](docs/DESIGN.md)：设计契约（single source of truth）。§9 的安全与正确性规则不能改。
- [docs/E2E-REPORT.md](docs/E2E-REPORT.md)：在真实 GitHub 仓库上跑通全流程的记录，包括发现的问题和尚未验证的部分。
- [docs/research/](docs/research/)：引擎事实调研。`ops.md` 讲 CLI 和 run 操作，`providers.md` 讲 Claude/Pi 配置，`packs.md`、`nodes.md`、`critic.md`、`sdlc.md`、`testing.md` 讲其余部分。

## 开发 pack 时的测试命令

改了 `pack/devflow/**`、`test/**` 或 `scripts/**` 之后，按 [docs/TROUBLESHOOTING.md §4.3](docs/TROUBLESHOOTING.md#43-验证按顺序执行每步都要通过) 的顺序全部跑一遍。那里是**唯一**维护的验证清单（单元测试、类型检查、biome、生成文件检查、复制式沙箱里的 validate 和 fixtures），每一步都写了期望输出和原因。这些命令都不调用模型，不花钱。

两条最容易踩的规则：

- `bun test` 必须在 `devflow/` 目录里跑，不要在 Archon 仓库根目录跑：根目录的配置会加载引擎测试的 preload。
- fixtures 必须在 `test/sandbox.sh --copy` 建的沙箱里跑：`archon workflow test` 不跟随符号链接（[E2E-REPORT](docs/E2E-REPORT.md) 第 7 条）。

# 端到端验证记录（2026-11-14，开发电脑）

本文件记录在真实 GitHub 私有仓库上跑通 devflow 全流程时的观察，供交接与排障参考。所有 run 都使用隔离的 `ARCHON_HOME=/tmp/devflow-e2e/home`，Archon 从源码运行（commit `2aabbd0ca` + devflow 分支）。

## 环境

| 项 | 值 |
|---|---|
| 测试仓库 | `github.com/shang-windpine/devflow-e2e-sandbox`（private，Java 17 / Maven，单类 `Greeter`） |
| CI | GitHub Actions `pr-checks`：`checkstyle`、`ut`、`it`。`it` 在每个 run 的第 1 次 attempt 故意打印 Maven「Connection reset」并失败，模拟基础设施故障；rerun 后通过 |
| Copilot | 账号**没有** Copilot code review 权限 |
| 模型 | `@devflow-main` claude/sonnet，`@devflow-fast` claude/haiku，`@devflow-ci` claude/sonnet，`@devflow-cross` **pi / magpie/deepseek-officially/deepseek-flash** |
| 工具 | gh 2.104.0，git 2.49，bun 1.4.4，Maven 3.9.10，JDK 25 |
| 安装方式 | `devflow/scripts/install.sh <repo>`（复制 pack），之后只改了 `.archon/packs/devflow.yaml` 里的 `jira_view_cmd: ""`、`poll_interval_sec: "30"`、`copilot_wait_min: "6"`、`ci_wait_min: "25"`、`api_hint` |

## 结果总览

| 步骤 | run id | 结果 | 费用 |
|---|---|---|---|
| devflow-smoke | `f3072fe5-…` | 16 项检查全部 PASS（含 Pi alias 结构化输出） | $0.01 |
| devflow-refine GRT-1 | `6c057182-…` | 2 轮：Pi 评审第 1 轮 `revise, needs_human`（指出 [API] 标签与仓库无 HTTP 接口矛盾、范围问题 Q-1），人工回答后第 2 轮 `approve`，人工 finalize | $0.48 |
| devflow-deliver GRT-1（第一次） | `8e0daf1f-…` | 第 1 轮：开 draft PR #1；模拟 review 的 2 个 thread：Pi 对「本地化」thread 判 `not_this_change`（不是 decline）并引用需求条款回复+resolve，对「补 greet(null) 测试」判 accept；`it` 判为 infra，发出 rerun。因 Copilot 超时而 escalate（人用自由文本回答「Copilot 不可用，别等」，脚本不解析 text，所以第 2 轮照样等）。第 2 轮：实现 accepted thread 并回复 `Fixed in <sha>` + resolve；新 head 上 `it` 再次 infra → 发出 rerun；本 run 最后一份 `snapshot.json` 仍是 `checks: red`（rerun 还没出结果），再次因 Copilot 超时 escalate。随后人工 abandon。rerun 变绿是在下面的续跑 run 里才观察到的 | — |
| devflow-deliver GRT-1（续跑） | `a8a01d62-…` | `--branch feature/GRT-1 --input copilot_mode=off`：找到已有 PR #1，implement 判断无事可做，checks 绿、无 open thread → done；写出 `delivery.json`、`change-summary.md`；PR 仍为 draft | — |
| devflow-verify GRT-1 | `53a43031-…` | classify：仅 API 侧；生成 4 个 API 用例（JShell 调用，因仓库无 HTTP）；Pi 计划评审 0 gap；人工在 JShell 实测后填写结果文件；triage：全部通过，并注意到 API-3 只测了一种空白输入 | $0.39 |
| devflow-deliver GRT-2（修复后） | `9a533b3c-…` | 手写 requirement.md（不经 refine）。第 1 轮：开 draft PR #2，`request-review` 20 秒内确认 Copilot 未登记 → `request_failed`（不再空等）；`it` infra → rerun；escalate 摘要为「needs you: requesting a Copilot review failed; status: …」。回答 `respond <run> skip-copilot` 后第 2 轮：无代码工作，checks 绿，done；summarize、finish 完成 | — |

## 发现的问题与处理

1. **`gh pr edit --add-reviewer @copilot` 在无 Copilot 权限的账号上返回 0，但不登记任何 review 请求**（`requested_reviewers` 为空，时间线没有 ReviewRequestedEvent）。旧实现因此把 head 记为「已请求」，每轮都等满 `copilot_wait_min` 后超时求助。
   - 处理：新增 setting `copilot_confirm_cmd`（默认读 issue events 里的 `review_requested`，因为公开资料显示即使请求成功，`requested_reviewers` 里也看不到 Copilot）。请求前后各读一次，请求后多出 Copilot 事件、或该 head 已有 Copilot review 才算成功，否则立即报 `request_failed`。已在 GRT-2 上实测。
2. **escalate 只有自由文本，人无法结构化地让本次 run「不再等 Copilot」**，只能 abandon 后加 `--input copilot_mode=off` 重跑。
   - 处理：escalate 改为 select 表单，选项 `continue` / `skip-copilot`（文本仍作为下一轮工作单）。
3. **escalation 摘要把「需要人决定的事」和「本轮状态」混在一起**，例如 Copilot 超时与「已 rerun」「已 decline」并列。
   - 处理：拆成 `askReasons` 与 `notes`，escalation.md 分「Needs your decision」「Status this round」两节。
   - 注意：问题 1–3 是在 `8e0daf1f` 之后才修的。所以 `8e0daf1f` 的 artifacts 里还是旧格式（`## Why the round stopped`、「Answer in plain text」），没有 `copilot-confirm.*` 文件，冻结的 inputs 里也没有 `copilot_confirm_cmd`。读旧 run 时不要以为环境坏了，识别方法见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §2.2。
4. **`archon workflow abandon` 会删除该 run 的 worktree**（分支保留，已 push 的提交不受影响）。续跑时用同一个 `--branch` 即可，会在原分支上重建 worktree。
5. **语言混用**：Claude 节点会加载用户全局 `~/.claude/CLAUDE.md`（本机要求中文），所以结构化字段（summary、reason）是中文，而按 policy 写的文件（requirement.md、plan）多为英文。这是 provider 原生配置生效，属预期行为；如需统一，在 `~/.claude/CLAUDE.md` 或 policy 中写明语言。
6. **引擎日志会把 `--input` 的值显示为 `[REDACTED]`**（例如 refuse 信息里的 KEY）。排障时以 run id 与 artifacts 为准。
7. **`archon workflow test` 不跟随符号链接**：`install.sh --link` 安装的 pack 跑不了 fixtures；需要 fixtures 时用复制安装（默认）或 `test/sandbox.sh --copy`。

## 未能验证的部分（工作电脑上首次使用时重点关注）

- Copilot 有权限时：`@copilot` 请求能否对 **draft PR** 生效；Copilot review 在 `pr.reviews` 里的 login 写法（默认 `copilot_logins` 已列出 4 种）；`requested_reviewers` 中的 login（`Copilot`？）。首次运行时打开 `$ARTIFACTS_DIR/copilot-request.log`、`snapshot.json` 对照。
- 真实的 `pr_caused` CI 失败（编译错误/测试失败）→ 下一轮修复 的路径：只在 fixtures 与单元测试中覆盖。
- 本地 checkstyle 失败 → `fix-style` 修复：只在 fixture 中覆盖。
- Jira：本机没有 jira-cli，`jira_view_cmd` 路径只用桩命令测过。
- 公司仓库的 required checks、Actions 是否在 draft PR 上运行（`pull_request` 事件默认包含 draft，但 job 可能写了 `if: !github.event.pull_request.draft`）。被这样跳过的 job 结论是 `skipped`，引擎 forge 会把它当成绿色，deliver 可能在 CI 没跑的情况下判定 done（[HANDOFF.md](HANDOFF.md) §8.1 第 3 条）。

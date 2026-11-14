# devflow pack 设计契约

本文件是 `devflow` workflow pack 的设计契约（single source of truth）。实现、测试、交接文档都以它为准；实现与本文不一致时，要么改实现，要么先改本文再改实现。

## 0. 目标与边界

把一个需求从「提出」带到「本地人工验证」，分三个独立的 Archon workflow，阶段之间只通过**文件**交接：

| workflow | 覆盖步骤 | 隔离 | 是否写代码/远端 |
|---|---|---|---|
| `devflow-refine` | 1 提出需求 → 5 确定最终需求 | `worktree.enabled: false`（只读，跑在当前 checkout） | 只写 `$STATE_DIR`；可选回写 Jira 评论 |
| `devflow-deliver` | 6 实现 → 7 Draft PR + Copilot review 循环 + CI 循环 | worktree（`--branch <feature-branch>`，run 结束后保留） | 提交、push、开 draft PR、回复/resolve thread、rerun check |
| `devflow-verify` | 8 本地人工测试 | `worktree.enabled: false` | 只写 `$STATE_DIR` |
| `devflow-smoke` | 接入点连通性自检（不改任何东西） | `worktree.enabled: false` | 否 |

不做的事：合并 PR、把 PR 标记为 ready（全程保持 draft）、启动本地服务、配置环境、读取 Slack API（Slack 内容由人粘贴到文件）。

## 1. 目录结构（在 Archon fork 的 `devflow/` 下）

```
devflow/
  README.md                    入口，指向 docs/
  docs/DESIGN.md               本文件
  docs/HANDOFF.md              交接主文档（给工作电脑上的 LLM 和人）
  docs/SETUP.md                工作电脑配置步骤（接入点清单）
  docs/OPERATIONS.md           日常使用：启动/观察/回答/恢复
  docs/TROUBLESHOOTING.md      故障决策树
  pack/devflow/                pack 本体，安装时复制/软链到 <java-repo>/.archon/workflows/devflow
    .pack/pack.yaml            只含 inputs:（pack settings）
    .shared/lib/*.ts           共享 TS 模块（纯逻辑 + forge 封装）
    .shared/scripts/*.ts       pack 级 named script（如 forge-check）
    .shared/policy/*.md        agent 读的策略文档（用 $PACK_DIR/.shared/policy/x.md 引用）
    devflow-refine/devflow-refine.yaml + commands/ + scripts/ + fixtures/
    devflow-deliver/devflow-deliver.yaml + commands/ + scripts/ + fixtures/
    devflow-verify/devflow-verify.yaml + commands/ + scripts/ + fixtures/
    devflow-smoke/devflow-smoke.yaml + scripts/
  templates/                   安装时写入目标仓库/ARCHON_HOME 的配置模板
  scripts/install.sh           安装脚本：把 pack 放进目标仓库，写模板（不覆盖已有文件）
  scripts/doctor.sh            工作电脑环境自检（工具版本、登录状态）
  test/                        pack 脚本的 bun 单元测试 + 沙箱 e2e 脚本
```

pack 布局硬规则：每个 workflow 文件夹恰好一个 YAML；pack 根目录不放 YAML；文件名 stem = `name:`；不用 `archon-` 前缀。

## 2. 跨阶段状态（交接通道）

根目录：`$STATE_DIR/devflow/<KEY>/`。`<KEY>` 是 Jira key（如 `ABC-123`）或人工起的 slug，必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，所有脚本在使用前校验，不合法即 refuse。

`$STATE_DIR` 是项目级、跨 run、不在 git 里的目录（`~/.archon/workspaces/<owner>/<repo>/state/`），worktree 删除后仍在。

| 文件 | 写入者 | 读取者 | 内容 |
|---|---|---|---|
| `inbox/*.md` | 人（手工粘贴 Slack/会议纪要） | refine.intake | 原始材料，任意格式 |
| `intake.md` | refine.intake | refine 各 agent | 汇总后的原始材料（Jira 正文+评论、inbox、命令行消息），带来源标注 |
| `requirement.md` | refine（最终批准后） | deliver、verify | 最终需求文档（模板见 policy/requirement-template.md） |
| `requirement.history/<run-id>.md` | refine.finalize | 人 | 历史版本 |
| `refine-log.md` | refine 每轮追加 | refine 下一轮、人 | 每轮 review 结论与人工讨论记录（追加式，带轮次标题） |
| `delivery.json` | deliver.finish | verify、deliver 重跑 | `{key, pr:{number,url,repo,head,base,head_revision}, worktree_path, branch, done, reason, updated_at}` |
| `change-summary.md` | deliver.summarize | verify | 改动摘要：模块、行为变化、UI/API 影响、风险点 |
| `verify-plan.md` | verify | 人 | 测试计划（前置数据、步骤、期望结果，按 UI/API 分节，每个用例有 ID） |
| `verify-results.md` | 人（填写） | verify.triage | 每个用例的 PASS/FAIL/BLOCKED + 备注（verify 预生成模板） |
| `followup-work.md` | verify.triage（有失败时） | deliver 下一次运行 | 需要修复的问题清单。deliver.finish 用过后改名为 `followup-work.consumed-<时间>.md`；verify.context 不移动未消费的这份（§7） |

原则：**下游只读文件，不读上游的对话。** 每个文件都应当是「下一个 session 冷启动所需的最小充分信息」。

## 3. Pack settings（`.pack/pack.yaml` 的 inputs，全部为文本）

项目覆盖值写在 `<repo>/.archon/packs/devflow.yaml`（顶层只有 `settings:`）。任何 setting 也可以用 `--input name=value` 单次覆盖。

| setting | 类型 | 默认 | 用途 |
|---|---|---|---|
| `jira_view_cmd` | string | `jira issue view {key} --plain --comments 30` | 获取 Jira 内容的命令；`{key}` 被替换为 KEY。为空表示不取 Jira |
| `jira_comment_cmd` | string | `""` | 回写 Jira 评论的命令，`{key}` 替换，`{file}` 替换为评论正文文件路径；为空表示不回写 |
| `checkstyle_cmd` | string | `mvn -B -q checkstyle:check` | 本地 checkstyle；退出码 0 = 通过 |
| `local_verify_cmd` | string | `""` | publish 在最终 HEAD 上额外跑的本地快速检查（如某模块 UT）；为空跳过。失败不拦 push：照常推送，act 把失败作为下一轮工作并问人（§6） |
| `copilot_mode` | enum `request\|auto\|off` | `request` | request=每次 push 后由 pack 请求 Copilot review；auto=仓库 ruleset 自动 review，pack 只等待；off=不等 Copilot |
| `copilot_request_cmd` | string | `gh pr edit {number} --repo {repo} --add-reviewer @copilot` | 请求 Copilot review 的命令；替换 `{number}`、`{repo}`（`gh --repo` 的写法：github.com 上为 OWNER/REPO，其他 host 为 HOST/OWNER/REPO）、`{host}`、`{path}`（OWNER/REPO） |
| `copilot_confirm_cmd` | string | `gh api --hostname {host} --paginate repos/{path}/issues/{number}/events --jq '.[] \| select(.event == "review_requested") \| .requested_reviewer.login // empty'` | 确认请求确实被 GitHub 记录的命令：在请求前后各跑一次，stdout 每行一个 review request 事件的 reviewer login，token 同上。请求后命中 `copilot_logins` 的行数比请求前多（必要时按 2/4/8 秒退避重读），或 head 上已有 Copilot review，才算成功；否则请求视为失败。不读 `pulls/{n}/requested_reviewers`：Copilot 即使 review 正在进行也从不出现在那里。该命令本身失败时只告警、请求仍算成功。为空表示不确认 |
| `copilot_logins` | list | `copilot-pull-request-reviewer,copilot-pull-request-reviewer[bot],copilot,Copilot` | 识别 Copilot review 作者的 login（大小写不敏感精确比较） |
| `poll_interval_sec` | string | `60` | 轮询间隔 |
| `copilot_wait_min` | string | `30` | 等待 Copilot review 的上限（分钟） |
| `ci_wait_min` | string | `90` | 等待 CI 完成的上限（分钟） |
| `required_checks` | list | `""` | 必须出现且为绿的 check 名（精确匹配）；为空时仅要求 summary=green。被跳过（`result: skipped`）的 required check 不算通过，即使它也在 `allow_skipped_checks` 里 |
| `allow_skipped_checks` | list | `""` | 允许结论为 `skipped` 的 check 名（精确匹配）。forge 把 `skipped` 映射为 green，而 devflow 的 PR 始终是 draft，写了 `if: !github.event.pull_request.draft` 的 job 在 draft 上总是 skipped，CI 实际没跑；所以其他任何 skipped 的 check 都让 checks 不算绿（§6 `done`/`ask`）。按名字判断：GitHub 插件不按名字去重，同一 head 上同名的 unit 只要有一个实际运行过（例如 `push` 触发的那次成功、draft `pull_request` 那次被跳过），这个名字就不算被跳过。为空表示一个都不允许 |
| `refine_human` | enum `auto\|always\|never` | `auto` | refine 循环里人工讨论的触发方式 |
| `ui_hint` | string | `""` | 告诉 agent 哪些路径/模块属于 UI 侧（自由文本） |
| `api_hint` | string | `""` | 告诉 agent 哪些路径/模块属于 External API 侧（自由文本） |
| `project_notes` | string | `""` | 仓库内给 agent 看的项目说明文件路径（如 `AGENTS.md`），为空则 agent 自行发现 |

命令模板替换是**我们自己的配置**做的确定性 token 替换，不是解析自然语言。替换值做 shell 安全处理：脚本用 `sh -c` 执行命令，替换进去的值一律经过单引号转义。

## 4. 模型与角色（model alias）

project scope 允许裸 `@alias`，未定义时 run 启动前就失败（fail-fast），因此每个角色都用 alias，由工作电脑上的 `~/.archon/config.yaml` 定义：

| alias | 角色 | 推荐 |
|---|---|---|
| `@devflow-main` | 探索、起草需求、实现、修复、测试计划 | claude / opus |
| `@devflow-fast` | 写 PR 文本、改动摘要、checkstyle 修复 | claude / sonnet |
| `@devflow-cross` | 需求 review、Copilot thread 评估、测试计划 review（第二视角） | pi / `<pi-provider>/<model>` |
| `@devflow-ci` | CI 失败日志判因 | claude / sonnet |

`@devflow-cross` 应当解析到与 `@devflow-main` **不同的厂商**（通过 Pi）：同一厂商的模型评审自己厂商写的东西，更容易附和。这是推荐而不是正确性要求：所有评审/判断节点（refine `review`、verify `plan-review`、deliver `judge-threads`、`judge-ci`）都写了 `context: fresh`，所以即使 alias 解析到同一个 provider，它们也不会继承起草者/实现者的会话（引擎只记一个「上一个顺序会话」：顺序执行、没写 `context:` 的 AI 节点在它来自同一 provider 时继承它，`context: fresh` 关掉这一点）。`templates/archon-home-config.yaml` 给没有 Pi 的机器留了 `claude/sonnet` 作为能跑的默认值，并在注释里写明这个取舍；`doctor.sh` 在能确定是同一厂商时给 WARN（同一个非 Pi provider，或同一个 Pi 模型 ref；Pi ref 写的是网关，不同的 Pi ref 判断不了）。

alias 决定 provider，节点上不写 `provider:`。因此 `allowed_tools` 不写（Claude 与 Pi 工具名不同）；只读节点用 `mutates_checkout: false` 做断言。Pi 不能用 mcp/plugins/hooks/agents。

## 5. devflow-refine

输入：`key`（必填）、`brief_file`（可选，额外材料文件的绝对路径）；run message（`$ARGUMENTS`）作为补充说明。

节点：

1. `intake`（script）：校验 KEY；若 `jira_view_cmd` 非空则执行并捕获输出（失败不致命，记录为警告，但若最终没有任何材料则 refuse）；读取 `brief_file`、`$STATE_DIR/devflow/<KEY>/inbox/*.md`、`$ARGUMENTS`；若已有 `requirement.md`（上一次 refine 的结果），作为 `previous_requirement` 一并提供（支持重跑续改）。写 `intake.md` 到 `$ARTIFACTS_DIR` 和状态目录。输出 `{key, state_dir, intake_path, sources:[...], has_previous}`。
2. `explore`（`@devflow-main`，command `explore`，`mutates_checkout: false`）：基于仓库探索可行性，写 `$ARTIFACTS_DIR/feasibility.md`。输出 `{feasible: yes|partial|no|unknown, summary}`。
3. `refine`（loop_group，`max_iterations: 5`，`on_exhausted: complete`，`fresh_context: true`）body：
   - `control`（script，body 第一个节点）：`with:` 绑定 `$LOOP_PREV.gate.output.decision` / `.text`（第一轮或上一轮 gate 被跳过时为 `''`）。若上一轮 gate 回答 `finalize` → 输出 `{finalize: true}`；否则把上一轮人工意见（如有）追加到 `refine-log.md`，输出 `{finalize: false, round, human_feedback_path}`。
   - `draft`（`@devflow-main`，command `draft`，`when: "$control.output.finalize == 'false'"`）：读 intake/feasibility/refine-log/上一版 requirement，写 `$ARTIFACTS_DIR/requirement.md`（模板见 policy）。输出 `{summary, open_questions: integer}`。
   - `review`（`@devflow-cross`，command `review`，`mutates_checkout: false`，`context: fresh`）：独立评审 requirement.md（不看 draft 的推理），检查缺漏、范围、tradeoff、可验收性；写 `$ARTIFACTS_DIR/review.md`。输出 `{verdict: approve|revise, needs_human: boolean, questions, summary}`。
   - `record`（script）：把本轮 review 追加到 `refine-log.md`（在问人之前落盘），把草稿和评审快照到 `$ARTIFACTS_DIR/rounds/<n>/`，写 `last-review.json`；按 `refine_human` 与 review 结论计算 `ask`（规则见下面的 gate）和推荐选项，并给出 gate 消息要用的绝对路径（attention 文本里 `$ARTIFACTS_DIR` 保持字面量）。输出 `{ask, round, verdict, summary, questions_text, requirement_path, review_path, refine_log_path, recommendation}`。
   - `gate`（终端唯一 sink，attention wait，form `select`，options `finalize` / `revise`）：`when: "$record.output.ask == 'true'"`。`record` 在以下任一情况把 `ask` 设为 true：review 要求人工；或 review 判定 approve（此时请人确认最终需求）；或 `refine_human == always`。`refine_human == never` 时只在 approve 时询问。消息里给出 requirement 路径、review 摘要、问题。人选 `revise` 时 text 写意见；选 `finalize` 时 text 可写补充。
   - `until_bash`：`f=$control.output.finalize; [ "$f" = "true" ]`（只读 control，绝不读可能被跳过的 gate）。
   - 说明：人选 finalize 后，下一轮 control 输出 finalize=true，draft/review/gate 被跳过，until 结束循环。被接受的 attention 回答允许超过 max_iterations 再跑一轮。
4. `status`（script，depends_on refine）：读 `$ARTIFACTS_DIR/refine-state.json`（control 每轮写），输出 `{finalized: boolean}`。
5. `final-gate`（approval wait，`when: "$status.output.finalized == 'false'"`）：循环耗尽仍未 finalize 时兜底确认；reject → `stop`（cancel）。
6. `finalize`（script，汇合 status/final-gate，`trigger_rule: none_failed_min_one_success`）：把 `requirement.md` 写入状态目录（旧版本移入 history）；若 `jira_comment_cmd` 非空，回写 Jira 评论（失败只告警）。输出 `{requirement_path, history_path}`。

## 6. devflow-deliver

运行方式：`archon workflow run devflow-deliver --branch <feature-branch> --input key=<KEY> [--input pr=<N>]`。`--branch` 创建/复用一个保留的 worktree；分支已存在（重跑）时不会被重置。

输入：`key`（必填）、`pr`（可选，继续已有 PR 的编号；为空时按 head 分支查找 open PR，没有则新建）。

顶层节点：

1. `preflight`（script）：校验 KEY 与 `requirement.md` 存在；`archon forge check`（所需 op 列表）；`gh --version` 与 `gh auth status`；解析 repo（forge `resolve` 当前 remote）、base（`$BASE_BRANCH`）、head 分支（`git rev-parse --abbrev-ref HEAD`）；把 requirement 与（若存在且未消费的）`followup-work.md` 复制进 `$ARTIFACTS_DIR`，生成第一轮工单的原件 `work-order.round1.md` 与 `work-threads.round1.json`（`[]`），由 control 在每个第 1 轮放到位。输出 `{repo, base, head, requirement_path, has_followup, pr_number}`（`pr_number` 为 `--input pr` 或按 head 找到的 open PR，没有则 0）。
2. `rounds`（loop_group，`max_iterations: 6`，`on_exhausted: complete`，`fresh_context: true`）body，每轮：
   - `control`（script）：第 1 轮把 preflight 的原件复制为 `work-order.md`/`work-threads.json`，并删掉上一次尝试留下的每轮交接文件（`next-work.md`、`next-threads.json`、`escalation.md`）。引擎在失败恢复时从第 1 轮重跑 loop_group，`$LOOP_PREV` 重新为空，但 `$ARTIFACTS_DIR` 里还是更晚轮次写的文件；不这样做，第 1 轮会拿到上一次最后一轮的工单。跨轮历史保留：`reruns.json`（每个 head 每个 unit 只 rerun 一次）、`copilot-requests.json`（已请求过 Copilot 的 head）、`human-answers.md`、`copilot-skipped`、`thread-notes.json`，它们记录的是 GitHub 上已发生的事或人在本 run 的决定，重跑后仍然成立。之后各轮合并上一轮 `act` 写的 `next-work.md` 与上一轮 `escalate` 的人工回答（`$LOOP_PREV.escalate.output.text`）生成本轮 `work-order.md`。另绑定 `answer_choice: $LOOP_PREV.escalate.output.decision`（第 1 轮或上一轮 escalate 被跳过时为 `''`；不在 `continue|skip-copilot` 内即 refuse）：为 `skip-copilot` 时写标记 `$ARTIFACTS_DIR/copilot-skipped`（本 run 内不再删除），此后 request-review 与 await 都按 `copilot_mode=off` 处理。只选 choice、没有 text 不算代码工作。输出 `{implement: boolean, round}`。第 1 轮 implement=true。
   - `implement`（`@devflow-main`，command `implement`，`when: "$control.output.implement == 'true'"`）：按 work-order 实现/修复，本地 focused 检查，按逻辑单元提交（不 push、不 rebase、不 force）。对 work-order 里的每个已接受 thread 给出处理结果。输出 `{summary, commits: integer, threads: [{thread, status: fixed|not_fixed, note}]}`。
   - `checkstyle`（script）：执行 `checkstyle_cmd`（及非空的 `local_verify_cmd`），退出码总是 0，输出 `{ok, style_ok, verify_ok, log_path, verify_log_path}`（`ok` = 两者都通过）。
   - `fix-style`（loop 节点，`@devflow-fast`，`when: "$checkstyle.output.style_ok == 'false'"`，`until_bash` 重跑 checkstyle_cmd 并覆盖 `checkstyle.log`，`max_iterations: 3`）：只修 checkstyle 违规并提交。`local_verify_cmd` 失败不在本轮修：publish 照常 push 并报告，act 把它交给下一轮的 implement（见下）。
   - `publish`（script，`trigger_rule: none_failed_min_one_success`）：checkstyle 本轮第一次失败时，在最终 HEAD 上重跑 `checkstyle_cmd` 与 `local_verify_cmd`。checkstyle 仍失败则 refuse（节点失败，run 失败，人修复后开新 run）。`local_verify_cmd` 仍失败**不** refuse：它在本轮没有修复者，refuse 会因一个下一轮能修（或人能解释）的失败结束整个 run；所以照常 push，输出 `verify_ok: false` 与日志路径 `verify_log_path`，由 act 处理，失败的本地检查不会被悄悄推上去而没人知道。push（merge 式，不 force，回读远端 ref）；无 PR 则用 `pr-text`（见下）生成标题/正文后 `pr.create(draft: true)`；有 PR 时若被改成 ready 则 `pr.draft` 改回。对 implement 报告 `fixed` 的 thread：回复 `Fixed in <sha>: <note>` 并 resolve。输出 `{pr: PrRecord, pushed: boolean, head_revision, answered, verify_ok, verify_log_path}`（`answered` = 本轮回复并 resolve 的 thread 数）。
     - PR 文本：`publish` 前有 `pr-text`（`@devflow-fast`，`when` PR 尚不存在）写 `$ARTIFACTS_DIR/pr-title.txt`、`pr-body.md`。
   - `request-review`（script）：`copilot_mode == request`、没有 `copilot-skipped` 标记、且本 head 尚未请求过（记录在 `$ARTIFACTS_DIR/copilot-requests.json`）时执行 `copilot_request_cmd`。`gh` 可能退出 0 却没记录任何请求（账号没有 Copilot code review、仓库/组织不允许，或命令没走到 GitHub 的 reviewer 请求），所以 `copilot_confirm_cmd` 非空时在请求前后各执行一次（只读其 stdout，每行一个 login，与 `copilot_logins` 做大小写不敏感精确比较）：请求后的 Copilot 行数比请求前多（这把证据绑定到本次请求，而不是上一轮的请求；事件可能晚 1–2 秒出现，所以按 2/4/8 秒退避重读），或 forge `pr.reviews` 已有 Copilot 对本 head 的 review，才算请求成功并记录 head；否则（包括读 reviews 失败）输出 `requested: false` 与说明原因和出路（回答 escalation 选 `skip-copilot`，或把 `copilot_mode` 设为 `off`/`auto`）的 `error`，不记录 head，下一轮在同一 head 上重试。上一 head 的 Copilot 请求仍在 pending 时，GitHub 可能不再记录新事件，这时也会询问人。confirm 命令自身失败（非 0/超时，请求前或请求后）时什么也没得知，不阻塞：发 notice 告警（含日志路径），照常记录并算成功，由 await 的超时兜底。所有模板在 preflight 用样例值试渲染，token 写错在任何 agent 开销之前就 refuse。请求失败不致命（`error` 非空），await 不再等 Copilot（`copilot=request_failed`），act 立即询问人。输出 `{requested, head_revision, error}`。
   - `await`（script，`timeout: 9000000` 毫秒）：每 `poll_interval_sec` 轮询，直到「Copilot 已就当前 head 给出 review（或 mode=off——含 `copilot-skipped` 标记——或请求失败，或超时）」且「checks 已稳定（无 pending/running，summary≠none，revision==head）或超时」。拉取并保存快照：`pr.threads`（未 resolve 的）、Copilot 当前 head 的 review 正文、request-review 的 `request_error`、`checks.state`；对每个 red 的 Actions unit 拉 `checks.logs` 存到 `$ARTIFACTS_DIR/ci-logs/<name>.log`；执行 `git merge-tree` 检查与 base 冲突。输出 `{head_revision, copilot: done|timeout|off|request_failed, checks: green|red|pending_timeout|none|gated|unknown, open_threads: integer, red_units: integer, conflict: boolean, snapshot_path}`。
   - `judge-threads`（`@devflow-cross`，command `judge-threads`，`context: fresh`，`when: "$await.output.open_threads > 0"`）：读快照中的 thread、Copilot review 正文、requirement；对每个 thread 给出 `accept | decline | not_this_change | needs_human`，decline/not_this_change 写回复正文。输出 `{decisions: [{thread, decision, reason, reply}], summary}`。
   - `judge-ci`（`@devflow-ci`，command `judge-ci`，`context: fresh`，`when: "$await.output.red_units > 0"`）：读 ci-logs 与 PR diff，判定每个 red unit：`pr_caused | infra | flaky | unknown`。输出 `{units: [{name, cause, evidence, fix}], summary}`。
   - `act`（script，`trigger_rule: none_failed_min_one_success`，依赖 await 与两个 judge）：执行 decline/not_this_change 的回复+resolve；对 infra/flaky 且可 rerun 的 unit 执行 `checks.rerun`（同一 head 同一 unit 只 rerun 一次，记录在 `$ARTIFACTS_DIR/reruns.json`）；把 accept 的 thread、pr_caused 的 CI 失败、merge 冲突、publish 报告的 `local_verify_cmd` 失败（附日志路径）写入 `next-work.md`；计算结果。输出 `{done, has_work, ask, reruns: integer, summary, report_path, pr_number, pr_url}`：
     - `done` = checks=green 且 revision==head 且 required_checks 全绿 且 没有不允许被跳过的 skipped check（§3 `allow_skipped_checks`）且 未 resolve thread=0 且 copilot∈{done,off} 且 无冲突 且 has_work=false 且 reruns=0。
     - `ask` = 存在 needs_human thread（含 judge 漏判的 thread、没有回复正文的 decline）、或 unknown 的 CI 失败、或 copilot=request_failed/timeout、或 checks=pending_timeout/gated/unknown/none、或同一 unit rerun 后仍红。另外有意加入的触发：checks 除 skipped 外全绿、本轮没有工作、但有不允许被跳过的 skipped check（原因写成 `checks skipped on the draft PR: <names> — CI may not run on drafts; ...`：等待改变不了 skipped，agent 也修不了，所以问人而不是空转；有工作或还有红/pending 时它只作为状态记录）；`local_verify_cmd` 在推上去的 head 上失败（同时是下一轮的工作：没有 judge 判断是代码还是环境的问题。设置是冻结的，环境问题每轮都会再失败、并一直挡住 `done`，回答结束不了它；提问里写明这时应 abandon 后带可用的 `local_verify_cmd` 开新 run）；没有任何 judge 判定的红 check、判为 infra/flaky 但 forge 不能 rerun、计划的 rerun 没有发出、本轮没有 checks 快照、以及「未 done 又没有 work 也没发 rerun」（no progress，否则循环会空转到 max_iterations）。
     - 原因分两类（`computeRoundOutcome` 的 `askReasons` 与 `notes`，`reasons` 保留为两者合集）：`askReasons` 只含需要人决定的事项，`notes` 是状态/进度（交给下一轮的工作、已发 rerun、checks 为红、未 resolve 的 thread、已拒绝并 resolve 的 thread 等）。ask 时 `summary` 为 `needs you: <askReasons>; status: <notes>`；`escalation.md` 分「Needs your decision」与「Status this round」两节（request 失败时附 `request_error`），并说明两个选项的作用；带 run id 的回答命令由引擎在暂停时给出（pause notice 与 `archon workflow attention`），act 不另写。
   - 说明：judge 判 decline/not_this_change 的 thread 在同一轮就回复并 resolve，人只能事后在 GitHub 上 unresolve（下一轮 judge 会再看到它）。这是有意保留的：等人确认每条 decline 会让每轮都停下来。
   - `escalate`（终端唯一 sink，attention wait，form `select`，`when: "$act.output.ask == 'true'"`）：options `continue`（再跑一轮，text 作为下一轮 work order）与 `skip-copilot`（本 run 余下部分不再请求、不再等待 Copilot review，然后继续；text 仍是 work order）；text 可选。attention 文本给出 summary 与 `escalation.md` 路径，回答命令在该文件里。人的 text 进入下一轮 work-order，由 implement agent 解释执行（例如「这个 thread 拒绝，理由是……」「CI 是环境问题，已手工 rerun」）；choice 由 control 结构化处理，绝不解析 text。
   - `until_bash`：`d=$act.output.done; [ "$d" = "true" ]`（只读 act，绝不读可能被跳过的 escalate）。
3. `summarize`（`@devflow-fast`，command `summarize`）：基于 requirement 与 `git diff <base>...HEAD` 写 `change-summary.md`（模块、行为变化、UI/API 影响）。
4. `finish`（script）：确保 PR 仍为 draft；写 `delivery.json`、`change-summary.md` 到状态目录；把 `followup-work.md` 标记为已消费（改名加时间戳）。输出 `{done, pr_url, reason}`。`returns: finish`，`outcome_field: done`。

## 7. devflow-verify

输入：`key`（必填）。

1. `context`（script）：读 `requirement.md`、`delivery.json`、`change-summary.md`；用 forge `pr.files`（失败时退回 `git diff --name-only`）列出改动文件，写 `$ARTIFACTS_DIR/context.md`；预生成路径。把上一次的 `verify-plan.md`、`verify-results.md`、`verify-report.md` 移进 `verify.history/<时间>/`。状态目录里还在的 `followup-work.md` **不移动**：deliver.finish 会把用过的那份改名，所以还在的一定没交付过，移走会悄悄丢掉人发现的失败；它留给下一次 deliver，context.md 写一条警告，输出 `followup_notice` 把同一句话放进 `run-tests` 等待的提示里，让做测试的人在回答前就看到（警告只进 context.md 的话，全部通过的 run 显示 succeeded，人看不到旧清单还在）。本次有失败时 triage 用本次的清单覆盖它；本次全部通过时旧清单仍在，提示让人在确认那些失败已修好后手工删除。输出 `{pr_url, worktree_path, plan_path, results_path, followup_notice, …}`。
2. `classify`（`@devflow-main`，`mutates_checkout: false`）：判断是否涉及 UI 侧、External API 侧（参考 `ui_hint`/`api_hint`）。输出 `{ui: boolean, api: boolean, reason}`。
3. `plan-ui`（`when: ui`）、`plan-api`（`when: api`）（`@devflow-main`）：按 policy/test-plan-format.md 写各自计划，**前置准备只含测试数据**（用户、权限组、空白表格、模板……），不含环境配置。
4. `plan-review`（`@devflow-cross`，`context: fresh`）：对照 requirement 的验收标准检查计划覆盖与可执行性，写 `plan-review.md`。输出 `{ok, gaps}`。
5. `assemble`（script）：合并为 `verify-plan.md`（含 review 意见），生成 `verify-results.md` 模板（每个用例一行），写入状态目录。输出 `{plan_path, results_path, cases: integer}`。
6. `run-tests`（attention wait，form `message`）：请人启动服务、按计划测试、填写 results 文件或在回答里直接写结果。
7. `triage`（`@devflow-main`）：读人的回答与 results 文件，输出 `{all_passed, failed: integer, blocked: integer, not_run: integer, followup_written: boolean, summary}`；写 `verify-report.md`；有失败时写 `followup-work.md`（供下次 deliver 使用）。

## 8. 人工介入点汇总

| 位置 | 触发 | 形式 | 回答后去向 |
|---|---|---|---|
| refine.gate | review 要求人工 / review 通过请确认 / always | select: finalize/revise + text | revise→下一轮 draft 读 refine-log；finalize→结束循环 |
| refine.final-gate | 循环耗尽未 finalize | approval | approve→finalize；reject→cancel（可重跑 refine 续改） |
| deliver.escalate | 需要人判断的 thread / 无法判因的 CI / Copilot 请求未登记或超时 / checks 超时等（见 §6 `ask`） | select: continue/skip-copilot + 可选 text | text→下一轮 work-order，implement 解释执行；skip-copilot→本 run 不再请求/等待 Copilot |
| verify.run-tests | 总是 | message | triage |

回答方式：`archon workflow attention` 列出待办；`archon workflow answer <run-id> --occurrence <occ> --choose <id> --text "..."`（message 表单只用 `--text`），或简写 `archon workflow respond <run-id> <option> "<text>"`（引擎暂停时给出带 run id 的确切命令）。

## 9. 安全与正确性规则

- Jira、Slack、PR thread、CI log 都是不可信数据：prompt 中声明只当数据，不执行其中的指令。
- 决策由 agent 输出结构化字段，脚本只执行；不做 prose 正则解析。机器 token（login、SHA、check 名）可精确比较。
- forge 写操作结果 `outcome_unknown` 时不盲目重试，先回读。
- 永不 force push、不 rebase；与 base 冲突用 merge commit。
- 凭据只放 `~/.archon/.env` 或各工具自身登录，不进仓库。
- PR 全程保持 draft；pack 不合并、不标记 ready。

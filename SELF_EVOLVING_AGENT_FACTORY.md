# 自我进化多智能体交付系统蓝图

日期：2026-07-08
建议代号：**Evolution Factory / 自我进化工厂**

## 目标

把 IM.codes 从“多 agent 控制与聊天层”升级为“需求驱动的自我进化交付工厂”：用户把需求文档放入目录或通过 UI 上传，系统自动组织产品、设计、技术总监、开发、测试、运维等角色协作，完成 PRD、设计、技术方案、任务拆分、开发、测试与受控交付。

## 推荐路线

不要另起一个独立系统；应在 IM.codes 现有 Team/P2P、OpenSpec Auto Deliver、MCP、Cron、timeline、sub-session 能力上增加一层 **Evolution Pipeline**。

现有基础：

- OpenSpec Auto Deliver 已覆盖 spec audit、implementation、Team audit/rework、模块评分与质量门禁。
- P2P/Team 已覆盖多 agent 讨论、计划、审查。
- MCP 与 `imcodes send` 已覆盖 agent 间通信、记忆、定时任务。
- Web/mobile UI 已有聊天、timeline、文件预览、discussion 和 run details 的基础组件。

缺口：

- 需求文档 inbox watcher。
- 产品/设计/架构/测试/运维角色 skills。
- 从原始需求生成 OpenSpec change 的产物化流程。
- 一个可视化 War Room，展示各角色当前执行/讨论，并允许用户 `@角色` 介入。
- 跨阶段状态机、预算、人工门禁和部署治理。

## 核心流程

```text
需求输入
  -> 需求标准化
  -> 产品讨论与 PRD
  -> 设计稿/高保真说明（默认 taste-skill，Figma 可选）
  -> 技术总监架构基线
  -> 任务清单
  -> 多 agent 开发迭代
  -> 测试用例补全与自动验证
  -> staging 自动交付
  -> production 人工门禁
```

## Loop Engineering 原则

- **状态账本优先**：每轮迭代都写入 `run.json`、artifact 和 evidence，UI 只展示可追溯事实。
- **Maker/Checker 分离**：开发 agent 不验收自己的输出，QA/安全/技术总监给出独立评分。
- **预算与止损**：每阶段有轮次、时长和失败阈值；超限进入 `needs_human`，不无限循环。
- **人工门禁**：staging 可自动化，production、密钥、支付、隐私、迁移必须人工确认。

## 状态机

```text
detected
  -> intake_normalized
  -> product_discussion
  -> prd_ready
  -> design_lofi
  -> design_hifi
  -> architecture_baseline
  -> tasks_ready
  -> implementation_loop
  -> qa_completion
  -> delivery_ready
  -> deployed_staging
  -> human_release_gate
  -> deployed_production | needs_human | failed | stopped
```

每个阶段必须记录：`stage`、`ownerRole`、`inputs`、`outputs`、`qualityScores`、`blockingQuestions`、`nextActions`、`evidence`。

## 角色 Skills

| 角色 | 职责 | 输出 |
|---|---|---|
| 产品经理 | 需求澄清、用户故事、验收标准 | `prd.md` |
| 产品审查 | 找矛盾、遗漏、边界 | `prd-review.md` |
| UX/视觉设计 | 流程、低保真、高保真说明 | `design/*` |
| 技术总监 | 架构、技术基线、ADR、风险 | `architecture-baseline.md` |
| 开发 agents | 按任务隔离实现 | code + tests |
| QA | 测试用例、自动化测试、验收证据 | `test-plan.md` |
| 运维/发布 | 部署计划、回滚、环境变量 | `deploy-plan.md` |
| Loop Supervisor | 状态、预算、门禁、人工升级 | `run.json` |

## 首期 MVP

1. 监听 `.imcodes/inbox/requirements/` 中的新 `.md/.txt/.json` 文件。
2. 创建 `.imc/evolution/<runId>/run.json` 状态账本。
3. 生成 `prd.md`、`design.md`、`architecture-baseline.md` 和 OpenSpec `proposal.md/design.md/tasks.md`。
4. 新增 War Room UI：角色状态、讨论流、产物列表、阻塞问题、用户输入。
5. 在 `tasks_ready` 后调用现有 OpenSpec Auto Deliver，完成开发/测试闭环。
6. 部署首期只支持 staging；production 必须人工确认。

## 当前落地进度

- 已实现 Evolution 协议、状态机、路径/请求/投影校验。
- 已把角色 skill 元数据纳入协议与账本：每个角色带 `skillName`、职责摘要和 responsibilities。
- 已把角色 skill 物化为真实 IM.codes 项目级 skill：每个 run 会在 `.imc/skills/evolution/*.md` 确保默认产品/审查/UX/视觉/技术/开发/QA/安全/运维 skill 文件存在，并作为带 Markdown preview 的 `role_skill` artifact 登记；已存在的同名 skill 不会被覆盖，War Room 可直接按角色查看 Skill Playbook。
- 已实现 requirement inbox watcher，稳定文件会自动创建 Evolution Run；已处理 daemon 重启后的去重账本，同一文件身份不会重复触发，文件内容/mtime 变化后可重新触发。
- 已实现 stage runner：自动产出 normalized requirement、PRD、PRD review、UX flow、wireframe、低保真 SVG、高保真说明、高保真 SVG mockup、`design/taste-hifi-prompt.md`、`design/taste-hifi-output.md`、`design-handoff.json`、架构基线、ADR、OpenSpec proposal/design/tasks/spec、多 agent 开发分派矩阵、测试计划、详细测试用例和部署计划。
- 高保真默认接入轻量 taste-skill 适配层：`design/taste-hifi-prompt.md` 指向 `https://github.com/Leonxlnx/taste-skill` 的 `design-taste-frontend` / `imagegen-frontend-web`，供视觉/前端 agent 生成高保真 UI 方向或参考图；Figma 仅作为后续可选导出，不作为必需依赖。
- 已新增可选 taste-skill 自动执行器：项目提供 `.imc/evolution/design.json` 后，`design_hifi` 阶段会用安全 `execFile`（非 shell）调用本地命令，把输出登记为 `design/taste-hifi-output.md`，日志登记为 `taste_hifi_log`；未配置时会用内置 distilled taste-skill 规则生成同一路径的高保真输出，不阻塞主流程。
- 已新增开箱可用的轻量 taste-skill runner：`imcodes-taste-skill` / `scripts/run-taste-skill.mjs` 会读取 `design/taste-hifi-prompt.md` 与 `design/design-handoff.json`，优先加载本机已安装的 `design-taste-frontend` skill，生成 `design/taste-hifi-output.md`，并可额外输出 `design/taste-hifi-reference.svg` 作为 War Room 内可预览的高保真参考图；示例配置见 `config/evolution/design.taste-skill.example.json`。
- 已补齐外部高保真视觉服务适配：同一个安全 `tasteSkill.command` 可以调用本地或云端 renderer，产出 `design/taste-hifi-reference.svg/png/jpg/jpeg/webp`；War Room 会把 SVG 和小型 PNG/JPG/WebP 登记为 `taste_hifi_reference` 并内联预览，示例见 `config/evolution/design.visual-reference.example.json`。
- `design-handoff.json` 包含设计系统 token、组件清单、屏幕状态、`highFidelityProvider`、taste-skill prompt、可选 Figma prompt、image generation prompt 和验收清单，作为后续接 taste-skill/图片生成/前端实现的稳定输入。
- 已实现 War Room 入口，可查看阶段、角色状态、role skill、产物、证据，并向指定角色发送指令。
- War Room 已新增“运行内置 Demo”入口：点击后 daemon 会在 `.imcodes/inbox/requirements/demo/` 自动生成一份 `IM.codes Evolution Factory Demo` 需求文档，通过 `evolution_pipeline.launch_demo` 启动完整 run，并在来源中标记为 `demo`，方便首次打开界面时无需手写需求文件即可看到自我进化闭环。
- War Room 已显示当前需求入口绝对路径、watcher/手动/API/cron 触发来源和本次需求文档；STATUS 响应会返回当前 session 的 inbox watcher 状态，界面显示 active/inactive、扫描间隔和文件稳定窗口，并提供“立即扫描 inbox”按钮让用户不必等待轮询周期即可触发扫描。
- War Room projection 已新增 `executionTimeline`：后端会把角色当前动作、角色讨论、产物、圆桌状态、taste-skill/OpenSpec/staging evidence 聚合成“角色执行轨迹”，前端可按角色/阶段看到谁正在做什么、产出了什么、何时更新。
- War Room projection 已新增 `liveEvents`：专门服务实时观察窗口，把 OpenSpec Auto Deliver 的状态、active prompt、任务进度、模块评分，以及 staging command/stdout/stderr 映射成可过滤事件流；用户可以在同一个聊天战情室看到开发 loop 正在推进到哪一轮、还剩多少任务、哪个评分模块在阻塞。
- War Room projection 已新增 `loopControl`：按 loop-engineering 思路把 state/memory、role skills、P2P 圆桌、taste-skill 高保真、maker/checker 任务、质量评分、implementation loop、delivery gate 汇总成 readiness score、当前 gate、预算用量和是否可自动继续。
- War Room 产物列表已支持受限内联预览：PRD/设计说明等 Markdown/text 直接展示文本片段，低保真/高保真 SVG 设计稿和高保真 PNG/JPG/WebP reference 直接展示图片预览，方便用户在聊天窗口内看到设计推进结果。
- 已实现角色讨论流：产品、审查、UX、视觉、技术、QA、运维、用户消息和 Auto Deliver 回流都进入同一条可追溯 discussion ledger。
- 已接入 IM.codes P2P 圆桌 bridge：产品讨论、设计高保真、架构基线、任务准备四个关键阶段会分别尝试启动“产品需求圆桌 / 设计复核圆桌 / 架构基线圆桌 / 规划复核圆桌”；有同项目 helper/worker session 时创建真实 P2P run，没有 helper 时会自动生成本地 deterministic 多角色圆桌复核产物 `roundtable_review`，以 `PASS`/风险清单形式继续推进，避免自我进化因为缺少在线 helper 而空转。
- 已实现圆桌结果回流与开发前门禁：`p2p.run_save/run_complete/run_error` 会更新 War Room roundtable 状态、当前目标、summary、失败 gate 与 evidence；真实 P2P 或本地 fallback 都会形成可审计 summary，OpenSpec Auto Deliver 会等规划复核明确 `PASS` 后才启动，`REWORK`/失败会进入 `needs_human`。
- 已在 `tasks_ready` 产出 `implementation/agent-task-matrix.md`，明确技术总监、后端、前端、QA、安全、运维的 maker/checker 分工、输入、输出证据和退出门禁，让 OpenSpec Auto Deliver 前的多 agent 开发 loop 可分派、可审查。
- 已在 `tasks_ready` 产出 `artifacts/test-cases.md`，把需求信号、War Room 指令、inbox、规划产物、maker/checker、taste-skill、staging/production gate 等场景转成可执行或可人工验收的测试用例清单；OpenSpec Auto Deliver `passed` 后会再生成 `artifacts/test-evidence.md`，记录任务完成度、模块评分、测试/风险 evidence 和 release boundary。
- 已新增两档圆桌门禁：`planning` 只强制开发前规划复核，`strict` 会在产品、设计、架构圆桌返回 `PASS` 前暂停后续产物生成；`REWORK`/失败会立即转入 `needs_human`。
- War Room 已提供“自动启动开发 Loop”开关；默认只启用受控 OpenSpec Auto Deliver，`autoCommitPush` 默认为关闭。
- War Room 已提供“严格圆桌门禁”开关，并在 summary 中展示当前 `roundtableGateMode`，方便用户选择少干预/强审查两种自动化强度。
- War Room 发给指定角色的用户指令会优先注入当前阶段正在运行的匹配 P2P 圆桌上下文，不再只是本地 ledger 记录；这让用户能在圆桌讨论中途补充约束或纠偏。
- War Room 用户指令已形成“落盘 + 角色响应 + 可追踪事件”闭环：每条角色消息会生成 `discussions/user-instructions/*.md` artifact 和 `role_instruction_response` artifact（位于 `discussions/role-responses/*.md`），目标角色会在讨论流里明确确认，并在 liveEvents 中显示其本地执行计划；也支持“全部角色 / 全局约束”广播，由 Loop Supervisor 确认并传播到后续 PRD/设计/架构/任务/测试产物。
- War Room 已支持“角色关注视角”：点击产品/设计/技术总监/开发/QA/运维等角色卡后，执行轨迹、P2P 圆桌、讨论流和产物列表会按该角色过滤，同时把消息发送对象切到该角色，更接近一个可介入的多角色聊天战情室。
- War Room 已支持角色 skill 在线编辑：角色 Skill Playbooks 卡片可展开 Markdown 编辑器，保存后直接更新 `.imc/skills/evolution/<skill>.md`，当前 run 会记录 `role_skill` 最新 artifact、`role_skill_revision` 备份、discussion 与 evidence，后续圆桌和开发 loop 会读取新版 playbook。
- 已新增 role skill 共享治理链路：War Room 每次保存 skill 会同时生成 `role_skill_release_candidate` artifact（位于 `.imc/evolution/<runId>/skills/release-candidates/`）；用户可直接在 War Room 点击“批准为共享模板”，系统会发布到 `config/evolution/role-skills/approved/<skill>.md`，维护 `config/evolution/role-skills/approved/manifest.json` 版本审计记录（version、sha256、runId、candidate artifact、approval message、previous hash），并记录 `role_skill_library` artifact 和审批 evidence。项目可配置 `config/evolution/role-skills/approval-policy.json` 开启本地多人审批，未达阈值时只生成 `role_skill_approval_record`，达到阈值后才发布 approved seed。后续新项目/run 若尚未有项目级 `.imc/skills/evolution/<skill>.md`，会优先用 approved library 模板初始化。
- OpenSpec Auto Deliver 回流已细化到开发 loop 角色事件：task board、implementation prompt 轮次、审查修复轮次、active P2P、模块评分和最近修复摘要会拆成后端/前端/QA/技术总监/运维可过滤的 discussion/evidence，而不只是单条摘要。
- `needs_human` 的“继续/解除阻塞”会根据阻塞来源恢复到正确阶段：严格圆桌 REWORK 会回到产品/设计/架构原阶段，规划门禁会回到 `tasks_ready`，并记录人工 PASS 覆盖后继续 autopilot，避免错误跳过 PRD/设计/架构直接进入实现。
- Inbox watcher 自动触发的 run 会在 `tasks_ready` 后尝试启动 OpenSpec Auto Deliver；若 daemon/server link 暂时不可用，会停留在 `tasks_ready` 并记录 `missing_server_link` 等待事件，连接恢复后自动重试，不会误进人工阻塞；生产发布仍保留 human gate。
- 手动模式仍可从 War Room 对 `tasks_ready` 生成的 OpenSpec change 启动现有 OpenSpec Auto Deliver 开发 loop。
- 已实现 OpenSpec Auto Deliver projection 回写 Evolution ledger：`linkedAutoDeliverRunId`、阶段映射、scores、evidence、needs-human blocker 会同步回 War Room。
- 已实现受控 staging 自动交付适配器：OpenSpec Auto Deliver `passed` 后会读取 `.imc/evolution/delivery.json`，仅在显式配置 `staging.enabled=true` 时用 `execFile`（非 shell）执行 staging 命令，写入可预览的 `staging_deploy_log` artifact，并把 command/stdout/stderr/exit code 拆成 War Room evidence/timeline 事件；成功后自动进入 `human_release_gate`。
- 已在 `tasks_ready` 产出 staging 启用手册与配置示例：每个 run 会生成 `delivery/staging-setup.md` 和 `delivery/delivery.example.json`，并在 `loopControl.delivery_gate` 中关联，方便 War Room 直接看到如何安全接入 staging 命令。
- War Room 已新增 staging 配置体检：`evolution_pipeline.check_staging` 只读校验项目根目录 `.imc/evolution/delivery.json`，不会执行部署命令；通过后状态显示为 `ready`，失败/未配置/禁用会生成 `staging_config_check` artifact、evidence、live event 和修复提示，生产仍保留人工门禁。
- 已显式保留生产发布 human gate；当前自动化可推进到开发/QA/staging，并把 Auto Deliver 与 staging 状态回流到 Evolution。War Room 在 `human_release_gate` 点击“确认生产门禁”会写入 `release/release-gate.md`、记录人工审批证据并把 ledger 完成到 `deployed_production`，但不会执行任何 production 命令。

### Staging 交付配置

项目如需自动 staging，新增：

```json
{
  "staging": {
    "enabled": true,
    "command": "npm",
    "args": ["run", "deploy:staging"],
    "cwd": ".",
    "timeoutMs": 600000
  }
}
```

也可以直接复制开箱示例或每个 run 自动生成的示例：

```bash
mkdir -p .imc/evolution
cp config/evolution/delivery.staging.example.json .imc/evolution/delivery.json
# 或：cp .imc/evolution/<runId>/delivery/delivery.example.json .imc/evolution/delivery.json
```

约束：不通过 shell 执行；`prod/production` 目标会被拒绝；生产发布只进入 `human_release_gate`，不自动执行。真实项目仍需把命令、环境变量、回滚与监控链接替换成自己的 staging 配置。

### 本地端到端 Smoke

开发机可先跑确定性 smoke，不需要真实 LLM 或生产部署账号：

```bash
npm run smoke:evolution
```

该命令会在 `tmp/evolution-factory-smoke-*` 下创建临时项目，写入 `.imcodes/inbox/requirements/smoke/evolution-factory.md`，触发 watcher，生成 PRD/设计/taste-skill 高保真/架构/OpenSpec/tasks/test cases，模拟 OpenSpec Auto Deliver `PASS`，执行安全 staging 命令，然后停在 `human_release_gate`。输出会打印 run 目录和 `evolution-factory-smoke-report.md`，可直接打开 `.imc/evolution/<runId>/` 查看 War Room ledger 与产物。

如果只想在指定项目目录验收：

```bash
npm run smoke:evolution -- --project /path/to/project
```

如需额外验证“批准生产门禁只记录证据、不执行 production 命令”：

```bash
npm run smoke:evolution -- --approve-production-record
```

### Role Skill 共享与审批

团队级 role skill 的推荐路径：

```bash
# 1. 在 War Room 编辑角色 skill 并保存
# 2. 推荐：在 War Room 的“待审批发布候选”里点击“批准为共享模板”
# 3. 或手动审查本次 run 生成的候选文件
ls .imc/evolution/<runId>/skills/release-candidates/

# 4. 在 War Room 点击“批准为共享模板”
# daemon 会写入：
# - config/evolution/role-skills/approved/<skill>.md
# - config/evolution/role-skills/approved/manifest.json

# 可选：开启本地多人审批
cp config/evolution/role-skills/approval-policy.example.json \
  config/evolution/role-skills/approval-policy.json
```

发布约束：候选文件仍必须保留 `name: <skill>` 与 `category: evolution`；项目级 `.imc/skills/evolution/<skill>.md` 优先级最高，approved library 不会覆盖已有项目 skill。War Room 一键审批会自动去掉候选文件末尾的 governance 说明，只把 skill Markdown 正文发布为 approved seed，并在 `manifest.json` 追加版本化审计记录。若配置 `approval-policy.json` 且 `requiredApprovals > 1`，审批会先写入 `config/evolution/role-skills/approvals/*.json` 和 run 内 `role_skill_approval_record` artifact，达到阈值后才发布。

### taste-skill 高保真生成配置

项目如需在 `design_hifi` 阶段自动调用本地 taste-skill/image generation/自定义适配器，新增 `.imc/evolution/design.json`：

```json
{
  "tasteSkill": {
    "enabled": true,
    "required": false,
    "command": "imcodes-taste-skill",
    "args": ["--prompt", "{promptPath}", "--design-handoff", "{designHandoffPath}", "--output", "{outputPath}", "--reference-output", "{referencePath}"],
    "cwd": ".",
    "outputRelativePath": "design/taste-hifi-output.md",
    "referenceRelativePath": "design/taste-hifi-reference.svg",
    "timeoutMs": 600000
  }
}
```

`referenceRelativePath` 支持 `.svg`、`.png`、`.jpg`、`.jpeg`、`.webp`。SVG 会按文本预览；PNG/JPG/WebP 会以 data URL 预览，过大的图片仍会作为产物登记但不塞进 `run.json`。

也可以直接复制开箱示例：

```bash
mkdir -p .imc/evolution
cp config/evolution/design.taste-skill.example.json .imc/evolution/design.json
# 或接入已有视觉/图片生成 CLI：
cp config/evolution/design.visual-reference.example.json .imc/evolution/design.json
```

若直接在源码仓库内运行、尚未把 `imcodes-taste-skill` 链接到 PATH，可把 `command` 改成 `node`，并在 `args` 开头加上 `scripts/run-taste-skill.mjs`。

占位符：`{projectRoot}`、`{runDir}`、`{promptPath}`、`{designHandoffPath}`、`{outputPath}`、`{referencePath}`。约束：不通过 shell 执行；输出必须留在当前 run 目录内；`required=true` 时生成失败会暂停在 `needs_human`。未配置该文件时，系统会自动生成内置 `design/taste-hifi-output.md`，包含 design read、dial、tokens、组件状态矩阵和前端实现说明。

仍未完成：

- 默认 role skill 已支持 War Room 内编辑、run 内 revision/evidence 追踪，以及基于 `config/evolution/role-skills/approved/` 的共享发布候选、War Room 一键审批、approved seed、本地语义化版本 manifest 和可选多人审批策略；尚未接入远端组织级权限。
- 设计稿目前已产出 deterministic SVG mockup、taste-skill 高保真提示词和内置高保真输出，并支持配置本地或云端视觉 renderer；尚未内置具体供应商账号托管和云端密钥管理。
- 多 agent 开发分派、测试用例和 War Room 执行轨迹已产物化，OpenSpec/staging evidence 已回流；OpenSpec 状态、active prompt、任务进度、评分和 staging shell 输出已拆成 liveEvents/timeline/evidence 事件，后续仍可把底层 LLM token 流进一步细化到 token/chunk 级别。
- staging 已有配置示例、run 内 setup artifact 和 War Room 只读配置体检；真实项目仍需要按具体环境提供部署脚本、环境变量、回滚策略和监控链接。

## 建议新增文件

```text
shared/evolution-pipeline-constants.ts
shared/evolution-pipeline-types.ts
shared/evolution-pipeline-validators.ts
src/daemon/evolution-inbox-watcher.ts
src/daemon/evolution-inbox-watch-manager.ts
src/daemon/evolution-artifact-store.ts
src/daemon/evolution-orchestrator.ts
src/daemon/evolution-stage-runner.ts
src/daemon/evolution-design-runner.ts
src/daemon/evolution-delivery-runner.ts
web/src/evolution-pipeline.ts
web/src/hooks/useEvolutionPipeline.ts
web/src/components/EvolutionWarRoom.tsx
scripts/run-taste-skill.mjs
scripts/evolution-factory-smoke.ts
config/evolution/*.example.json
```

## 安全原则

- 首期不自动 merge、不自动生产部署。
- 触碰鉴权、支付、隐私、生产配置、数据库迁移时必须人工确认。
- 实现 agent 不审自己的结果，必须有 QA/审查 agent。
- 第三次同阶段失败自动进入 `needs_human`。
- 所有关键结论必须有 artifact/evidence，不接受纯聊天结论。

## 详细执行计划

OMX 计划副本：`.omx/plans/self-evolving-agent-factory-2026-07-07.md`

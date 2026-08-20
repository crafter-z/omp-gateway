# 03 — hermes 能力基线对照与缺口清单

> 基线来源：NousResearch/hermes-agent 官方文档
> `website/docs/user-guide/features/cron.md`、`messaging/index.md`、`messaging/qqbot.md`
> （2026-08 调研，见 `C:/tmp/omp-migration-report.md` §2/§3）。
> 目标：omp-gateway 对两个任务（cron 定时任务、QQ 网关）达到 hermes 同等能力。

## 1. 覆盖矩阵

| # | hermes 能力 | omp-gateway 对应 | 状态 |
|---|---|---|---|
| C1 | cron 语法：5 字段 cron / interval / 相对时间 / ISO | croner 6 字段 + interval + once | ✅ 已规划 |
| C2 | 自然语言调度（"every 2h"、"every sunday 9am"） | NL 解析层（§02-3.1） | ⚠️ 需自建/选库 |
| C3 | 每 job 全新 AIAgent 会话 | `omp --mode rpc --no-session` | ✅ |
| C4 | 按需注入技能 | `--skills`/`--no-skills` 透传 | ✅（实现细节） |
| C5 | 每 job 工具集限制（enabled_toolsets） | `--tools`/`--no-tools` 透传 | ✅（实现细节） |
| C6 | per-job 模型 pin → 舰队默认 → 全局默认 | `job.action.model` → `omp.model` → 会话默认 | ⚠️ 需实现解析顺序 + fail-closed |
| C7 | 台账 executions.db（claimed→…→unknown） | ledger（bun:sqlite） | ✅ 已规划 |
| C8 | 防重叠（.tick.lock / workdir 串行化） | 独占检查 + workdir 文件锁 | ✅ |
| C9 | misfire catch-up / 失败连击 nudge | misfire_grace_s + nudge_after_failures | ✅ |
| C10 | no-agent 纯脚本模式（$0） | `job.action.type = "no-agent"` | ✅ 已规划 |
| C11 | `{"wakeAgent": false}` 预检门（$0 省 token） | `wake_agent: false`（空输出不唤醒） | ✅ |
| C12 | 投递：origin/local 文件/20+ 平台/QQ | delivery：file/qq/origin + home_channel | ✅（仅 QQ） |
| C13 | `[SILENT]` 静默 / 响应包装 / continuable 续聊 | delivery 语义 | ✅ |
| C14 | cron job 由 agent 创建（cronjob 工具） | Phase 2 壳 `registerTool`（`job_add` 等） | ⏳ Phase 2 |
| C15 | 防 agent 自建 cron 死循环（allow_agent_scheduling） | job 创建来源标记 + 循环检测 | ⚠️ 需实现 |
| C16 | QQ 官方 API v2：WS 收 + REST 发 | qq 模块 | ✅ |
| C17 | C2C/群 @/频道/直发 | intents 订阅 | ✅ |
| C18 | 语音转写（QQ ASR + 可配 STT） | ASR + zai/openai STT | ✅ |
| C19 | 图片/文件附件收发 | REST 媒体上传/下载 | ✅ |
| C20 | 每聊天会话隔离（session store） | chat_sessions 映射 | ✅ |
| C21 | 允许清单（QQ_ALLOWED_USERS 等） | qq.allow | ✅ |
| C22 | home channel（QQBOT_HOME_CHANNEL） | delivery.home_channel | ✅ |
| C23 | preflight 配置校验（不烧 token） | zod + preflight 检查 | ✅ |
| C24 | 注入/凭据外泄扫描 | outbound 扫描 | ✅ |
| C25 | 模型漂移守卫 + fallback 凭证池轮换 | ⚠️ 部分：依赖 omp auto-retry；凭证池轮换不做 | 🟡 裁剪（记录） |
| C26 | 20+ 平台矩阵 | 仅 QQ | 🟡 裁剪（明确不做） |
| C27 | webhook 入站适配器 | 不做 | 🟡 裁剪（范围外） |
| C28 | mirror_delivery / thread | 不做（QQ 无 thread） | 🟡 裁剪 |
| C29 | context_from 链 / continuity（上次结果注入下次） | 预留 job.action.prompt 模板变量（如 `{{last_output}}`） | ⚠️ 需实现 |

## 2. 关键缺口（需重点设计/实现，对应契约章节）

按重要性排序，均为"可做但要专门设计"而非原理障碍：

1. **C2 自然语言调度解析**（`02-contracts.md §3.1`）——croner 不认 NL，需 NL→cron/interval 映射层，支持中文输入。
2. **C6 模型解析顺序 + fail-closed**——per-job → 全局 → 会话默认；解析失败应明确报错（preflight 拦截），不静默用错模型。
3. **C10/C11 no-agent $0 模式**——脚本执行器 + `wake_agent` 预检门 + 空输出静默 + 非零退出告警；这是 hermes 省 token 的核心路径，omp 无对应物，全部自建。
4. **C7 台账崩溃恢复**——`claimed` 超时扫描 → `unknown` 的语义要设计（重启后不重复执行、可审计）。
5. **C15 防死循环**——agent 通过工具建 job 时（Phase 2），检测"job 的 prompt 由某 job 创建"的环；且调度 job 不得再创建调度 job（hermes `cron.allow_agent_scheduling` 默认关）。
6. **C29 context_from/continuity**——跨次执行的上下文传递（模板变量注入 + 可选复用上次会话）。
7. **C24 凭据外泄扫描**——投递前扫描，模式列表（QQ 凭证、sk-、Bearer 等）+ 脱敏/阻断。
8. **C23 preflight**——job 创建即校验（模型可解析、脚本存在、workdir 可写、目标可达），失败零 token 消耗。

## 3. 裁剪决策（明确不做，避免范围蔓延）

| 裁剪项 | 理由 | 恢复条件 |
|---|---|---|
| 20+ 平台 | 用户仅需要 QQ | 未来按需加 Telegram（壳已有 omp-telegram 参考） |
| webhook 适配器 | 不在 cron+QQ 两任务范围 | 用户明确要求时 |
| 凭证池轮换 / fallback_providers | omp 有 auto-retry；个人单密钥够用 | 多 provider 需求出现时 |
| mirror/thread 投递 | QQ 无 thread 概念 | — |
| 官方 markdown 模板全套 | 需 QQ 审核，默认纯文本 | 有营销/富文本需求时按需接入 |

## 4. 验收对照（实现完成时的验证清单）

- [ ] `omp-gateway jobs add --every "5m" --prompt "..."` 后，agent 会话按周期执行、结果进 home channel
- [ ] `"每天 9 点"` 中文自然语言可正确调度（C2）
- [ ] QQ 私聊消息 → agent 回复回原 chat，回复可续聊（continuable，C20）
- [ ] no-agent job：脚本 stdout 投递、空输出静默、退出码非 0 告警、`wake_agent:false` 不唤醒（C10/C11）
- [ ] 杀掉 daemon 重启：运行中任务标记 unknown 不重复执行；未触发任务按 misfire 宽限补触发（C7/C9）
- [ ] 同 job 并发触发时第二次跳过（C8）
- [ ] 连续 3 次失败 → home channel 收到 nudge（C9）
- [ ] job prompt/输出含密钥 → 被阻断并告警（C24）
- [ ] 模型配置错误 → job 创建即报错，不消耗 token（C23）

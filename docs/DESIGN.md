# HiveMem — 面向多智能体协作的持久化、自演化记忆系统（设计草案 v0.1）

> **项目名：HiveMem**（蜂巢记忆：一群 agent 共用一个大脑）。2026-10-29 定名；npm、PyPI 上的 `hivemem` 均未被注册，GitHub 上只有少量同领域小仓库（≤34★）。
> 调研依据见 [research-landscape.md](research-landscape.md)。日期：2026-10-29。

---

## 0. 一句话定位

**让你同时使用的所有 agent（Claude Code、Codex、CodeBuddy、Cursor、Gemini CLI……以及办公 agent 和多智能体框架里的 agent）共用一套"会记账、能交接、可审计、会自我进化"的记忆。**

现有项目大多回答"一个 agent 怎么记住用户"。HiveMem 要回答的是"**一群 agent 怎么像一个团队一样共享、交接、纠错知识**"。

---

## 1. 为什么现在做：市场空白

调研里 15+ 个项目和 10+ 篇论文暴露出同一个结构性缺口：

| 能力 | 现状 | 谁做得最接近 |
|---|---|---|
| 跨工具共享（同一个项目在 Claude Code / Codex / Cursor 之间） | 只能靠"MCP + 厂商存储"或手工同步 markdown | Supermemory（按 git remote 推导命名空间，但核心闭源）、memU、Mnemon（hooks 覆盖广，但只在本地、没有作用域） |
| 出处（哪个 agent、什么证据、从哪条派生） | 产品里最多记一个 speaker ID | 只有研究里有：Collaborative Memory、MemTX |
| 多 agent 冲突处理 | 最后写入者胜、LLM 合并，或干脆只追加（ADD-only）绕开问题 | MemTX（研究） |
| 并发与一致性 | 生产系统里没有任何隔离级别 | Letta 的 git worktree 模式 |
| 权限（按 agent 读写） | 只有租户/数据集级；Graphiti 的 MCP 干脆不鉴权 | cognee（粗粒度） |
| agent 间交接 | 没有标准对象 | — |
| 自演化的治理（可审阅、可回滚） | 程序记忆（skills/playbook）没有版本和审阅 | ACE、ReasoningBank（研究） |
| 多 agent 记忆基准 | 没有任何基准测并发写、交接保真度或出处正确性 | — |

**结论：在一个真正开源的引擎里，把"版本化账本 + 出处 + 作用域/ACL + 交接 + 受治理的自演化"做成即插即用，是一个有防御性的位置。**

### 1.1 真实痛点（来自各工具的 issue 和论坛，2026-10，详见 research-landscape §7）

| # | 痛点 | 证据强度 | 代表性 issue |
|---|---|---|---|
| P1 | **每个工具各有一套指令文件**（CLAUDE.md、AGENTS.md、GEMINI.md、CODEBUDDY.md、rules），互不认、互相漂移 | ★★★★★ | claude-code#6235（约 460 条评论，置顶评论 672👍，近期才加了只认一个文件的 fallback）、codex#28739、codex#17401、gemini-cli#12345；ruler 约 3.0k★、rulesync 约 1.6k★，说明有需求 |
| P2 | **压缩（compaction）之后指令和工作状态丢失** | ★★★★ | claude-code#6354、#98747、#27242；codex#2927 |
| P3 | **自动记忆不透明**：不知道加载了什么、条目膨胀、写进错误事实、没法审阅和删改、生成记忆还吃额度 | ★★★★ | claude-code#82056、#52706、#59111；codex#30299、#26684（并发保存时丢失或重复）、#19105；Cursor 2.1 删掉了 Memories 管理界面 |
| P4 | **项目身份不稳定**：同一仓库的不同 worktree、不同机器之间记忆分裂，切换目录后记忆仍然串到别的项目 | ★★★★ | claude-code#81833、#81391（要求用 git remote 作为稳定身份并支持同步）、#102836；codex#25319 |
| P5 | **跨工具交接**：撞到额度上限后手工总结，再粘贴到另一个工具，导致上下文漂移和重复劳动 | ★★★（工具已经冒出来） | claude-code#13354（82👍）；ai-handoff、Relay、Delimit 等小工具 |
| P6 | **subagent 和并行 agent 之间不共享发现** | ★★ | 官方文档确认主记忆不会加载进 subagent；claude-code#77261、#23669 |
| P7 | **隐私**：记忆被发往了哪里、记忆里是否存了密钥 | ★★ | codex#41711、#55868 |

**关键洞察：**

1. **每个工具都已经有了自己的原生记忆**：Claude Code 的 `MEMORY.md`、Codex 的 `~/.codex/memories`、CodeBuddy 的 `~/.codebuddy/memories/{project}`、Gemini 的 Auto Memory，以及 Cursor Memories。痛点不在于"没有记忆"，而在于**这些记忆彼此孤立、不透明、不可治理**。所以 HiveMem 不应该另起炉灶取代原生记忆，而应该做**联邦和桥接**：读取各家的原生记忆，统一治理，再写回各家的原生文件。目前没有任何产品做到这一点。
2. 现有方案各管一段，全都做不到"学到的记忆 + 并发安全 + 审阅 + 稳定身份 + 写回原生文件"：
   - **ruler、rulesync** 只同步静态规则，不同步学到的记忆。
   - **claude-mem**（约 104k★，需求最强的证明）以 Claude 为中心，需要注册账号，30 天试用期后要订阅才能继续用，README 里还推广加密代币。
   - **mem0、Supermemory** 绑定厂商或云服务。
   - **交接类小工具**只支持特定的工具对。

---

## 2. 设计原则

1. **记忆是一本账，不是一堆向量**（Event-sourced ledger）。所有变化都是不可变的操作日志（op），当前状态是对日志的投影。版本、出处、审计、同步、回滚都由这一个机制得到。
2. **写入不等于相信**（write ≠ belief，借鉴 MemTX）。新记忆先进入 `tentative`，经过验证才进入 `committed`。共享区默认只召回 committed 的记忆。
3. **出处是一等公民**。每条记忆都带着"谁、在哪个工具、用哪个模型、基于什么证据、从哪几条派生而来"。
4. **LLM 可选的确定性内核**（借鉴 Mnemon）。内核从不调用 LLM：判断交给宿主 agent（经由 hooks 和 skill），或交给可选的、自带模型（BYO LLM）的后台 worker。这样零成本、可离线、行为可预测。另外 MCP 新规范已经废弃 sampling，本来就不该依赖它。
5. **自动优先，工具调用兜底**。hooks 能自动注入和捕获的宿主就走 hooks；MCP 工具只作为补充和兜底手段。不能指望模型"记得去调用 remember"。
6. **本地优先，可升级为团队**。单机用 SQLite 单文件，团队用 Postgres 服务。两者是同一套 schema 和同一份 op 日志，同步就是复制 op。
7. **人类可读、可编辑、可迁移**。记忆可以双向映射到 markdown 和 JSONL，可以放进 git，也可以导出为 CLAUDE.md、AGENTS.md、SKILL.md。
8. **安全默认值**：默认私有、写入前脱敏、注入时当作数据处理（防记忆投毒），支持可证明的级联遗忘。
9. **原生优先，联邦而不取代**（Native-first federation）：把各工具的原生记忆和指令文件当作"读写端点"来对接。用户卸载 HiveMem 之后，各工具照常工作，记忆也留在各自的原生文件里。这是降低采用门槛、避免与厂商对立的关键。
10. **透明**：每次注入了什么、为什么注入、来自哪里，都能看到；任何写入都可以审阅（借鉴 Gemini 的 `/memory inbox`）。

---

## 3. 核心场景（按优先级）

### S1 ⭐ 跨工具共享（MVP 主打）
同一个开发者在同一台或多台机器上，同时或交替使用 Claude Code、Codex、CodeBuddy、Cursor 开发一个或多个项目。

- **原生记忆桥接（P1、P3）**：把 Claude Code 的 `MEMORY.md`、Codex 的 memories、CodeBuddy 的 memories、Gemini 的 Added Memories 统一导入到一本账里，去重、解决冲突、审阅之后，再按各工具的格式写回。在任何一个工具里学到的东西，所有工具都知道。
- **共享项目记忆**：在 Claude Code 里讨论定下的"API 统一用 snake_case""测试用 pytest -x"，Codex 下一次会话开始时自动就知道。
- **稳定的项目身份（P4）**：以规范化的 git remote 为主键，把同一仓库的所有 worktree、clone 和机器归并为同一个项目，切换目录时自动切换作用域。
- **压缩救援（P2）**：PreCompact 时把关键状态（当前目标、约定、未完成事项）抢先落账；PostCompact 或下一个 prompt 时重新注入，解决"压缩后忘光 CLAUDE.md"的问题。
- **审阅收件箱与"加载回执"（P3）**：自动捕获的记忆先进入收件箱（tentative），一键批准、修改或丢弃。每次会话开始时可以查看"本次加载了哪 N 条记忆、共多少 token、被截断了什么"。
- **指令文件单一来源**：CLAUDE.md、AGENTS.md、GEMINI.md、CODEBUDDY.md、`.cursor/rules` 都从同一份"约定记忆"生成，不再各写各的、互相漂移。手工改了其中任何一个，也能导入回来。
- **会话交接（Baton，接力棒）**：Claude Code 撞到额度上限或要切换工具时，自动生成一份交接包，内容包括目标、已完成、待办、改过的文件、关键决策、未解决问题和最后一个报错。在 Codex 里开新会话时会看到提示："有一份 12 分钟前来自 claude-code 的交接，要继续吗？"
- **并行协作感知**：两个工具同时在同一个仓库干活时，可以对文件或任务登记"认领（claim，带 TTL 的租约）"，彼此都能看到。每次提交 prompt 时，注入"自你上次查看以来，队友（另一个工具）提交了 2 条影响 auth 模块的决策"。
- **跨项目**：用户级记忆（偏好、全局习惯）对所有项目生效。项目级记忆默认隔离，需要显式开启才能跨项目召回，例如问"我在项目 B 里是怎么解决 X 的"。
- **多设备同步**：可以自建 `hivemem serve`，也可以走 git 模式（把团队约定提交到仓库的 `.hivemem/` 目录），或者用网盘同步 op 日志。

### S2 编程 agent 内部的多智能体协作
主 agent 和 subagent、并行 worktree 里的 agent、"写代码 + 审代码"双 agent 之间共享发现：
- SubagentStop 时把结论写入任务作用域；SubagentStart 时注入相关记忆和交接包。
- 某个 agent 的"发现"需要被另一个 agent 复核才进入 committed，避免一个 agent 的幻觉污染整个团队。

### S3 多智能体框架和办公 agent
在 LangGraph、ADK、Microsoft Agent Framework、CrewAI 里给每个角色一份私有记忆，再加上团队黑板（共享决策、任务、交接）。ChatGPT、Claude.ai、Copilot Studio、Dify、n8n 和飞书 bot 通过远程 MCP 或 REST 接入同一份记忆。

### S4 经验沉淀成技能（自进化的落地形态）
从多个 agent、多个会话的成功和**失败**轨迹中蒸馏出程序记忆（做法借鉴 ReasoningBank 和 ACE），审阅通过后**导出为各工具原生的 SKILL.md、AGENTS.md 章节和 Cursor rules**，形成"agent 干活 → 沉淀经验 → 装回工具"的闭环。

### S5 记忆专家（MoE）与"谁知道什么"
记忆按领域拆成可插拔的**记忆专家**，例如约定、构建与测试、依赖、报错与修复、代码地图、架构、偏好、技能。路由器根据意图、当前文件、所用工具，稀疏地激活少数几个专家；"关键决策"和"全文检索"作为共享专家始终激活，保证召回下限。

在团队层面，系统记录每个 agent 或工具在各个领域上的可靠度，也就是交互记忆（"谁知道什么"），用来给召回排序、裁决冲突、建议交接对象。

专家接口是开放的，社区可以贡献领域专家（Django、K8s……），形成插件生态。详见 ARCHITECTURE §19。

---

## 4. 架构总览

```
 ┌──────────────── 宿主 / 接入层 (Adapters) ────────────────────────────────────┐
 │ Claude Code · Codex · CodeBuddy · Cursor · Gemini CLI · Copilot · OpenCode … │
 │   └─ hooks shim (SessionStart/Prompt/Stop/PreCompact/Subagent*) + skill      │
 │ ChatGPT · Claude.ai · Copilot Studio · Dify · n8n  └─ 远程 MCP (tools)       │
 │ LangGraph · ADK · MS Agent Framework · CrewAI · Mastra └─ Py/TS SDK 适配器    │
 │ 飞书 / Slack bot · A2A Agent Card                  └─ REST / A2A             │
 └───────────────┬──────────────────────────────────────────────────────────────┘
                 │  CLI (hivemem hook …) · MCP (stdio / Streamable HTTP) · REST
 ┌───────────────▼──────────── hivememd（本地守护进程 / 团队服务）───────────────┐
 │  Identity & Scope     身份解析：principal / runtime / agent / session / 项目 │
 │  Policy (ACL)         谁能读写哪个作用域；脱敏；风险分级                      │
 │  Write Pipeline       capture → redact → dedup → conflict → tentative        │
 │  Commit Engine        validate → commit / quarantine / supersede / revoke    │
 │  Recall Engine        intent → 多路召回 → RRF → 图扩展 → 过滤 → 打包注入      │
 │  Coordination         baton 交接 · claims 租约 · 变更订阅 (change feed)       │
 │  Projection           op log → 记忆表 / 图 / FTS / 向量 / markdown / 指令文件 │
 └───────────────┬───────────────────────────────────────┬──────────────────────┘
                 │                                       │
 ┌───────────────▼──────────────┐       ┌────────────────▼─────────────────────┐
 │ Storage                      │       │ Dreamer（可选后台 worker，BYO LLM）   │
 │ 本地：SQLite(WAL)+FTS5+向量   │       │ 整合 · 抽象 · 技能蒸馏 · 衰减 · 信任   │
 │ 团队：Postgres + pgvector     │       │ 所有产出都是 proposal（diff），按风险   │
 │ 同步：op 日志复制 / git 模式  │       │ 自动合入或进入审阅收件箱               │
 └──────────────────────────────┘       └──────────────────────────────────────┘
                 Web 控制台：时间线 · 图谱 · 冲突收件箱 · 提案审阅 · agent 信任度
```

**为什么用守护进程**：多个工具同时读写时，由单一写者把写入串行化（SQLite 只能有一个写者），从而得到一致性。Hook 脚本要求冷启动快，守护进程常驻也能维持向量索引在内存里。守护进程不在时，CLI 自动拉起它，或者降级为直接打开数据库文件。

---

## 5. 数据模型

### 5.1 身份（Identity）
```
principal  : 人或组织（user:alice, org:acme）
runtime    : claude-code | codex | codebuddy | cursor | gemini-cli | chatgpt | langgraph | …
agent      : 角色化的 agent 身份（如 claude-code/main、claude-code/subagent:reviewer、crew:planner）
session    : 一次会话（来自 hook 负载里的 session_id）
model      : claude-opus-5-5 / gpt-x / …（用于信任度统计和跨模型偏差分析）
project    : 由规范化后的 git remote 推导 hash；没有 remote 时用根路径。同一仓库的多个 clone 和 worktree 归并为同一个项目；monorepo 支持子路径
```

### 5.2 作用域（Scope）——"记在哪、谁能看"
```
session   → 会话草稿（工作记忆，默认会话结束后整理或丢弃）
agent     → 某个 agent 私有
project   → 项目共享（跨工具共享的主战场）
user      → 用户级（偏好、全局习惯，跨项目）
team/org  → 团队共享（需要服务模式）
```
- 写入时自动判断可见性（参考 AIM），但**判断不确定时降级为更私有的作用域**。
- **晋升（promote）就是"提 PR"**：从私有晋升到共享要经过验证规则或审阅；晋升后与原条目保持派生关系（lineage）。

### 5.3 记忆条目（Memory）
```yaml
id: 01JD...            # ULID，可排序、多端生成不冲突
kind: semantic | episodic | procedural | profile | coordination
content: "后端 API 字段统一使用 snake_case"
context: "在讨论 /users 接口时由用户明确决定"   # LLM 增强的上下文（A-MEM）
keywords/tags/entities: [...]
scope: { level: project, project: p_7f3a…, owner: user:alice }
status: tentative | committed | quarantined | superseded | revoked | archived
provenance:
  author: { principal: user:alice, runtime: claude-code, agent: main, model: …, session: … }
  method: user-stated | agent-inferred | hook-capture | dream-derived | imported
  evidence: [ {type: turn, ref: "sess_x#42"}, {type: file, ref: "api/users.py@a1b2c3"} ]
  derived_from: [ids]
confidence: 0.9        # 来源 × 证据 × 复核次数
importance: 1..5       # 有效重要度按衰减公式计算（借鉴 Mnemon）
time: { valid_from, valid_to, recorded_at }   # 双时态（借鉴 Graphiti）
version: 3, parent: <op_id>
embedding: <vector?>
```

### 5.4 关系（类型化的边）
| 边 | 含义 | 来源 |
|---|---|---|
| `supersedes` | 新事实取代旧事实（旧的变为 superseded，保留历史） | Supermemory `updates` |
| `extends` | 补充细节，两条都有效 | Supermemory |
| `derives` | 推断或整合而来（用于级联撤回） | Supermemory / MemTX |
| `contradicts` | 检测到冲突，等待解决 | MemTX |
| `causes` / `temporal` / `about(entity)` / `similar` | 用于图检索 | Mnemon / MAGMA |
| `handoff_of` / `part_of_task` | 协作关系 | 新增 |

### 5.5 操作日志（Op）——唯一真相来源
```
op_id(ULID) · actor(身份) · ts · type · target · base_version · payload · sig?(ed25519，团队模式可选)
type ∈ create | revise | link | unlink | promote | commit | quarantine | resolve | retract | access | claim | release | handoff
```
- **乐观并发**：revise 时必须携带 base_version；版本不一致时，不覆盖，生成 `contradicts` 冲突。
- 针对不同条目的 op 之间可以任意交换顺序（可交换），所以多端同步时直接按 op 合并即可，接近 CRDT 的思路。

### 5.6 协作对象（coordination 类）
- **Baton（交接包）**：`{goal, done[], todo[], files_touched[], decisions[ids], open_questions[], last_error, from, to?, expires}`
- **Claim（认领）**：`{resource: file|task|branch, holder, ttl}`。只是提示性的软锁，不会阻止编辑。
- **Decision（决策记录）**：类似 ADR，带理由和备选方案，默认高重要度并免疫衰减。
- **Change feed**：每个 agent 都有一个"已读游标"，可以查询"自上次以来与我相关的 committed 变更"。

---

## 6. 写入通路

```
① 捕获 capture
   · 显式：用户说"记住…"；agent 调用 remember
   · 自动：Stop / PreCompact / SessionEnd / SubagentStop hooks 拿到 transcript 增量
② 脱敏 redact：密钥 / token / 私钥 / 连接串 / PII 正则 + 熵检测；命中后打码或拒绝写入
③ 抽取 extract（三种模式可选）
   a. 宿主模式（默认，零成本）：Stop hook 返回一个"nudge"，让宿主 agent 判断是否 remember（Mnemon 做法）
   b. Worker 模式：后台用自带的小模型批量抽取（一次调用处理一批，借鉴 Memobase 固定调用预算）
   c. 规则模式：从 git commit、改动的配置文件、测试命令等确定性信号里抽取
④ 去重 dedup：内容 hash → 近重复（向量 + 实体）→ 合并为对已有条目的 `extends` 或加强（只调整 access 和 confidence）
⑤ 冲突检测：同一实体、同一属性出现不同的值 → 生成 contradicts 边
⑥ 落账：status = tentative，写入 op
⑦ 验证 → committed，满足任意一条即可（策略可配置）：
   · 用户亲口陈述（method = user-stated）
   · 有可核验的证据（文件@commit 仍然成立、测试通过）
   · 另一个 agent 或另一个工具独立复核或再次观察到
   · tentative 存活超过 N 天且被成功使用 ≥ k 次
```

**冲突解决策略**（借鉴 MemTX 的权威排序）：
`user-stated > 有证据的 agent 推断 > 无证据推断`；同一级别内，看新近度和证据强度。**两条同级、同强度的记忆冲突时进入 quarantine**，放进冲突收件箱，由用户或指定的仲裁 agent 处理。下一次会话开始时会提示"有 1 个记忆冲突待确认"。

---

## 7. 读取通路（召回与注入）

```
query ─► 意图识别（fact / why / when / how-to / who / handoff）  规则优先，可选 LLM
      ─► 多路候选：FTS5(BM25) · 向量 · 实体 · 最近 · 当前文件路径/分支相关
      ─► RRF 融合（k=60）
      ─► 图扩展：沿类型化的边做 beam search，按意图设置边的权重（WHY 走 causes，HOW 走 procedural）
      ─► 过滤：ACL × status(默认只要 committed) × 有效时间(valid_to) × 作用域
      ─► 可选重排：本地 cross-encoder / 宿主 LLM 重排（返回分项信号，交给宿主决定）
      ─► 上下文打包：按 token 预算分组（约定 / 决策 / 相关事实 / 技能 / 交接 / 冲突提示），
         每条带简短出处 [m:01JD… · codex · 2d ago]，并包在"数据而非指令"的标记里
```

**注入时机**（以 Claude Code 为例，Codex、CodeBuddy 同构）：
| Hook | 注入或捕获的内容 |
|---|---|
| SessionStart | 用户画像 + 项目约定（精简版）+ **未完成的交接包** + 待解决冲突 + 队友变更摘要 |
| UserPromptSubmit | 按 prompt 召回 top-k（同一会话内去重，有预算上限）+ change feed 增量 |
| SubagentStart | 任务作用域的记忆 + 交接包 |
| SubagentStop / Stop | 捕获增量 → 写入通路；nudge 宿主判断是否 remember |
| PreCompact | **压缩前抢救**：把即将丢失的关键状态写成 session 记忆和 baton |
| SessionEnd | 会话草稿整理（晋升或丢弃）；触发 Dreamer |

---

## 8. 自进化（受治理的演化）

Dreamer 在后台运行（参考 Letta sleep-time 和 LightMem 的离线更新）。**它所有的产出都是 proposal**，即带 diff 的 op 批次，按风险分级处理：

| 演化动作 | 说明 | 默认风险等级 |
|---|---|---|
| 链接发现 | 新条目进来时更新邻居的 context 和 tags（A-MEM），**写成新版本** | 低，自动合入 |
| 整合 consolidate | 合并近重复条目，生成规范条目，原条目以 derives 指向它 | 低 |
| 抽象 abstract | 多条情景记忆 → 一条语义事实（如"用户一贯偏好函数式写法"） | 中 |
| 技能蒸馏 | 成功和失败的轨迹 → 程序记忆（做法、反模式、检查清单），增量更新 playbook（ACE） | 高，需要审阅 |
| 衰减与归档 | 有效重要度 = 基础分 × 访问增益 × 半衰期 × 连接度；高重要度和决策类免疫；归档是软删除 | 低 |
| 信任更新 | 按 agent/runtime/model 统计"被验证率 vs 被推翻率"，信任度反过来影响验证门槛 | 自动 |
| 导出 | 已审阅的技能和约定 → SKILL.md / AGENTS.md / CLAUDE.md 托管块 / .cursor/rules | 中 |

**回滚**：任何 proposal 都可以整批撤回（retract 它产生的 ops），派生出的记忆会沿 derives 边级联标记为待复核。

---

## 9. 接入层（即插即用）

### 9.1 一条命令安装
```bash
npx hivemem setup       # 或 npm i -g hivemem；Python 用户可用 pip install hivemem（薄客户端）
hivemem setup               # 自动探测已安装的 Claude Code / Codex / CodeBuddy / Cursor / Gemini CLI …
hivemem setup --target claude-code,codex,codebuddy --yes
hivemem setup --eject       # 干净卸载，恢复原配置
```
`setup` 对每个宿主做的事：
1. 注册 MCP 服务器（写入对应的配置文件，并做备份）。
2. 安装 hooks shim（`hivemem hook <event> --runtime <x>`）。
3. 安装 skill 或指令片段（告诉 agent 何时用 remember 和 handoff）。
4. 在指令文件里插入**托管块** `<!-- hivemem:begin --> … <!-- hivemem:end -->`，块外的内容不动。

### 9.2 覆盖矩阵（首批）
| 宿主 | 机制 | 自动注入 | 自动捕获 |
|---|---|---|---|
| Claude Code | plugin（marketplace）= MCP + hooks + skill | ✅ | ✅ |
| Codex CLI | `config.toml` MCP + `hooks.json`（schema 几乎与 Claude Code 相同） | ✅ | ✅ |
| CodeBuddy Code CLI | **兼容 Claude 插件格式**（`.claude-plugin/`）+ `~/.codebuddy/.mcp.json` + 26 个 hooks 事件（与 Claude Code 同构，另有 CwdChanged、WorktreeCreate、InstructionsLoaded 等）；指令文件为 CODEBUDDY.md | ✅ | ✅ |
| Qoder CLI | AGENTS.md + `.qoder/rules` + MCP | 视 hooks 情况 | ⚠️ |
| Kimi Code CLI | AGENTS.md + `mcp.json` + `config.toml [[hooks]]`（beta） | ✅（beta） | ✅（beta） |
| Qwen Code | Gemini CLI 的分支：QWEN.md + `save_memory` + hooks + MCP | ✅ | ✅ |
| Cursor | `.cursor/mcp.json` + `hooks.json`（只能在 sessionStart 注入） | ⚠️ 部分 | ✅ |
| Gemini CLI | extension = MCP + hooks + skills | ✅ | ✅ |
| Copilot / VS Code | MCP + 复用 `.claude/settings.json` 的 hooks | ⚠️ | ✅ |
| OpenCode | TS 插件 | ✅ | ✅ |
| Windsurf / Cline | MCP + 只能捕获的 hooks | ❌，靠 MCP | ✅ |
| TRAE | `.trae/rules` + `.trae/mcp.json`（来自第三方资料，未核实） | 靠 MCP | ❌ |
| ChatGPT / Claude.ai / Copilot Studio | 远程 Streamable HTTP MCP + OAuth，**只用 tools** | 靠工具 | 靠工具 |
| LangGraph / ADK / MS Agent Framework / CrewAI / OpenAI Agents / Mastra | SDK 适配器：`BaseStore` / `BaseMemoryService` / `ContextProvider` / `StorageBackend` / `Session` | ✅ | ✅ |
| 飞书 / Slack / Dify / n8n | REST + bot 模板 / MCP 节点 | — | — |

### 9.3 MCP 工具（保持精简，ChatGPT 和 Copilot Studio 只认 tools）
| 工具 | 作用 |
|---|---|
| `recall(query, scope?, kinds?, budget?)` | 召回打包好的上下文 |
| `remember(content, kind?, scope?, evidence?)` | 写入（进入 tentative） |
| `revise(id, content \| status, reason)` | 修订、取代、确认 |
| `forget(id \| query, cascade?)` | 遗忘（软删除，可级联） |
| `handoff(action: create \| list \| accept, …)` | 交接包 |
| `coordinate(action: claim \| release \| feed, …)` | 认领 / 变更订阅 |

MCP 需要同时支持 2025-11-25 和 2026-07-28 两版规范。工具注解要标明只读、破坏性、幂等（借鉴 basic-memory）。

### 9.4 指令文件同步（解决漂移）
- **单一来源**：scope = project、kind ∈ {约定, 决策} 的 committed 记忆。
- **生成**：在 CLAUDE.md、AGENTS.md、GEMINI.md、CODEBUDDY.md、`.cursor/rules/hivemem.mdc` 中渲染托管块，内容按工具做适配（长度、格式）。
- **回流**：检测到用户手工改了某个托管块，或者在块外新增了规则，就作为 `imported` 记忆导入，再同步到其他文件。
- 提供 `hivemem sync --check` 用于 CI，在指令文件漂移时报警。
- 与 ruler、rulesync 的区别：它们只是静态复制规则文件；HiveMem 同步的是**学到的、带出处和状态的记忆**，规则文件只是它的一种投影。将来也可以把 rulesync 当作底层的格式渲染器复用，不必重复造轮子。

### 9.5 原生记忆桥接（Native Memory Bridge）
每个宿主实现一个 `NativeStore` 适配器，接口为 `read() → [Memory]`、`write([Memory])`、`watch()`：

| 宿主 | 原生位置 | 读 | 写回策略 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<repo>/memory/MEMORY.md` + topic 文件；CLAUDE.md、`.claude/rules/` | ✅ | 在 MEMORY.md 里维护托管段；遵守 200 行 / 25KB 的加载上限，把最有价值的条目排在前面 |
| Codex | `~/.codex/memories/`；AGENTS.md（32KiB 上限） | ✅ | 默认只读（官方说明这些文件是生成状态）；需要它遵守的规则写进 AGENTS.md 托管块 |
| CodeBuddy | `~/.codebuddy/memories/{project-id}/MEMORY.md`（typed frontmatter）；CODEBUDDY.md | ✅ | 托管段；frontmatter 类型映射为 HiveMem 的 kind |
| Gemini CLI / Qwen Code | `~/.gemini/GEMINI.md` 里的 "Gemini Added Memories" 段，以及 Auto Memory 的 `.patch` 文件 / `~/.qwen/QWEN.md` | ✅ | 写入它自己的段 |
| Cursor | 导出的 Memories；`.cursor/rules` | ⚠️（只能通过导出拿到） | 写 `rules/hivemem.mdc` |

- **导入时**的 provenance：`method: imported`，`runtime` 标记为来源工具，状态为 tentative（来源可信时可配置为直接 committed）。
- **写回时**按各宿主的上限做摘要和排序，并在文件里注明"由 HiveMem 管理，完整内容见 `hivemem web`"。
- 多个工具同时写原生文件时，用文件监听加上 op 的 base_version 检测冲突，不会静默覆盖。Codex 的 #26684 暴露的正是这个问题。

---

## 10. 存储与同步

| 模式 | 适用 | 实现 |
|---|---|---|
| 单机（默认） | 个人、多工具 | `~/.hivemem/hivemem.db`（SQLite WAL + FTS5 + sqlite-vec）+ 守护进程串行写 |
| Git 模式 | 小团队共享约定 | `.hivemem/` 下放 markdown 和 JSONL（只放 project 作用域里标记为可提交的条目），PR 就是审阅 |
| 服务模式 | 团队、多设备、办公 agent | `hivemem serve`：Postgres + pgvector，OAuth，远程 MCP；本地节点双向复制 op |

**嵌入模型**：默认本地小模型（bge-small 或同类，ONNX，CPU 可跑），也可以换成 OpenAI 或 Ollama。没有嵌入模型时退化为 BM25 + 图检索，照样可用。

---

## 11. 安全与隐私

- **默认私有**；跨作用域晋升要满足规则或经过审阅。
- **脱敏**：写入前过滤密钥；`.hivememignore` 可以排除路径和模式。
- **防记忆投毒**：来自网页、工具输出等非可信来源的内容打上 `untrusted` 标记；含有指令式文本的记忆进入 quarantine；注入上下文时一律包成带出处的"数据块"。在多 agent 场景下，一个被投毒的 agent 不能直接污染共享区，因为写入的内容首先只是 tentative。
- **可证明的遗忘**：forget 时沿 derives 边级联，被删除的内容不会残留在派生摘要里。GateMem 发现现有系统普遍做不到这一点。
- 审计日志（op log）完整可查；团队模式下可选 op 签名。

---

## 12. 技术选型建议

- **内核：TypeScript（Node ≥ 22.13，2026-10-29 由 Go 改定）**。理由：目标用户（Claude Code、Codex、Gemini CLI）机器上都有 Node，`npx hivemem` 一条命令就能装；`node:sqlite` 内置，不需要原生编译，Windows 安装最省事；MCP 的 TS SDK 最成熟；transformers.js 可以在本地跑嵌入，不依赖 Python；内核、Web 控制台和插件（OpenCode、OpenClaw 都是 TS）可以用同一种语言；claude-mem、Supermemory 已经验证过这条分发路径。Python 只做薄 SDK 和框架适配器（LangGraph、CrewAI、ADK）。代价是 hook 冷启动：实测约 116ms，其中 Node 启动约 71ms，v0.2 用 daemon 压缩。
- **SDK**：Python 和 TypeScript 做成薄客户端（REST/MCP），框架适配器放在独立的包里。
- **Web 控制台**：TS + 轻量框架，内嵌进二进制（`hivemem web`）。
- **许可证：Apache-2.0 + 托管服务 open-core（已定要做托管）**。内核、适配器、Web 控制台和单租户团队服务器全部开源；多租户控制面、SSO/SCIM、托管模型和 SLA 放在专有的托管版里；名称注册商标。这和 Supermemory "核心闭源、本地版限量" 形成鲜明对比，也避开 AGPL 给企业采用带来的阻力。为托管服务预留的设计见 ARCHITECTURE §15。

---

## 13. 评测：自己定义赛道

1. 常规基准：LongMemEval、LoCoMo（证明基本功），MemoryAgentBench（含选择性遗忘），GateMem（访问控制 + 遗忘）。
2. **自建 `MACoBench`（工作名）—— 第一个多 agent 记忆基准**，测：
   - 跨工具交接保真度：A 工具中断 → B 工具续做的任务完成率与重复劳动率；
   - 并发写一致性：两个 agent 同时写入相互冲突的事实时的处理正确率；
   - 出处正确性：召回结果能否准确追溯到作者和证据；
   - 泄漏率：私有记忆或已遗忘的内容出现在其他 agent 上下文中的比例；
   - 指令漂移：多个指令文件之间的一致性。
   
   基准本身就是吸引研究者、写论文、上榜单的抓手。

---

## 14. 路线图

| 阶段 | 交付 | 验收 Demo |
|---|---|---|
| **v0.1 跨工具共享** | 内核（op 日志、SQLite、BM25 + 向量、作用域）、git remote 项目身份、CLI、MCP（stdio）、Claude Code / Codex / CodeBuddy 的 hooks（三者同构，一套 shim 即可）、**原生记忆桥接**（这三家）、指令文件托管块、**Git 模式**（`.hivemem/memories` 一条记忆一个文件，PR 即审阅）、压缩救援、Baton 交接、审阅收件箱、`hivemem web` 时间线与加载回执 | Claude Code 里定下约定、中途撞额度 → 在 Codex 里一键续做，并且自动知道约定和进度；同时 CodeBuddy 的 MEMORY.md 里也出现了这条约定 |
| v0.2 多 agent 协作 + 记忆专家 | tentative/committed 验证、冲突收件箱、claims、change feed、subagent hooks、Cursor / Gemini / OpenCode 适配；**Expert 插件接口与内置专家，规则路由（`router.mode=rules`）** | 两个工具并行改同一个仓库，互相看到对方的认领和决策，冲突进入收件箱；同一个报错再次出现时，errors-fixes 专家直接给出上次的修法 |
| v0.3 团队与办公 | `hivemem serve`（Postgres、OAuth、远程 MCP）、多设备同步、ChatGPT / Claude.ai / Copilot Studio 接入、飞书 bot 模板 | 团队成员和 ChatGPT 共用一份项目知识 |
| v0.4 自进化 | Dreamer：整合、抽象、技能蒸馏、信任度、proposal 审阅、导出 SKILL.md；**学习型路由（bandit）与交互记忆的专长图** | 一周后自动沉淀出 5 条可审阅、可安装的项目技能；Web 控制台里出现"谁知道什么"热力图 |
| v0.5 生态 | LangGraph / ADK / MS Agent Framework / CrewAI / Mastra 适配器、A2A Agent Card、MACoBench 发布 | 多智能体框架 demo + 基准报告 |

---

## 15. 开源推广策略

- **10 秒能看懂的 Demo GIF**：左边 Claude Code、右边 Codex，记忆在两者之间流动。
- **一条命令装好，一条命令卸干净**（`setup --eject`）。
- 中英双语文档。适配 TRAE、Qoder、CodeBuddy、Kimi Code、飞书、Dify、Coze，覆盖国际项目普遍照顾不到的国内用户群。
- 上架 Claude Code plugin marketplace、Gemini extensions、awesome-mcp-servers、MCP Registry。
- 可复现的基准和公开的评测脚本。不只报自家分数，也开放 MACoBench 供其他系统跑。
- 发布渠道：HN、Reddit（r/ClaudeAI、r/LocalLLaMA）、V2EX、掘金、知乎、即刻；配一篇技术博客《Memory is a ledger, not a vector store》。

---

## 16. 风险

| 风险 | 对策 |
|---|---|
| 范围膨胀（这是最大的风险） | v0.1 只做 S1 跨工具共享，其他能力一律推后 |
| 宿主的 hooks 接口变化快 | shim 层做成表驱动配置，加上每晚跑的兼容性测试 |
| 自动捕获写入低质量或错误的记忆 | tentative 机制 + 验证门槛 + 冲突收件箱 + 衰减 |
| 注入太多污染上下文 | 严格的 token 预算 + 会话内去重 + 可观测（web 里能看到每次注入了什么） |
| 隐私和密钥泄漏 | 默认本地、默认私有、写前脱敏、`.hivememignore` |
| 与大厂原生记忆竞争 | 定位"跨厂商的中立层"，并且桥接而不取代原生记忆：原生记忆天然锁在单一厂商里，HiveMem 让它们互通 |
| claude-mem 等已有大量用户的项目 | 差异化：完全开源、无需账号或订阅、多工具对等（不以 Claude 为中心）、有审阅和出处机制、写回原生文件、适合团队和多 agent；再提供从 claude-mem 一键导入 |
| 与 ruler/rulesync 功能重叠 | 静态规则同步只是 HiveMem 的一个投影，可以复用它们做格式渲染，也可以与它们共存 |

---

## 17. 决策记录
| 问题 | 结论 | 日期 |
|---|---|---|
| 项目名 | **HiveMem**（CLI：`hivemem`，目录：`.hivemem/`） | 2026-10-29 |
| 内核语言 | TypeScript（Node）；Python 做 SDK 和框架适配器（最初定为 Go，同日改定） | 2026-10-29 |
| Git 模式 | 纳入 v0.1 | 2026-10-29 |
| 托管服务 | 要做；采用 Apache-2.0 open-core，架构从第一天起预留多租户 | 2026-10-29 |
| 多平台协作 | 建在同一本账上，一并设计、分阶段实现；当前重点是记忆内核（ARCHITECTURE.md） | 2026-10-29 |
| MoE 记忆 | 采用系统层 MoE（专家插件 + 稀疏路由）和团队层 MoE（交互记忆）；不做参数层 MoE；学习型路由只有在评测上胜过 dense 模式才默认开启 | 2026-10-29 |

### 17.1 名称候选（2026-10-29 查重，最终选定 HiveMem）
| 名称 | 寓意 | npm | PyPI | GitHub 同名情况 |
|---|---|---|---|---|
| **HiveMem** | 蜂巢：一群 agent 共用一个大脑 | 可用 | 可用 | 有几个同领域小仓库（≤34★） |
| **CairnMem** | cairn = 登山者给后来者留下的石堆路标，即"给下一个 agent 留下记忆" | 可用 | 可用 | 无 |
| **CoMem** | Collaborative Memory，极短 | 可用 | 可用 | 无同领域项目（typst/comemo 不相关） |
| **MemRelay** | 接力：跨工具、跨 agent 交接 | 可用 | 可用 | 有几个同领域 0★ 仓库 |
| **MemPact** | pact = 契约：agent 之间对事实"立约"，呼应账本和确认机制 | 可用 | 可用 | 一个 4★ 仓库（上下文压缩方向） |
| **Mnemosync** | Mnemosyne（记忆女神）+ sync | 可用 | 可用 | 2★ 仓库（跨平台人设同步） |
| ~~MemMesh~~ | — | — | — | 已被同领域 405★ 项目占用 |

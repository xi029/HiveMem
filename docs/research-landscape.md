# 调研笔记：Agent 记忆系统全景（2026-10-29）

> 数据来自对各仓库 README/源码/文档与论文的在线核对。Star 数为近似值；标 **[未核实]** 的条目来自二手来源或厂商自报，引用前请复核。

## 1. 用户指定的三个参考仓库

### A-MEM（agiresearch/A-mem）— Zettelkasten 式"会自我演化的笔记"
- 约 1.2k★，MIT，NeurIPS 2025（arXiv 2502.12110）。约 10 个月无提交，研究代码。
- **数据单元**：note = {content, timestamp, keywords, tags, context, embedding, links}。链接是无类型、无权重的 id 列表。
- **写入**：取 top-5 近邻 → 一次 LLM 调用（严格 JSON schema）决定是否演化：strengthen（建链）/ update_neighbor（改写邻居的 context 与 tags）。
- **读取**：Chroma 余弦 top-k，再拼上链接邻居。代码里标"hybrid"，但 BM25 实际未使用。
- **问题**：演化直接覆盖旧内容（`evolution_history` 字段从未写入）；没有去重、冲突处理或衰减；只是 Python 类，没有 MCP、REST 或 CLI。
- **值得借鉴**：① 由 LLM 生成 context、keywords、tags 并拼进 embedding 文本；② 新记忆触发"邻居演化"。改写要存成**新版本**，不能覆盖。

### Supermemory（supermemoryai/supermemory）— 集成面最完整的商业 Memory API
- 约 31.5k★，MIT。**但核心引擎不开源**：本地版闭源，上限 1 万文档；仓库里只有 SDK、MCP、插件和 UI。
- **四层模型**：Document（原文）→ Chunk（RAG 用）→ Memory（事实）→ Profile（静态与动态画像）。
- **记忆之间的三种关系**：`updates`（取代，保留历史，带 `isLatest`）、`extends`（补充，两条都有效）、`derives`（推断，带 `isInference`）。
- **记忆类型**：fact、preference（重复出现时增强）、episode（不重要就衰减）。
- **"dreaming"**：异步做抽取、建链、解决更新和推断。
- **检索参数**：hybrid / memories / chunks 三种模式，可选 rerank、rewriteQuery、嵌套元数据过滤；`profile()` 一次调用返回画像。
- **集成**：Claude Code 插件用了 4 个 hooks：SessionStart 注入画像，UserPromptSubmit 召回，PreToolUse 自动放行读操作，Stop 在后台捕获并脱敏。另有 Cursor、Codex、OpenCode、OpenClaw 插件，以及 LangChain、LangGraph、Mastra、Agno、OpenAI Agents、n8n 适配器。
- **命名空间**：由 git remote 推导，形如 `repo_<name>__<hash>`，同一个仓库在不同工具间共享记忆。
- **值得借鉴**：updates/extends/derives 三种关系；Document/Memory/Profile 分层；按 git remote 推导命名空间；hooks 组合。
- **短板**：核心闭源；没有 agent 级 ACL。

### Mnemon（mnemon-dev/mnemon）— "LLM 监督、二进制执行"的本地记忆
- 约 670★，Apache-2.0，非常活跃（2026-10-26 发布 v0.2.13）。Go 单二进制 + SQLite，**二进制本身从不调用 LLM**。
- **数据模型**：insight 表（category、importance 1–5、tags、entities、可选 embedding、访问计数等）。edges 分 temporal、entity、causal、semantic 四类，带权重；另有 oplog 审计表。
- **写入**：完全相同的内容跳过；同时给出 ADD/UPDATE/CONFLICT/DUPLICATE 建议。四类边按规则自动建立；余弦 0.40–0.80 的"候选边"交给宿主 LLM 用 `mnemon link` 确认。
- **读取**：先做意图识别（WHY、WHEN、ENTITY、GENERAL）。关键词、向量、时间、实体四路锚点用 RRF 融合，再在图上做 beam search，按意图加权重排；WHY 类结果做拓扑排序（因在前、果在后）；输出带各路信号分数。
- **衰减公式**：有效重要度 = importance × max(1, ln(1+访问次数)) × 0.5^(天数/30) × (1 + 0.1·min(边数, 5))。高重要度或高访问量的记忆免疫；条目过多时自动软删除，留 24h 宽限期。
- **集成**：一个 skill，加四段 hooks：Prime（会话开始）、Remind（提交 prompt 时）、Nudge（停止时决定是否写回）、Compact（压缩前）。`mnemon setup --target <x>` 覆盖 Claude Code、Cursor、Codex、OpenCode、TRAE、Qoder、Kimi Code 等约 20 个运行时。**刻意不做 MCP。**
- **值得借鉴**：零 LLM 成本的确定性内核；类型化的边 + 按意图路由召回；把候选边交给 agent 确认；检索信号透明；衰减公式和免疫规则；软删除 + oplog；覆盖面广的 `setup --target`。
- **短板**：质量依赖宿主 agent 是否自觉调用；没有 supersede 版本链；只在本地，不能团队同步；没有 ACL；没有跨 store 查询。

## 2. 其他重要项目

| 项目 | ★≈ | 最有特色的设计 | 主要短板 |
|---|---|---|---|
| **mem0 / OpenMemory** | 68k | 按 user_id、agent_id、run_id、app_id 划分作用域；2026-04 改为只追加（ADD-only）的单遍抽取，加实体链接；semantic + BM25 + entity 混合检索；OpenMemory 是本地 MCP，支持按客户端暂停或撤销访问，并有审计 | 这些 ID 只是过滤条件，不是 ACL；没有多 agent 合并语义 |
| **Letta (MemGPT)** | 25k | 记忆块常驻上下文；sleep-time agent 做异步整理；**2026-02 推出 Context Repositories / MemFS：记忆就是 markdown + git 仓库，反思与整理的 subagent 在 git worktree 里写、再合并回去**；有共享记忆仓库 | 冲突完全交给 git 文本合并；绑定 Letta 运行时 |
| **Zep / Graphiti** | 32k | **双时态**（事件时间与入库时间分开）；事实被"失效"而不是删除；episode、entity、community 三层子图 | 参考 MCP 服务器不做鉴权；抽取依赖大量 LLM 调用；默认单写者 |
| **cognee** | 33k | remember、recall、improve、forget 四个操作；把会话教训反馈沉淀进长期记忆；自定义本体；默认多租户 | 管线重；权限只到数据集级别 |
| **MemOS** | 12k | **MemCube**：带 owner 和 id，可隔离、共享、组合；统一明文、KV-cache、参数三类记忆；层次为轨迹 → 策略 → 世界模型 → 技能 | 复杂；跨 cube 的共享语义文档很少 |
| **memU** | 15k | 记忆是跨 agent、跨设备共享的 markdown wiki；从历史中提炼可复用技能（skip/patch/create）；内核不调用 LLM；有 Codex、Claude Code、Cursor、OpenClaw 适配器 | 没有出处、权限或冲突模型 |
| **basic-memory** | 4.4k | 人和 AI 共编 markdown（兼容 Obsidian）+ MCP；MCP 工具注解（只读、破坏性、幂等） | AGPL；没有 agent 身份 |
| **MIRIX** | 3.5k | 六类记忆（核心、情景、语义、程序、资源、知识库），每类由一个管理 agent 负责 | 这里的"多智能体"是内部组件，不是用户侧协作 |
| **LightMem** | 1.2k | 借 Atkinson–Shiffrin 模型分三段：感觉预压缩 → 短期 → 睡眠期离线更新；大幅省 token（ICLR 2026） | 研究代码 |
| **LangMem** | 1.7k | 程序记忆 = 用 prompt 优化器从轨迹重写系统提示 | 绑定 LangGraph |
| **Memobase** | 2.9k | 带 schema 的用户画像 + 事件时间线；每次运行固定 3 次 LLM 调用 | 只建模用户 |
| **Beads** | — | git 管理的 JSONL 任务记忆；hash ID 避免多 agent、多分支冲突 **[二手来源]** | 只覆盖任务 |
| **Hindsight** | — | retain、recall、reflect 四网络；在 GroupMemBench 上排第一 | 高分依赖强底座模型 |

## 3. 多智能体记忆相关研究（新颖思路的来源）

- **G-Memory**（NeurIPS 2025）：insight、query、interaction 三层图，组织记忆理论；可插入现有 MAS 框架而不改动它。
- **Intrinsic Memory Agents**：每个 agent 有按角色定制的模板记忆。
- **Collaborative Memory**（arXiv 2505.18279）：私有与共享两层；用户↔agent↔资源的动态访问图；**不可变出处**（贡献者、访问过的资源、时间）。
- **AIM + MUMBench**（Microsoft，2026-09）：写入时自动判断私有还是公开，索引级 ACL。可见性判断准确率 96%，但 CRUD 严格准确率只有 58.8%。
- **MemTX**（2026-07）：**"写入记忆 ≠ 确立信念"**。
  - 八态生命周期：tentative → validated → committed → action-safe，另有 quarantined、superseded、revoked。
  - 快照隔离事务，按风险分级。
  - 冲突按权威排序；权威相同则隔离（quarantine）。
  - 沿派生图做级联撤回。
- **Multi-Agent Memory from a Computer Architecture Perspective**（2026-03）：指出一致性是最紧迫的问题，而 agent 记忆至今没有形式化的一致性模型。
- **MemCollab**：跨模型共享记忆，通过对比不同模型的轨迹去掉模型特有的偏差。
- **程序/经验记忆**：
  - AWM：从轨迹归纳工作流。
  - **ReasoningBank**（ICLR 2026）：从成功和**失败**中蒸馏策略。
  - Memento：案例库 + 学习得到的检索策略。
  - **ACE**（ICLR 2026）：Generator、Reflector、Curator 三个角色，对 playbook 做增量（delta）更新，避免"上下文坍缩"。
- **GCC (Git Context Controller)**：对 agent 上下文做 COMMIT、BRANCH、MERGE。

## 4. 基准

- **LoCoMo** 已接近饱和，答案集本身也有质量争议 **[厂商审计，未核实]**。**LongMemEval-S** 约 115k token，能整段放进上下文窗口，所以更像在测上下文能力。
- 更有区分度的基准：**MemoryAgentBench**（ICLR 2026，含选择性遗忘）、**GroupMemBench**（多方对话；最好的系统约 46%，BM25 排第二）、**GateMem**（同时考查效用、访问控制和遗忘，现有方法都会泄露未授权或已删除的数据）、MUMBench。
- **空白**：没有任何基准测**并发多 agent 写入、agent 间交接保真度、出处正确性**。

## 5. 集成面（适配器设计依据）

| 宿主 | MCP 配置 | 生命周期 hooks（不依赖模型主动调用工具） | 指令文件 |
|---|---|---|---|
| Claude Code | `.mcp.json` / `claude mcp add`；plugin 可打包 skills、hooks、mcp | SessionStart、UserPromptSubmit、PreCompact、Stop、SubagentStart/Stop、SessionEnd 等，可注入 `additionalContext` | CLAUDE.md、skills |
| Codex CLI | `config.toml` 中的 `[mcp_servers.x]` | **默认开启**；schema 与 Claude Code 几乎相同（SessionStart、UserPromptSubmit、PreCompact、Stop、SubagentStart/Stop 等） | AGENTS.md |
| Cursor | `.cursor/mcp.json` | `.cursor/hooks.json`；只有 sessionStart 和 postToolUse 能注入 | `.cursor/rules`、AGENTS.md |
| Gemini CLI | `settings.json`；extension 可打包 mcp、hooks、skills | SessionStart、BeforeAgent（可注入）、PreCompress、SessionEnd | GEMINI.md |
| Copilot / VS Code | `.vscode/mcp.json`、`~/.copilot/mcp-config.json` | 预览阶段；**VS Code 也读取 `.claude/settings.json` 里的 hooks** | copilot-instructions.md |
| Windsurf / Devin Desktop | `mcp_config.json` | 只能观察或拦截，不能注入；有带 transcript 的 hook，适合捕获 | rules |
| OpenCode | `opencode.json` | JS/TS 插件：session.created、idle、compacted 等 | AGENTS.md |
| Cline | 扩展设置 | TaskStart、UserPromptSubmit、PreCompact（仅 macOS/Linux） | `.clinerules` |
| OpenClaw | — | 有独占的 memory slot，需要原生插件 | — |
| ChatGPT | **只支持远程 HTTPS MCP，且只用 tools** | — | — |
| Claude.ai / Desktop | 远程 connector、`.mcpb` | — | — |
| Copilot Studio / M365 | 只支持 Streamable HTTP MCP | — | — |
| Dify / n8n / Coze | MCP 客户端节点 | — | — |
| 飞书 / Slack | 需要自建 bot 调 REST | — | — |

**多智能体框架的后端接口**：
- LangGraph：`BaseStore`。
- Google ADK：`BaseMemoryService`（`add_session_to_memory`、`search_memory`）。
- Microsoft Agent Framework：`ContextProvider`（before_run/after_run，自动注入加自动捕获最干净）。
- CrewAI：`StorageBackend`。
- OpenAI Agents SDK：`Session`（只有历史）。
- Mastra：storage/vector adapter。
- Claude Agent SDK：复用 Claude Code 的 hooks 和 MCP。

**协议**：
- **MCP 2026-07-28 版是破坏性更新**：
  - 无状态：没有 initialize，也没有 session id。
  - Sampling、Roots、Logging 已废弃，**不要依赖 sampling 做摘要**。
  - Elicitation 改走多轮请求。
  - 需要同时兼容 2025-11-25 版。
- **A2A v1.0**：Agent Card，适合把记忆服务暴露成一个 agent。
- **AGENTS.md**：由 AAIF 治理。
- **记忆可移植格式**目前没有标准：W3C AI Agent Memory Interop CG（2026-06 立章程）、MacPaw `.mem`、MIF。

## 6. 主要来源
- https://github.com/agiresearch/A-mem · https://arxiv.org/abs/2502.12110
- https://github.com/supermemoryai/supermemory · https://supermemory.ai/docs/concepts/graph-memory · https://github.com/supermemoryai/claude-supermemory
- https://github.com/mnemon-dev/mnemon（docs/design/03–07）
- https://github.com/mem0ai/mem0 · https://www.letta.com/blog/context-repositories · https://arxiv.org/abs/2501.13956 · https://github.com/topoteretes/cognee · https://arxiv.org/abs/2507.03724 · https://github.com/NevaMind-AI/memU · https://github.com/basicmachines-co/basic-memory
- https://arxiv.org/abs/2506.07398 (G-Memory) · https://arxiv.org/abs/2505.18279 (Collaborative Memory) · https://arxiv.org/abs/2609.12320 (AIM) · https://www.alphaxiv.org/abs/2607.23929 (MemTX) · https://arxiv.org/abs/2603.10062 · https://arxiv.org/abs/2509.25140 (ReasoningBank) · https://arxiv.org/abs/2510.04618 (ACE) · https://arxiv.org/abs/2508.00031 (GCC)
- https://arxiv.org/abs/2507.05257 · https://arxiv.org/abs/2605.14498 · https://arxiv.org/abs/2606.18829
- https://code.claude.com/docs/en/hooks · https://developers.openai.com/codex/mcp · https://cursor.com/docs/agent/hooks · https://geminicli.com/docs/hooks/ · https://modelcontextprotocol.io/specification/2026-07-28/changelog · https://adk.dev/sessions/memory/ · https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/context-providers

## 7. 跨工具记忆痛点证据（issue 与论坛挖掘，2026-10-29）

> 计数多为 GitHub 搜索页显示的评论数；标 👍 的是反应数。CodeBuddy 文档取自镜像 workbuddy.ai/docs/cli。

1. **指令文件割裂**（最强）：
   - claude-code#6235 "Support AGENTS.md"（约 460 条评论，置顶 672👍）。2026-09 的 v2.1.277 加了 fallback：只有不存在 CLAUDE.md 时才读 AGENTS.md。用户仍在要求两者同时加载：#96466、#31005。
   - codex#17401（@include）、#28739（要像 Claude Code 那样支持 overlay、@ 引用和出处）、#12115（嵌套 AGENTS.md）、#13386（32KiB 截断）。
   - gemini-cli#12345。
   - 已有工具：ruler 约 3.0k★、rulesync 约 1.6k★（已支持 CodeBuddy、Qwen、Kimi、Trae、Qoder）。
2. **压缩后失忆**：claude-code#6354、#4017、#29890、#98747、#27242；codex#2927。
3. **自动记忆不透明、膨胀、写错、不可审阅**：
   - Claude Code：#82056（不知道 MEMORY.md 有没有完整加载）、#79217、#23544、#52706（希望写入前确认）、#59111（希望有衰减或 TTL）、#70525（模型臆造的内容经由记忆被强化）。
   - Codex：#30299（没有查看、清理、限定作用域的命令；全局文件膨胀到上千行并串到其他工作区）、#26684（并发保存时丢失或重复）、#19105（生成记忆耗额度）。
   - Cursor：2.1 版删掉了 Memories 管理界面，引发用户恐慌。
4. **项目身份**：
   - claude-code 的 worktree 问题集中在 #81833、#16600、#44130。
   - 跨机器：#81391（git remote 作为身份 + 同步）、#87027、#67369；目录切换不重新划定作用域：#102836。
   - codex#25319。
5. **跨工具交接**：claude-code#13354（82👍）；Reddit 上有大量"手工总结再粘贴"的抱怨（经镜像获取，未核实）；小工具有 ai-handoff（只支持 Claude→Codex）、Relay、Delimit、dotclaude `/handoff`。
6. **subagent 之间不共享**：文档确认主记忆不加载进 subagent；claude-code#77261、#23669。
7. **隐私**：codex#41711（memories 在未提示的情况下把本地 provider 的聊天内容发给 OpenAI）、#55868。

**各工具的原生记忆现状**：
- **Claude Code**：auto memory 存在 `~/.claude/projects/<repo>/memory/MEMORY.md`，加载前 200 行或 25KB，仅限本机；AGENTS.md 的加载模式可以在 /config 里选；`/import` 能一次性导入其他 agent 的配置。
- **Codex**：memories 默认关闭，存在 `~/.codex/memories/`，由空闲会话在后台生成；官方说明这些文件是"生成状态"，不建议手工编辑。
- **Cursor**：Memories 的管理 UI 已删除。
- **Gemini CLI**：`save_memory` 写入 GEMINI.md；实验性的 Auto Memory 会产出 `.patch` 和 SKILL.md 草稿，通过 `/memory inbox` 审阅后才加载。**这个"先审后载"的设计值得借鉴。**
- **CodeBuddy Code CLI**：
  - 指令文件：CODEBUDDY.md（user / project / local 三级）、`.codebuddy/rules`，以及 `@imports`。
  - 记忆：`~/.codebuddy/memories/{project-id}/MEMORY.md`，带 typed frontmatter（user / feedback / project / reference）。
  - MCP：`~/.codebuddy/.mcp.json`、`.mcp.json`。
  - hooks：26 个事件，与 Claude Code 同构。
  - 插件：兼容 `.claude-plugin/`。
- **Qoder**：AGENTS.md、`.qoder/rules`；IDE 和桌面端的记忆是分开存的。
- **Kimi Code**：AGENTS.md、`mcp.json`、`[[hooks]]`（beta）；没有内置记忆。
- **Qwen Code**：QWEN.md、`save_memory`、hooks、MCP。

**已有的同类工具与局限**：
- **claude-mem**（约 104k★）：用 hooks 捕获，存进 SQLite + Chroma，支持多工具；需要登录账号，30 天试用期后需订阅，README 推广加密代币。这是需求最强的证明。
- 其他：mem0/OpenMemory、Supermemory、Hindsight、Cognee、codemem（P2P 同步）、Memorix、AgentMemory。
- **空白**：并发安全写入、先审后载、跨 worktree 和机器的稳定身份、密钥扫描与外发控制、**写回各工具的原生文件**。

## 8. MoE / 路由式记忆（2026-10-29 补充）

| 层次 | 工作 | 要点 |
|---|---|---|
| 参数层 | Memory Layers、UltraMem、PEER；Memory Decoder（NeurIPS 2025，https://arxiv.org/abs/2508.09874） | 把记忆做进权重，或者做成可插拔的小解码器（要求共享 tokenizer）。闭源宿主无法使用，**不适合本项目内核** |
| 系统层 | **ShardMemo**（https://arxiv.org/abs/2601.21545） | 先按作用域和元数据掩码，再由学习型路由器在可用分片中选少数几个探测；在固定探测预算下，LoCoMo 比学习型路由基线约高 3 F1，比最强记忆基线最多高 6.8 F1 |
| | Cost-Sensitive Store Routing（https://arxiv.org/abs/2603.15658） | 把"查哪个存储"建模为代价敏感决策；oracle 路由比全量检索更准、token 更少；学习型路由列为未来工作 |
| | Retriever Portfolios（https://www.alphaxiv.org/abs/2605.31176）、LTRR（arXiv 2506.13743）、MoR、RAGRouter（NeurIPS 2025） | 按 query 路由或加权多个检索器，普遍优于单一检索器 |
| | MemRouter（https://arxiv.org/pdf/2605.00356）、FluxMem | 写入侧路由（决定哪些轮次进入长期记忆）；用学习型门控选择记忆结构 |
| | MIRIX | 6 类记忆，各由一个管理 agent 负责，加一个元路由器 |
| 团队层 | LLMA-Mem（https://arxiv.org/abs/2604.03295） | 多智能体终身记忆，含交互记忆模块；结论是团队规模并非越大越好，记忆让小团队可以胜过大团队 |
| | MATM（https://arxiv.org/pdf/2606.19911） | 生产者 agent 把轨迹存入共享库，消费者 agent 检索 |
| | Gated-Memory Routing（https://www.alphaxiv.org/abs/2609.00237） | 路由决策同时参考 query 和学到的执行记忆 |

**判断**：系统层和团队层的 MoE 与 HiveMem 架构天然契合（ACL 就是掩码，多路通道就是专家，信任度细化后就是专长图），已写入 ARCHITECTURE §19。论文报告的收益属于中等幅度，部分 arXiv 编号与日期只看过摘要，引用前需要复核。

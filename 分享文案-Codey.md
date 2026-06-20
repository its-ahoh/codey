# Codey 技术分享文案

> 面向受众：开发者 / 工程师 ｜ 时长：3–5 分钟短视频 ｜ 交付：特色亮点提炼 + 口播稿

---

## 一句话定位

Codey 不是又一个「聊天接 AI」的桥，而是**你已经在用的那些编码 Agent（Claude Code / Codex / OpenCode）的控制平面**——一个地方组织、切换、编排它们，跑在你自己的机器上。

一句更口语的说法：**给你的编码 Agent 们配了个「调度中枢」和「项目工位」。**

---

## 特色亮点提炼（核心卖点）

下面每条都可以单独做一个分镜或一页 PPT。按「最抓人 → 次抓人」排序。

### 1. 多 Agent 并行同台 PK（最大差异点）
一条 prompt，`/parallel` 同时丢给 Claude Code、Codex、OpenCode，**并排比较谁的实现更好**，而不是凭感觉选一个。
> 金句：「不要再猜哪个模型更适合这个任务——让它们当场比一遍。」

### 2. Worker 团队，而不是单个 prompt
用 markdown 给每个角色定义**人格、职责、工具、甚至各自的 Agent 和模型**：Architect 跑 Opus、Executor 跑 Codex、Reviewer 跑本地 OpenCode。
三种调度模式：
- `all`：每个成员依次执行，输出向后传递
- `auto`：内置 Advisor 自动挑出真正相关的子集
- `parallel`：所有成员并发，组成一个 **Advisor 主持的圆桌讨论**（详见下方专章）
> 金句：「从『一个提示词』升级到『一支有分工的团队』。」

### 2.5 Parallel 模式的工作原理（面向工程师的硬核细节）
这是 worker 团队里最值得展开讲的一块。它不是「同时跑一遍取最优」那么简单，而是一套**基于文件的并发协作 + Advisor 调度循环**：

- **基于文件的协作，不是内存消息传递**。运行时在磁盘上开一个 discussion 目录：一份 control 控制文件、topic、共享 summary，以及**每个 worker 各自一份 opinion 意见文件**。worker 互相能读到对方的 opinion 文件路径——也就是说它们能看见彼此在说什么。
- **worker 是循环迭代，不是只跑一次**。每个 worker 在自己的 loop 里反复：读同伴意见 → 产出 → 写回自己的 opinion 文件，每轮结束后读 control 文件并据状态反应（`terminated` 退出 / `finalizing` 收尾退出 / `paused` 每 5 秒轮询直到解除）。
- **Advisor 是一条独立的调度循环**。按 `advisorPollMs` 轮询、并用 `fs.watch` 监听目录变化。每一拍它读取 topic + summary + 全部意见 + worker 用 `[ASK_ADVISOR]` 抛出的问题，调用 LLM 返回**一个 JSON**，做四选一决策：
  - `continue`：继续迭代，可顺手改写共享 summary、给 worker 下一条 `directive` 指令
  - `ask_user`：暂停全部 worker，把问题（可带选项）抛给用户，拿到回答后注入并恢复
  - `finalize`：达成共识 / 停滞收敛，正常收尾
  - `terminate`：跑偏（drift）了，强制中止
  - 注意：**共享 summary 由 Advisor 维护，worker 不写它**。
- **两个独立看门狗（supervisor）**：一个硬性 `maxDurationMs` 总时长上限；一个 `idleTimeoutMs` 空闲看门狗——若意见/summary 文件在空闲窗口内都没变化就停（且只在出现第一次写入后才武装）。
- **结束产出**：带上终止原因（`consensus` / `drift` / `max_duration` / `timeout`）、最终消息、共享 summary，以及每个 worker 意见文件的摘录。
> 金句：「不是『一起跑一遍』，而是一张**会读彼此发言、有人主持、能喊停**的圆桌。」

### 3. 每个项目一个 Workspace（项目工位）
每个 workspace 有自己的工作目录、记忆（memory.md）和 workers。`/workspace myproject` 一键切换，Agent 的工作目录自动跟着切。

### 4. 多层记忆系统
Worker 和团队每次运行都会读写工作区记忆；还有跨工作区共享的**用户全局记忆层**（`~/.codey/`）。
团队协作有「**黑板机制**」：worker 之间用 `[FACT]` `[DECISION]` `[HANDOFF]` `[OPEN]` 标记传递事实与决策，这些标记对用户隐藏、在步骤间累积，最后汇成一份 `🧠 Team blackboard` 总结。
> 工程师会买账的点：warm session 用 `--resume` 复用，每步只发**黑板增量**，不重发人格和记忆 —— 省 token、省时间。

### 5. 随处可用的入口
- **原生 macOS 菜单栏 App**（Electron + React）：多 chat 标签、工作区切换、内联设置、文件变更 diff 面板
- **聊天平台**：Telegram / Discord / iMessage，手机上就能派活
- **系统级语音输入**：按住热键（默认 `Fn`）说话松开，转写后**直接粘贴进当前聚焦的任何 App**

### 6. 语音输入做得很硬核
本地 **WhisperKit**（CoreML / 神经引擎 ANE）端上转写，无需联网无需 API key，空闲 30s 自动卸载省内存；也支持任意 OpenAI 兼容接口，甚至 **WebSocket 实时流式转写**（边说边出字，连接失败自动回退批量 HTTP）。

### 7. 本地优先，数据是你自己的
跑在你自己的机器上，直连你自己的账号，**中间没有代理服务器**。

---

## 口播稿（3–5 分钟 / 逐字稿）

> 语速按约 250–280 字/分钟，全文约 1000 字，对应 3.5–4 分钟。括号内为分镜/演示提示。

**【开场 · 抛问题】**
如果你和我一样，电脑里同时装了 Claude Code、Codex、还有 OpenCode——你大概率遇到过同一个纠结：这个任务到底交给谁更合适？切来切去，每个工具还各有各的工作目录、各有各的上下文。今天我想分享一个我一直在用的项目，叫 Codey，它的思路是：**别把它当成一个聊天工具，把它当成这些编码 Agent 的控制中枢。**

**【核心一 · 并行 PK】**（演示：输入 `/parallel`，三栏同时出结果）
先看最爽的一个功能。我敲一条 `/parallel`，同一个 prompt，Claude Code、Codex、OpenCode **同时开跑**，结果并排摆在一起。我不用再猜哪个模型更适合这个任务——让它们当场比一遍，我直接挑最好的那份。

**【核心二 · Worker 团队】**（演示：打开一个 worker 的 markdown 定义）
但真正改变工作方式的，是第二点：**Worker 团队**。在 Codey 里，我可以用一个 markdown 文件给每个角色定义人格、职责、工具，甚至给它们各自分配不同的 Agent 和模型——架构师用 Opus，执行用 Codex，代码审查用本地的 OpenCode。然后一条 `/team`，它们可以依次接力，也可以让内置的 Advisor 自动挑出相关的几个，甚至开成一场**并发的圆桌讨论**。

这场圆桌值得多说一句，因为它的实现挺讲究：每个 worker 在磁盘上有自己的一份意见文件，而且能读到别人的——所以它们是**边看彼此发言边迭代**，不是各跑各的。背后有一个 Advisor 调度循环在轮询所有人的意见，每一拍做一个决定：继续迭代、改写共享总结、或者暂停下来回头问我，甚至判断跑题了就直接喊停。还有两个看门狗兜底：一个管总时长，一个在大家都不再产出时自动收尾。这已经不是「写个提示词」了，这是**派一支会协作、有人主持、能喊停的团队去干活**。

**【核心三 · 工作区 + 记忆】**（演示：`/workspace` 切换）
每个项目还有自己独立的工作区——独立的目录、独立的记忆。切工作区，Agent 的工作目录自动跟着切。而且记忆是分层的：工作区级别、跨项目的全局级别都有。团队内部还有个我特别喜欢的「黑板」机制：worker 之间用标记传递关键事实和决策，对我隐藏、在背后累积，最后给我一份干净的总结。配合 warm session 复用，每一步只发增量，省 token 也省时间。

**【核心四 · 随处可用 + 语音】**（演示：按住 Fn 语音输入）
最后，入口很全。一个原生的 macOS 菜单栏 App 日常用，Telegram 上用手机随时派活，还有系统级的语音输入——按住热键说话，松开，转写结果直接粘进我正在用的任何输入框。而且转写可以完全在本地用 WhisperKit 跑，不联网、不要 key。

**【收尾 · 立意】**
所以 Codey 想做的，其实就一件事：把你**已经在用**的这些编码 Agent，从一堆各自为政的工具，变成一个能组织、能编排、跑在你自己机器上的整体。如果你也同时在用好几个 AI 编码工具，我真的建议你试试这种「控制平面」的思路。我是 JO，感谢观看，项目链接放在下面。

---

## 备用素材

**更短的 30 秒电梯版（备用）**
「你装了 Claude Code、Codex、OpenCode，但每次都在纠结用哪个？Codey 让你一条命令并行跑、当场比；还能把它们编成一支有分工的 Worker 团队，每个角色配不同的模型；每个项目独立工作区和记忆；手机、菜单栏、语音都能派活。一句话——它是你那些编码 Agent 的控制平面，跑在你自己的机器上。」

**可用作标题 / 封面的金句**
- 「别再猜哪个 AI 更行——让它们当场比一遍。」
- 「从一个提示词，到一支有分工的团队。」
- 「你那些编码 Agent 的控制平面。」
- 「一条命令，三个 Agent 同台 PK。」

**技术名词速查（讲解时可甩出来显专业）**
Advisor 编排 LLM ｜ Parallel 模式：基于文件的协作（control / topic / summary / 每人一份 opinion）+ Advisor 轮询循环（`continue`/`ask_user`/`finalize`/`terminate` 四选一 JSON）+ 双看门狗（`maxDurationMs` / `idleTimeoutMs`）+ `[ASK_ADVISOR]` 上报 ｜ Sequential/all 模式：黑板机制（`[FACT]`/`[DECISION]`/`[HANDOFF]`）｜ warm session `--resume` 增量 ｜ WhisperKit on-device（CoreML/ANE）｜ monorepo：`@codey/core` + `@codey/gateway` + `codey-mac` + Swift voice helper

> 提示：**黑板机制（`[FACT]/[DECISION]/[HANDOFF]`）属于 Sequential/all 模式；Parallel 模式用的是 opinion 意见文件 + `[ASK_ADVISOR]`**，两者别混讲。

<p align="center">
  <img src="assets/logo.png" alt="Codey —— Claude Code / Codex / OpenCode / pi 的多 Agent 工作台" width="300" />
</p>

# Codey 🚀 —— Claude Code / Codex / OpenCode / pi 的多 Agent 工作台

[English](README.md) | [中文](README.zh-CN.md)

<p align="center">
  <a href="https://github.com/its-ahoh/codey/releases/latest"><img src="https://img.shields.io/github/v/release/its-ahoh/codey?label=download&color=2ea44f" alt="最新版本" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-black" alt="平台：macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/its-ahoh/codey" alt="许可证：MIT" /></a>
  <a href="https://github.com/its-ahoh/codey/stargazers"><img src="https://img.shields.io/github/stars/its-ahoh/codey?style=social" alt="GitHub stars" /></a>
</p>

**面向编码 Agent 的多 Agent 工作台。** Codey 把 Claude Code、OpenCode、Codex 等编码 Agent 统一管起来：给每个项目独立的 workspace，用可复用的角色定义组建 Bot 团队，在同一个任务上并行跑多个 Agent 做对比；从原生 macOS 应用、聊天平台（Telegram / Discord / iMessage）或者全局语音输入都能用。

与其说它是"聊天平台到 Agent 的桥"，不如说它是**你已经在用的那些编码 Agent 的控制台**。它完全跑在你自己的机器上，直接复用你已装好、已登录的 Agent CLI —— 没有中间代理服务器，也不用额外订阅。

**目录：** [为什么用 Codey](#为什么用-codey) · [下载](#下载) · [功能特性](#功能特性) · [快速开始](#快速开始) · [配置](#配置) · [Team 与流程图](#Bot配置) · [命令](#命令) · [语音](#语音输入-macos) · [记忆](#co-memo-共享记忆) · [常见问题](#常见问题)

<p align="center">
  <img src="assets/demo.gif" alt="Codey 演示：定时 Automation 自动起草内容，并通过内置的 Agent 控制浏览器完成发帖" width="800" />
</p>
<p align="center"><em>定时 Automation 自动搜集资讯、起草内容，并通过 Codey 内置的 Agent 控制浏览器完成发帖 —— 全程无人值守（2.5 倍速）。</em></p>

## 为什么用 Codey

- **不同任务用不同 Agent。** 每个对话都能选自己的 Agent、模型和思考强度，同一个项目里这边用 Claude Code、那边用 Codex 都没问题。
- **同一个 prompt 让多个 Agent 并行跑。** 直接把 Claude Code / Codex / OpenCode 的结果摆在一起对比，不用靠猜。
- **用 bot 团队代替单条 prompt。** 给每个 bot 配角色、性格、工具，可以按顺序执行、让 Advisor 挑选需要的成员，或者开圆桌讨论。
- **多入口，随时调用。** 桌面用 macOS 菜单栏应用，在手机上用聊天平台派活，免手输直接用语音粘到任何前台应用。
- **完全本地，自己掌控。** 跑在你自己机器上，连你自己的账号，中间没有代理服务器。

## 下载

从 [Releases 页面](https://github.com/its-ahoh/codey/releases/latest) 获取最新的 macOS 应用：

- `Codey-<version>-arm64.dmg`（仅支持 Apple Silicon）

发布版本已签名并通过公证，也会自动更新。

## 功能特性

**Agent 管理**
- **多种编码代理**：Claude Code、OpenCode、Codex、[pi](https://pi.dev)（支持会话恢复）
- **并行执行**：同一个 prompt 让多个 Agent 同时跑，方便对比
- **每个对话独立设置**：每个对话选自己的 Agent、模型和思考强度
- **思考强度**：一个 low → max 的统一档位，自动映射到各家 CLI 自己的推理参数
- **Advisor**：可选的路由模型，按任务把活派给 team 里合适的成员

**工作区与 Bot**
- **多工作区**：每个工作区对应自己的项目目录，并启用自己的 team
- **Bot团队**：所有 Bot 放在同一个共享库里，各自定义角色、个性和工具；执行使用聊天设置或 Default 的 Agent / 模型
- **流程图**：在画布上把一个 team 画成图，由裁判 LLM 按边上的自然语言条件决定下一步 —— 可以分支、回退返工，也可以停下来问你
- **记忆**：通过 Co-memo 管理用户记忆和项目记忆，每次运行前自动召回
- **对话上下文**：在会话中记忆之前的消息

**接入方式**
- **macOS 应用**：对话可按 Bot 或工作区查看；用快速捕获（Quick Capture）随时发任务
- **聊天平台**：Telegram、Discord、iMessage
- **语音 (macOS)**：按热键听写，直接粘进任何前台应用；也支持语音对话模式 —— 可选本地 WhisperKit（CoreML / Neural Engine）、OpenAI 兼容 API 或流式实时转写
- **健康检查端点**：内置健康检查和指标监控

**对话窗口内**
- **实时状态面板**：Agent 自己的 todo 列表和当前正在做的事，四家 CLI 统一呈现
- **文件改动**：整个对话里的所有修改，按文件分组，以 git 风格 diff 展示
- **Git 感知**：分支选择器、同步状态，以及可选的「每个对话一个 git worktree」隔离，多个对话并行也不会互相干扰
- **Quick Question**：只读的旁路提问线程，回答关于当前对话的问题但不影响它
- **`@` 提及**：引用文件、Skill、插件或 MCP 服务器；`@` 一个 bot 或 team 就把任务交给它，`@` 多个 bot 会临时组成一个 team
- **附件与主题**：粘贴或拖入图片和文件；可切换配色主题
- **图片和流程图**：Agent 输出的图片和 Mermaid 图会显示在 Mac 应用和聊天平台里

**技能、自动化与网页**
- **Skills 与 Playbooks**：Skill 装一次，所有 Agent 都能用；Codey 会观察运行实际做了什么，可以把重复的流程存成 playbook Skill
- **Automations 定时自动化**：给 Agent 排日程 —— 每日发帖、定期检查、cron 式工作流，都在 Mac 应用里管理
- **Agent 控制的内置浏览器**：Agent 可以打开、阅读、点击、填表 —— 默认只读，所有会改变状态的操作都需要你确认
- **外部 MCP 服务器**：在 Mac 应用的 **Tools → MCPs** 里给 Agent 接入更多工具
- **QR 扫码配对**：扫码即可把 Telegram / iMessage 连到你的 gateway

## 快速开始

需要 Node.js 24.12 及以上，并至少装好一个 Agent CLI。这是一个 monorepo，包含三个工作区：`@codey/core`、`@codey/gateway` 和 `codey-mac`。

```bash
# 安装依赖（所有工作区）
npm install

# 构建全部
npm run build

# 复制配置模板
cp gateway.json.example gateway.json

# 配置（可选）
npm run configure

# 启动网关
npm start
```

在开发模式下运行 macOS 应用：

```bash
npm run dev -w codey-mac        # 带热更新的开发模式
npm run build:mac -w codey-mac  # 在 codey-mac/release/ 生成 DMG
```

## 配置

编辑 `gateway.json`：

```json
{
  "gateway": { "port": 3000 },
  "channels": {
    "telegram": { "enabled": true },
    "discord": { "enabled": false },
    "imessage": { "enabled": false }
  },
  "agents": {
    "claude-code": { "enabled": true, "provider": "anthropic", "defaultModel": "claude-sonnet-4-20250514" },
    "opencode": { "enabled": true, "provider": "openai", "defaultModel": "gpt-4.1" },
    "pi": { "enabled": true, "provider": "anthropic", "defaultModel": "claude-sonnet-4-5" },
    "codex": { "enabled": true, "provider": "openai", "defaultModel": "gpt-5-codex" }
  },
  "advisor": { "agent": "claude-code", "model": "claude-haiku-4-5" },
  "dev": { "logLevel": "info" }
}
```

`advisor` 是可选项，用来设置 team 路由用的模型。

**密钥不要写进这个文件。** API key 和 bot token 请在 Mac 应用的 **设置 → Models & keys** 和 **设置 → Gateway** 里添加，它们保存在 `~/.codey/secrets.json`。如果 `gateway.json` 里还有密钥，Codey 加载时会自动移过去。也可以用环境变量：`TELEGRAM_BOT_TOKEN`、`DISCORD_BOT_TOKEN`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GOOGLE_API_KEY`。

## 工作区结构

```
bots/
└── architect/
    ├── personality.md       # 角色、性格、指令
    └── config.json          # 工具、显示名、路由提示
workspaces/
├── default/
│   └── workspace.json       # 项目目录 + 启用的 team
└── project-a/
    └── workspace.json
```

用户记忆和项目记忆由 Co-memo 存储，与工作区文件分开管理。项目记忆以项目目录路径区分。

每个工作区通过 `workspace.json` 关联到一个项目目录：

```json
{
  "workingDir": "/path/to/project",
  "teams": ["reviewers"]
}
```

`teams` 列出这个工作区能用共享库里的哪些 team。切换工作区（`/workspace myproject`）会自动设置 Agent 的工作目录。

## Bot配置

每个 Bot 是共享 `bots/` 库里的一个文件夹。`personality.md` 写它的性格：

```markdown
## Role
负责项目规划的首席架构师...

## Soul
战略思维者，专注于可扩展性...

## Instructions
收到提示时，分析需求并提供...
```

`config.json` 写它的设置。Bot 运行时使用所在对话的 Agent 和模型。

```json
{
  "displayName": "Architect",
  "tools": ["file-system", "git", "web-search"],
  "dispatchHint": "负责架构规划，并拆解大型功能"
}
```

## 命令

### Bot
| 命令 | 描述 |
|------|------|
| `/bots` | 列出库里的所有 Bot |
| `/bot <名称> <任务>` | 运行指定的 Bot |
| `/teams` | 列出这个工作区的 team |
| `/team <名称> [--all] <任务>` | 运行指定的 team（详见下方） |
| `/skill <名称> <任务>` | 用指定的 Skill 执行任务 |

**Team dispatch 说明：**

- `/team <name> [--all] <task>` — 运行指定的 team，成员按顺序串行执行，输出会作为下一个成员的输入。
  - 默认 `dispatch: 'sequential'`（所有成员按顺序参与）。
  - 配置为 `dispatch: 'auto'` 的 team 会先调用内置 Advisor，自动选择本次任务真正需要的成员。临时跳过 Advisor 可以加 `--all` 标志。
  - 在 bot 的 `config.json` 里加可选的 `dispatchHint` 字段（一句话）可以提升路由准确性。
  - Advisor 用的 agent/model 在 `gateway.json` 的 `advisor.{agent, model}` 字段配置，未配置时回退到 gateway 默认 agent/model。
  - 配置为 `dispatch: 'roundtable'` 的 team 会以 **Advisor 主持的圆桌** 方式运行：所有 bot 作为长驻会话并发执行，
    在 `chats/<chatId>/discussion/` 下共享各自的意见文件；Advisor 循环评估进展、维护共享摘要，并决定何时问你、
    何时继续、何时结束。可选参数在 `roundtable: { maxDurationMs, idleTimeoutMs, advisorPollMs }`。
    参见[设计文档](docs/superpowers/specs/2026-05-24-team-parallel-mode-design.md)。
  - 串行 team 还可以带一张**流程图** —— `graph: { entry, maxHops, nodes, edges }`。
    节点是 bot（外加 `start` / `end`），每条边上写一句自然语言条件。每个 bot 跑完后，
    由裁判 LLM（复用 Advisor 的 agent/model）按条件挑下一条边，因此流程可以分支，也可以回退到更早的 bot 返工，
    直到走到 `end` 或达到 `maxHops` 上限。bot 可以用 `[ASK_USER]` 暂停流程，你回复后会从暂停处继续。
    流程图可以在 Mac 应用的拖拽画布里直接画。

### 工作区
| 命令 | 描述 |
|------|------|
| `/workspaces` | 列出所有工作区 |
| `/workspace <名称>` | 切换到指定工作区 |

### 代理
| 命令 | 描述 |
|------|------|
| `/parallel <提示>` | 并行运行所有 Agent（旧命令） |
| `/all <提示>` | 同 `/parallel`（旧命令） |
| `/agent <名称>` | 切换默认代理 |

### 设置
| 命令 | 描述 |
|------|------|
| `/help` | 显示帮助信息 |
| `/status` | 显示网关状态 |
| `/clear` | 清除对话历史 |
| `/reset` | 开始新对话 |
| `/model [名称]` | 显示/设置模型 |
| `/effort <级别>` | 设置思考强度（low/medium/high/xhigh/max） |
| `/cwd [路径]` | 显示/设置工作目录 |
| `/config` | 显示当前配置 |
| `/memory` | 列出最近的记忆（`/memory search <关键词>` 可搜索） |
| `/remember <内容>` | 保存一条记忆 |

## 使用示例

```bash
# 切换工作区
/workspace myproject

# 列出 Bot
/bots

# 运行 Bot
/bot architect design a REST API

# 运行团队任务
/team builders build a todo app

# 并行运行所有代理
/parallel create a hello world app
```

## 语音输入 (macOS)

全局语音听写。按一下热键（默认 `Fn`）开始说话，再按一下结束，Codey 会转录并把结果直接粘贴到当前焦点输入框 — 不管你在哪个 app 都行。另一个热键（默认 `Shift+Fn`）可以和当前对话语音交谈。

**两种转录后端：**
- **本地 (WhisperKit)** — 在 CoreML / Neural Engine 上运行。模型首次使用时从 HuggingFace 拉取，默认为 `large-v3-turbo` 量化版（~954 MB）。完全离线、无需 API key。30 秒空闲后自动卸载模型，避免常驻 RAM / ANE
- **API** — 任何 OpenAI 兼容的 `/audio/transcriptions` 端点，配置 `apiUrl` / `apiKey` / `apiModel` 即可（如 `whisper-1`、`gpt-4o-transcribe`）

**HUD 浮窗：**
- **录音中**：浮动胶囊带 5 根实时音频条，能看到麦克风是否在拾音
- **转写中**：spinner + "Transcribing…"
- **已注入**：绿色 ✓，自动消失
- **没有可粘贴的焦点**：完整识别文本展示在更宽的卡片里，自动复制到剪贴板，点击关闭

**操作：**
- **热键**（默认 `Fn`）— 切换录音开关。可配置为 F 键或修饰键组合（如 `Cmd+Shift+V`）
- **录音中按 Esc** — 取消本次录音，buffer 直接丢弃，不转写

所有配置都在 macOS 应用的 **设置 → Voice**：切换 provider、换模型、下载 / 预热 / 删除 WhisperKit 变体、改热键或注入方式（paste 或 Accessibility API）。

需要麦克风和辅助功能权限（首次启动会提示）。

## 健康检查端点

网关在 `port + 1` 端口暴露健康检查端点：

- `GET /health` - 完整状态 JSON
- `GET /metrics` - Prometheus 风格指标
- `GET /ready` - 就绪检查

## CLI 命令

```bash
npm run configure              # 交互式配置
npm run status                 # 显示配置
npm run set-agent claude-code  # 设置默认编码代理
npm run set-model              # 设置默认模型
npm run tui                    # 启动终端 UI
npm run build                  # 构建所有工作区
```

其他配置请在 macOS 应用的设置里调整，或编辑 `gateway.json`。密钥请放在设置里，不要写进这个文件。

## 项目结构

```
packages/
├── core/                # 共享类型、Agent、工作区与 Bot 管理器
│   └── src/
│       └── agents/      # 编码 Agent 适配器（claude-code、opencode、codex、pi）
└── gateway/             # 网关服务与渠道
    └── src/
        ├── channels/    # 聊天平台处理器（telegram、discord、imessage）
        ├── config.ts
        ├── gateway.ts
        ├── health.ts
        ├── logger.ts
        └── index.ts
codey-mac/               # macOS 应用（Electron + React）
├── electron/            # 主进程与 preload
└── src/                 # 渲染进程（React UI）
voice/                   # 原生 Swift helper（热键 + 录音 + WhisperKit）
└── Sources/CodeyVoice/  # AudioCapture、HotkeyManager、HudOverlay、WhisperKitEngine 等
bots/                    # 共享 Bot 库
workspaces/              # 各工作区的配置
```

## Co-memo 共享记忆

Codey 通过本地 MCP stdio 使用官方的 `co-memo` 0.8.3 包，gateway 需要 Node.js 24.12 及以上。用户记忆跨项目共享；项目记忆按对话的工作目录区分，包括它所在的 worktree。没有项目的对话只会收到个人记忆。Bot 没有私有记忆。

记忆可以在 **设置 → Memory** 和工作区的记忆面板里管理。运行前 gateway 会召回相关记忆，要保存什么由 Agent 自己决定，没有后台抽取器。Codey 自己创建的 worktree 会一次性复制主目录的项目记忆，之后两边互不同步。

## 常见问题

**Codey 是要替代 Claude Code / Codex / OpenCode 吗？**
不是，它是来驱动它们的。Codey 调用你本机已经装好、已经登录的 Agent CLI，在它们之上补一层：workspace、bot 团队、并行对比、定时任务和远程访问。

**必须要 API key 吗？**
用到才需要。如果你的 Agent CLI 已经登录（比如 Claude 订阅），Codey 直接沿用。设置里的 API key 只用于你想直连的 Agent / 模型，以及云端语音转写。

**我的代码会被上传吗？**
Codey 本身完全本地 —— gateway、macOS 应用、语音 helper 都跑在你自己机器上。代码只会去它本来就会去的地方（你选的那个 Agent CLI），不会多走一步。用本地 WhisperKit 时语音也不出本机。

**支持哪些平台？**
gateway 是 Node.js，Node 能跑的地方都能跑；桌面应用和语音输入目前仅限 macOS。

**能在手机上用吗？**
可以 —— 接上 Telegram、Discord 或 iMessage（扫码配对即可），在任何地方对同一批 workspace 发任务。

**这和开一堆终端窗口有什么区别？**
跨 Agent 共享的 workspace 与记忆、用 team 和流程图代替一次性 prompt、每个对话独立 git worktree 避免并行冲突、可定时的自动化，以及一个能同时看到所有运行状态、diff 和 todo 的界面。

## 许可证

[MIT](LICENSE)

<p align="center">
  <img src="assets/logo.png" alt="Codey Logo" width="300" />
</p>

# Codey 🚀

[English](README.md) | [中文](README.zh-CN.md)

**面向编码 Agent 的多 Agent 工作台。** Codey 把 Claude Code、OpenCode、Codex 等编码 Agent 统一管起来：给每个项目独立的 workspace，按角色为 worker 配不同的 Agent / 模型，在同一个任务上并行跑多个 Agent 做对比；从原生 macOS 应用、聊天平台（Telegram / Discord / iMessage）或者全局语音输入都能用。

与其说它是"聊天平台到 Agent 的桥"，不如说它是**你已经在用的那些编码 Agent 的控制台**。

## 为什么用 Codey

- **一个项目里，不同任务用不同 Agent。** 每个 workspace 有默认 Agent / 模型，每个 worker 还能单独覆盖 —— Architect 用 Opus、Executor 用 Codex、Reviewer 用本地 OpenCode，都没问题。
- **同一个 prompt 让多个 Agent 并行跑。** 直接把 Claude Code / Codex / OpenCode 的结果摆在一起对比，不用靠猜。
- **用 worker 团队代替单条 prompt。** 给每个 worker 配角色、性格、工具，按顺序执行，或者让 dispatcher 自动挑选真正相关的子集。
- **多入口，随时调用。** 桌面用 macOS 菜单栏应用，在手机上用聊天平台派活，免手输直接用语音粘到任何前台应用。
- **完全本地，自己掌控。** 跑在你自己机器上，连你自己的账号，中间没有代理服务器。

## 下载

从 [Releases 页面](https://github.com/its-ahoh/codey/releases/latest) 获取最新的 macOS 应用：

- Apple Silicon：`Codey-<version>-arm64.dmg`
- Intel：`Codey-<version>.dmg`

当前发布版本未签名 — 首次启动时请右键点击应用 → **打开** → 确认以绕过 Gatekeeper。

## 功能特性

**Agent 管理**
- **多种编码代理**：Claude Code、OpenCode、Codex（支持会话恢复）
- **并行执行**：同一个 prompt 让多个 Agent 同时跑，方便对比
- **每个 workspace 独立默认**：每个项目挑自己的默认 Agent + 模型
- **自动 Dispatcher**：内置 dispatcher 可选，按任务自动路由到 team 的相关子集

**工作区与 Worker**
- **多工作区**：每个工作区拥有独立的工作目录、记忆与工作者
- **工作者团队**：每个 worker 可定义角色、个性、工具，以及自己的 Agent / 模型
- **对话上下文**：在会话中记忆之前的消息

**接入方式**
- **macOS 菜单栏应用**：多对话标签、工作区切换器、内嵌设置面板
- **聊天平台**：Telegram、Discord、iMessage
- **语音输入 (macOS)**：热键触发的语音转录，支持本地 WhisperKit（CoreML / Neural Engine）和 OpenAI 兼容 API — 识别结果直接粘贴到当前光标所在的输入框
- **健康检查端点**：内置健康检查和指标监控

## 快速开始

这是一个 monorepo，包含三个工作区：`@codey/core`、`@codey/gateway` 和 `codey-mac`。

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
  "gateway": {
    "port": 3000,
    "defaultAgent": "claude-code",
    "defaultModel": "claude-sonnet-4-20250514"
  },
  "channels": {
    "telegram": { "enabled": true, "botToken": "YOUR_TOKEN" },
    "discord": { "enabled": false, "botToken": "" },
    "imessage": { "enabled": false }
  },
  "agents": {
    "claude-code": { "enabled": true, "provider": "anthropic", "defaultModel": "claude-sonnet-4-20250514" },
    "opencode": { "enabled": true, "provider": "openai", "defaultModel": "gpt-4.1" },
    "codex": { "enabled": true, "provider": "openai", "defaultModel": "gpt-5-codex" }
  },
  "profiles": [
    {
      "name": "default",
      "anthropic": { "apiKey": "sk-..." },
      "openai": { "apiKey": "sk-..." }
    }
  ],
  "activeProfile": "default",
  "dev": {
    "logLevel": "info"
  }
}
```

Auto-dispatch 设置：`dispatcher.{agent, model}`（可选）。

## 工作区结构

```
workspaces/
├── default/
│   ├── workspace.json       # 工作区配置（workingDir + 工作者）
│   ├── memory.md            # 项目记忆/笔记
│   └── workers/
│       ├── architect.md
│       └── executor.md
├── project-a/
│   ├── workspace.json
│   ├── memory.md
│   └── workers/
│       └── ...
└── project-b/
    ├── workspace.json
    ├── memory.md
    └── workers/
        └── ...
```

每个工作区通过 `workspace.json` 关联到一个项目目录：

```json
{
  "workingDir": "/path/to/project",
  "workers": {
    "architect": {
      "codingAgent": "claude-code",
      "model": "claude-opus-4-6",
      "tools": ["file-system", "git", "web-search"]
    }
  }
}
```

切换工作区（`/workspace myproject`）会自动设置代理的工作目录。

## 工作者配置

每个工作者在一个 Markdown 文件中定义：

```markdown
# Worker: Architect

## Role
负责项目规划的首席架构师...

## Soul
战略思维者，专注于可扩展性...

## Coding Agent
claude-code

## Model
claude-opus-4-20250514

## Tools
file-system, git, web-search

## Relationship
领导实现工作者

## Instructions
收到提示时，分析需求并提供...
```

## 命令

### 工作者
| 命令 | 描述 |
|------|------|
| `/workers` | 列出当前工作区的所有工作者 |
| `/worker <名称> <任务>` | 运行指定的工作者 |
| `/team <名称> [--all] <任务>` | 运行指定的 team（详见下方） |

**Team dispatch 说明：**

- `/team <name> [--all] <task>` — 运行指定的 team，成员按顺序串行执行，输出会作为下一个成员的输入。
  - 默认 `dispatch: 'all'`（所有成员参与）。
  - 配置为 `dispatch: 'auto'` 的 team 会先调用内置 dispatcher，自动选择本次任务真正需要的成员子集。临时跳过 dispatcher 可以加 `--all` 标志。
  - 在 worker 的 `config.json` 里加可选的 `dispatchHint` 字段（一句话）可以提升路由准确性。
  - Dispatcher 用的 agent/model 在 `gateway.json` 的 `dispatcher.{agent, model}` 字段配置，未配置时回退到 gateway 默认 agent/model。

### 工作区
| 命令 | 描述 |
|------|------|
| `/workspaces` | 列出所有工作区 |
| `/workspace <名称>` | 切换到指定工作区 |

### 代理
| 命令 | 描述 |
|------|------|
| `/parallel <提示>` | 并行运行所有代理 |
| `/all <提示>` | 并行运行所有代理 |
| `/agent <名称>` | 切换默认代理 |

### 设置
| 命令 | 描述 |
|------|------|
| `/help` | 显示帮助信息 |
| `/status` | 显示网关状态 |
| `/clear` | 清除对话历史 |
| `/reset` | 开始新对话 |
| `/model <名称>` | 显示/设置模型 |

## 使用示例

```bash
# 切换工作区
/workspace myproject

# 列出工作者
/workers

# 运行工作者
/worker architect design a REST API

# 运行团队任务
/team build a todo app

# 并行运行所有代理
/parallel create a hello world app
```

## 语音输入 (macOS)

全局按键语音听写。按住配置的热键（默认 `Fn`）说话，松开后 Codey 转录并把结果直接粘贴到当前焦点输入框 — 不管你在哪个 app 都行。

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

所有配置都在 macOS 应用的 **Whisper** 标签页：切换 provider、换模型、下载 / 预热 / 删除 WhisperKit 变体、改热键或注入方式（paste 或 Accessibility API）。

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

其他配置（渠道、Profile、API Key）请直接编辑 `gateway.json` 或在 macOS 应用的设置面板中调整。

## 项目结构

```
packages/
├── core/                # 共享类型、工作区与工作者管理器
│   └── src/
└── gateway/             # 网关服务、渠道、代理
    └── src/
        ├── agents/      # 编码代理适配器（claude-code、opencode、codex）
        ├── channels/    # 聊天平台处理器（telegram、discord、imessage）
        ├── config.ts
        ├── conversation.ts
        ├── gateway.ts
        ├── health.ts
        ├── logger.ts
        └── index.ts
codey-mac/               # macOS 菜单栏应用（Electron + React）
├── electron/            # 主进程与 preload
└── src/                 # 渲染进程（React UI）
voice/                   # 原生 Swift helper（热键 + 录音 + WhisperKit）
└── Sources/CodeyVoice/  # AudioCapture、HotkeyManager、HudOverlay、WhisperKitEngine 等
workspaces/              # 各工作区的配置、记忆与工作者
```

## 许可证

[MIT](LICENSE)

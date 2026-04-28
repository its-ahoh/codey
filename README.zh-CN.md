<p align="center">
  <img src="assets/logo.png" alt="Codey Logo" width="300" />
</p>

# Codey 🚀

[English](README.md) | [中文](README.zh-CN.md)

一个本地网关，将聊天平台（Telegram、Discord、iMessage）的提示路由到编码代理，支持多工作区和工作者团队。附带原生 macOS 菜单栏应用，可在本地管理对话、工作区与代理。

## 下载

从 [Releases 页面](https://github.com/its-ahoh/codey/releases/latest) 获取最新的 macOS 应用：

- Apple Silicon：`Codey-<version>-arm64.dmg`
- Intel：`Codey-<version>.dmg`

当前发布版本未签名 — 首次启动时请右键点击应用 → **打开** → 确认以绕过 Gatekeeper。

## 功能特性

- **macOS 菜单栏应用**：多对话标签、工作区切换器、内嵌设置面板
- **多渠道支持**：Telegram、Discord、iMessage
- **多种编码代理**：Claude Code、OpenCode、Codex（支持会话恢复)
- **多工作区**：每个工作区拥有独立的工作目录、记忆与工作者
- **工作者团队**：定义具有角色、个性和关系的工作者
- **并行执行**：同时运行多个代理或工作者
- **对话上下文**：在会话中记忆之前的消息
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
| `/team <任务>` | 按顺序运行工作者 |

### 工作区
| 命令 | 描述 |
|------|------|
| `/workspaces` | 列出所有工作区 |
| `/workspace <名称>` | 切换到指定工作区 |

### 代理（旧版）
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
workspaces/              # 各工作区的配置、记忆与工作者
```

## 许可证

[MIT](LICENSE)

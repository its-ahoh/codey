<p align="center">
  <img src="assets/logo.png" alt="Codey Logo" width="300" />
</p>

# Codey

[English](README.md) | [中文](README.zh-CN.md)

管理你的 AI coding 工具，在一个地方。

## 为什么做这个

现在有越来越多的 AI coding agent — Claude Code、OpenCode、Codex……每个都很好用，但用起来有点折腾：

- 要在 UI 和命令行之间来回切换，配置散落在各处
- 我主力用 Claude Pro，一天的额度很快就用完了。想换个工具继续，得把整段对话搬过去，非常麻烦
- 想在手机上也能操作（比如出门时用 Telegram 继续推进），但每个 agent 的接入方式都不一样

所以我做了 Codey：一个本地运行的管理网关，把这些 coding agent 统一接到几个聊天平台上。从 Telegram、Discord 或者 macOS 菜单栏 app 里发消息，Codey 会自动路由到你选的 agent，同时管理对话上下文、项目工作区和 worker 团队。

## 它能做什么

**多渠道接入**
- Telegram、Discord、iMessage，加上自带的 macOS 菜单栏 app 和终端 TUI
- 不用打开 IDE 也能操作 coding agent，手机上也可以

**多 agent 管理**
- 支持 Claude Code、OpenCode、Codex
- 可以随时切换，不用重新配置
- 一个 agent 额度用完了，换另一个继续，对话上下文还在

**工作区系统**
- 每个工作区对应一个项目目录，有自己的配置、记忆和 worker
- 用 `/workspace myproject` 切换，agent 的工作目录自动跟着变

**Worker 团队**
- 用 Markdown 文件定义 worker 的角色、个性和工具
- 可以单个运行（`/worker architect 设计一个 REST API`），也可以组成团队按顺序执行（`/team 搭建一个 todo app`）

**macOS 菜单栏应用**
- 多对话标签、工作区切换、内嵌设置
- 不用开终端也能管理

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/its-ahoh/codey.git
cd codey

# 安装依赖
npm install

# 构建
npm run build

# 复制配置模板并编辑
cp gateway.json.example gateway.json
# 在 gateway.json 里填入你的 API key 和 bot token

# 启动
npm start
```

或者直接下载 macOS 应用：[Releases 页面](https://github.com/its-ahoh/codey/releases/latest)

> 当前版本未签名 — 首次启动请右键点击应用 → **打开** → 确认。

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
    "claude-code": { "enabled": true, "provider": "anthropic" },
    "opencode": { "enabled": true, "provider": "openai" },
    "codex": { "enabled": true, "provider": "openai" }
  }
}
```

完整配置示例见 [`gateway.json.example`](gateway.json.example)。

## 命令

| 命令 | 说明 |
|------|------|
| `/workspace <名称>` | 切换工作区 |
| `/workspaces` | 列出所有工作区 |
| `/worker <名称> <任务>` | 运行指定 worker |
| `/team <任务>` | 按顺序运行 worker 团队 |
| `/workers` | 列出当前工作区的 worker |
| `/agent <名称>` | 切换 coding agent |
| `/model <名称>` | 切换模型 |
| `/clear` | 清除对话历史 |
| `/status` | 查看网关状态 |

## 工作区结构

```
workspaces/
├── default/
│   ├── workspace.json       # 工作目录 + worker 配置
│   ├── memory.md            # 项目记忆
│   └── workers/
│       └── architect.md
└── myproject/
    ├── workspace.json
    ├── memory.md
    └── workers/
        └── ...
```

Worker 用 Markdown 定义：

```markdown
# Worker: Architect

## Role
负责项目规划的首席架构师

## Soul
战略思维者，关注可扩展性

## Coding Agent
claude-code

## Model
claude-opus-4-20250514

## Tools
file-system, git, web-search
```

## 项目结构

```
packages/
├── core/          # 共享类型、工作区和 worker 管理
└── gateway/       # 网关服务、channels、agent 适配器
codey-mac/         # macOS 菜单栏应用 (Electron + React)
workspaces/        # 工作区配置和 worker 定义
```

## 参与贡献

Codey 还在早期阶段，很多地方不够完善。如果你觉得这个方向有意思，非常欢迎：

- 提 issue 说说你的想法或遇到的问题
- 提 PR 一起改进
- 在 Discussions 里聊聊你希望支持哪些 agent 或功能

## 许可证

[MIT](LICENSE)

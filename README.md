# Coding Gateway ⌘

A local gateway application that routes prompts from multiple chat platforms (Telegram, Discord, iMessage) to coding agents (Claude Code, OpenCode, Codex) and forwards responses back to users.

## Features

- **Multi-channel support**: Telegram, Discord, iMessage
- **Multiple coding agents**: Claude Code, OpenCode, Codex
- **Agent selection**: Users can switch agents with `/agent <name>` command
- **TypeScript**: Full type safety
- **Easy configuration**: Environment variables

## Prerequisites

- Node.js 18+
- [Claude Code](https://claude.com/claude-code) installed (optional, for claude-code agent)
- [OpenCode](https://github.com/antfu/opencode) installed (optional)
- [OpenAI Codex](https://openai.com/codex) CLI installed (optional)

### For Telegram
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### For Discord
- A Discord Bot Token from [Discord Developer Portal](https://discord.com/developers/applications)

### For iMessage
- macOS (for AppleScript-based sending)

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd coding-gateway

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

## Configuration

Edit `.env` with your settings:

```env
PORT=3000
DEFAULT_AGENT=claude-code

# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_token

# Discord  
DISCORD_BOT_TOKEN=your_discord_token

# iMessage (macOS only)
IMESSAGE_ENABLED=false

# Claude Code (if needed)
ANTHROPIC_API_KEY=your_api_key
```

## Usage

```bash
# Build the project
npm run build

# Run the gateway
npm start

# Or run in development mode
npm run dev
```

## Commands

- `/agent claude-code` - Switch to Claude Code
- `/agent opencode` - Switch to OpenCode  
- `/agent codex` - Switch to Codex
- Any other text is treated as a prompt for the coding agent

## Example

```
User: /agent claude-code
User: Create a simple hello world function in Python

Gateway: Thinking...
Gateway: Here's a simple Hello World function in Python:

def hello_world():
    print("Hello, World!")
    return "Hello, World!"

if __name__ == "__main__":
    hello_world()
```

## Project Structure

```
src/
├── agents/          # Coding agent adapters
│   ├── base.ts
│   ├── claude-code.ts
│   ├── opencode.ts
│   └── codex.ts
├── channels/        # Chat platform handlers
│   ├── base.ts
│   ├── telegram.ts
│   ├── discord.ts
│   └── imessage.ts
├── types/          # TypeScript definitions
│   └── index.ts
├── gateway.ts      # Main gateway logic
└── index.ts        # Entry point
```

## License

ISC

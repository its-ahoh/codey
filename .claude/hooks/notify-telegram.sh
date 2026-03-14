#!/usr/bin/env bash
# Claude Code hook script: Send Telegram notification when Claude stops and
# waits for user input (i.e. long-running work is done).
#
# Setup:
#   1. Create a Telegram bot via @BotFather and copy the token.
#   2. Send a message to the bot, then get your chat ID from:
#      https://api.telegram.org/bot<TOKEN>/getUpdates
#   3. Either configure the Telegram bot token in gateway.json:
#        "channels": { "telegram": { "botToken": "123456:ABC-DEF..." } }
#      or set environment variables (e.g. in ~/.zshrc):
#        export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
#        export TELEGRAM_CHAT_ID="123456789"
#   4. chmod +x notify-telegram.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATEWAY_CONFIG="${PROJECT_ROOT}/gateway.json"

TELEGRAM_BOT_TOKEN_FROM_CFG=""
TELEGRAM_CHAT_ID_FROM_CFG=""
if [[ -f "${GATEWAY_CONFIG}" ]] && command -v jq &>/dev/null; then
  TELEGRAM_ENABLED="$(jq -r '.channels.telegram.enabled // empty' "${GATEWAY_CONFIG}" 2>/dev/null || echo "")"
  if [[ "${TELEGRAM_ENABLED}" == "false" ]]; then
    exit 0
  fi
  TELEGRAM_BOT_TOKEN_FROM_CFG="$(jq -r '.channels.telegram.botToken // empty' "${GATEWAY_CONFIG}" 2>/dev/null || echo "")"
  TELEGRAM_CHAT_ID_FROM_CFG="$(jq -r '.channels.telegram.notifyChatId // empty' "${GATEWAY_CONFIG}" 2>/dev/null || echo "")"
fi

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$TELEGRAM_BOT_TOKEN_FROM_CFG}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$TELEGRAM_CHAT_ID_FROM_CFG}"

if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN is not set and channels.telegram.botToken is missing from ${GATEWAY_CONFIG}" >&2
  exit 1
fi

if [[ -z "${TELEGRAM_CHAT_ID}" ]]; then
  echo "Error: TELEGRAM_CHAT_ID is not set and channels.telegram.notifyChatId is missing from ${GATEWAY_CONFIG}" >&2
  exit 1
fi

# Read hook JSON payload from stdin
INPUT=$(cat)

if command -v jq &>/dev/null; then
  STOP_REASON=$(echo "$INPUT" | jq -r '.stop_hook_reason // "completed"' 2>/dev/null || echo "completed")
  CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"' 2>/dev/null || echo "unknown")
  LAST_MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null || echo "")
else
  STOP_REASON="completed"
  CWD="unknown"
  LAST_MESSAGE=""
fi

# Truncate output to fit Telegram's 4096 char limit (leave room for header)
MAX_OUTPUT_LEN=3500
if [[ ${#LAST_MESSAGE} -gt $MAX_OUTPUT_LEN ]]; then
  LAST_MESSAGE="${LAST_MESSAGE:0:$MAX_OUTPUT_LEN}..."
fi

MESSAGE="🤖 *Claude Code finished*
📁 \`${CWD}\`
🔚 Reason: ${STOP_REASON}"

if [[ -n "${LAST_MESSAGE}" ]]; then
  MESSAGE="${MESSAGE}

💬 *Output:*
${LAST_MESSAGE}"
fi

curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  -d parse_mode="Markdown" \
  --data-urlencode text="$MESSAGE" \
  >/dev/null 2>&1

exit 0

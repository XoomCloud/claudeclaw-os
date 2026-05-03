#!/bin/bash
# Send a status message mid-task via the configured messenger.
# Usage: notify.sh "message text"
# Reads MESSENGER_TYPE from .env and dispatches to Telegram or Discord.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "notify.sh: .env not found at $ENV_FILE" >&2
  exit 1
fi

read_env() {
  grep -E "^${1}=" "$ENV_FILE" | head -n1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

MESSENGER=$(read_env MESSENGER_TYPE)
MESSENGER=${MESSENGER:-telegram}

case "$MESSENGER" in
  discord)
    TOKEN=$(read_env DISCORD_BOT_TOKEN)
    # Prefer a server channel; fall back to DM via the user's snowflake.
    CHANNEL=$(read_env DISCORD_ALLOWED_CHANNEL_ID)
    USER_ID=$(read_env DISCORD_ALLOWED_USER_ID)

    if [ -z "$TOKEN" ]; then
      echo "notify.sh: DISCORD_BOT_TOKEN not set in .env" >&2
      exit 1
    fi

    if [ -z "$CHANNEL" ] && [ -z "$USER_ID" ]; then
      echo "notify.sh: set DISCORD_ALLOWED_CHANNEL_ID or DISCORD_ALLOWED_USER_ID in .env" >&2
      exit 1
    fi

    # If only USER_ID is set, open a DM channel first.
    if [ -z "$CHANNEL" ]; then
      CHANNEL=$(curl -s -X POST "https://discord.com/api/v10/users/@me/channels" \
        -H "Authorization: Bot ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"recipient_id\":\"${USER_ID}\"}" \
        | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p' | head -n1)
      if [ -z "$CHANNEL" ]; then
        echo "notify.sh: could not open DM channel for user ${USER_ID}" >&2
        exit 1
      fi
    fi

    curl -s -X POST "https://discord.com/api/v10/channels/${CHANNEL}/messages" \
      -H "Authorization: Bot ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary @- <<EOF > /dev/null
{"content": $(printf '%s' "${1}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}
EOF
    ;;

  telegram|*)
    TOKEN=$(read_env TELEGRAM_BOT_TOKEN)
    CHAT_ID=$(read_env ALLOWED_CHAT_ID)

    if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
      echo "notify.sh: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env" >&2
      exit 1
    fi

    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d chat_id="${CHAT_ID}" \
      -d text="${1}" \
      -d parse_mode="HTML" > /dev/null
    ;;
esac

# Personal context for [DISPLAY_NAME]

This file overrides the agent-level `CLAUDE.md` when this user is the
active human. The SDK loads it via `settingSources: ['project']` from
`users/<chat_id>/CLAUDE.md` whenever a message comes from this chat.

Keep this short and high-signal — anything you wouldn't tell a new
coworker on day one probably doesn't belong here.

## Who you are

I'm [DISPLAY_NAME]. Telegram chat id: [CHAT_ID].

(Replace with a one-line bio: what you do, where you're based, what
you'd typically use this assistant for.)

## How I like to work

- (your preferences — terse vs. verbose, formal vs. casual, where you
  push back, what you delegate)

## Active projects

- (the 2–3 things you actively want the assistant to keep track of)

## Things I never want done without asking

- (any guardrails specific to you — destructive ops, money moves,
  sending messages to specific people, etc.)

## Notes for the assistant

- You can pin important memories with `/pin <id>`.
- Use `/whoami` to see what you can do.
- Use `/setpin <new>` to set a PIN; `/lock` locks your session.

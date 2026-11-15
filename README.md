# wye
Live multiplayer splitter for Antigravity and Claude Code conversations.

## Why
Pair programming with an AI agent usually means screensharing or copy-pasting prompts back and forth. `wye` lets a partner join your active session directly from a browser or terminal so you can both read the stream and send prompts in real time.

## How

* Auto-detects the active **Antigravity** (Desktop or `agy` CLI) or **Claude Code** (Desktop or `claude` CLI) session.
* Tails the local conversation transcript and injects partner prompts directly into your live session.
* Zero dependencies; built on Node.js native `fetch`, `WebSocket`, and `node:crypto`.
* End-to-end encrypted (`AES-GCM` using a key in the `#<key>` URL fragment, which is never sent to the relay).

## Quickstart (Antigravity)
Paste this into an Antigravity conversation to have your agent install the skill and start sharing:

> Install `wye` from `https://github.com/jessetane/wye` (`npm i -g github:jessetane/wye`), save its `SKILL.md` to `~/.gemini/config/skills/wye/SKILL.md`, and start sharing this conversation.

*(Requires [Node.js](https://nodejs.org/). Once installed, you only need to ask Antigravity to "share this conversation" in future sessions.)*

### Manual install
```sh
npm i -g github:jessetane/wye
mkdir -p ~/.gemini/config/skills/wye
curl -fsSL https://raw.githubusercontent.com/jessetane/wye/main/SKILL.md -o ~/.gemini/config/skills/wye/SKILL.md
```

For Claude Code, link or copy `SKILL.md` to `~/.claude/skills/wye/SKILL.md` instead.

## Usage
When `wye host` is launched from inside Antigravity or Claude Code, it prints a `web:` URL (open in any browser) and a `join:` CLI command:

```sh
wye host [--relay wss://wye.jessetane.com] [--harness antigravity|claude] [--room <token>]
wye join <url-or-room#key> [--name <user>]
wye status
wye stop [<room-or-conversation-id>]
```

### Self-hosting the relay
```sh
wye relay [--port 8787] [--bind 0.0.0.0]
```

## Security
Sessions are end-to-end encrypted between host and guests, and the relay never sees the `#<key>` fragment. However, anyone you share the link with can submit prompts directly to your live agent—with whatever filesystem, shell, and tool permissions your session has. Only share links with people you trust.

# wye
Live multiplayer splitter for Antigravity and Claude Code conversations.

## Why
Pair programming with an AI agent usually means screensharing or copy-pasting prompts back and forth. `wye` lets a partner join your active session directly from a browser or terminal so you can both read the stream and send prompts in real time.

## How

* Runs inside an active **Antigravity** or **Claude Code** session, using the injected environment (`ANTIGRAVITY_*` env vars + local language server RPC for Antigravity; `CLAUDE_CODE_MESSAGING_SOCKET` + session files for Claude Code) to locate the transcript and inject prompts.
* Zero dependencies; built on Web Platform `fetch`, `WebSocket`, `EventTarget`, and `crypto.subtle`.
* End-to-end encrypted (`AES-GCM` using a key in the `#<key>` URL fragment, which is never sent to the relay).

## Install
Install `wye` and link `SKILL.md` into `~/.gemini/config/skills/wye` (Antigravity) or `~/.claude/skills/wye` (Claude Code):

```sh
npm i -g github:jessetane/wye
mkdir -p <skills-dir>
ln -sf "$(npm root -g)/wye/SKILL.md" <skills-dir>/SKILL.md
```

## Usage
To share a conversation, ask the agent inside that conversation to share it (e.g. *"share this conversation"*). The skill instructs the agent to run `wye host` in the background and reply with a `web:` URL (open in any browser) and a `join:` CLI command:

```sh
wye host [--relay wss://wye.jessetane.com] [--harness antigravity|claude] [--room <token>]
wye join <url-or-room#key> [--name <user>]
wye status
wye stop [<room-or-conversation-id>]
```

In guest views, `Ctrl+O` toggles full thinking and tool output. Tool approval prompts stay on the host; if a turn stalls waiting on approval or a slow command, guests can unstick it with `Stop` (web) or `/stop` / `Ctrl+C` (CLI).

### Relay
By default, `wye` connects to the public relay at `wss://wye.jessetane.com`. To self-host a relay and point clients at it via `--relay` or `WYE_RELAY`:

```sh
wye relay [--port 8787] [--bind 0.0.0.0]
```

## Security
Sessions are end-to-end encrypted between host and guests, and the relay never sees the `#<key>` fragment. However, anyone you share the link with can submit prompts directly to your live agent—with whatever filesystem, shell, and tool permissions your session has. Only share links with people you trust.

## License
MIT

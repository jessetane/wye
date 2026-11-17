# wye
Live multiplayer splitter for Antigravity and Claude Code conversations.

## Why
Collaborating with multiple humans and one agent usually means screensharing or copy-pasting prompts back and forth. `wye` lets others join your active session directly from a browser or terminal so everyone can read the stream and send prompts in real time.

## How

* Runs inside an active **Antigravity** or **Claude Code** session, using the injected environment (`ANTIGRAVITY_*` env vars + local language server RPC for Antigravity; `CLAUDE_CODE_MESSAGING_SOCKET` + session files for Claude Code) to locate the transcript and inject prompts.
* Built on Web Platform `fetch`, `WebSocket`, `EventTarget`, and `crypto.subtle` (plus `ws` for the relay server).
* End-to-end encrypted (`AES-GCM` using a key in the `#<key>` URL fragment, which is never sent to the relay).

## Install
Install `wye` and link `SKILL.md` into `~/.gemini/config/skills/wye` (Antigravity) or `~/.claude/skills/wye` (Claude Code):

```sh
npm i -g github:jessetane/wye
mkdir -p <skills-dir>
ln -sf "$(npm root -g)/wye/SKILL.md" <skills-dir>/SKILL.md
```

## Usage

* **Share (host):** Ask your agent to *"share this conversation"*. It runs `wye` in the background and gives you a link for guests.
* **Join (web):** Open the link in any browser.
* **Join (CLI):** Run `wye join '<url>' [--name <user>]`.
* **Stop (host):** Ask your agent to *"stop sharing"*, or stop the background task in your harness UI.

### Notes

* **Expand output:** Press `Ctrl+O` to toggle full thinking and tool output.
* **Tool approvals:** Permission prompts stay on the host. Guests can cancel a stalled turn with `Stop` (web) or `/stop` / `Ctrl+C` (CLI).
* **Plain prompts only:** Guests send regular messages; harness slash commands (`/rewind`, `/mcp`, etc.) only work on the host.
* **Rewinding:** Host rewinds reflect on guests once the next message is sent, and rewinding past the share turn stops the background share task.

### Relay
By default, `wye` connects to the public relay at `wss://wye.jessetane.com`. To self-host a relay and point clients at it via `--relay` or `WYE_RELAY`:

```sh
wye relay [--port 8787] [--bind 127.0.0.1]
```

See [`.env.example`](.env.example) for relay environment settings (`wye` loads `.env` automatically if present).

## Security
Sessions are end-to-end encrypted between host and guests, and the relay never sees the `#<key>` fragment. However, anyone you share the link with can submit prompts directly to your live agent—with whatever filesystem, shell, and tool permissions your session has. Only share links with people you trust.

## License
MIT

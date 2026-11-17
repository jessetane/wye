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

### Host
You stay in your normal Antigravity or Claude Code session:

* **Start:** Ask your agent to *"share this conversation"* and send the link it returns to your guests.
* **Stop:** Ask your agent to *"stop sharing"*, or stop the background task in your harness UI.
* **Approvals:** Tool permission prompts still appear on your machine as usual.
* **Rewinding:** Rewinds don't update guest views until the next message is sent, and rewinding past the turn where you started sharing stops the share.

### Guest

* **Web:** Open the share link in any browser (no install needed).
* **CLI:** Run `wye join '<url>' [--name <user>]`.
* **Expand output:** Press `Ctrl+O` to toggle full thinking and tool output.
* **Cancel:** Click `Stop` (web) or use `/stop` / `Ctrl+C` (CLI) if a turn stalls waiting on a command or host approval.
* **Prompts:** Plain messages only—harness slash commands (`/rewind`, `/mcp`, etc.) don't work from guest views.

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

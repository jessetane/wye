---
name: wye
description: >-
  Split and share the current live Antigravity or Claude Code conversation in
  real time with a partner, check active shares, or stop an active share.
  Activate when the user asks to share, collaborate on, wye, host, or stop
  sharing a conversation.
---

# Wye — Live Conversation Splitter

Allows a partner to join the host's active **Antigravity** (Desktop or `agy` CLI) or **Claude Code** (Desktop Code tab or `claude` CLI) conversation in real time via CLI (`wye join`) or browser (`http(s)://.../<room>`). Both participants submit plain user prompts into the live session, and the host stays directly inside their open Desktop or CLI window.

CLI entrypoint: [wye.js](./bin/wye.js)

## Starting a Share (Host)

1. Check if the target relay is reachable (default local relay: `http://127.0.0.1:8787/healthz`, unless the user specifies a remote `ws://` or `wss://` relay URL or `WYE_RELAY` is set).
   - If using the local default relay and `http://127.0.0.1:8787/healthz` is not running yet, start it in the background (Antigravity: `IsDaemon: true`, `WaitMsBeforeAsync: 1500`; Claude Code: `run_in_background: true`):
     ```sh
     wye relay
     ```
2. Launch `wye host` in the background (Antigravity: `IsDaemon: true`, `WaitMsBeforeAsync: 1500`; Claude Code: `run_in_background: true`). `wye host` auto-detects whether it is running inside Antigravity or Claude Code:
   ```sh
   wye host [--relay <ws-url>] [--room <optional-room>]
   ```
3. Read the background task output and share both the `web:` URL and `join:` CLI command printed by `wye host`.

## Stopping a Share

Run `wye stop` (passing the room/session ID if multiple shares are running, or with no arguments to stop active shares):

```sh
wye stop [<room-or-session-id>]
```

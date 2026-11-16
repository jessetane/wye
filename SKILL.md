---
name: wye
description: >-
  Split and share the current live Antigravity or Claude Code conversation in
  real time with a partner, check active shares, or stop an active share.
  Activate when the user asks to share, collaborate on, wye, host, or stop
  sharing a conversation.
---

# Wye — Live Conversation Splitter

Allows a partner to join the host's active **Antigravity** (Desktop or `agy` CLI) or **Claude Code** (Desktop Code tab or `claude` CLI) conversation in real time via CLI (`wye join`) or browser (`http(s)://.../<room>#<key>`). Sessions are end-to-end encrypted (`AES-GCM` with the `#<key>` URL fragment never sent to the relay). Both participants submit plain user prompts into the live session, and the host stays directly inside their open Desktop or CLI window.

CLI entrypoint: [wye.js](./bin/wye.js)

## Starting a Share (Host)

1. Launch `wye host` in the background (Antigravity: `IsDaemon: true`, `WaitMsBeforeAsync: 1500`; Claude Code: `run_in_background: true`). By default it connects to `wss://wye.jessetane.com` and auto-detects whether it is running inside Antigravity or Claude Code (only start a local `wye relay` first if the user explicitly asks for `--relay ws://127.0.0.1:8787`):
   ```sh
   wye host [--relay <ws-url>] [--room <optional-room>]
   ```
2. Read the background task output and reply using this layout (do not include `wye stop` commands, and keep the guest links at the very end):
   > Live share started (ask me to stop sharing anytime). Send either of these to your guest(s):
   >
   > - **Web:** `<web url>`
   > - **CLI:** `wye join '<web url>'`

## Checking or Stopping a Share

Run `wye status` to list active shares, or `wye stop` (passing the room/session ID if multiple shares are running, or with no arguments to stop active shares):

```sh
wye status
wye stop [<room-or-session-id>]
```

---
name: wye
description: >-
  Split and share the current live Antigravity Desktop or CLI conversation in
  real time with a partner, check active shares, or stop an active share.
  Activate when the user asks to share, collaborate on, wye, host, or stop
  sharing a conversation.
---

# Wye — Live Conversation Splitter

Allows a partner to join the host's active Antigravity Desktop or `agy` CLI conversation in real time via CLI (`wye join`) or browser (`http(s)://.../<room>`). Both participants submit plain user prompts into the live session, and the host stays directly inside their open Antigravity Desktop or CLI window.

CLI entrypoint: [wye.js](./bin/wye.js)

## Starting a Share (Host)

1. Check if the target relay is reachable (default local relay: `http://127.0.0.1:8787/healthz`, unless the user specifies a remote `ws://` or `wss://` relay URL or `WYE_RELAY` is set).
   - If using the local default relay and `http://127.0.0.1:8787/healthz` is not running yet, start it as a daemon task (`IsDaemon: true`, `WaitMsBeforeAsync: 1500`) using the resolved path to [wye.js](./bin/wye.js):
     ```sh
     node /path/to/wye/bin/wye.js relay
     ```
2. Launch `wye host` as a background daemon task (`IsDaemon: true`, `WaitMsBeforeAsync: 1500`):
   ```sh
   node /path/to/wye/bin/wye.js host [--relay <ws-url>] [--room <optional-room>]
   ```
3. Check the task output (via `manage_task` `status` if backgrounded before printing) and share both the `web:` URL and `join:` CLI command printed by `wye host`.

## Stopping a Share

Run `wye stop` targeting this conversation (or run `wye stop` from any terminal):

```sh
node /path/to/wye/bin/wye.js stop "$ANTIGRAVITY_CONVERSATION_ID"
```

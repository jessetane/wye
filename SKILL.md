---
name: collab
description: >-
  Share the current live Antigravity Desktop or CLI conversation in real time
  with a partner, check active shares, or stop an active collab share. Activate
  when the user asks to share, collaborate on, host, or stop sharing a
  conversation.
---

# Collab — Live Conversation Sharing

Allows a guest to join the host's active Antigravity Desktop or `agy` CLI conversation in real time via CLI (`collab join`) or browser (`http(s)://.../<room>`). Both participants submit plain user prompts into the live session, and the host stays directly inside their open Antigravity Desktop or CLI window.

CLI entrypoint: [collab.js](./bin/collab.js)

## Starting a Share (Host)

1. Check if the target relay is reachable (default local relay: `http://127.0.0.1:8787/healthz`, unless the user specifies a remote `ws://` or `wss://` relay URL or `COLLAB_RELAY` is set).
   - If using the local default relay and `http://127.0.0.1:8787/healthz` is not running yet, start it as a daemon task (`IsDaemon: true`, `WaitMsBeforeAsync: 1500`) using the resolved path to [collab.js](./bin/collab.js):
     ```sh
     node /path/to/collab/bin/collab.js relay
     ```
2. Launch `collab host` as a background daemon task (`IsDaemon: true`, `WaitMsBeforeAsync: 1500`):
   ```sh
   node /path/to/collab/bin/collab.js host [--relay <ws-url>] [--room <optional-room>]
   ```
3. Check the task output (via `manage_task` `status` if backgrounded before printing) and share both the `web:` URL and `join:` CLI command printed by `collab host`.

## Stopping a Share

Run `collab stop` targeting this conversation (or run `collab stop` from any terminal):

```sh
node /path/to/collab/bin/collab.js stop "$ANTIGRAVITY_CONVERSATION_ID"
```

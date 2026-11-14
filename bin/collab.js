#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createRelay } from '../lib/relay.js'
import { connectHost } from '../lib/host.js'
import { connectGuest } from '../lib/join.js'

const USAGE = `Usage:
  collab relay [--port 8787] [--bind 0.0.0.0]
  collab host  [--relay ws://127.0.0.1:8787] [--room <token>] [--name <user>]
  collab join  <url-or-room> [--relay ws://127.0.0.1:8787] [--name <user>]`

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		port: { type: 'string', short: 'p' },
		bind: { type: 'string', short: 'b' },
		relay: { type: 'string', short: 'r' },
		room: { type: 'string' },
		name: { type: 'string', short: 'n' },
		help: { type: 'boolean', short: 'h' }
	}
})

const cmd = positionals[0]
if (values.help || !cmd) {
	console.log(USAGE)
	process.exit(values.help ? 0 : 1)
}

if (cmd === 'relay') {
	const port = values.port ? Number(values.port) : Number(process.env.PORT || 8787)
	const bind = values.bind || process.env.BIND || '0.0.0.0'
	const relay = createRelay({ port, host: bind })
	const addr = await relay.open(port, bind)
	console.log(`collab relay listening on ws://${addr.address}:${addr.port}`)
	async function shutdown () {
		try {
			await relay.close()
		} finally {
			process.exit(0)
		}
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
} else if (cmd === 'host') {
	const session = await connectHost({
		relayUrl: values.relay,
		room: values.room,
		name: values.name,
		onEvent (ev) {
			if (ev.type === 'presence') {
				console.log(`[presence] ${ev.name} ${ev.event}`)
			} else if (ev.type === 'injected') {
				console.log(`[prompt] ${ev.text}`)
			}
		},
		onClose () {
			console.error('collab host disconnected from relay')
			process.exit(1)
		}
	})
	const joinBase = session.relayUrl.replace(/\/+$/, '')
	console.log(`room: ${session.room}`)
	console.log(`join: collab join ${joinBase}/${session.room}`)
	function shutdown () {
		session.disconnect()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
} else if (cmd === 'join') {
	const target = positionals[1] || values.room
	if (!target) {
		console.error('Missing <url-or-room>.\n\n' + USAGE)
		process.exit(1)
	}
	await connectGuest({
		target,
		relayUrl: values.relay,
		name: values.name,
		onClose () {
			process.exit(0)
		}
	})
} else {
	console.error(`Unknown subcommand: ${cmd}\n\n${USAGE}`)
	process.exit(1)
}

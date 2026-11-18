#!/usr/bin/env node
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { Relay } from '../lib/relay.js'
import { DEFAULT_RELAY_URL, Host, listHosts, stopHosts } from '../lib/host.js'
import { Guest } from '../lib/join.js'

const USAGE = `Usage:
  wye relay  [--port 8787] [--bind 127.0.0.1]
  wye host   [--relay ${DEFAULT_RELAY_URL}] [--harness antigravity|claude] [--session <id>] [--room <token>] [--key <key>] [--name <user>]
  wye join   <url-or-room#key> [--relay ${DEFAULT_RELAY_URL}] [--key <key>] [--name <user>]
  wye status
  wye stop   [<room-or-conversation-id>]`

let values
let positionals
try {
	({ values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			port: { type: 'string', short: 'p' },
			bind: { type: 'string', short: 'b' },
			relay: { type: 'string', short: 'r' },
			harness: { type: 'string' },
			session: { type: 'string', short: 's' },
			room: { type: 'string' },
			key: { type: 'string', short: 'k' },
			name: { type: 'string', short: 'n' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' }
		}
	}))
} catch (err) {
	console.error(`${err.message}\n\n${USAGE}`)
	process.exit(1)
}

if (values.version) {
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
	console.log(pkg.version)
	process.exit(0)
}

const cmd = positionals[0]
if (values.help || !cmd) {
	console.log(USAGE)
	process.exit(values.help ? 0 : 1)
}

if (cmd === 'relay') {
	if (fs.existsSync('.env')) process.loadEnvFile('.env')
	const port = values.port ? Number(values.port) : undefined
	const relay = new Relay({ port, host: values.bind })
	const addr = await relay.open()
	const hostLabel = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
	console.log(`wye relay listening on ws://${hostLabel}:${addr.port}`)
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
	const host = new Host({
		relayUrl: values.relay,
		harness: values.harness,
		sessionId: values.session,
		room: values.room,
		key: values.key,
		name: values.name
	})
	host.addEventListener('presence', ev => {
		console.log(`[presence] ${ev.detail.name} ${ev.detail.event}`)
	})
	host.addEventListener('prompt', ev => {
		console.log(`[prompt] ${ev.detail.text}`)
	})
	host.addEventListener('cancel', ev => {
		console.log(`[cancel] requested by ${ev.detail.sender}`)
	})
	host.addEventListener('reconnecting', ev => {
		console.error(`[reconnect] retrying in ${ev.detail.delay}ms`)
	})
	host.addEventListener('reconnected', () => {
		console.log('[reconnect] restored relay connection')
	})
	host.addEventListener('error', ev => {
		console.error(`[wye host] ${ev.detail.message}`)
	})
	host.addEventListener('close', () => {
		process.exit(0)
	})
	try {
		await host.connect()
	} catch (err) {
		console.error(err.message)
		process.exit(1)
	}
	console.log(`room: ${host.room}`)
	console.log(`web:  ${host.webUrl}`)
	console.log(`join: wye join '${host.webUrl}'`)
	function shutdown () {
		host.disconnect()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
} else if (cmd === 'join') {
	const target = positionals[1] || values.room
	if (!target) {
		console.error('Missing <url-or-room#key>.\n\n' + USAGE)
		process.exit(1)
	}
	const guest = new Guest({
		target,
		key: values.key,
		relayUrl: values.relay,
		name: values.name
	})
	guest.addEventListener('close', () => {
		process.exit(0)
	})
	await guest.connect()
} else if (cmd === 'status') {
	const active = listHosts()
	if (active.length === 0) {
		console.log('No active wye host sessions.')
	} else {
		for (const h of active) {
			console.log(`${h.room}\t${h.harness || 'unknown'}\tpid=${h.pid}\t${h.webUrl || h.relayUrl}\t${h.workspace}`)
		}
	}
} else if (cmd === 'stop') {
	const target = positionals[1] || values.room || ''
	const stopped = stopHosts(target)
	if (stopped.length === 0) {
		console.log('No matching active wye host sessions.')
	} else {
		for (const h of stopped) {
			console.log(`stopped ${h.room} (pid ${h.pid})`)
		}
	}
} else {
	console.error(`Unknown subcommand: ${cmd}\n\n${USAGE}`)
	process.exit(1)
}

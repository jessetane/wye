import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHarness } from './harnesses/index.js'

const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'wye-hosts')

export function normalizeRelayWsUrl (relayUrl, room, params) {
	const base = relayUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '')
	const query = new URLSearchParams(params).toString()
	return `${base}/ws/${encodeURIComponent(room)}?${query}`
}

export function normalizeRelayHttpUrl (relayUrl, room) {
	const base = relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/+$/, '')
	return `${base}/${encodeURIComponent(room)}`
}

function isProcessAlive (pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		if (err.code === 'ESRCH') return false
		return true
	}
}

export function listHosts (stateDir = DEFAULT_STATE_DIR) {
	if (!fs.existsSync(stateDir)) return []
	const active = []
	for (const entry of fs.readdirSync(stateDir)) {
		if (!entry.endsWith('.json')) continue
		const file = path.join(stateDir, entry)
		const info = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (isProcessAlive(info.pid)) {
			active.push(info)
		} else {
			fs.rmSync(file, { force: true })
		}
	}
	return active
}

export function stopHosts (target = '', stateDir = DEFAULT_STATE_DIR) {
	const hosts = listHosts(stateDir)
	const matched = target
		? hosts.filter(h => h.room === target || h.conversationId === target)
		: hosts
	for (const h of matched) {
		process.kill(h.pid, 'SIGTERM')
		fs.rmSync(path.join(stateDir, `${encodeURIComponent(h.room)}.json`), { force: true })
	}
	return matched
}

export async function connectHost (opts = {}) {
	const env = opts.env || process.env
	const harness = resolveHarness(opts)
	const conversationId = harness.conversationId
	const workspace = harness.workspace
	const transcriptPath = harness.transcriptPath
	const relayUrl = opts.relayUrl || env.WYE_RELAY || 'ws://127.0.0.1:8787'
	const room = opts.room || conversationId
	const name = opts.name || env.WYE_NAME || os.userInfo().username
	const reconnect = opts.reconnect ?? true
	const minDelay = opts.reconnectDelayMs ?? 500
	const maxDelay = opts.maxReconnectDelayMs ?? 5000
	const stateDir = opts.stateDir || DEFAULT_STATE_DIR
	const trackState = opts.trackState ?? true
	const stateFile = path.join(stateDir, `${encodeURIComponent(room)}.json`)
	const wsUrl = normalizeRelayWsUrl(relayUrl, room, {
		role: 'host',
		name,
		harness: harness.type,
		conversationId,
		workspace
	})
	const stepsByIndex = new Map()
	const sentDigests = new Map()
	let ws = null
	let stopped = false
	let reconnectTimer = null
	let attempt = 0
	function flushStep (step) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const serialized = JSON.stringify(step)
		if (sentDigests.get(step.index) === serialized) return
		sentDigests.set(step.index, serialized)
		ws.send(JSON.stringify({ type: 'step', step }))
	}
	function attachHandlers (socket, isReconnect) {
		socket.addEventListener('message', async event => {
			const msg = JSON.parse(String(event.data))
			if (msg.type === 'prompt') {
				try {
					await harness.send(msg.text)
					if (opts.onEvent) opts.onEvent({ type: 'injected', sender: msg.sender, text: msg.text })
				} catch (err) {
					if (opts.onError) opts.onError(err)
					else console.error(`[wye host] ${err.message}`)
				}
			} else if (msg.type === 'cancel') {
				try {
					await harness.cancel()
					if (opts.onEvent) opts.onEvent({ type: 'cancelled', sender: msg.sender })
				} catch (err) {
					if (opts.onError) opts.onError(err)
					else console.error(`[wye host] ${err.message}`)
				}
			} else if (opts.onEvent) {
				opts.onEvent(msg)
			}
		})
		socket.addEventListener('close', () => {
			if (ws === socket) ws = null
			if (stopped) {
				if (opts.onClose) opts.onClose()
				return
			}
			if (!reconnect) {
				unwatch()
				removeStateFile()
				if (opts.onClose) opts.onClose()
				return
			}
			scheduleReconnect()
		})
		if (isReconnect) {
			sentDigests.clear()
			const ordered = [...stepsByIndex.values()].sort((a, b) => a.index - b.index)
			for (const step of ordered) flushStep(step)
			if (opts.onEvent) opts.onEvent({ type: 'reconnected' })
		}
	}
	function openSocket () {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl)
			function onOpen () {
				socket.removeEventListener('error', onError)
				ws = socket
				attempt = 0
				resolve(socket)
			}
			function onError () {
				reject(new Error(`Failed to connect to wye relay at ${wsUrl}`))
			}
			socket.addEventListener('open', onOpen, { once: true })
			socket.addEventListener('error', onError, { once: true })
		})
	}
	function scheduleReconnect () {
		if (stopped || reconnectTimer) return
		const delay = Math.min(maxDelay, minDelay * (2 ** attempt))
		attempt += 1
		if (opts.onEvent) opts.onEvent({ type: 'reconnecting', delay })
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = null
			if (stopped) return
			try {
				const socket = await openSocket()
				if (stopped) {
					socket.close()
					return
				}
				attachHandlers(socket, true)
			} catch (err) {
				if (opts.onError) opts.onError(err)
				else console.error(`[wye host] ${err.message}`)
				scheduleReconnect()
			}
		}, delay)
		reconnectTimer.unref()
	}
	function removeStateFile () {
		if (trackState) fs.rmSync(stateFile, { force: true })
	}
	const initialSocket = await openSocket()
	attachHandlers(initialSocket, false)
	const unwatch = harness.watch(step => {
		stepsByIndex.set(step.index, step)
		flushStep(step)
	})
	if (trackState) {
		fs.mkdirSync(stateDir, { recursive: true })
		fs.writeFileSync(stateFile, JSON.stringify({
			pid: process.pid,
			harness: harness.type,
			room,
			conversationId,
			relayUrl,
			workspace,
			startedAt: new Date().toISOString()
		}))
	}
	return {
		harness: harness.type,
		room,
		name,
		relayUrl,
		webUrl: normalizeRelayHttpUrl(relayUrl, room),
		conversationId,
		transcriptPath,
		get ws () {
			return ws
		},
		disconnect () {
			if (stopped) return
			stopped = true
			if (reconnectTimer) clearTimeout(reconnectTimer)
			unwatch()
			removeStateFile()
			if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
				ws.close()
			}
		}
	}
}

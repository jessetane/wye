import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHarness } from './harnesses/index.js'
import { generateKey, importKey, encryptJson, decryptJson } from '../public/crypto.js'

export const DEFAULT_RELAY_URL = 'wss://wye.jessetane.com'
const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'wye-hosts')

export function relayWsUrl (relayUrl, room, params) {
	const base = relayUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '')
	const query = new URLSearchParams(params).toString()
	return `${base}/ws/${encodeURIComponent(room)}?${query}`
}

export function relayHttpUrl (relayUrl, room, key = '') {
	const base = relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/+$/, '')
	const hash = key ? `#${key}` : ''
	return `${base}/${encodeURIComponent(room)}${hash}`
}

function isProcessAlive (pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return err.code !== 'ESRCH'
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

export class Host extends EventTarget {
	constructor (opts = {}) {
		super()
		this.opts = opts
		this.reconnect = opts.reconnect ?? true
		this.minDelay = opts.reconnectDelayMs ?? 500
		this.maxDelay = opts.maxReconnectDelayMs ?? 5000
		this.stateDir = opts.stateDir || DEFAULT_STATE_DIR
		this.trackState = opts.trackState ?? true
		this.ws = null
		this.stopped = false
		this.reconnectTimer = null
		this.unwatch = null
		this.stateFile = ''
		this.stepsByIndex = new Map()
		this.sentDigests = new Map()
		this.pendingSteps = []
		this.activeDrain = null
		this.attempt = 0
		this.epoch = crypto.randomUUID()
	}

	async connect () {
		const opts = this.opts
		const env = opts.env || process.env
		this.driver = await resolveHarness(opts)
		this.harness = this.driver.type
		this.conversationId = this.driver.conversationId
		this.workspace = this.driver.workspace
		this.transcriptPath = this.driver.transcriptPath
		this.relayUrl = opts.relayUrl || env.WYE_RELAY || DEFAULT_RELAY_URL
		this.room = opts.room || this.conversationId
		this.key = opts.key || env.WYE_KEY || generateKey()
		this.name = opts.name || env.WYE_NAME || os.userInfo().username
		this.webUrl = relayHttpUrl(this.relayUrl, this.room, this.key)
		this.wsUrl = relayWsUrl(this.relayUrl, this.room, { role: 'host' })
		this.stateFile = path.join(this.stateDir, `${encodeURIComponent(this.room)}.json`)
		this.cryptoKey = await importKey(this.key)
		const socket = await this.openSocket()
		await this.attachSocket(socket, false)
		this.unwatch = this.driver.watch(step => {
			this.stepsByIndex.set(step.index, step)
			this.flushStep(step)
		})
		if (this.activeDrain) await this.activeDrain
		if (this.trackState) {
			fs.mkdirSync(this.stateDir, { recursive: true })
			fs.writeFileSync(this.stateFile, JSON.stringify({
				pid: process.pid,
				harness: this.harness,
				room: this.room,
				webUrl: this.webUrl,
				conversationId: this.conversationId,
				relayUrl: this.relayUrl,
				workspace: this.workspace,
				startedAt: new Date().toISOString()
			}))
		}
		return this
	}

	openSocket () {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.wsUrl)
			socket.onopen = () => {
				this.ws = socket
				this.attempt = 0
				resolve(socket)
			}
			socket.onerror = () => {
				reject(new Error(`Failed to connect to wye relay at ${this.wsUrl}`))
			}
		})
	}

	async attachSocket (socket, isReconnect) {
		socket.onmessage = event => this.onMessage(event.data)
		socket.onclose = () => this.onSocketClose(socket)
		socket.onerror = null
		const [nameBox, metaBox] = await Promise.all([
			encryptJson(this.cryptoKey, this.name),
			encryptJson(this.cryptoKey, {
				hostName: this.name,
				harness: this.harness,
				conversationId: this.conversationId,
				workspace: this.workspace
			})
		])
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'hello', epoch: this.epoch, nameBox, metaBox }))
		}
		if (isReconnect) {
			this.sentDigests.clear()
			const ordered = [...this.stepsByIndex.values()].sort((a, b) => a.index - b.index)
			for (const step of ordered) this.flushStep(step)
			this.dispatchEvent(new Event('reconnected'))
		}
	}

	async onMessage (raw) {
		try {
			const msg = JSON.parse(String(raw))
			if (msg.type === 'prompt' && typeof msg.box === 'string') {
				const payload = await decryptJson(this.cryptoKey, msg.box)
				const sender = msg.senderBox ? await decryptJson(this.cryptoKey, msg.senderBox) : 'guest'
				await this.driver.send(payload.text)
				this.dispatchEvent(new CustomEvent('prompt', { detail: { sender, text: payload.text } }))
			} else if (msg.type === 'cancel') {
				const sender = msg.senderBox ? await decryptJson(this.cryptoKey, msg.senderBox) : 'guest'
				await this.driver.cancel()
				this.cancelRunningTools(sender)
				this.dispatchEvent(new CustomEvent('cancel', { detail: { sender } }))
			} else if (msg.type === 'presence' && msg.nameBox) {
				const peerName = await decryptJson(this.cryptoKey, msg.nameBox)
				this.dispatchEvent(new CustomEvent('presence', { detail: { event: msg.event, name: peerName } }))
			} else if (msg.type === 'ready') {
				this.dispatchEvent(new CustomEvent('ready', { detail: msg }))
			}
		} catch (err) {
			const detail = err.name === 'KeyMismatchError'
				? new Error('Ignored guest message with mismatched #key.')
				: err
			this.dispatchEvent(new CustomEvent('error', { detail }))
		}
	}

	onSocketClose (socket) {
		if (this.ws === socket) this.ws = null
		if (this.stopped) {
			this.dispatchEvent(new Event('close'))
			return
		}
		if (!this.reconnect) {
			if (this.unwatch) this.unwatch()
			this.removeStateFile()
			this.dispatchEvent(new Event('close'))
			return
		}
		this.scheduleReconnect()
	}

	scheduleReconnect () {
		if (this.stopped || this.reconnectTimer) return
		const delay = Math.min(this.maxDelay, this.minDelay * (2 ** this.attempt))
		this.attempt += 1
		this.dispatchEvent(new CustomEvent('reconnecting', { detail: { delay } }))
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null
			if (this.stopped) return
			try {
				const socket = await this.openSocket()
				if (this.stopped) {
					socket.close()
					return
				}
				await this.attachSocket(socket, true)
			} catch (err) {
				this.dispatchEvent(new CustomEvent('error', { detail: err }))
				this.scheduleReconnect()
			}
		}, delay)
		this.reconnectTimer.unref()
	}

	cancelRunningTools (sender) {
		for (const step of this.stepsByIndex.values()) {
			if (!Array.isArray(step.tools)) continue
			let changed = false
			for (const tool of step.tools) {
				if (tool.status === 'running') {
					tool.status = 'error'
					if (!tool.output) tool.output = `Cancelled by ${sender}`
					changed = true
				}
			}
			if (changed) this.flushStep(step)
		}
	}

	flushStep (step) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
		const serialized = JSON.stringify(step)
		if (this.sentDigests.get(step.index) === serialized) return
		this.sentDigests.set(step.index, serialized)
		this.pendingSteps.push({ step, socket: this.ws })
		if (!this.activeDrain) this.activeDrain = this.drainSteps()
	}

	async drainSteps () {
		try {
			while (this.pendingSteps.length > 0) {
				const { step, socket } = this.pendingSteps.shift()
				if (socket.readyState !== WebSocket.OPEN) continue
				try {
					const box = await encryptJson(this.cryptoKey, step)
					if (socket.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify({ type: 'step', index: step.index, box }))
					}
				} catch (err) {
					this.dispatchEvent(new CustomEvent('error', { detail: err }))
				}
			}
		} finally {
			this.activeDrain = null
		}
	}

	removeStateFile () {
		if (this.trackState && this.stateFile) fs.rmSync(this.stateFile, { force: true })
	}

	disconnect () {
		if (this.stopped) return
		this.stopped = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.unwatch) this.unwatch()
		this.removeStateFile()
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			this.ws.close()
		}
	}
}

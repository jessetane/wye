import fs from 'node:fs'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const REPO_URL = PKG.repository
const REPO_LABEL = REPO_URL.replace(/^https?:\/\//, '')
const INDEX_HTML = new TextEncoder().encode(
	fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
		.replace('{{REPO_URL}}', escapeHtml(REPO_URL))
		.replace('{{REPO_LABEL}}', escapeHtml(REPO_LABEL))
		.replace('{{README}}', escapeHtml(fs.readFileSync(new URL('../readme.md', import.meta.url), 'utf8').trim()))
)
const ROOM_HTML = fs.readFileSync(new URL('../public/room.html', import.meta.url))
const STYLE_CSS = fs.readFileSync(new URL('../public/style.css', import.meta.url))
const APP_JS = fs.readFileSync(new URL('../public/app.js', import.meta.url))
const CRYPTO_JS = fs.readFileSync(new URL('../public/crypto.js', import.meta.url))

const DEFAULT_MAX_ROOMS = 1024
const DEFAULT_MAX_GUESTS = 32
const DEFAULT_MAX_PEERS_PER_IP = 64
const DEFAULT_MAX_ROOM_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_PAYLOAD = 1024 * 1024
const DEFAULT_MAX_WRITE_BUFFER = 8 * 1024 * 1024
const DEFAULT_PING_MS = 25000
const MAX_SMALL_BOX = 8192

function normalizeIp (addr) {
	return String(addr || '').trim().replace(/^::ffff:/, '')
}

function resolveClientIp (req, socket) {
	const remote = normalizeIp(socket.remoteAddress)
	if (remote === '127.0.0.1' || remote === '::1') {
		const forwarded = req.headers['x-forwarded-for']
		if (typeof forwarded === 'string' && forwarded.trim()) {
			return normalizeIp(forwarded.split(',')[0])
		}
	}
	return remote || 'unknown'
}

function envInt (env, key, fallback) {
	const raw = env[key]
	if (raw === undefined || raw === '') return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function escapeHtml (str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseJsonMessage (raw, isBinary) {
	if (isBinary) return null
	try {
		return JSON.parse(raw.toString('utf8'))
	} catch {
		return null
	}
}

export class Relay {
	constructor (opts = {}) {
		const env = opts.env || process.env
		this.port = opts.port ?? envInt(env, 'PORT', 8787)
		this.host = opts.host ?? env.BIND ?? '127.0.0.1'
		this.maxRooms = opts.maxRooms ?? envInt(env, 'MAX_ROOMS', DEFAULT_MAX_ROOMS)
		this.maxGuests = opts.maxGuests ?? envInt(env, 'MAX_GUESTS', DEFAULT_MAX_GUESTS)
		this.maxPeersPerIp = opts.maxPeersPerIp ?? envInt(env, 'MAX_PEERS_PER_IP', DEFAULT_MAX_PEERS_PER_IP)
		this.maxRoomBytes = opts.maxRoomBytes ?? envInt(env, 'MAX_ROOM_BYTES', DEFAULT_MAX_ROOM_BYTES)
		this.maxWriteBuffer = opts.maxWriteBuffer ?? envInt(env, 'MAX_WRITE_BUFFER', DEFAULT_MAX_WRITE_BUFFER)
		this.rooms = new Map()
		this.peersByIp = new Map()
		this.wss = new WebSocketServer({
			noServer: true,
			perMessageDeflate: false,
			maxPayload: opts.maxPayload ?? envInt(env, 'MAX_PAYLOAD', DEFAULT_MAX_PAYLOAD)
		})
		this.server = http.createServer((req, res) => this.onRequest(req, res))
		this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
		this.pingTimer = setInterval(() => this.ping(), opts.pingIntervalMs ?? envInt(env, 'PING_INTERVAL_MS', DEFAULT_PING_MS))
		this.pingTimer.unref()
	}

	onRequest (req, res) {
		const url = new URL(req.url, 'http://localhost')
		if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(INDEX_HTML)
			return
		}
		if (req.method === 'GET' && url.pathname === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ ok: true, rooms: this.rooms.size }))
			return
		}
		if (req.method === 'GET' && url.pathname === '/style.css') {
			res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
			res.end(STYLE_CSS)
			return
		}
		if (req.method === 'GET' && url.pathname === '/app.js') {
			res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
			res.end(APP_JS)
			return
		}
		if (req.method === 'GET' && url.pathname === '/crypto.js') {
			res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
			res.end(CRYPTO_JS)
			return
		}
		if (req.method === 'GET' && /^\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(ROOM_HTML)
			return
		}
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('not found')
	}

	getRoom (id) {
		let room = this.rooms.get(id)
		if (!room) {
			room = {
				id,
				epoch: null,
				metaBox: null,
				host: null,
				hostNameBox: null,
				guests: new Map(),
				steps: new Map(),
				stepBytes: 0
			}
			this.rooms.set(id, room)
		}
		return room
	}

	send (peer, message) {
		if (peer.readyState !== WebSocket.OPEN) return
		const raw = typeof message === 'string' ? message : JSON.stringify(message)
		if (peer.bufferedAmount + raw.length > this.maxWriteBuffer) {
			peer.terminate()
			return
		}
		peer.send(raw)
	}

	broadcast (room, payload, except = null) {
		const raw = JSON.stringify(payload)
		if (room.host && room.host !== except) this.send(room.host, raw)
		for (const guest of room.guests.keys()) {
			if (guest !== except) this.send(guest, raw)
		}
	}

	roster (room) {
		const members = []
		if (room.host && room.hostNameBox) members.push({ role: 'host', nameBox: room.hostNameBox })
		for (const info of room.guests.values()) {
			if (info.nameBox) members.push({ role: 'guest', nameBox: info.nameBox })
		}
		return members
	}

	cleanupRoom (room) {
		if (!room.host && room.guests.size === 0) this.rooms.delete(room.id)
	}

	canEnterRoom (roomId, role) {
		const existing = this.rooms.get(roomId)
		if (!existing) return this.rooms.size < this.maxRooms
		return role !== 'guest' || existing.guests.size < this.maxGuests
	}

	onUpgrade (req, socket, head) {
		socket.on('error', () => {})
		const url = new URL(req.url, 'http://localhost')
		const match = /^\/ws\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname)
		const role = url.searchParams.get('role')
		if (!match || (role !== 'host' && role !== 'guest')) {
			socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
			socket.destroy()
			return
		}
		const roomId = match[1]
		const ip = resolveClientIp(req, socket)
		if ((this.peersByIp.get(ip) || 0) >= this.maxPeersPerIp) {
			socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
			socket.destroy()
			return
		}
		if (!this.canEnterRoom(roomId, role)) {
			socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
			socket.destroy()
			return
		}
		this.wss.handleUpgrade(req, socket, head, peer => {
			const count = this.peersByIp.get(ip) || 0
			if (count >= this.maxPeersPerIp || !this.canEnterRoom(roomId, role)) {
				peer.terminate()
				return
			}
			this.peersByIp.set(ip, count + 1)
			peer.on('close', () => {
				const remaining = (this.peersByIp.get(ip) || 1) - 1
				if (remaining <= 0) this.peersByIp.delete(ip)
				else this.peersByIp.set(ip, remaining)
			})
			peer.alive = true
			peer.on('error', () => {})
			peer.on('pong', () => { peer.alive = true })
			const room = this.getRoom(roomId)
			if (role === 'host') {
				this.attachHost(room, peer)
			} else {
				this.attachGuest(room, peer)
			}
		})
	}

	attachHost (room, peer) {
		if (room.host) room.host.close()
		room.host = peer
		peer.on('message', (data, isBinary) => {
			peer.alive = true
			const msg = parseJsonMessage(data, isBinary)
			if (!msg) {
				peer.terminate()
				return
			}
			if (msg.type === 'hello' && typeof msg.nameBox === 'string' && msg.nameBox.length <= MAX_SMALL_BOX) {
				if (room.epoch && msg.epoch !== room.epoch) {
					room.steps.clear()
					room.stepBytes = 0
					room.metaBox = null
					for (const guest of [...room.guests.keys()]) guest.close()
				}
				room.epoch = typeof msg.epoch === 'string' ? msg.epoch.slice(0, 128) : null
				room.hostNameBox = msg.nameBox
				if (typeof msg.metaBox === 'string' && msg.metaBox.length <= MAX_SMALL_BOX) room.metaBox = msg.metaBox
				this.send(peer, { type: 'ready', room: room.id, members: this.roster(room) })
				this.broadcast(room, {
					type: 'presence',
					event: 'host_joined',
					nameBox: room.hostNameBox,
					metaBox: room.metaBox,
					members: this.roster(room)
				}, peer)
			} else if (msg.type === 'step' && Number.isInteger(msg.index) && msg.index >= 0 && typeof msg.box === 'string') {
				if (msg.box.length > this.maxRoomBytes) {
					peer.terminate()
					return
				}
				if (msg.truncate) {
					for (const [idx, prev] of [...room.steps.entries()]) {
						if (idx >= msg.index) {
							room.stepBytes -= prev.box.length
							room.steps.delete(idx)
						}
					}
				}
				const prev = room.steps.get(msg.index)
				if (prev) room.stepBytes -= prev.box.length
				room.steps.set(msg.index, { index: msg.index, box: msg.box })
				room.stepBytes += msg.box.length
				if (room.stepBytes > this.maxRoomBytes) {
					const sorted = [...room.steps.keys()].sort((a, b) => a - b)
					for (const idx of sorted) {
						if (room.stepBytes <= this.maxRoomBytes || idx === msg.index) break
						room.stepBytes -= room.steps.get(idx).box.length
						room.steps.delete(idx)
					}
				}
				const out = JSON.stringify(msg.truncate
					? { type: 'step', index: msg.index, truncate: true, box: msg.box }
					: { type: 'step', index: msg.index, box: msg.box }
				)
				for (const guest of room.guests.keys()) {
					this.send(guest, out)
				}
			}
		})
		peer.on('close', () => {
			if (room.host !== peer) return
			const nameBox = room.hostNameBox
			room.host = null
			room.hostNameBox = null
			if (nameBox) {
				this.broadcast(room, { type: 'presence', event: 'host_left', nameBox, members: this.roster(room) })
			}
			this.cleanupRoom(room)
		})
	}

	attachGuest (room, peer) {
		const guestInfo = { nameBox: null }
		room.guests.set(peer, guestInfo)
		peer.on('message', (data, isBinary) => {
			peer.alive = true
			const msg = parseJsonMessage(data, isBinary)
			if (!msg) {
				peer.terminate()
				return
			}
			if (msg.type === 'hello' && typeof msg.nameBox === 'string' && msg.nameBox.length <= MAX_SMALL_BOX) {
				guestInfo.nameBox = msg.nameBox
				const orderedSteps = [...room.steps.values()].sort((a, b) => a.index - b.index)
				this.send(peer, {
					type: 'snapshot',
					room: room.id,
					metaBox: room.metaBox,
					members: this.roster(room),
					steps: orderedSteps
				})
				this.broadcast(room, {
					type: 'presence',
					event: 'guest_joined',
					nameBox: guestInfo.nameBox,
					members: this.roster(room)
				}, peer)
			} else if (msg.type === 'prompt' && guestInfo.nameBox && typeof msg.box === 'string') {
				if (!room.host) {
					this.send(peer, { type: 'error', message: 'Host is not currently connected to this room.' })
					return
				}
				this.send(room.host, { type: 'prompt', senderBox: guestInfo.nameBox, box: msg.box })
			} else if (msg.type === 'cancel' && guestInfo.nameBox) {
				if (!room.host) {
					this.send(peer, { type: 'error', message: 'Host is not currently connected to this room.' })
					return
				}
				this.send(room.host, { type: 'cancel', senderBox: guestInfo.nameBox })
				this.broadcast(room, { type: 'presence', event: 'cancelled_turn', nameBox: guestInfo.nameBox, members: this.roster(room) })
			}
		})
		peer.on('close', () => {
			if (!room.guests.delete(peer)) return
			if (guestInfo.nameBox) {
				this.broadcast(room, { type: 'presence', event: 'guest_left', nameBox: guestInfo.nameBox, members: this.roster(room) })
			}
			this.cleanupRoom(room)
		})
	}

	ping () {
		for (const room of [...this.rooms.values()]) {
			for (const peer of [room.host, ...room.guests.keys()]) {
				if (!peer) continue
				if (!peer.alive) peer.terminate()
				else if (peer.readyState === WebSocket.OPEN) {
					peer.alive = false
					peer.ping()
				}
			}
		}
	}

	async open (port = this.port, host = this.host) {
		await new Promise((resolve, reject) => {
			this.server.once('error', reject)
			this.server.listen(port, host, resolve)
		})
		return this.server.address()
	}

	async close () {
		clearInterval(this.pingTimer)
		for (const room of this.rooms.values()) {
			if (room.host) room.host.terminate()
			for (const guest of room.guests.keys()) guest.terminate()
		}
		this.rooms.clear()
		this.peersByIp.clear()
		this.wss.close()
		await new Promise((resolve, reject) => {
			this.server.close(err => (err ? reject(err) : resolve()))
		})
	}
}

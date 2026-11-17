import fs from 'node:fs'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const INDEX_HTML = new TextEncoder().encode(
	fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
		.replace('{{README}}', escapeHtml(fs.readFileSync(new URL('../readme.md', import.meta.url), 'utf8').trim()))
)
const ROOM_HTML = fs.readFileSync(new URL('../public/room.html', import.meta.url))
const STYLE_CSS = fs.readFileSync(new URL('../public/style.css', import.meta.url))
const APP_JS = fs.readFileSync(new URL('../public/app.js', import.meta.url))
const CRYPTO_JS = fs.readFileSync(new URL('../public/crypto.js', import.meta.url))

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
		this.port = opts.port ?? 8787
		this.host = opts.host ?? '127.0.0.1'
		this.rooms = new Map()
		this.wss = new WebSocketServer({
			noServer: true,
			perMessageDeflate: false,
			maxPayload: opts.maxPayload ?? 1024 * 1024
		})
		this.server = http.createServer((req, res) => this.onRequest(req, res))
		this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
		this.pingTimer = setInterval(() => this.ping(), opts.pingIntervalMs ?? 25000)
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
		if (req.method === 'GET' && /^\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
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
				steps: new Map()
			}
			this.rooms.set(id, room)
		}
		return room
	}

	send (peer, message) {
		if (peer.readyState !== WebSocket.OPEN) return
		peer.send(typeof message === 'string' ? message : JSON.stringify(message))
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

	onUpgrade (req, socket, head) {
		socket.on('error', () => {})
		const url = new URL(req.url, 'http://localhost')
		const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
		const role = url.searchParams.get('role')
		if (!match || (role !== 'host' && role !== 'guest')) {
			socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
			socket.destroy()
			return
		}
		const roomId = match[1]
		this.wss.handleUpgrade(req, socket, head, peer => {
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
			if (msg.type === 'hello' && typeof msg.nameBox === 'string') {
				if (room.epoch && msg.epoch !== room.epoch) {
					room.steps.clear()
					room.metaBox = null
					for (const guest of [...room.guests.keys()]) guest.close()
				}
				room.epoch = msg.epoch
				room.hostNameBox = msg.nameBox
				if (typeof msg.metaBox === 'string') room.metaBox = msg.metaBox
				this.send(peer, { type: 'ready', room: room.id, members: this.roster(room) })
				this.broadcast(room, {
					type: 'presence',
					event: 'host_joined',
					nameBox: room.hostNameBox,
					metaBox: room.metaBox,
					members: this.roster(room)
				}, peer)
			} else if (msg.type === 'step' && typeof msg.index === 'number' && typeof msg.box === 'string') {
				if (msg.truncate) {
					for (const idx of [...room.steps.keys()]) {
						if (idx >= msg.index) room.steps.delete(idx)
					}
				}
				room.steps.set(msg.index, { index: msg.index, box: msg.box })
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
			if (msg.type === 'hello' && typeof msg.nameBox === 'string') {
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
			} else if (msg.type === 'prompt' && typeof msg.box === 'string') {
				if (!room.host) {
					this.send(peer, { type: 'error', message: 'Host is not currently connected to this room.' })
					return
				}
				this.send(room.host, { type: 'prompt', senderBox: guestInfo.nameBox, box: msg.box })
			} else if (msg.type === 'cancel') {
				if (!room.host) {
					this.send(peer, { type: 'error', message: 'Host is not currently connected to this room.' })
					return
				}
				this.send(room.host, { type: 'cancel', senderBox: guestInfo.nameBox })
				if (guestInfo.nameBox) {
					this.broadcast(room, { type: 'presence', event: 'cancelled_turn', nameBox: guestInfo.nameBox, members: this.roster(room) })
				}
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
		this.wss.close()
		await new Promise((resolve, reject) => {
			this.server.close(err => (err ? reject(err) : resolve()))
		})
	}
}

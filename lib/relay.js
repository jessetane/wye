import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptUpgrade } from './ws.js'

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT_DIR, 'public')
const INDEX_HTML = Buffer.from(
	fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
		.replace('{{README}}', escapeHtml(fs.readFileSync(path.join(ROOT_DIR, 'readme.md'), 'utf8').trim()))
)
const ROOM_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'room.html'))
const STYLE_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'))
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'))
const CRYPTO_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'crypto.js'))

function escapeHtml (str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function createRelay (opts = {}) {
	const rooms = new Map()
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost')
		if (req.method === 'GET' && url.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(INDEX_HTML)
			return
		}
		if (req.method === 'GET' && url.pathname === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
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
	})
	function getRoom (id) {
		let room = rooms.get(id)
		if (!room) {
			room = {
				id,
				metaBox: null,
				host: null,
				hostNameBox: null,
				guests: new Map(),
				steps: new Map()
			}
			rooms.set(id, room)
		}
		return room
	}
	function broadcast (room, payload, except = null) {
		const raw = JSON.stringify(payload)
		if (room.host && room.host !== except) room.host.send(raw)
		for (const guest of room.guests.keys()) {
			if (guest !== except) guest.send(raw)
		}
	}
	function roster (room) {
		const members = []
		if (room.host && room.hostNameBox) members.push({ role: 'host', nameBox: room.hostNameBox })
		for (const info of room.guests.values()) {
			members.push({ role: 'guest', nameBox: info.nameBox })
		}
		return members
	}
	function cleanupRoom (room) {
		if (!room.host && room.guests.size === 0) rooms.delete(room.id)
	}
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, 'http://localhost')
		const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
		const role = url.searchParams.get('role')
		if (!match || (role !== 'host' && role !== 'guest')) {
			socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
			socket.destroy()
			return
		}
		const roomId = match[1]
		const peer = acceptUpgrade(req, socket, head)
		const room = getRoom(roomId)
		if (role === 'host') {
			if (room.host) room.host.close()
			room.host = peer
			peer.on('message', raw => {
				const msg = JSON.parse(raw)
				if (msg.type === 'hello' && typeof msg.nameBox === 'string') {
					room.hostNameBox = msg.nameBox
					if (typeof msg.metaBox === 'string') room.metaBox = msg.metaBox
					peer.send({ type: 'ready', room: roomId, members: roster(room) })
					broadcast(room, {
						type: 'presence',
						event: 'host_joined',
						nameBox: room.hostNameBox,
						metaBox: room.metaBox,
						members: roster(room)
					}, peer)
				} else if (msg.type === 'step' && typeof msg.index === 'number' && typeof msg.box === 'string') {
					const entry = { index: msg.index, box: msg.box }
					room.steps.set(msg.index, entry)
					for (const guest of room.guests.keys()) {
						guest.send({ type: 'step', index: msg.index, box: msg.box })
					}
				}
			})
			peer.on('close', () => {
				if (room.host === peer) {
					const nameBox = room.hostNameBox
					room.host = null
					room.hostNameBox = null
					if (nameBox) {
						broadcast(room, { type: 'presence', event: 'host_left', nameBox, members: roster(room) })
					}
					cleanupRoom(room)
				}
			})
		} else {
			const guestInfo = { nameBox: null }
			room.guests.set(peer, guestInfo)
			peer.on('message', raw => {
				const msg = JSON.parse(raw)
				if (msg.type === 'hello' && typeof msg.nameBox === 'string') {
					guestInfo.nameBox = msg.nameBox
					const orderedSteps = [...room.steps.values()].sort((a, b) => a.index - b.index)
					peer.send({
						type: 'snapshot',
						room: roomId,
						metaBox: room.metaBox,
						members: roster(room),
						steps: orderedSteps
					})
					broadcast(room, {
						type: 'presence',
						event: 'guest_joined',
						nameBox: guestInfo.nameBox,
						members: roster(room)
					}, peer)
				} else if (msg.type === 'prompt' && typeof msg.box === 'string') {
					if (!room.host) {
						peer.send({ type: 'error', message: 'Host is not currently connected to this room.' })
						return
					}
					room.host.send({ type: 'prompt', senderBox: guestInfo.nameBox, box: msg.box })
				} else if (msg.type === 'cancel') {
					if (!room.host) {
						peer.send({ type: 'error', message: 'Host is not currently connected to this room.' })
						return
					}
					room.host.send({ type: 'cancel', senderBox: guestInfo.nameBox })
					if (guestInfo.nameBox) {
						broadcast(room, { type: 'presence', event: 'cancelled_turn', nameBox: guestInfo.nameBox, members: roster(room) })
					}
				}
			})
			peer.on('close', () => {
				if (room.guests.delete(peer)) {
					if (guestInfo.nameBox) {
						broadcast(room, { type: 'presence', event: 'guest_left', nameBox: guestInfo.nameBox, members: roster(room) })
					}
					cleanupRoom(room)
				}
			})
		}
	})
	const pingTimer = setInterval(() => {
		for (const room of rooms.values()) {
			if (room.host) room.host.ping()
			for (const guest of room.guests.keys()) guest.ping()
		}
	}, 25000)
	pingTimer.unref()
	return {
		server,
		rooms,
		async open (port = opts.port ?? 8787, host = opts.host ?? '127.0.0.1') {
			await new Promise((resolve, reject) => {
				server.once('error', reject)
				server.listen(port, host, resolve)
			})
			return server.address()
		},
		async close () {
			clearInterval(pingTimer)
			for (const room of rooms.values()) {
				if (room.host) room.host.close()
				for (const guest of room.guests.keys()) guest.close()
			}
			rooms.clear()
			await new Promise((resolve, reject) => {
				server.close(err => (err ? reject(err) : resolve()))
			})
		}
	}
}

import http from 'node:http'
import { acceptUpgrade } from './ws.js'

export function createRelay (opts = {}) {
	const rooms = new Map()
	const server = http.createServer((req, res) => {
		if (req.url === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
			return
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' })
		res.end('collab relay: connect with `collab join`')
	})
	function getRoom (id) {
		let room = rooms.get(id)
		if (!room) {
			room = {
				id,
				meta: null,
				host: null,
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
		if (room.meta) members.push({ role: 'host', name: room.meta.hostName })
		for (const info of room.guests.values()) {
			members.push({ role: 'guest', name: info.name })
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
		const name = (url.searchParams.get('name') || '').trim()
		if (!match || (role !== 'host' && role !== 'guest') || !name) {
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
			room.meta = {
				hostName: name,
				conversationId: url.searchParams.get('conversationId') || '',
				workspace: url.searchParams.get('workspace') || ''
			}
			peer.on('message', raw => {
				const msg = JSON.parse(raw)
				if (msg.type === 'step' && msg.step && typeof msg.step.index === 'number') {
					room.steps.set(msg.step.index, msg.step)
					for (const guest of room.guests.keys()) {
						guest.send({ type: 'step', step: msg.step })
					}
				}
			})
			peer.on('close', () => {
				if (room.host === peer) {
					room.host = null
					broadcast(room, { type: 'presence', event: 'host_left', name, members: roster(room) })
					cleanupRoom(room)
				}
			})
			peer.send({ type: 'ready', room: roomId, members: roster(room) })
			broadcast(room, { type: 'presence', event: 'host_joined', name, meta: room.meta, members: roster(room) }, peer)
		} else {
			room.guests.set(peer, { name })
			const orderedSteps = [...room.steps.values()].sort((a, b) => a.index - b.index)
			peer.send({
				type: 'snapshot',
				room: roomId,
				meta: room.meta,
				members: roster(room),
				steps: orderedSteps
			})
			broadcast(room, { type: 'presence', event: 'guest_joined', name, members: roster(room) }, peer)
			peer.on('message', raw => {
				const msg = JSON.parse(raw)
				if (msg.type === 'prompt') {
					const text = String(msg.text || '').trim()
					if (!text) return
					if (!room.host) {
						peer.send({ type: 'error', message: 'Host is not currently connected to this room.' })
						return
					}
					room.host.send({ type: 'prompt', sender: name, text })
				} else if (msg.type === 'cancel') {
					if (!room.host) {
						peer.send({ type: 'error', message: 'Host is not currently connected to this room.' })
						return
					}
					room.host.send({ type: 'cancel', sender: name })
					broadcast(room, { type: 'presence', event: 'cancelled_turn', name, members: roster(room) })
				}
			})
			peer.on('close', () => {
				if (room.guests.delete(peer)) {
					broadcast(room, { type: 'presence', event: 'guest_left', name, members: roster(room) })
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

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class WsPeer extends EventEmitter {
	constructor (socket) {
		super()
		this.socket = socket
		this.buffer = Buffer.alloc(0)
		this.fragments = []
		this.fragOpcode = 0
		this.closed = false
		socket.setNoDelay(true)
		socket.on('data', chunk => this.onData(chunk))
		socket.on('close', () => this.onClose())
		socket.on('error', err => this.emit('error', err))
	}

	onData (chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk])
		while (this.buffer.length >= 2) {
			const first = this.buffer[0]
			const second = this.buffer[1]
			const fin = (first & 0x80) !== 0
			const opcode = first & 0x0f
			const masked = (second & 0x80) !== 0
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (this.buffer.length < 4) return
				length = this.buffer.readUInt16BE(2)
				offset = 4
			} else if (length === 127) {
				if (this.buffer.length < 10) return
				length = Number(this.buffer.readBigUInt64BE(2))
				offset = 10
			}
			const maskLength = masked ? 4 : 0
			if (this.buffer.length < offset + maskLength + length) return
			const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length))
			if (masked) {
				const mask = this.buffer.subarray(offset, offset + 4)
				for (let i = 0; i < payload.length; i++) {
					payload[i] ^= mask[i & 3]
				}
			}
			this.buffer = this.buffer.subarray(offset + maskLength + length)
			if (opcode === 0x08) {
				this.close()
				return
			} else if (opcode === 0x09) {
				this.writeFrame(0x0a, payload)
			} else if (opcode === 0x00) {
				this.fragments.push(payload)
				if (fin) {
					const full = Buffer.concat(this.fragments)
					const doneOpcode = this.fragOpcode
					this.fragments = []
					this.fragOpcode = 0
					if (doneOpcode === 0x01) this.emit('message', full.toString('utf8'))
				}
			} else if (opcode === 0x01 || opcode === 0x02) {
				if (fin) {
					if (opcode === 0x01) this.emit('message', payload.toString('utf8'))
				} else {
					this.fragOpcode = opcode
					this.fragments = [payload]
				}
			}
		}
	}

	send (message) {
		if (this.closed) return
		const payload = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8')
		this.writeFrame(0x01, payload)
	}

	writeFrame (opcode, payload) {
		if (this.closed) return
		const len = payload.length
		let header
		if (len < 126) {
			header = Buffer.alloc(2)
			header[0] = 0x80 | opcode
			header[1] = len
		} else if (len < 65536) {
			header = Buffer.alloc(4)
			header[0] = 0x80 | opcode
			header[1] = 126
			header.writeUInt16BE(len, 2)
		} else {
			header = Buffer.alloc(10)
			header[0] = 0x80 | opcode
			header[1] = 127
			header.writeBigUInt64BE(BigInt(len), 2)
		}
		this.socket.write(Buffer.concat([header, payload]))
	}

	ping () {
		this.writeFrame(0x09, Buffer.alloc(0))
	}

	close () {
		if (this.closed) return
		this.closed = true
		this.socket.end(Buffer.from([0x88, 0x00]))
		this.emit('close')
	}

	onClose () {
		if (this.closed) return
		this.closed = true
		this.emit('close')
	}
}

export function acceptUpgrade (req, socket, head) {
	const key = req.headers['sec-websocket-key']
	if (!key) {
		socket.destroy()
		throw new Error('Missing Sec-WebSocket-Key header')
	}
	const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
	socket.write([
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${accept}`,
		'\r\n'
	].join('\r\n'))
	const peer = new WsPeer(socket)
	if (head && head.length > 0) peer.onData(head)
	return peer
}

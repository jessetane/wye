const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function concatBytes (chunks) {
	let total = 0
	for (const c of chunks) total += c.byteLength
	const out = new Uint8Array(total)
	let offset = 0
	for (const c of chunks) {
		out.set(c, offset)
		offset += c.byteLength
	}
	return out
}

export class WsPeer extends EventTarget {
	constructor (socket) {
		super()
		this.socket = socket
		this.buffer = new Uint8Array(0)
		this.fragments = []
		this.fragBytes = 0
		this.fragOpcode = 0
		this.closed = false
		this.alive = true
		socket.setNoDelay(true)
		socket.on('data', chunk => this.onData(chunk))
		socket.on('end', () => this.close(true))
		socket.on('close', () => this.close(true))
		socket.on('error', err => this.dispatchEvent(new CustomEvent('error', { detail: err })))
		socket.resume()
	}

	onData (chunk) {
		this.alive = true
		this.buffer = this.buffer.byteLength === 0 ? new Uint8Array(chunk) : concatBytes([this.buffer, chunk])
		while (this.buffer.byteLength >= 2) {
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
			const first = this.buffer[0]
			const second = this.buffer[1]
			const fin = (first & 0x80) !== 0
			const opcode = first & 0x0f
			const masked = (second & 0x80) !== 0
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (this.buffer.byteLength < 4) return
				length = view.getUint16(2)
				offset = 4
			} else if (length === 127) {
				if (this.buffer.byteLength < 10) return
				length = Number(view.getBigUint64(2))
				offset = 10
			}
			if (length > MAX_FRAME_BYTES) {
				this.close(true)
				return
			}
			const maskLength = masked ? 4 : 0
			if (this.buffer.byteLength < offset + maskLength + length) return
			const payload = this.buffer.slice(offset + maskLength, offset + maskLength + length)
			if (masked) {
				const mask = this.buffer.subarray(offset, offset + 4)
				for (let i = 0; i < payload.byteLength; i++) {
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
				this.fragBytes += payload.byteLength
				if (this.fragBytes > MAX_FRAME_BYTES) {
					this.close(true)
					return
				}
				this.fragments.push(payload)
				if (fin) {
					const full = concatBytes(this.fragments)
					const doneOpcode = this.fragOpcode
					this.fragments = []
					this.fragBytes = 0
					this.fragOpcode = 0
					if (doneOpcode === 0x01) {
						this.dispatchEvent(new MessageEvent('message', { data: decoder.decode(full) }))
					}
				}
			} else if (opcode === 0x01 || opcode === 0x02) {
				if (fin) {
					if (opcode === 0x01) {
						this.dispatchEvent(new MessageEvent('message', { data: decoder.decode(payload) }))
					}
				} else {
					this.fragOpcode = opcode
					this.fragBytes = payload.byteLength
					this.fragments = [payload]
				}
			}
		}
	}

	send (message) {
		if (this.closed) return
		const payload = encoder.encode(typeof message === 'string' ? message : JSON.stringify(message))
		this.writeFrame(0x01, payload)
	}

	writeFrame (opcode, payload) {
		if (this.closed || this.socket.destroyed || !this.socket.writable) return
		const len = payload.byteLength
		let header
		if (len < 126) {
			header = new Uint8Array(2)
			header[0] = 0x80 | opcode
			header[1] = len
		} else if (len < 65536) {
			header = new Uint8Array(4)
			header[0] = 0x80 | opcode
			header[1] = 126
			new DataView(header.buffer).setUint16(2, len)
		} else {
			header = new Uint8Array(10)
			header[0] = 0x80 | opcode
			header[1] = 127
			new DataView(header.buffer).setBigUint64(2, BigInt(len))
		}
		this.socket.write(concatBytes([header, payload]))
	}

	ping () {
		this.writeFrame(0x09, new Uint8Array(0))
	}

	close (force = false) {
		if (this.closed) return
		this.closed = true
		if (force || this.socket.destroyed || !this.socket.writable) {
			this.socket.destroy()
		} else {
			this.socket.end(new Uint8Array([0x88, 0x00]))
		}
		this.dispatchEvent(new Event('close'))
	}
}

export async function acceptUpgrade (req, socket, head) {
	const key = req.headers['sec-websocket-key']
	if (!key) {
		socket.destroy()
		throw new Error('Missing Sec-WebSocket-Key header')
	}
	socket.pause()
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(key + WS_GUID)))
	let binary = ''
	for (let i = 0; i < digest.byteLength; i++) binary += String.fromCharCode(digest[i])
	const accept = btoa(binary)
	socket.write([
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${accept}`,
		'\r\n'
	].join('\r\n'))
	const peer = new WsPeer(socket)
	if (head && head.byteLength > 0) peer.onData(head)
	return peer
}

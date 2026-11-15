import fs from 'node:fs'
import path from 'node:path'

export function watchJsonl (filePath, onLine) {
	let offset = 0
	let remainder = ''
	let decoder = new TextDecoder()
	let closed = false
	let dirWatcher = null
	let pollTimer = null
	function drain () {
		if (closed || !fs.existsSync(filePath)) return
		const stat = fs.statSync(filePath)
		if (stat.size < offset) {
			offset = 0
			remainder = ''
			decoder = new TextDecoder()
		}
		if (stat.size === offset) return
		const length = stat.size - offset
		const buf = new Uint8Array(length)
		const fd = fs.openSync(filePath, 'r')
		let bytesRead = 0
		try {
			bytesRead = fs.readSync(fd, buf, 0, length, offset)
		} finally {
			fs.closeSync(fd)
		}
		offset += bytesRead
		const chunk = remainder + decoder.decode(buf.subarray(0, bytesRead), { stream: true })
		const lines = chunk.split('\n')
		remainder = lines.pop()
		for (const line of lines) {
			const trimmed = line.trim()
			if (trimmed) onLine(trimmed)
		}
	}
	drain()
	const dir = path.dirname(filePath)
	fs.mkdirSync(dir, { recursive: true })
	dirWatcher = fs.watch(dir, () => drain())
	pollTimer = setInterval(drain, 400)
	pollTimer.unref()
	return function unwatch () {
		if (closed) return
		closed = true
		if (dirWatcher) dirWatcher.close()
		if (pollTimer) clearInterval(pollTimer)
	}
}

import fs from 'node:fs'
import path from 'node:path'

const USER_REQ_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

function summarizeTool (call) {
	const name = call.name
	const args = call.args || {}
	if (name === 'run_command') return { label: 'Bash', detail: String(args.CommandLine || args.toolSummary || '').replace(/\s+/g, ' ').slice(0, 96) }
	if (name === 'read_file') return { label: 'Read', detail: String(args.Path || '') }
	if (name === 'write_file') return { label: 'Write', detail: String(args.Path || '') }
	if (name === 'edit_file') return { label: 'Edit', detail: String(args.Path || '') }
	if (name === 'search_web') return { label: 'WebSearch', detail: String(args.query || '') }
	const firstVal = Object.values(args).find(v => typeof v === 'string')
	return { label: name, detail: firstVal ? firstVal.replace(/\s+/g, ' ').slice(0, 80) : '' }
}

export function parseStep (line) {
	const raw = JSON.parse(line)
	const index = raw.step_index
	if (typeof index !== 'number') return null
	if (raw.type === 'USER_INPUT') {
		const match = USER_REQ_RE.exec(raw.content || '')
		const text = (match ? match[1] : String(raw.content || '')).trim()
		if (!text) return null
		return {
			index,
			role: 'user',
			text,
			status: raw.status,
			createdAt: raw.created_at
		}
	}
	if (raw.type === 'PLANNER_RESPONSE') {
		const text = typeof raw.content === 'string' ? raw.content.trim() : ''
		const tools = Array.isArray(raw.tool_calls) ? raw.tool_calls.map(summarizeTool) : []
		if (!text && tools.length === 0) return null
		return {
			index,
			role: 'assistant',
			text,
			tools,
			status: raw.status,
			createdAt: raw.created_at
		}
	}
	if (raw.type === 'GENERIC' && raw.status === 'ERROR' && raw.error) {
		return {
			index,
			role: 'error',
			text: String(raw.error),
			status: raw.status,
			createdAt: raw.created_at
		}
	}
	return null
}

export function resolveTranscriptPath (appDataDir, conversationId) {
	const fullPath = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
	if (fs.existsSync(fullPath)) return fullPath
	const compactPath = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
	if (fs.existsSync(compactPath)) return compactPath
	return fullPath
}

export function watchTranscript (filePath, onStep) {
	let offset = 0
	let remainder = ''
	let closed = false
	let dirWatcher = null
	let pollTimer = null
	function drain () {
		if (closed || !fs.existsSync(filePath)) return
		const stat = fs.statSync(filePath)
		if (stat.size < offset) {
			offset = 0
			remainder = ''
		}
		if (stat.size === offset) return
		const length = stat.size - offset
		const buf = Buffer.alloc(length)
		const fd = fs.openSync(filePath, 'r')
		let bytesRead = 0
		try {
			bytesRead = fs.readSync(fd, buf, 0, length, offset)
		} finally {
			fs.closeSync(fd)
		}
		offset += bytesRead
		const chunk = remainder + buf.subarray(0, bytesRead).toString('utf8')
		const lines = chunk.split('\n')
		remainder = lines.pop()
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			const step = parseStep(trimmed)
			if (step) onStep(step)
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

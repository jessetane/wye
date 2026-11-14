import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { watchJsonl } from '../transcript.js'

const PEER_LEADS = [
	'Another Claude session sent a message while you were working:\n',
	'Another Claude session sent a message:\n',
	'A peer session sent a message while you were working:\n'
]
const PEER_TAIL_MARKERS = [
	'\n\nThis came from another Claude session ',
	'\n\nThat "other Claude session" is an agent working inside this same session ',
	'\n\nIMPORTANT: This is NOT from your user ',
	'\n\nThis is from another Claude session, not your user.'
]

export function unwrapPeerContent (text) {
	const lead = PEER_LEADS.find(prefix => text.startsWith(prefix))
	if (!lead) return text
	let body = text.slice(lead.length)
	for (const marker of PEER_TAIL_MARKERS) {
		const idx = body.lastIndexOf(marker)
		if (idx !== -1) {
			body = body.slice(0, idx)
			break
		}
	}
	return body.trim()
}

function summarizeClaudeTool (block) {
	const name = block.name || 'Tool'
	const input = block.input || {}
	if (name === 'Bash') return { label: 'Bash', detail: String(input.command || input.description || '').replace(/\s+/g, ' ').slice(0, 96) }
	if (name === 'Read') return { label: 'Read', detail: String(input.file_path || '') }
	if (name === 'Write') return { label: 'Write', detail: String(input.file_path || '') }
	if (name === 'Edit' || name === 'MultiEdit') return { label: name, detail: String(input.file_path || '') }
	if (name === 'Grep' || name === 'Glob') return { label: name, detail: String(input.pattern || '') }
	if (name === 'WebSearch') return { label: 'WebSearch', detail: String(input.query || '') }
	if (name === 'WebFetch') return { label: 'WebFetch', detail: String(input.url || '') }
	const firstVal = Object.values(input).find(v => typeof v === 'string')
	return { label: name, detail: firstVal ? firstVal.replace(/\s+/g, ' ').slice(0, 80) : '' }
}

export function createClaudeStepParser () {
	let nextIndex = 0
	const stepsByKey = new Map()
	return function parseLine (line) {
		const raw = JSON.parse(line)
		if (raw.isSidechain) return null
		if (raw.type === 'user') {
			if (raw.toolUseResult) return null
			if (raw.isMeta && raw.origin?.kind !== 'peer') return null
			const msgContent = raw.message?.content
			let text = ''
			if (typeof msgContent === 'string') {
				text = msgContent
			} else if (Array.isArray(msgContent)) {
				if (msgContent.every(b => b.type === 'tool_result')) return null
				text = msgContent.filter(b => b.type === 'text').map(b => b.text).join('\n')
			}
			text = unwrapPeerContent(text).trim()
			if (!text || text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]') return null
			const key = `user:${raw.uuid || nextIndex}`
			let step = stepsByKey.get(key)
			if (!step) {
				step = {
					index: nextIndex++,
					role: 'user',
					text,
					status: 'DONE',
					createdAt: raw.timestamp
				}
				stepsByKey.set(key, step)
			} else {
				step.text = text
			}
			return { ...step }
		}
		if (raw.type === 'assistant') {
			const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
			const textParts = []
			const toolParts = []
			for (const b of blocks) {
				if (b.type === 'text' && b.text) textParts.push(b.text)
				else if (b.type === 'tool_use') toolParts.push({ id: b.id, ...summarizeClaudeTool(b) })
			}
			if (textParts.length === 0 && toolParts.length === 0) return null
			const msgId = raw.message?.id || raw.uuid || String(nextIndex)
			const key = `assistant:${msgId}`
			let entry = stepsByKey.get(key)
			if (!entry) {
				entry = {
					index: nextIndex++,
					textChunks: [],
					seenChunkUuids: new Set(),
					toolsById: new Map(),
					createdAt: raw.timestamp
				}
				stepsByKey.set(key, entry)
			}
			const chunkId = raw.uuid || JSON.stringify(blocks)
			if (!entry.seenChunkUuids.has(chunkId)) {
				entry.seenChunkUuids.add(chunkId)
				for (const t of textParts) entry.textChunks.push(t)
				for (const tool of toolParts) {
					const toolKey = tool.id || `${tool.label}:${tool.detail}:${entry.toolsById.size}`
					entry.toolsById.set(toolKey, { label: tool.label, detail: tool.detail })
				}
			}
			const combinedText = entry.textChunks.join('').trim()
			const tools = [...entry.toolsById.values()]
			if (!combinedText && tools.length === 0) return null
			return {
				index: entry.index,
				role: 'assistant',
				text: combinedText,
				tools,
				status: raw.message?.stop_reason ? 'DONE' : 'RUNNING',
				createdAt: entry.createdAt
			}
		}
		return null
	}
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

export function resolveClaudeConfigDir (env = process.env) {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function slugifyClaudeProject (cwd) {
	return cwd.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function resolveClaudeTranscript (configDir, sessionId, cwd) {
	const projectsDir = path.join(configDir, 'projects')
	if (cwd) {
		const direct = path.join(projectsDir, slugifyClaudeProject(cwd), `${sessionId}.jsonl`)
		if (fs.existsSync(direct)) return direct
		const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd
		const realCandidate = path.join(projectsDir, slugifyClaudeProject(real), `${sessionId}.jsonl`)
		if (fs.existsSync(realCandidate)) return realCandidate
	}
	if (fs.existsSync(projectsDir)) {
		for (const slug of fs.readdirSync(projectsDir)) {
			const candidate = path.join(projectsDir, slug, `${sessionId}.jsonl`)
			if (fs.existsSync(candidate)) return candidate
		}
	}
	return path.join(projectsDir, slugifyClaudeProject(cwd || process.cwd()), `${sessionId}.jsonl`)
}

function readPeerToken (sessionsDir, pid, socketPath) {
	const canonical = fs.existsSync(socketPath) ? fs.realpathSync(socketPath) : path.resolve(socketPath)
	const hashes = new Set([
		crypto.createHash('sha256').update(path.resolve(socketPath)).digest('hex'),
		crypto.createHash('sha256').update(canonical).digest('hex')
	])
	for (const hash of hashes) {
		const keyFile = path.join(sessionsDir, `${pid}.${hash}.key`)
		if (fs.existsSync(keyFile)) {
			const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
			if (parsed.peerToken) return parsed.peerToken
		}
	}
	return ''
}

export function discoverClaudeSession (opts = {}) {
	const env = opts.env || process.env
	const configDir = opts.claudeConfigDir || resolveClaudeConfigDir(env)
	const sessionsDir = path.join(configDir, 'sessions')
	const targetId = opts.conversationId || opts.sessionId || ''
	const targetSock = opts.socketPath || env.CLAUDE_CODE_MESSAGING_SOCKET || ''
	const targetCwd = opts.workspace || process.cwd()
	const candidates = []
	if (fs.existsSync(sessionsDir)) {
		for (const file of fs.readdirSync(sessionsDir)) {
			if (!/^\d+\.json$/.test(file)) continue
			const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'))
			if (!rec.pid || !isProcessAlive(rec.pid)) continue
			candidates.push(rec)
		}
	}
	let chosen = null
	if (targetId) {
		chosen = candidates.find(c => c.sessionId === targetId || c.jobId === targetId || c.name === targetId)
	}
	if (!chosen && targetSock) {
		chosen = candidates.find(c => c.messagingSocketPath === targetSock)
	}
	if (!chosen && candidates.length > 0) {
		const realTargetCwd = fs.existsSync(targetCwd) ? fs.realpathSync(targetCwd) : targetCwd
		const sameCwd = candidates.filter(c => {
			if (!c.cwd) return false
			const realRecCwd = fs.existsSync(c.cwd) ? fs.realpathSync(c.cwd) : c.cwd
			return realRecCwd === realTargetCwd
		})
		const pool = sameCwd.length > 0 ? sameCwd : (candidates.length === 1 ? candidates : [])
		pool.sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
		chosen = pool[0] || null
	}
	const sessionId = chosen?.sessionId || targetId
	const socketPath = chosen?.messagingSocketPath || targetSock
	const pid = chosen?.pid || opts.claudePid || null
	const workspace = chosen?.cwd || targetCwd
	if (!sessionId || !socketPath) {
		throw new Error('Could not locate an active Claude Code session with a messaging socket. Launch `wye host` from inside Claude Code (or pass `--session <session-id>` in the project directory).')
	}
	const token = opts.socketToken || env.CLAUDE_CODE_MESSAGING_TOKEN || (pid ? readPeerToken(sessionsDir, pid, socketPath) : '')
	const transcriptPath = opts.transcriptPath || resolveClaudeTranscript(configDir, sessionId, workspace)
	return {
		pid,
		sessionId,
		socketPath,
		token,
		workspace,
		transcriptPath
	}
}

function sendUdsFrame (socketPath, token, frame) {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: socketPath })
		let failed = false
		sock.setTimeout(5000, () => {
			failed = true
			sock.destroy()
			reject(new Error(`Timed out writing to Claude Code socket ${socketPath}`))
		})
		sock.on('error', err => {
			failed = true
			reject(err)
		})
		sock.on('connect', () => {
			const lines = []
			if (token) lines.push(JSON.stringify({ type: 'auth', token }))
			lines.push(JSON.stringify(frame))
			sock.write(lines.join('\n') + '\n')
			setTimeout(() => {
				if (!sock.destroyed) sock.end()
			}, 30)
		})
		sock.on('close', () => {
			if (!failed) resolve()
		})
	})
}

export function createClaudeHarness (opts = {}) {
	const session = discoverClaudeSession(opts)
	const parseLine = createClaudeStepParser()
	return {
		type: 'claude',
		conversationId: session.sessionId,
		workspace: session.workspace,
		transcriptPath: session.transcriptPath,
		watch (onStep) {
			return watchJsonl(session.transcriptPath, line => {
				const step = parseLine(line)
				if (step) onStep(step)
			})
		},
		async send (text) {
			await sendUdsFrame(session.socketPath, session.token, {
				msgV: 1,
				msg_id: crypto.randomUUID(),
				type: 'user',
				session_id: session.sessionId,
				message: {
					role: 'user',
					content: text
				}
			})
		},
		async cancel () {
			await sendUdsFrame(session.socketPath, session.token, {
				msgV: 1,
				msg_id: crypto.randomUUID(),
				type: 'user',
				priority: 'now',
				session_id: session.sessionId,
				message: {
					role: 'user',
					content: 'Stop the current task immediately and wait for the next instruction.'
				}
			})
		}
	}
}

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { watchJsonl } from '../transcript.js'
import { capToolText, normalizeToolCall } from './tools.js'

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

function extractToolResultText (block, toolUseResult) {
	if (typeof block.content === 'string') return capToolText(block.content)
	if (Array.isArray(block.content)) {
		const joined = block.content
			.map(item => (typeof item === 'string' ? item : (item && item.type === 'text' ? item.text : JSON.stringify(item))))
			.filter(Boolean)
			.join('\n')
		if (joined) return capToolText(joined)
	}
	if (toolUseResult && typeof toolUseResult === 'object') {
		const parts = []
		if (toolUseResult.stdout) parts.push(String(toolUseResult.stdout))
		if (toolUseResult.stderr) parts.push(String(toolUseResult.stderr))
		if (parts.length > 0) return capToolText(parts.join('\n'))
	}
	return ''
}

function buildAssistantStep (entry) {
	const combinedText = entry.textChunks.join('').trim()
	const combinedThinking = entry.thinkingChunks.join('\n').trim()
	const tools = [...entry.toolsById.values()].map(t => ({ ...t }))
	if (!combinedText && !combinedThinking && tools.length === 0) return null
	return {
		index: entry.index,
		role: 'assistant',
		text: combinedText,
		thinking: combinedThinking ? capToolText(combinedThinking) : '',
		thinkingTokens: entry.thinkingTokens,
		tools,
		status: entry.status,
		createdAt: entry.createdAt
	}
}

export function createStepParser (opts = {}) {
	const homeDir = opts.homeDir ?? os.homedir()
	let nextIndex = 0
	const stepsByKey = new Map()
	const toolsByUseId = new Map()
	return function parseLine (line) {
		const raw = JSON.parse(line)
		if (raw.isSidechain) return null
		if (raw.type === 'user') {
			const msgContent = raw.message?.content
			if (Array.isArray(msgContent)) {
				let updatedEntry = null
				for (const b of msgContent) {
					if (b && b.type === 'tool_result' && b.tool_use_id && toolsByUseId.has(b.tool_use_id)) {
						const ref = toolsByUseId.get(b.tool_use_id)
						const tool = ref.entry.toolsById.get(ref.toolKey)
						if (tool) {
							const isError = Boolean(
								b.is_error ||
								raw.toolUseResult?.interrupted ||
								(typeof raw.toolUseResult?.returnCode === 'number' && raw.toolUseResult.returnCode !== 0)
							)
							tool.status = isError ? 'error' : 'done'
							tool.output = extractToolResultText(b, raw.toolUseResult)
							updatedEntry = ref.entry
						}
					}
				}
				if (updatedEntry && msgContent.every(b => b.type === 'tool_result')) {
					return buildAssistantStep(updatedEntry)
				}
			}
			if (raw.toolUseResult) return null
			if (raw.isMeta && raw.origin?.kind !== 'peer') return null
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
			const thinkingParts = []
			const textParts = []
			const toolParts = []
			for (const b of blocks) {
				if (b.type === 'thinking' && b.thinking) thinkingParts.push(b.thinking)
				else if (b.type === 'text' && b.text) textParts.push(b.text)
				else if (b.type === 'tool_use') toolParts.push({ id: b.id, ...normalizeToolCall(b.name, b.input || {}, homeDir) })
			}
			if (thinkingParts.length === 0 && textParts.length === 0 && toolParts.length === 0) return null
			const msgId = raw.message?.id || raw.uuid || String(nextIndex)
			const key = `assistant:${msgId}`
			let entry = stepsByKey.get(key)
			if (!entry) {
				entry = {
					index: nextIndex++,
					thinkingChunks: [],
					thinkingTokens: null,
					textChunks: [],
					seenChunkUuids: new Set(),
					toolsById: new Map(),
					status: 'RUNNING',
					createdAt: raw.timestamp
				}
				stepsByKey.set(key, entry)
			}
			if (typeof raw.message?.usage?.output_tokens === 'number') {
				entry.thinkingTokens = raw.message.usage.output_tokens
			}
			if (raw.message?.stop_reason) entry.status = 'DONE'
			const chunkId = raw.uuid || JSON.stringify(blocks)
			if (!entry.seenChunkUuids.has(chunkId)) {
				entry.seenChunkUuids.add(chunkId)
				for (const th of thinkingParts) entry.thinkingChunks.push(th)
				for (const t of textParts) entry.textChunks.push(t)
				for (const tool of toolParts) {
					const toolKey = tool.id || `${tool.label}:${tool.detail}:${entry.toolsById.size}`
					const { id, ...normalized } = tool
					entry.toolsById.set(toolKey, normalized)
					if (id) toolsByUseId.set(id, { entry, toolKey })
				}
			}
			return buildAssistantStep(entry)
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

export function resolveConfigDir (env = process.env) {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function slugifyProject (cwd) {
	return cwd.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function resolveTranscript (configDir, sessionId, cwd) {
	const projectsDir = path.join(configDir, 'projects')
	if (cwd) {
		const direct = path.join(projectsDir, slugifyProject(cwd), `${sessionId}.jsonl`)
		if (fs.existsSync(direct)) return direct
		const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd
		const realCandidate = path.join(projectsDir, slugifyProject(real), `${sessionId}.jsonl`)
		if (fs.existsSync(realCandidate)) return realCandidate
	}
	if (fs.existsSync(projectsDir)) {
		for (const slug of fs.readdirSync(projectsDir)) {
			const candidate = path.join(projectsDir, slug, `${sessionId}.jsonl`)
			if (fs.existsSync(candidate)) return candidate
		}
	}
	return path.join(projectsDir, slugifyProject(cwd || process.cwd()), `${sessionId}.jsonl`)
}

async function sha256Hex (str) {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)))
	let hex = ''
	for (let i = 0; i < bytes.byteLength; i++) hex += bytes[i].toString(16).padStart(2, '0')
	return hex
}

async function readPeerToken (sessionsDir, pid, socketPath) {
	const canonical = fs.existsSync(socketPath) ? fs.realpathSync(socketPath) : path.resolve(socketPath)
	const hashes = new Set([
		await sha256Hex(path.resolve(socketPath)),
		await sha256Hex(canonical)
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

export async function discoverSession (opts = {}) {
	const env = opts.env || process.env
	const configDir = opts.claudeConfigDir || resolveConfigDir(env)
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
	if (!sessionId || !socketPath) return null
	const token = opts.socketToken || env.CLAUDE_CODE_MESSAGING_TOKEN || (pid ? await readPeerToken(sessionsDir, pid, socketPath) : '')
	const transcriptPath = opts.transcriptPath || resolveTranscript(configDir, sessionId, workspace)
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

export async function createHarness (opts = {}) {
	const session = opts.session || await discoverSession(opts)
	if (!session) {
		throw new Error('Could not locate an active Claude Code session with a messaging socket. Launch `wye host` from inside Claude Code (or pass `--session <session-id>` in the project directory).')
	}
	const parseLine = createStepParser({ homeDir: opts.homeDir })
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

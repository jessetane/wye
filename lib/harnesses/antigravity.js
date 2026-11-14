import fs from 'node:fs'
import path from 'node:path'
import { watchJsonl } from '../transcript.js'

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

export function parseAntigravityStep (line) {
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

export function resolveAntigravityTranscript (appDataDir, conversationId) {
	const fullPath = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
	if (fs.existsSync(fullPath)) return fullPath
	const compactPath = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
	if (fs.existsSync(compactPath)) return compactPath
	return fullPath
}

async function callLsRpc (lsAddress, csrfToken, method, body) {
	const res = await fetch(`http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Connect-Protocol-Version': '1',
			'x-codeium-csrf-token': csrfToken
		},
		body: JSON.stringify(body)
	})
	if (!res.ok) {
		const detail = await res.text()
		throw new Error(`${method} failed (${res.status}): ${detail}`)
	}
}

export function createAntigravityHarness (opts = {}) {
	const env = opts.env || process.env
	const conversationId = opts.conversationId || env.ANTIGRAVITY_CONVERSATION_ID
	const appDataDir = opts.appDataDir || env.ANTIGRAVITY_APP_DATA_DIR
	const lsAddress = opts.lsAddress || env.ANTIGRAVITY_LS_ADDRESS
	const csrfToken = opts.csrfToken || env.ANTIGRAVITY_CSRF_TOKEN
	if (!conversationId || !appDataDir || !lsAddress || !csrfToken) {
		throw new Error('Missing Antigravity session environment (ANTIGRAVITY_CONVERSATION_ID, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN).')
	}
	const workspace = opts.workspace || process.cwd()
	const transcriptPath = opts.transcriptPath || resolveAntigravityTranscript(appDataDir, conversationId)
	return {
		type: 'antigravity',
		conversationId,
		workspace,
		transcriptPath,
		watch (onStep) {
			return watchJsonl(transcriptPath, line => {
				const step = parseAntigravityStep(line)
				if (step) onStep(step)
			})
		},
		async send (text) {
			await callLsRpc(lsAddress, csrfToken, 'SendUserCascadeMessage', {
				cascadeId: conversationId,
				items: [{ text }]
			})
		},
		async cancel () {
			await callLsRpc(lsAddress, csrfToken, 'CancelCascadeInvocation', {
				cascadeId: conversationId,
				killBackgroundTasks: false
			})
		}
	}
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watchJsonl } from '../transcript.js'
import { capToolText, normalizeToolCall } from './tools.js'

const USER_REQ_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/
const STAMP_HEADER_RE = /^(?:(?:Created|Completed) At: [^\n]*\n)+/
const BG_TASK_ID_RE = /Tool is running as a background task with task id:\s*([^\s]+)/
const SYS_TASK_DONE_RE = /sender=([^\s]+)\s+priority=[^\s]+\s+content=Task id "[^"]+" (finished|was canceled) with result:\n([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|\s*$)/
const NONZERO_EXIT_RE = /^Command exited with code [1-9]\d*\b/m

function cleanGenericContent (content, error) {
	const stripped = String(content || '').replace(/\r\n/g, '\n').replace(STAMP_HEADER_RE, '').trim()
	if (error && !stripped.includes(String(error))) {
		return capToolText(stripped ? `${stripped}\n${error}` : String(error))
	}
	return capToolText(stripped)
}

function snapshotStep (step) {
	return {
		...step,
		tools: step.tools ? step.tools.map(t => ({ ...t })) : undefined
	}
}

export function createStepParser (opts = {}) {
	const homeDir = opts.homeDir ?? os.homedir()
	const pendingQueue = []
	const tasksById = new Map()
	return function parseLine (line) {
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
			pendingQueue.length = 0
			const text = typeof raw.content === 'string' ? raw.content.trim() : ''
			const thinking = typeof raw.thinking === 'string' ? raw.thinking.trim() : ''
			const thinkingTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : null
			const tools = Array.isArray(raw.tool_calls)
				? raw.tool_calls.map(c => normalizeToolCall(c.name, c.args || {}, homeDir))
				: []
			if (!text && !thinking && tools.length === 0) return null
			const step = {
				index,
				role: 'assistant',
				text,
				thinking: thinking ? capToolText(thinking) : '',
				thinkingTokens,
				tools,
				status: raw.status,
				createdAt: raw.created_at
			}
			for (let i = 0; i < tools.length; i++) {
				pendingQueue.push({ step, toolIndex: i })
			}
			return snapshotStep(step)
		}
		if (raw.type === 'GENERIC') {
			const output = cleanGenericContent(raw.content, raw.error)
			if (pendingQueue.length > 0) {
				const { step, toolIndex } = pendingQueue.shift()
				const tool = step.tools[toolIndex]
				const bgMatch = BG_TASK_ID_RE.exec(raw.content || '')
				if (bgMatch) tasksById.set(bgMatch[1], { step, toolIndex })
				if (raw.status === 'RUNNING') {
					tool.status = 'running'
				} else if (raw.status === 'ERROR' || NONZERO_EXIT_RE.test(output)) {
					tool.status = 'error'
				} else {
					tool.status = 'done'
				}
				tool.output = output
				return snapshotStep(step)
			}
			if (raw.status === 'ERROR' && (raw.error || output)) {
				return {
					index,
					role: 'error',
					text: String(raw.error || output),
					status: raw.status,
					createdAt: raw.created_at
				}
			}
			return null
		}
		if (raw.type === 'SYSTEM_MESSAGE') {
			const match = SYS_TASK_DONE_RE.exec(raw.content || '')
			if (!match) return null
			const target = tasksById.get(match[1])
			if (!target) return null
			const outcome = match[2]
			const output = capToolText(match[3].trim())
			const tool = target.step.tools[target.toolIndex]
			tool.status = (outcome === 'was canceled' || NONZERO_EXIT_RE.test(output)) ? 'error' : 'done'
			tool.output = output
			tasksById.delete(match[1])
			return snapshotStep(target.step)
		}
		return null
	}
}

export function resolveTranscript (appDataDir, conversationId) {
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

export function createHarness (opts = {}) {
	const env = opts.env || process.env
	const conversationId = opts.conversationId || env.ANTIGRAVITY_CONVERSATION_ID
	const appDataDir = opts.appDataDir || env.ANTIGRAVITY_APP_DATA_DIR
	const lsAddress = opts.lsAddress || env.ANTIGRAVITY_LS_ADDRESS
	const csrfToken = opts.csrfToken || env.ANTIGRAVITY_CSRF_TOKEN
	const missing = []
	if (!conversationId) missing.push('ANTIGRAVITY_CONVERSATION_ID')
	if (!appDataDir) missing.push('ANTIGRAVITY_APP_DATA_DIR')
	if (!lsAddress) missing.push('ANTIGRAVITY_LS_ADDRESS')
	if (!csrfToken) missing.push('ANTIGRAVITY_CSRF_TOKEN')
	if (missing.length > 0) {
		throw new Error(
			`Missing Antigravity session environment (${missing.join(', ')}).\n` +
			'Antigravity only injects these variables into agent tool calls (not `!` bash mode or external terminals).\n' +
			'Ask your Antigravity agent to share this conversation (via the wye skill) instead.'
		)
	}
	const workspace = opts.workspace || process.cwd()
	const transcriptPath = opts.transcriptPath || resolveTranscript(appDataDir, conversationId)
	const parseLine = createStepParser({ homeDir: opts.homeDir })
	return {
		type: 'antigravity',
		conversationId,
		workspace,
		transcriptPath,
		watch (onStep) {
			return watchJsonl(transcriptPath, line => {
				const step = parseLine(line)
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

import os from 'node:os'
import readline from 'node:readline'
import { DEFAULT_RELAY_URL, normalizeRelayWsUrl } from './host.js'
import { importKey, encryptJson, decryptJson } from '../public/crypto.js'

const MAX_EXPANDED_LINES = 120

const ANSI = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	code: '\x1b[38;5;110m',
	userBar: '\x1b[48;5;235m'
}

function styleMarkdown (text) {
	return text
		.replace(/^(#{1,4}\s+.*)$/gm, `${ANSI.code}${ANSI.bold}$1${ANSI.reset}`)
		.replace(/`([^`\n]+)`/g, `${ANSI.code}$1${ANSI.reset}`)
		.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
}

function indentBlock (text, prefix, maxLines = MAX_EXPANDED_LINES) {
	const rawLines = String(text || '').split('\n')
	const slice = rawLines.slice(0, maxLines)
	const out = slice.map((l, idx) => `${idx === 0 ? prefix.first : prefix.rest}${l}`)
	if (rawLines.length > maxLines) {
		out.push(`${prefix.rest}… (+${rawLines.length - maxLines} lines)`)
	}
	return out.join('\n')
}

function formatToolLine (t, isLast, expanded) {
	const status = t.status || 'done'
	const dotColor = status === 'error' ? ANSI.red : (status === 'running' ? ANSI.yellow : ANSI.green)
	const detail = t.detail ? `(${t.detail})` : ''
	const hint = isLast ? `${ANSI.dim} (ctrl+o to ${expanded ? 'collapse' : 'expand'})${ANSI.reset}` : ''
	const lines = [`${dotColor}●${ANSI.reset} ${ANSI.yellow}${ANSI.bold}${t.label}${ANSI.reset}${detail}${hint}`]
	if (expanded) {
		if (t.input) {
			lines.push(`${ANSI.dim}${indentBlock(t.input, { first: '  │ ', rest: '  │ ' })}${ANSI.reset}`)
		}
		if (t.output) {
			const color = status === 'error' ? ANSI.red : ANSI.dim
			lines.push(`${color}${indentBlock(t.output, { first: '  └ ', rest: '    ' })}${ANSI.reset}`)
		} else if (status === 'running') {
			lines.push(`${ANSI.dim}  └ Running…${ANSI.reset}`)
		}
	} else if (status === 'error' && t.output) {
		const firstErr = t.output.split('\n').find(Boolean) || 'Tool error'
		lines.push(`${ANSI.red}  └ ✖ ${firstErr.slice(0, 140)}${ANSI.reset}`)
	}
	return lines.join('\n')
}

export function formatStep (step, prev = null, opts = {}) {
	const expanded = Boolean(opts.expanded)
	const lines = []
	if (step.role === 'user') {
		if (prev && prev.text === step.text) return ''
		lines.push(`\n${ANSI.userBar}${ANSI.dim}[>${ANSI.reset}${ANSI.userBar} ${ANSI.cyan}${ANSI.bold}${step.text}${ANSI.reset}`)
		return lines.join('\n')
	}
	if (step.role === 'assistant') {
		if (step.thinking && (!prev || !prev.hadThinking)) {
			const tok = step.thinkingTokens ? `, ${step.thinkingTokens} tokens` : ''
			if (expanded) {
				lines.push(`${ANSI.dim}▾ Thought${tok}\n${indentBlock(step.thinking, { first: '  ', rest: '  ' })}${ANSI.reset}`)
			} else {
				const oneLine = step.thinking.replace(/\s+/g, ' ').slice(0, 110)
				const ellipsis = step.thinking.length > 110 ? '…' : ''
				lines.push(`${ANSI.dim}▸ Thought${tok}\n  ${oneLine}${ellipsis}${ANSI.reset}`)
			}
		}
		const tools = step.tools || []
		const prevTools = prev ? prev.tools : []
		for (let i = 0; i < tools.length; i++) {
			const t = tools[i]
			const pt = prevTools[i]
			const isLast = i === tools.length - 1
			if (!pt) {
				lines.push(formatToolLine(t, isLast, expanded))
			} else if (expanded && pt.output !== t.output && t.output) {
				const color = t.status === 'error' ? ANSI.red : ANSI.dim
				lines.push(`${color}${indentBlock(t.output, { first: `  └ (${t.label}) `, rest: '    ' })}${ANSI.reset}`)
			} else if (!expanded && pt.status !== 'error' && t.status === 'error' && t.output) {
				const firstErr = t.output.split('\n').find(Boolean) || 'Tool error'
				lines.push(`${ANSI.red}  └ (${t.label}) ✖ ${firstErr.slice(0, 140)}${ANSI.reset}`)
			}
		}
		if (step.text && (!prev || prev.text !== step.text)) {
			lines.push(`\n${styleMarkdown(step.text)}`)
		}
		return lines.join('\n')
	}
	if (step.role === 'error') {
		if (prev && prev.text === step.text) return ''
		lines.push(`${ANSI.red}✖ ${step.text}${ANSI.reset}`)
		return lines.join('\n')
	}
	return ''
}

export function parseJoinTarget (target, defaultRelay) {
	if (/^(ws|wss|http|https):\/\//.test(target)) {
		const u = new URL(target)
		const parts = u.pathname.split('/').filter(Boolean)
		const room = parts[parts.length - 1]
		if (!room) throw new Error(`Missing room token in URL: ${target}`)
		const relayUrl = `${u.protocol}//${u.host}`
		const key = u.hash ? u.hash.slice(1) : ''
		return { relayUrl, room, key }
	}
	const hashIdx = target.indexOf('#')
	if (hashIdx !== -1) {
		return {
			relayUrl: defaultRelay,
			room: target.slice(0, hashIdx),
			key: target.slice(hashIdx + 1)
		}
	}
	return { relayUrl: defaultRelay, room: target, key: '' }
}

async function decryptRoster (cryptoKey, members) {
	const out = []
	for (const m of members || []) {
		const name = m.nameBox ? await decryptJson(cryptoKey, m.nameBox) : 'unknown'
		out.push({ role: m.role, name })
	}
	return out
}

export async function connectGuest (opts = {}) {
	const env = opts.env || process.env
	const defaultRelay = opts.relayUrl || env.WYE_RELAY || DEFAULT_RELAY_URL
	const parsed = opts.target ? parseJoinTarget(opts.target, defaultRelay) : { relayUrl: defaultRelay, room: opts.room, key: '' }
	const relayUrl = parsed.relayUrl
	const room = parsed.room
	const key = opts.key || parsed.key || env.WYE_KEY || ''
	if (!room) throw new Error('Room token or URL is required to join.')
	if (!key) throw new Error('Missing room encryption key (#<key> in URL or --key / WYE_KEY).')
	const cryptoKey = await importKey(key)
	const name = opts.name || env.WYE_NAME || os.userInfo().username
	const input = opts.input || process.stdin
	const output = opts.output || process.stdout
	const interactive = opts.interactive ?? Boolean(input.isTTY)
	const wsUrl = normalizeRelayWsUrl(relayUrl, room, { role: 'guest' })
	const ws = new WebSocket(wsUrl)
	const stepsByIndex = new Map()
	const rendered = new Map()
	let expanded = Boolean(opts.expanded)
	let bannerLine = ''
	let rl = null
	let messageChain = Promise.resolve()
	function snapshotRecord (step) {
		return {
			text: step.text || '',
			hadThinking: Boolean(step.thinking),
			tools: Array.isArray(step.tools) ? step.tools.map(t => ({ status: t.status, output: t.output })) : []
		}
	}
	function writeLine (text) {
		if (!text) return
		if (rl && interactive) {
			readline.clearLine(output, 0)
			readline.cursorTo(output, 0)
			output.write(`${text}\n`)
			rl.prompt(true)
		} else {
			output.write(`${text}\n`)
		}
	}
	function redrawAll () {
		rendered.clear()
		output.write('\x1b[2J\x1b[H')
		if (bannerLine) output.write(`${bannerLine}\n`)
		const ordered = [...stepsByIndex.values()].sort((a, b) => a.index - b.index)
		for (const step of ordered) {
			const formatted = formatStep(step, null, { expanded })
			rendered.set(step.index, snapshotRecord(step))
			if (formatted) output.write(`${formatted}\n`)
		}
		if (rl && interactive) rl.prompt(true)
	}
	function handleStep (step) {
		stepsByIndex.set(step.index, step)
		const prev = rendered.get(step.index)
		const formatted = formatStep(step, prev, { expanded })
		rendered.set(step.index, snapshotRecord(step))
		if (formatted) writeLine(formatted)
		if (opts.onStep) opts.onStep(step)
	}
	await new Promise((resolve, reject) => {
		function onOpen () {
			ws.removeEventListener('error', onError)
			resolve()
		}
		function onError () {
			reject(new Error(`Failed to connect to wye relay at ${wsUrl}`))
		}
		ws.addEventListener('open', onOpen, { once: true })
		ws.addEventListener('error', onError, { once: true })
	})
	ws.addEventListener('message', event => {
		messageChain = messageChain.then(async () => {
			const msg = JSON.parse(String(event.data))
			if (msg.type === 'snapshot') {
				const meta = msg.metaBox ? await decryptJson(cryptoKey, msg.metaBox) : null
				const members = await decryptRoster(cryptoKey, msg.members)
				const who = members.map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', ')
				const wsInfo = meta && meta.workspace ? ` · ${meta.workspace}` : ''
				bannerLine = `${ANSI.dim}── connected to room ${msg.room} (${who}${wsInfo}) ──${ANSI.reset}`
				writeLine(bannerLine)
				const steps = []
				for (const item of msg.steps || []) {
					const step = await decryptJson(cryptoKey, item.box)
					steps.push(step)
					handleStep(step)
				}
				if (opts.onSnapshot) opts.onSnapshot({ room: msg.room, meta, members, steps })
			} else if (msg.type === 'step' && typeof msg.box === 'string') {
				const step = await decryptJson(cryptoKey, msg.box)
				handleStep(step)
			} else if (msg.type === 'presence') {
				const peerName = msg.nameBox ? await decryptJson(cryptoKey, msg.nameBox) : 'peer'
				const members = await decryptRoster(cryptoKey, msg.members)
				const label = msg.event.replaceAll('_', ' ')
				writeLine(`${ANSI.dim}── ${peerName} ${label} ──${ANSI.reset}`)
				if (opts.onPresence) opts.onPresence({ event: msg.event, name: peerName, members })
			} else if (msg.type === 'error') {
				writeLine(`${ANSI.red}✖ ${msg.message}${ANSI.reset}`)
			}
		}).catch(err => {
			writeLine(`${ANSI.red}✖ Decryption error (check room #key): ${err.message}${ANSI.reset}`)
			if (opts.onError) opts.onError(err)
		})
	})
	const nameBox = await encryptJson(cryptoKey, name)
	ws.send(JSON.stringify({ type: 'hello', nameBox }))
	async function sendEncryptedPrompt (text) {
		const box = await encryptJson(cryptoKey, { text })
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'prompt', box }))
		}
	}
	if (interactive) {
		rl = readline.createInterface({
			input,
			output,
			prompt: `${ANSI.cyan}>${ANSI.reset} `
		})
		if (typeof rl._ttyWrite === 'function') {
			const origTtyWrite = rl._ttyWrite.bind(rl)
			rl._ttyWrite = (s, key) => {
				if (key && key.ctrl && key.name === 'o') {
					expanded = !expanded
					redrawAll()
					return
				}
				origTtyWrite(s, key)
			}
		}
		rl.on('line', line => {
			const trimmed = line.trim()
			if (trimmed === '/quit' || trimmed === '/exit') {
				rl.close()
				ws.close()
				return
			}
			if (trimmed === '/stop' || trimmed === '/cancel') {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'cancel' }))
				}
				rl.prompt()
				return
			}
			if (trimmed && ws.readyState === WebSocket.OPEN) {
				sendEncryptedPrompt(trimmed).catch(err => {
					writeLine(`${ANSI.red}✖ ${err.message}${ANSI.reset}`)
				})
			}
			rl.prompt()
		})
		rl.on('SIGINT', () => {
			if (rl.line.length > 0) {
				rl.write(null, { ctrl: true, name: 'u' })
				rl.prompt()
				return
			}
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'cancel' }))
				writeLine(`${ANSI.dim}── sent cancel (/quit or ctrl+d to disconnect) ──${ANSI.reset}`)
			}
		})
		rl.on('close', () => {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
		})
		rl.prompt()
	}
	ws.addEventListener('close', () => {
		if (rl) rl.close()
		writeLine(`${ANSI.dim}── disconnected ──${ANSI.reset}`)
		if (opts.onClose) opts.onClose()
	})
	return {
		ws,
		room,
		name,
		sendPrompt (text) {
			return sendEncryptedPrompt(text)
		},
		sendCancel () {
			ws.send(JSON.stringify({ type: 'cancel' }))
		},
		disconnect () {
			if (rl) rl.close()
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
		}
	}
}

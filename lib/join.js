import os from 'node:os'
import readline from 'node:readline'
import { normalizeRelayWsUrl } from './host.js'

const ANSI = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	code: '\x1b[38;5;110m',
	userBar: '\x1b[48;5;236m\x1b[97m'
}

function styleMarkdown (text) {
	return text
		.replace(/`([^`\n]+)`/g, `${ANSI.code}$1${ANSI.reset}`)
		.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
}

export function formatStep (step, prev) {
	const lines = []
	if (step.role === 'user') {
		if (prev && prev.text === step.text) return ''
		lines.push(`\n${ANSI.userBar} > ${step.text} ${ANSI.reset}`)
		return lines.join('\n')
	}
	if (step.role === 'assistant') {
		if (step.text && (!prev || prev.text !== step.text)) {
			lines.push(`\n${styleMarkdown(step.text)}`)
		}
		const prevTools = prev ? prev.toolCount : 0
		const tools = step.tools || []
		for (let i = prevTools; i < tools.length; i++) {
			const t = tools[i]
			const detail = t.detail ? `(${t.detail})` : ''
			lines.push(`${ANSI.green}●${ANSI.reset} ${ANSI.bold}${t.label}${ANSI.reset}${ANSI.dim}${detail}${ANSI.reset}`)
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
		return { relayUrl, room }
	}
	return { relayUrl: defaultRelay, room: target }
}

export async function connectGuest (opts = {}) {
	const env = opts.env || process.env
	const defaultRelay = opts.relayUrl || env.WYE_RELAY || 'ws://127.0.0.1:8787'
	const { relayUrl, room } = opts.target ? parseJoinTarget(opts.target, defaultRelay) : { relayUrl: defaultRelay, room: opts.room }
	if (!room) throw new Error('Room token or URL is required to join.')
	const name = opts.name || env.WYE_NAME || os.userInfo().username
	const input = opts.input || process.stdin
	const output = opts.output || process.stdout
	const interactive = opts.interactive ?? Boolean(input.isTTY)
	const wsUrl = normalizeRelayWsUrl(relayUrl, room, { role: 'guest', name })
	const ws = new WebSocket(wsUrl)
	const rendered = new Map()
	let rl = null
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
	function handleStep (step) {
		const prev = rendered.get(step.index)
		const formatted = formatStep(step, prev)
		rendered.set(step.index, {
			text: step.text || '',
			toolCount: Array.isArray(step.tools) ? step.tools.length : 0
		})
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
		const msg = JSON.parse(String(event.data))
		if (msg.type === 'snapshot') {
			const who = (msg.members || []).map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', ')
			const wsInfo = msg.meta && msg.meta.workspace ? ` · ${msg.meta.workspace}` : ''
			writeLine(`${ANSI.dim}── connected to room ${msg.room} (${who}${wsInfo}) ──${ANSI.reset}`)
			for (const step of msg.steps || []) handleStep(step)
			if (opts.onSnapshot) opts.onSnapshot(msg)
		} else if (msg.type === 'step') {
			handleStep(msg.step)
		} else if (msg.type === 'presence') {
			const label = msg.event.replace('_', ' ')
			writeLine(`${ANSI.dim}── ${msg.name} ${label} ──${ANSI.reset}`)
			if (opts.onPresence) opts.onPresence(msg)
		} else if (msg.type === 'error') {
			writeLine(`${ANSI.red}✖ ${msg.message}${ANSI.reset}`)
		}
	})
	if (interactive) {
		rl = readline.createInterface({
			input,
			output,
			prompt: `${ANSI.cyan}>${ANSI.reset} `
		})
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
				ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
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
			ws.send(JSON.stringify({ type: 'prompt', text }))
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

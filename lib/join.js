import os from 'node:os'
import readline from 'node:readline'
import { DEFAULT_RELAY_URL, relayWsUrl } from './host.js'
import { importKey, encryptJson, decryptJson, decryptRoster } from '../public/crypto.js'

const MAX_EXPANDED_LINES = 120
const WAIT_HINT_MS = 5000

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

function snapshotRecord (step) {
	return {
		text: step.text || '',
		hadThinking: Boolean(step.thinking),
		tools: Array.isArray(step.tools) ? step.tools.map(t => ({ status: t.status, output: t.output })) : []
	}
}

export class Guest extends EventTarget {
	constructor (opts = {}) {
		super()
		this.opts = opts
		this.input = opts.input || process.stdin
		this.output = opts.output || process.stdout
		this.interactive = opts.interactive ?? Boolean(this.input.isTTY)
		this.expanded = Boolean(opts.expanded)
		this.waitHintMs = opts.waitHintMs ?? WAIT_HINT_MS
		this.ws = null
		this.rl = null
		this.cryptoKey = null
		this.stepsByIndex = new Map()
		this.rendered = new Map()
		this.waitTimers = new Map()
		this.inbox = []
		this.draining = false
		this.bannerLine = ''
	}

	async connect () {
		const opts = this.opts
		const env = opts.env || process.env
		const defaultRelay = opts.relayUrl || env.WYE_RELAY || DEFAULT_RELAY_URL
		const parsed = opts.target ? parseJoinTarget(opts.target, defaultRelay) : { relayUrl: defaultRelay, room: opts.room, key: '' }
		this.relayUrl = parsed.relayUrl
		this.room = parsed.room
		const key = opts.key || parsed.key || env.WYE_KEY || ''
		if (!this.room) throw new Error('Room token or URL is required to join.')
		if (!key) throw new Error('Missing room encryption key (#<key> in URL or --key / WYE_KEY).')
		this.cryptoKey = await importKey(key)
		this.name = opts.name || env.WYE_NAME || os.userInfo().username
		const wsUrl = relayWsUrl(this.relayUrl, this.room, { role: 'guest' })
		const ws = new WebSocket(wsUrl)
		this.ws = ws
		await new Promise((resolve, reject) => {
			ws.onopen = resolve
			ws.onerror = () => reject(new Error(`Failed to connect to wye relay at ${wsUrl}`))
		})
		ws.onerror = null
		ws.onmessage = event => {
			this.inbox.push(event.data)
			this.drainInbox()
		}
		ws.onclose = () => {
			this.clearWaitTimers()
			if (this.rl) this.rl.close()
			this.writeLine(`${ANSI.dim}── disconnected ──${ANSI.reset}`)
			this.dispatchEvent(new Event('close'))
		}
		const nameBox = await encryptJson(this.cryptoKey, this.name)
		ws.send(JSON.stringify({ type: 'hello', nameBox }))
		if (this.interactive) this.attachReadline()
		return this
	}

	writeLine (text) {
		if (!text) return
		if (this.rl && this.interactive) {
			readline.clearLine(this.output, 0)
			readline.cursorTo(this.output, 0)
			this.output.write(`${text}\n`)
			this.rl.prompt(true)
		} else {
			this.output.write(`${text}\n`)
		}
	}

	redraw () {
		this.rendered.clear()
		this.output.write('\x1b[2J\x1b[H')
		if (this.bannerLine) this.output.write(`${this.bannerLine}\n`)
		const ordered = [...this.stepsByIndex.values()].sort((a, b) => a.index - b.index)
		for (const step of ordered) {
			const formatted = formatStep(step, null, { expanded: this.expanded })
			this.rendered.set(step.index, snapshotRecord(step))
			if (formatted) this.output.write(`${formatted}\n`)
		}
		if (this.rl && this.interactive) this.rl.prompt(true)
	}

	handleStep (step) {
		this.stepsByIndex.set(step.index, step)
		const prev = this.rendered.get(step.index)
		const formatted = formatStep(step, prev, { expanded: this.expanded })
		this.rendered.set(step.index, snapshotRecord(step))
		this.syncWaitTimers(step)
		if (formatted) this.writeLine(formatted)
		this.dispatchEvent(new CustomEvent('step', { detail: step }))
	}

	syncWaitTimers (step) {
		const tools = step.tools || []
		for (let i = 0; i < tools.length; i++) {
			const key = `${step.index}:${i}`
			const status = tools[i].status || 'done'
			if (status === 'running') {
				if (!this.waitTimers.has(key)) {
					const label = tools[i].label || 'tool'
					const timer = setTimeout(() => {
						this.waitTimers.set(key, null)
						this.writeLine(`${ANSI.dim}── waiting on ${label} (output or host approval · /stop or ctrl+c to cancel) ──${ANSI.reset}`)
					}, this.waitHintMs)
					timer.unref()
					this.waitTimers.set(key, timer)
				}
			} else {
				const timer = this.waitTimers.get(key)
				if (timer) clearTimeout(timer)
				this.waitTimers.delete(key)
			}
		}
	}

	clearWaitTimers () {
		for (const timer of this.waitTimers.values()) {
			if (timer) clearTimeout(timer)
		}
		this.waitTimers.clear()
	}

	async drainInbox () {
		if (this.draining) return
		this.draining = true
		try {
			while (this.inbox.length > 0) {
				const raw = this.inbox.shift()
				try {
					const msg = JSON.parse(String(raw))
					if (msg.type === 'snapshot') {
						const meta = msg.metaBox ? await decryptJson(this.cryptoKey, msg.metaBox) : null
						const members = await decryptRoster(this.cryptoKey, msg.members)
						const who = members.map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', ')
						const wsInfo = meta && meta.workspace ? ` · ${meta.workspace}` : ''
						this.bannerLine = `${ANSI.dim}── connected to room ${msg.room} (${who}${wsInfo}) ──${ANSI.reset}`
						this.writeLine(this.bannerLine)
						const steps = []
						for (const item of msg.steps || []) {
							const step = await decryptJson(this.cryptoKey, item.box)
							steps.push(step)
							this.handleStep(step)
						}
						this.dispatchEvent(new CustomEvent('snapshot', { detail: { room: msg.room, meta, members, steps } }))
					} else if (msg.type === 'step' && typeof msg.box === 'string') {
						const step = await decryptJson(this.cryptoKey, msg.box)
						this.handleStep(step)
					} else if (msg.type === 'presence') {
						const peerName = msg.nameBox ? await decryptJson(this.cryptoKey, msg.nameBox) : 'peer'
						const members = await decryptRoster(this.cryptoKey, msg.members)
						const label = msg.event.replaceAll('_', ' ')
						this.writeLine(`${ANSI.dim}── ${peerName} ${label} ──${ANSI.reset}`)
						this.dispatchEvent(new CustomEvent('presence', { detail: { event: msg.event, name: peerName, members } }))
					} else if (msg.type === 'error') {
						this.writeLine(`${ANSI.red}✖ ${msg.message}${ANSI.reset}`)
					}
				} catch (err) {
					if (this.bannerLine && err.name === 'KeyMismatchError') {
						this.writeLine(`${ANSI.red}✖ Host restarted the share with a new #key — rejoin with the updated URL${ANSI.reset}`)
					} else {
						this.writeLine(`${ANSI.red}✖ Decryption error (check room #key): ${err.message}${ANSI.reset}`)
					}
					this.dispatchEvent(new CustomEvent('error', { detail: err }))
				}
			}
		} finally {
			this.draining = false
		}
	}

	attachReadline () {
		const rl = readline.createInterface({
			input: this.input,
			output: this.output,
			prompt: `${ANSI.cyan}>${ANSI.reset} `
		})
		this.rl = rl
		if (typeof rl._ttyWrite === 'function') {
			const origTtyWrite = rl._ttyWrite.bind(rl)
			rl._ttyWrite = (s, key) => {
				if (key && key.ctrl && key.name === 'o') {
					this.expanded = !this.expanded
					this.redraw()
					return
				}
				origTtyWrite(s, key)
			}
		}
		rl.on('line', async line => {
			const trimmed = line.trim()
			if (trimmed === '/quit' || trimmed === '/exit') {
				this.disconnect()
				return
			}
			if (trimmed === '/stop' || trimmed === '/cancel') {
				this.cancel()
				rl.prompt()
				return
			}
			if (trimmed && this.ws.readyState === WebSocket.OPEN) {
				try {
					await this.send(trimmed)
				} catch (err) {
					this.writeLine(`${ANSI.red}✖ ${err.message}${ANSI.reset}`)
				}
			}
			rl.prompt()
		})
		rl.on('SIGINT', () => {
			if (rl.line.length > 0) {
				rl.write(null, { ctrl: true, name: 'u' })
				rl.prompt()
				return
			}
			if (this.ws.readyState === WebSocket.OPEN) {
				this.cancel()
				this.writeLine(`${ANSI.dim}── sent cancel (/quit or ctrl+d to disconnect) ──${ANSI.reset}`)
			}
		})
		rl.on('close', () => {
			if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close()
		})
		rl.prompt()
	}

	async send (text) {
		const box = await encryptJson(this.cryptoKey, { text })
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'prompt', box }))
		}
	}

	cancel () {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'cancel' }))
		}
	}

	disconnect () {
		this.clearWaitTimers()
		if (this.rl) this.rl.close()
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			this.ws.close()
		}
	}
}

import { importKey, encryptJson, decryptJson, decryptRoster } from '/crypto.js'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const formEl = document.getElementById('composer')
const inputEl = document.getElementById('input')
const stopBtn = document.getElementById('stop')
const room = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '')
const params = new URLSearchParams(location.search)
const guestName = params.get('name') || 'web'
const stepsByIndex = new Map()
const stepNodes = new Map()
const openTools = new Set()
const openThoughts = new Set()
const runningSince = new Map()
const waitNodes = new Map()
const WAIT_HINT_MS = 5000
let waitTimer = null
let expandAll = false
let ws = null
let cryptoKey = null
let cachedMeta = null
let hasSession = false

function nearBottom () {
	return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 64
}

function appendNotice (text) {
	const stick = nearBottom()
	const div = document.createElement('div')
	div.className = 'notice'
	div.textContent = `── ${text} ──`
	logEl.appendChild(div)
	if (stick) logEl.scrollTop = logEl.scrollHeight
}

function appendInlineMarkdown (parent, line) {
	const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
	let last = 0
	let match
	while ((match = tokenRe.exec(line)) !== null) {
		if (match.index > last) {
			parent.appendChild(document.createTextNode(line.slice(last, match.index)))
		}
		const raw = match[0]
		if (raw.startsWith('`')) {
			const code = document.createElement('code')
			code.textContent = raw.slice(1, -1)
			parent.appendChild(code)
		} else {
			const strong = document.createElement('strong')
			strong.textContent = raw.slice(2, -2)
			parent.appendChild(strong)
		}
		last = tokenRe.lastIndex
	}
	if (last < line.length) {
		parent.appendChild(document.createTextNode(line.slice(last)))
	}
}

function renderFormattedText (text) {
	const wrap = document.createElement('div')
	wrap.className = 'text'
	const lines = text.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line)
		if (headingMatch) {
			const h = document.createElement('div')
			h.className = 'heading'
			appendInlineMarkdown(h, headingMatch[2])
			wrap.appendChild(h)
		} else {
			appendInlineMarkdown(wrap, line)
			if (i < lines.length - 1) wrap.appendChild(document.createTextNode('\n'))
		}
	}
	return wrap
}

function renderThinking (step) {
	const details = document.createElement('details')
	details.className = 'thinking'
	const isOpen = expandAll || openThoughts.has(step.index)
	details.open = isOpen
	const summary = document.createElement('summary')
	const label = step.thinkingTokens ? `Thought · ${step.thinkingTokens} tokens` : 'Thought'
	summary.textContent = label
	const preview = document.createElement('div')
	preview.className = 'thinking-preview'
	preview.textContent = step.thinking.replace(/\s+/g, ' ')
	const full = document.createElement('pre')
	full.className = 'thinking-body'
	full.textContent = step.thinking
	details.appendChild(summary)
	details.appendChild(preview)
	details.appendChild(full)
	details.addEventListener('toggle', () => {
		if (details.open) openThoughts.add(step.index)
		else openThoughts.delete(step.index)
	})
	return details
}

function renderTool (step, tool, toolIdx, isLast) {
	const toolKey = `${step.index}:${toolIdx}`
	const details = document.createElement('details')
	const status = tool.status || 'done'
	details.className = `tool status-${status}`
	const isOpen = expandAll || openTools.has(toolKey)
	details.open = isOpen
	const summary = document.createElement('summary')
	const dot = document.createElement('span')
	dot.className = 'dot'
	dot.textContent = '● '
	const label = document.createElement('b')
	label.textContent = tool.label
	summary.appendChild(dot)
	summary.appendChild(label)
	if (tool.detail) {
		const detailSpan = document.createElement('span')
		detailSpan.className = 'detail'
		detailSpan.textContent = `(${tool.detail})`
		summary.appendChild(detailSpan)
	}
	let hintSpan = null
	if (isLast) {
		hintSpan = document.createElement('span')
		hintSpan.className = 'hint'
		hintSpan.textContent = details.open ? ' (ctrl+o to collapse)' : ' (ctrl+o to expand)'
		summary.appendChild(hintSpan)
	}
	details.appendChild(summary)
	const body = document.createElement('div')
	body.className = 'tool-body'
	if (tool.input) {
		const inPre = document.createElement('pre')
		inPre.className = 'tool-in'
		inPre.textContent = tool.input
		body.appendChild(inPre)
	}
	const outPre = document.createElement('pre')
	outPre.className = 'tool-out'
	outPre.textContent = tool.output || (status === 'running' ? 'Running…' : '(no output)')
	body.appendChild(outPre)
	details.appendChild(body)
	details.addEventListener('toggle', () => {
		if (details.open) openTools.add(toolKey)
		else openTools.delete(toolKey)
		if (hintSpan) {
			hintSpan.textContent = details.open ? ' (ctrl+o to collapse)' : ' (ctrl+o to expand)'
		}
	})
	return details
}

function formatWaitHint (startedAt) {
	const secs = Math.floor((Date.now() - startedAt) / 1000)
	if (secs * 1000 < WAIT_HINT_MS) return ''
	return `  └ waiting on output or host approval (${secs}s) — Stop to cancel`
}

function syncWaitTimer () {
	if (runningSince.size > 0 && !waitTimer) {
		waitTimer = setInterval(updateWaitHints, 1000)
	} else if (runningSince.size === 0 && waitTimer) {
		clearInterval(waitTimer)
		waitTimer = null
	}
}

function updateWaitHints () {
	const stick = nearBottom()
	let revealed = false
	for (const [key, el] of waitNodes) {
		const startedAt = runningSince.get(key)
		const text = startedAt ? formatWaitHint(startedAt) : ''
		if (el.hidden && text) revealed = true
		el.hidden = !text
		el.textContent = text
	}
	if (stick && revealed) logEl.scrollTop = logEl.scrollHeight
	syncWaitTimer()
}

function renderStep (step) {
	stepsByIndex.set(step.index, step)
	const stick = nearBottom()
	for (const key of waitNodes.keys()) {
		if (key.startsWith(`${step.index}:`)) waitNodes.delete(key)
	}
	let node = stepNodes.get(step.index)
	if (!node) {
		node = document.createElement('div')
		node.dataset.index = String(step.index)
		stepNodes.set(step.index, node)
		logEl.appendChild(node)
	}
	node.textContent = ''
	if (step.role === 'user') {
		node.className = 'user'
		const prefix = document.createElement('span')
		prefix.className = 'prompt-prefix'
		prefix.textContent = '[> '
		const body = document.createElement('span')
		body.className = 'prompt-text'
		body.textContent = step.text
		node.appendChild(prefix)
		node.appendChild(body)
	} else if (step.role === 'assistant') {
		node.className = 'assistant'
		if (step.thinking) {
			node.appendChild(renderThinking(step))
		}
		const tools = step.tools || []
		if (tools.length > 0) {
			const group = document.createElement('div')
			group.className = 'tool-group'
			for (let i = 0; i < tools.length; i++) {
				const tool = tools[i]
				const toolKey = `${step.index}:${i}`
				const status = tool.status || 'done'
				group.appendChild(renderTool(step, tool, i, i === tools.length - 1))
				if (status === 'running') {
					if (!runningSince.has(toolKey)) runningSince.set(toolKey, Date.now())
					const wait = document.createElement('div')
					wait.className = 'wait-hint'
					const text = formatWaitHint(runningSince.get(toolKey))
					wait.hidden = !text
					wait.textContent = text
					waitNodes.set(toolKey, wait)
					group.appendChild(wait)
				} else {
					runningSince.delete(toolKey)
				}
			}
			node.appendChild(group)
		}
		if (step.text) {
			node.appendChild(renderFormattedText(step.text))
		}
	} else if (step.role === 'error') {
		node.className = 'error'
		node.textContent = `✖ ${step.text}`
	}
	syncWaitTimer()
	if (stick) logEl.scrollTop = logEl.scrollHeight
}

function toggleExpandAll () {
	expandAll = !expandAll
	openTools.clear()
	openThoughts.clear()
	for (const step of stepsByIndex.values()) {
		renderStep(step)
	}
}

function updateHeader (meta, members) {
	if (meta) cachedMeta = meta
	const parts = [`room ${room}`]
	if (Array.isArray(members) && members.length > 0) {
		parts.push(members.map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', '))
	}
	if (cachedMeta && cachedMeta.workspace) parts.push(cachedMeta.workspace)
	statusEl.textContent = parts.join(' · ')
}

function connect () {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
	ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}?role=guest`)
	const inbox = []
	let draining = false
	let shouldReconnect = true
	async function drainInbox () {
		if (draining) return
		draining = true
		try {
			while (inbox.length > 0) {
				const raw = inbox.shift()
				try {
					const msg = JSON.parse(String(raw))
					if (msg.type === 'snapshot') {
						const meta = msg.metaBox ? await decryptJson(cryptoKey, msg.metaBox) : null
						const members = await decryptRoster(cryptoKey, msg.members)
						hasSession = true
						updateHeader(meta, members)
						for (const item of msg.steps || []) {
							const step = await decryptJson(cryptoKey, item.box)
							renderStep(step)
						}
						logEl.scrollTop = logEl.scrollHeight
					} else if (msg.type === 'step' && typeof msg.box === 'string') {
						const step = await decryptJson(cryptoKey, msg.box)
						renderStep(step)
					} else if (msg.type === 'presence') {
						const meta = msg.metaBox ? await decryptJson(cryptoKey, msg.metaBox) : null
						const members = await decryptRoster(cryptoKey, msg.members)
						const peerName = msg.nameBox ? await decryptJson(cryptoKey, msg.nameBox) : 'peer'
						updateHeader(meta, members)
						appendNotice(`${peerName} ${msg.event.replaceAll('_', ' ')}`)
					} else if (msg.type === 'error') {
						appendNotice(`error: ${msg.message}`)
					}
				} catch (err) {
					shouldReconnect = false
					if (hasSession && err.name === 'KeyMismatchError') {
						appendNotice('host restarted the share with a new #key — ask for the updated URL')
						statusEl.textContent = `room ${room} · share restarted (new #key)`
					} else {
						appendNotice(`decryption failed (check #key in URL): ${err.message}`)
						statusEl.textContent = `room ${room} · key mismatch`
					}
					ws.close()
					return
				}
			}
		} finally {
			draining = false
		}
	}
	ws.addEventListener('open', async () => {
		const nameBox = await encryptJson(cryptoKey, guestName)
		ws.send(JSON.stringify({ type: 'hello', nameBox }))
	})
	ws.addEventListener('message', event => {
		inbox.push(event.data)
		drainInbox()
	})
	ws.addEventListener('close', () => {
		if (!shouldReconnect) return
		statusEl.textContent = `room ${room} · reconnecting...`
		setTimeout(connect, 1500)
	})
}

async function submitPrompt () {
	const text = inputEl.value.trim()
	if (!text || !cryptoKey || !ws || ws.readyState !== WebSocket.OPEN) return
	inputEl.value = ''
	const box = await encryptJson(cryptoKey, { text })
	ws.send(JSON.stringify({ type: 'prompt', box }))
}

formEl.addEventListener('submit', event => {
	event.preventDefault()
	submitPrompt()
})

inputEl.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault()
		submitPrompt()
	}
})

window.addEventListener('keydown', event => {
	if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'o') {
		event.preventDefault()
		toggleExpandAll()
	}
})

stopBtn.addEventListener('click', () => {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: 'cancel' }))
	}
})

async function boot () {
	const keyStr = location.hash.slice(1).trim()
	if (!keyStr) {
		statusEl.textContent = `room ${room} · missing #key`
		appendNotice('missing encryption #key in URL fragment')
		inputEl.disabled = true
		stopBtn.disabled = true
		return
	}
	try {
		cryptoKey = await importKey(keyStr)
		connect()
	} catch (err) {
		statusEl.textContent = `room ${room} · invalid #key`
		appendNotice(err.message)
		inputEl.disabled = true
		stopBtn.disabled = true
	}
}

window.addEventListener('hashchange', () => location.reload())
boot()

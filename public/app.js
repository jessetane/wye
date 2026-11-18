import { importKey, encryptJson, decryptJson, decryptRoster } from '/crypto.js'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const activityEl = document.getElementById('activity')
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
const WAIT_HINT_MS = 5000
let activity = null
let activityTimer = null
let expandAll = false
let ws = null
let cryptoKey = null
let cachedMeta = null
let hasSession = false
let maxStepIndex = -1

function nearBottom () {
	const doc = document.scrollingElement
	return doc.scrollHeight - doc.scrollTop - window.innerHeight < 64
}

function scrollToBottom () {
	window.scrollTo(0, document.scrollingElement.scrollHeight)
}

function syncLogInsets () {
	const stick = nearBottom()
	const gap = parseFloat(getComputedStyle(logEl).paddingLeft)
	logEl.style.paddingTop = `${statusEl.offsetHeight + gap}px`
	logEl.style.paddingBottom = `${formEl.offsetHeight + gap}px`
	if (stick) scrollToBottom()
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

function isRunningActivity (act) {
	return Boolean(act && (act.kind === 'working' || act.kind === 'tool'))
}

function formatActivity (act) {
	if (act.kind === 'info' || act.kind === 'error') return act.text
	const secs = Math.floor((Date.now() - act.startedAt) / 1000)
	if (act.kind === 'tool') {
		if (secs * 1000 >= WAIT_HINT_MS) {
			return `* waiting on ${act.label} (output or host approval · ${secs}s) — Stop to cancel`
		}
		return secs > 0 ? `* running ${act.label}… (${secs}s)` : `* running ${act.label}…`
	}
	if (secs >= 10) return `* working… (${secs}s) — Stop to cancel`
	return secs > 0 ? `* working… (${secs}s)` : '* working…'
}

function renderActivity () {
	const active = isRunningActivity(activity)
	stopBtn.hidden = !active
	if (!activity) {
		activityEl.hidden = true
		activityEl.className = ''
		activityEl.textContent = ''
		if (activityTimer) {
			clearInterval(activityTimer)
			activityTimer = null
		}
		return
	}
	const stick = nearBottom()
	const wasHidden = activityEl.hidden
	activityEl.hidden = false
	activityEl.className = activity.kind === 'error' ? 'error' : ''
	activityEl.textContent = formatActivity(activity)
	if (stick && wasHidden) scrollToBottom()
	if (active) {
		if (!activityTimer) activityTimer = setInterval(renderActivity, 1000)
	} else if (activityTimer) {
		clearInterval(activityTimer)
		activityTimer = null
	}
}

function setActivity (next) {
	if (!next) {
		activity = null
	} else if (next.kind === 'info' || next.kind === 'error') {
		activity = { kind: next.kind, text: next.text }
	} else if (!activity || activity.kind !== next.kind || activity.label !== next.label) {
		activity = { kind: next.kind, label: next.label, startedAt: Date.now() }
	}
	renderActivity()
}

function deriveActivity (step, fromSnapshot) {
	if (!step) return null
	if (step.role === 'assistant') {
		const tools = step.tools || []
		const running = tools.find(t => (t.status || 'done') === 'running')
		if (running) return { kind: 'tool', label: running.label || 'tool' }
		if (fromSnapshot) return null
		const cancelled = tools.some(t => t.status === 'error' && String(t.output || '').startsWith('Cancelled by '))
		if (cancelled) return null
		if (tools.length > 0 || !step.text) return { kind: 'working', label: '' }
		return null
	}
	if (!fromSnapshot && step.role === 'user') return { kind: 'working', label: '' }
	return null
}

function syncActivity (fromSnapshot = false) {
	setActivity(deriveActivity(stepsByIndex.get(maxStepIndex), fromSnapshot))
}

function truncateSteps (fromIndex) {
	for (const idx of [...stepsByIndex.keys()]) {
		if (idx >= fromIndex) {
			stepsByIndex.delete(idx)
			openThoughts.delete(idx)
			const node = stepNodes.get(idx)
			if (node) {
				node.remove()
				stepNodes.delete(idx)
			}
		}
	}
	for (const key of [...openTools]) {
		if (parseInt(key, 10) >= fromIndex) openTools.delete(key)
	}
	maxStepIndex = Math.max(-1, ...stepsByIndex.keys())
}

function renderStep (step) {
	stepsByIndex.set(step.index, step)
	if (step.index > maxStepIndex) maxStepIndex = step.index
	const stick = nearBottom()
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
				group.appendChild(renderTool(step, tools[i], i, i === tools.length - 1))
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
	if (stick) scrollToBottom()
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
		if (!members.some(m => m.role === 'host')) parts.push('host offline')
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
						truncateSteps(0)
						updateHeader(meta, members)
						for (const item of msg.steps || []) {
							const step = await decryptJson(cryptoKey, item.box)
							renderStep(step)
						}
						syncActivity(true)
						scrollToBottom()
					} else if (msg.type === 'step' && typeof msg.box === 'string') {
						const step = await decryptJson(cryptoKey, msg.box)
						if (msg.truncate) truncateSteps(step.index)
						renderStep(step)
						syncActivity(false)
					} else if (msg.type === 'presence') {
						const meta = msg.metaBox ? await decryptJson(cryptoKey, msg.metaBox) : null
						const members = await decryptRoster(cryptoKey, msg.members)
						const name = await decryptJson(cryptoKey, msg.nameBox)
						updateHeader(meta, members)
						if (msg.event === 'cancelled_turn') {
							setActivity({ kind: 'info', text: `* cancelled by ${name}` })
						} else if (msg.event === 'host_left') {
							setActivity(null)
						}
					} else if (msg.type === 'error') {
						setActivity({ kind: 'error', text: `✖ ${msg.message}` })
					}
				} catch (err) {
					shouldReconnect = false
					inputEl.disabled = true
					if (hasSession && err.name === 'KeyMismatchError') {
						setActivity({ kind: 'error', text: '✖ host restarted the share with a new #key — ask for the updated URL' })
						statusEl.textContent = `room ${room} · share restarted (new #key)`
					} else {
						setActivity({ kind: 'error', text: `✖ decryption failed (check #key in URL): ${err.message}` })
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
		setActivity(null)
		statusEl.textContent = `room ${room} · reconnecting...`
		setTimeout(connect, 1500)
	})
}

async function submitPrompt () {
	const text = inputEl.value.trim()
	if (!text || !cryptoKey || !ws || ws.readyState !== WebSocket.OPEN) return
	inputEl.value = ''
	setActivity({ kind: 'working', label: '' })
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
	if (ws && ws.readyState === WebSocket.OPEN && isRunningActivity(activity)) {
		setActivity({ kind: 'info', text: '* cancelling…' })
		ws.send(JSON.stringify({ type: 'cancel' }))
	}
})

async function boot () {
	const keyStr = location.hash.slice(1).trim()
	if (!keyStr) {
		statusEl.textContent = `room ${room} · missing #key`
		setActivity({ kind: 'error', text: '✖ missing encryption #key in URL fragment' })
		inputEl.disabled = true
		return
	}
	try {
		cryptoKey = await importKey(keyStr)
		connect()
	} catch (err) {
		statusEl.textContent = `room ${room} · invalid #key`
		setActivity({ kind: 'error', text: `✖ ${err.message}` })
		inputEl.disabled = true
	}
}

const barObserver = new ResizeObserver(syncLogInsets)
barObserver.observe(statusEl)
barObserver.observe(formEl)
window.addEventListener('hashchange', () => location.reload())
boot()

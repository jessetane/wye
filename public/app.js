const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const formEl = document.getElementById('composer')
const inputEl = document.getElementById('input')
const stopBtn = document.getElementById('stop')
const room = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '')
const params = new URLSearchParams(location.search)
const guestName = params.get('name') || 'web'
const stepNodes = new Map()
let ws = null

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

function renderStep (step) {
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
		node.textContent = `> ${step.text}`
	} else if (step.role === 'assistant') {
		node.className = 'assistant'
		if (step.text) {
			const body = document.createElement('div')
			body.className = 'text'
			body.textContent = step.text
			node.appendChild(body)
		}
		for (const t of step.tools || []) {
			const row = document.createElement('div')
			row.className = 'tool'
			const dot = document.createElement('span')
			dot.className = 'dot'
			dot.textContent = '● '
			const label = document.createElement('b')
			label.textContent = t.label
			row.appendChild(dot)
			row.appendChild(label)
			if (t.detail) row.appendChild(document.createTextNode(`(${t.detail})`))
			node.appendChild(row)
		}
	} else if (step.role === 'error') {
		node.className = 'error'
		node.textContent = `✖ ${step.text}`
	}
	if (stick) logEl.scrollTop = logEl.scrollHeight
}

function updateHeader (meta, members) {
	const parts = [`room ${room}`]
	if (Array.isArray(members) && members.length > 0) {
		parts.push(members.map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', '))
	}
	if (meta && meta.workspace) parts.push(meta.workspace)
	statusEl.textContent = parts.join(' · ')
}

function connect () {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
	const query = new URLSearchParams({ role: 'guest', name: guestName }).toString()
	ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}?${query}`)
	ws.addEventListener('message', event => {
		const msg = JSON.parse(String(event.data))
		if (msg.type === 'snapshot') {
			updateHeader(msg.meta, msg.members)
			for (const step of msg.steps || []) renderStep(step)
			logEl.scrollTop = logEl.scrollHeight
		} else if (msg.type === 'step') {
			renderStep(msg.step)
		} else if (msg.type === 'presence') {
			updateHeader(msg.meta, msg.members)
			appendNotice(`${msg.name} ${msg.event.replaceAll('_', ' ')}`)
		} else if (msg.type === 'error') {
			appendNotice(`error: ${msg.message}`)
		}
	})
	ws.addEventListener('close', () => {
		statusEl.textContent = `room ${room} · reconnecting...`
		setTimeout(connect, 1500)
	})
}

function submitPrompt () {
	const text = inputEl.value.trim()
	if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
	ws.send(JSON.stringify({ type: 'prompt', text }))
	inputEl.value = ''
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

stopBtn.addEventListener('click', () => {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: 'cancel' }))
	}
})

connect()

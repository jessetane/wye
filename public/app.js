import { importKey, encryptJson, decryptJson } from '/crypto.js'

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
let cryptoKey = null
let cachedMeta = null

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
	if (meta) cachedMeta = meta
	const parts = [`room ${room}`]
	if (Array.isArray(members) && members.length > 0) {
		parts.push(members.map(m => `${m.name}${m.role === 'host' ? '*' : ''}`).join(', '))
	}
	if (cachedMeta && cachedMeta.workspace) parts.push(cachedMeta.workspace)
	statusEl.textContent = parts.join(' · ')
}

async function decryptRoster (members) {
	const out = []
	for (const m of members || []) {
		const name = m.nameBox ? await decryptJson(cryptoKey, m.nameBox) : 'unknown'
		out.push({ role: m.role, name })
	}
	return out
}

function connect () {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
	ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}?role=guest`)
	let chain = Promise.resolve()
	ws.addEventListener('open', async () => {
		const nameBox = await encryptJson(cryptoKey, guestName)
		ws.send(JSON.stringify({ type: 'hello', nameBox }))
	})
	ws.addEventListener('message', event => {
		chain = chain.then(async () => {
			const msg = JSON.parse(String(event.data))
			if (msg.type === 'snapshot') {
				const meta = msg.metaBox ? await decryptJson(cryptoKey, msg.metaBox) : null
				const members = await decryptRoster(msg.members)
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
				const members = await decryptRoster(msg.members)
				const peerName = msg.nameBox ? await decryptJson(cryptoKey, msg.nameBox) : 'peer'
				updateHeader(meta, members)
				appendNotice(`${peerName} ${msg.event.replaceAll('_', ' ')}`)
			} else if (msg.type === 'error') {
				appendNotice(`error: ${msg.message}`)
			}
		}).catch(err => {
			appendNotice(`decryption failed (check #key in URL): ${err.message}`)
		})
	})
	ws.addEventListener('close', () => {
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

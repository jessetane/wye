import os from 'node:os'
import { resolveTranscriptPath, watchTranscript } from './transcript.js'

export function normalizeRelayWsUrl (relayUrl, room, params) {
	const base = relayUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '')
	const query = new URLSearchParams(params).toString()
	return `${base}/ws/${encodeURIComponent(room)}?${query}`
}

export async function sendUserMessage ({ lsAddress, csrfToken, conversationId, text }) {
	const res = await fetch(`http://${lsAddress}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Connect-Protocol-Version': '1',
			'x-codeium-csrf-token': csrfToken
		},
		body: JSON.stringify({
			cascadeId: conversationId,
			items: [{ text }]
		})
	})
	if (!res.ok) {
		const detail = await res.text()
		throw new Error(`SendUserCascadeMessage failed (${res.status}): ${detail}`)
	}
}

export async function connectHost (opts = {}) {
	const env = opts.env || process.env
	const conversationId = opts.conversationId || env.ANTIGRAVITY_CONVERSATION_ID
	const appDataDir = opts.appDataDir || env.ANTIGRAVITY_APP_DATA_DIR
	const lsAddress = opts.lsAddress || env.ANTIGRAVITY_LS_ADDRESS
	const csrfToken = opts.csrfToken || env.ANTIGRAVITY_CSRF_TOKEN
	if (!conversationId || !appDataDir || !lsAddress || !csrfToken) {
		throw new Error('Missing Antigravity session environment (ANTIGRAVITY_CONVERSATION_ID, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN). Launch `collab host` from inside an Antigravity Desktop or CLI conversation.')
	}
	const relayUrl = opts.relayUrl || env.COLLAB_RELAY || 'ws://127.0.0.1:8787'
	const room = opts.room || conversationId
	const name = opts.name || env.COLLAB_NAME || os.userInfo().username
	const workspace = opts.workspace || process.cwd()
	const transcriptPath = opts.transcriptPath || resolveTranscriptPath(appDataDir, conversationId)
	const wsUrl = normalizeRelayWsUrl(relayUrl, room, {
		role: 'host',
		name,
		conversationId,
		workspace
	})
	const ws = new WebSocket(wsUrl)
	let unwatch = null
	const sentDigests = new Map()
	await new Promise((resolve, reject) => {
		function onOpen () {
			ws.removeEventListener('error', onError)
			resolve()
		}
		function onError () {
			reject(new Error(`Failed to connect to collab relay at ${wsUrl}`))
		}
		ws.addEventListener('open', onOpen, { once: true })
		ws.addEventListener('error', onError, { once: true })
	})
	unwatch = watchTranscript(transcriptPath, step => {
		const serialized = JSON.stringify(step)
		if (sentDigests.get(step.index) === serialized) return
		sentDigests.set(step.index, serialized)
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'step', step }))
		}
	})
	ws.addEventListener('message', async event => {
		const msg = JSON.parse(String(event.data))
		if (msg.type === 'prompt') {
			try {
				await sendUserMessage({
					lsAddress,
					csrfToken,
					conversationId,
					text: msg.text
				})
				if (opts.onEvent) opts.onEvent({ type: 'injected', sender: msg.sender, text: msg.text })
			} catch (err) {
				if (opts.onError) opts.onError(err)
				else console.error(`[collab host] ${err.message}`)
			}
		} else if (opts.onEvent) {
			opts.onEvent(msg)
		}
	})
	ws.addEventListener('close', () => {
		if (unwatch) unwatch()
		if (opts.onClose) opts.onClose()
	})
	return {
		room,
		name,
		relayUrl,
		conversationId,
		transcriptPath,
		ws,
		disconnect () {
			if (unwatch) unwatch()
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
		}
	}
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import * as antigravity from '../lib/harnesses/antigravity.js'
import * as claude from '../lib/harnesses/claude.js'
import { resolveHarness } from '../lib/harnesses/index.js'
import { Relay } from '../lib/relay.js'
import { Host, listHosts } from '../lib/host.js'
import { Guest, formatStep } from '../lib/join.js'

test('createAntigravityStepParser formats agy-style tools and correlates GENERIC + background outputs', () => {
	const parse = antigravity.createStepParser({ homeDir: '/Users/jesse' })
	const userStep = parse(JSON.stringify({
		step_index: 0,
		source: 'USER_EXPLICIT',
		type: 'USER_INPUT',
		status: 'DONE',
		created_at: '2026-11-13T20:00:00Z',
		content: '<USER_REQUEST>\nwhat is the latest on topical?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>'
	}))
	assert.equal(userStep.role, 'user')
	assert.equal(userStep.text, 'what is the latest on topical?')
	const modelStep = parse(JSON.stringify({
		step_index: 3,
		source: 'MODEL',
		type: 'PLANNER_RESPONSE',
		status: 'DONE',
		created_at: '2026-11-13T20:01:05Z',
		thinking: 'Checking the schema instructions for topical.',
		output_tokens: 127,
		content: 'Here is the **answer**.',
		tool_calls: [
			{ name: 'read_file', args: { Path: '/Users/jesse/.gemini/antigravity-cli/mcp/topical/http_api.json' } },
			{ name: 'call_mcp_tool', args: { ServerName: 'topical', ToolName: 'http_api', Arguments: { method: 'GET', url: '/api/topics' } } },
			{ name: 'run_command', args: { CommandLine: 'python3 -c \'\nprint(1)\n\'' } }
		]
	}))
	assert.equal(modelStep.role, 'assistant')
	assert.equal(modelStep.thinking, 'Checking the schema instructions for topical.')
	assert.equal(modelStep.thinkingTokens, 127)
	assert.equal(modelStep.tools[0].label, 'Read')
	assert.equal(modelStep.tools[0].detail, '~/.gemini/antigravity-cli/mcp/topical/http_api.json')
	assert.equal(modelStep.tools[0].status, 'running')
	assert.equal(modelStep.tools[1].label, 'topical/http_api')
	assert.equal(modelStep.tools[1].detail, '{"method":"GET","url":"/api/topics"}')
	assert.equal(modelStep.tools[2].label, 'Bash')
	assert.equal(modelStep.tools[2].detail, 'python3 -c \'')
	assert.match(modelStep.tools[2].input, /print\(1\)/)
	const afterRead = parse(JSON.stringify({
		step_index: 4,
		source: 'MODEL',
		type: 'GENERIC',
		status: 'DONE',
		content: 'Created At: 2026-11-13T20:01:05Z\nCompleted At: 2026-11-13T20:01:05Z\n{"name":"http_api"}'
	}))
	assert.equal(afterRead.index, 3)
	assert.equal(afterRead.tools[0].status, 'done')
	assert.equal(afterRead.tools[0].output, '{"name":"http_api"}')
	const afterMcpErr = parse(JSON.stringify({
		step_index: 5,
		source: 'MODEL',
		type: 'GENERIC',
		status: 'ERROR',
		error: 'MCP 500 Internal Error',
		content: 'Created At: 2026-11-13T20:01:06Z\n'
	}))
	assert.equal(afterMcpErr.tools[1].status, 'error')
	assert.match(afterMcpErr.tools[1].output, /MCP 500 Internal Error/)
	const afterBgStart = parse(JSON.stringify({
		step_index: 6,
		source: 'MODEL',
		type: 'GENERIC',
		status: 'RUNNING',
		content: 'Created At: 2026-11-13T20:01:06Z\nTool is running as a background task with task id: conv/task-6'
	}))
	assert.equal(afterBgStart.tools[2].status, 'running')
	const afterBgDone = parse(JSON.stringify({
		step_index: 7,
		source: 'SYSTEM',
		type: 'SYSTEM_MESSAGE',
		status: 'DONE',
		content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T20:01:08Z sender=conv/task-6 priority=HIGH content=Task id "conv/task-6" finished with result:\nCommand exited with code 0.\n\nCommand output:\n1\n</SYSTEM_MESSAGE>'
	}))
	assert.equal(afterBgDone.tools[2].status, 'done')
	assert.match(afterBgDone.tools[2].output, /Command output:\n1/)
	const collapsed = formatStep(afterBgDone, null, { expanded: false })
	assert.match(collapsed, /\(ctrl\+o to expand\)/)
	assert.match(collapsed, /MCP 500 Internal Error/)
	const expanded = formatStep(afterBgDone, null, { expanded: true })
	assert.match(expanded, /\(ctrl\+o to collapse\)/)
	assert.match(expanded, /Command output:/)
	const rewound = parse(JSON.stringify({
		step_index: 3,
		source: 'USER_EXPLICIT',
		type: 'USER_INPUT',
		status: 'DONE',
		content: '<USER_REQUEST>\nrewound question\n</USER_REQUEST>'
	}))
	assert.equal(rewound.index, 3)
	assert.equal(rewound.text, 'rewound question')
})

test('createClaudeStepParser coalesces assistant blocks, attaches tool_result outputs, and unwraps peer prompts', () => {
	const parse = claude.createStepParser({ homeDir: '/Users/jesse' })
	assert.equal(parse(JSON.stringify({ type: 'mode', mode: 'normal' })), null)
	const u1 = parse(JSON.stringify({
		type: 'user',
		uuid: 'u-1',
		timestamp: '2026-11-14T20:00:00Z',
		message: { role: 'user', content: 'Explain this repo' }
	}))
	assert.equal(u1.index, 0)
	assert.equal(u1.role, 'user')
	assert.equal(u1.text, 'Explain this repo')
	const aThink = parse(JSON.stringify({
		type: 'assistant',
		uuid: 'a-think',
		message: { id: 'msg-1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }
	}))
	assert.equal(aThink.index, 1)
	assert.equal(aThink.thinking, 'hmm')
	const a1 = parse(JSON.stringify({
		type: 'assistant',
		uuid: 'a-text',
		message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Checking files.' }] }
	}))
	assert.equal(a1.index, 1)
	assert.equal(a1.text, 'Checking files.')
	assert.deepEqual(a1.tools, [])
	const a2 = parse(JSON.stringify({
		type: 'assistant',
		uuid: 'a-tool',
		message: {
			id: 'msg-1',
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/Users/jesse/src/index.js' } },
				{ type: 'tool_use', id: 't-2', name: 'mcp__chrome-tab__eval', input: { code: 'document.title' } }
			]
		}
	}))
	assert.equal(a2.index, 1)
	assert.equal(a2.tools[0].label, 'Read')
	assert.equal(a2.tools[0].detail, '~/src/index.js')
	assert.equal(a2.tools[0].status, 'running')
	assert.equal(a2.tools[1].label, 'chrome-tab/eval')
	assert.equal(a2.tools[1].detail, '{"code":"document.title"}')
	const aAfterRes = parse(JSON.stringify({
		type: 'user',
		uuid: 'u-toolres',
		parentUuid: 'a-tool',
		toolUseResult: { stdout: 'export default 42' },
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'export default 42' }] }
	}))
	assert.equal(aAfterRes.index, 1)
	assert.equal(aAfterRes.tools[0].status, 'done')
	assert.equal(aAfterRes.tools[0].output, 'export default 42')
	parse(JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'sys-1', parentUuid: 'u-toolres' }))
	const peerPrompt = parse(JSON.stringify({
		type: 'user',
		uuid: 'u-peer',
		parentUuid: 'sys-1',
		isMeta: true,
		origin: { kind: 'peer' },
		message: {
			role: 'user',
			content: 'Another Claude session sent a message:\nCan we check tests next?\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.'
		}
	}))
	assert.equal(peerPrompt.index, 2)
	assert.equal(peerPrompt.role, 'user')
	assert.equal(peerPrompt.text, 'Can we check tests next?')
	const rewound = parse(JSON.stringify({
		type: 'user',
		uuid: 'u-rewound',
		parentUuid: 'sys-1',
		message: { role: 'user', content: 'Rewound over peer prompt' }
	}))
	assert.equal(rewound.index, 2)
	assert.equal(rewound.text, 'Rewound over peer prompt')
})

test('end-to-end Antigravity host + relay + guest syncs history, prompts, cancel, state, and reconnect', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wye-test-'))
	const stateDir = path.join(tmpDir, 'state')
	const convId = '11111111-2222-3333-4444-555555555555'
	const logDir = path.join(tmpDir, 'brain', convId, '.system_generated', 'logs')
	fs.mkdirSync(logDir, { recursive: true })
	const transcriptPath = path.join(logDir, 'transcript_full.jsonl')
	fs.writeFileSync(transcriptPath, [
		JSON.stringify({
			step_index: 0,
			source: 'USER_EXPLICIT',
			type: 'USER_INPUT',
			status: 'DONE',
			created_at: '2026-11-13T20:00:00Z',
			content: '<USER_REQUEST>\nalready chatting in desktop\n</USER_REQUEST>'
		}),
		JSON.stringify({
			step_index: 1,
			source: 'MODEL',
			type: 'PLANNER_RESPONSE',
			status: 'DONE',
			created_at: '2026-11-13T20:00:02Z',
			content: 'Prior desktop reply.'
		})
	].join('\n') + '\n')
	const receivedRpc = []
	let resolveCancelRpc
	const cancelRpcDone = new Promise(resolve => { resolveCancelRpc = resolve })
	const mockLs = http.createServer((req, res) => {
		let body = ''
		req.on('data', chunk => { body += chunk })
		req.on('end', () => {
			const parsed = JSON.parse(body)
			receivedRpc.push({
				url: req.url,
				csrf: req.headers['x-codeium-csrf-token'],
				payload: parsed
			})
			if (req.url.endsWith('/SendUserCascadeMessage')) {
				const userText = parsed.items[0].text
				fs.appendFileSync(transcriptPath, [
					JSON.stringify({
						step_index: 2,
						source: 'USER_EXPLICIT',
						type: 'USER_INPUT',
						status: 'DONE',
						created_at: '2026-11-13T20:02:00Z',
						content: `<USER_REQUEST>\n${userText}\n</USER_REQUEST>`
					}),
					JSON.stringify({
						step_index: 3,
						source: 'MODEL',
						type: 'PLANNER_RESPONSE',
						status: 'DONE',
						created_at: '2026-11-13T20:02:01Z',
						content: 'Live reply to both partners!'
					})
				].join('\n') + '\n')
			} else if (req.url.endsWith('/CancelCascadeInvocation')) {
				resolveCancelRpc()
			}
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end('{}')
		})
	})
	await new Promise(resolve => mockLs.listen(0, '127.0.0.1', resolve))
	const lsPort = mockLs.address().port
	let relay = new Relay()
	const relayAddr = await relay.open(0, '127.0.0.1')
	const relayPort = relayAddr.port
	const relayUrl = `ws://127.0.0.1:${relayPort}`
	let resolveReconnected
	const reconnectedDone = new Promise(resolve => { resolveReconnected = resolve })
	const hostSession = new Host({
		relayUrl,
		name: 'partner',
		conversationId: convId,
		appDataDir: tmpDir,
		lsAddress: `127.0.0.1:${lsPort}`,
		csrfToken: 'secret-csrf',
		workspace: '/Users/partner/project',
		stateDir,
		reconnectDelayMs: 40,
		maxReconnectDelayMs: 100
	})
	hostSession.addEventListener('reconnected', () => resolveReconnected())
	await hostSession.connect()
	assert.equal(hostSession.harness, 'antigravity')
	assert.equal(hostSession.room, convId)
	assert.ok(hostSession.key.length >= 20)
	assert.equal(listHosts(stateDir).length, 1)
	const indexRes = await fetch(`http://127.0.0.1:${relayPort}/`)
	assert.equal(indexRes.status, 200)
	const indexText = await indexRes.text()
	assert.match(indexText, /Live multiplayer splitter/)
	assert.match(indexText, /github\.com\/jessetane\/wye/)
	const htmlRes = await fetch(`http://127.0.0.1:${relayPort}/${convId}`)
	assert.equal(htmlRes.status, 200)
	assert.match(await htmlRes.text(), /<script type="module" src="\/app\.js"><\/script>/)
	const cssRes = await fetch(`http://127.0.0.1:${relayPort}/style.css`)
	assert.equal(cssRes.status, 200)
	const cryptoRes = await fetch(`http://127.0.0.1:${relayPort}/crypto.js`)
	assert.equal(cryptoRes.status, 200)
	const seenSteps = []
	let resolveLiveDone
	const liveDone = new Promise(resolve => { resolveLiveDone = resolve })
	let renderedOutput = ''
	const guestSession = new Guest({
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: { write (s) { renderedOutput += s } }
	})
	guestSession.addEventListener('step', ev => {
		seenSteps.push(ev.detail)
		if (ev.detail.index === 3) resolveLiveDone()
	})
	await guestSession.connect()
	await new Promise(resolve => setTimeout(resolve, 60))
	assert.equal(seenSteps.length, 2)
	const relayRoom = relay.rooms.get(convId)
	assert.ok(!JSON.stringify([...relayRoom.steps.values()]).includes('already chatting in desktop'))
	assert.ok(!JSON.stringify(relayRoom.metaBox).includes('/Users/partner/project'))
	await guestSession.send('hey partner, jumping in!')
	await liveDone
	guestSession.cancel()
	await cancelRpcDone
	assert.equal(receivedRpc.length, 2)
	assert.equal(receivedRpc[0].url, '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage')
	assert.equal(receivedRpc[0].payload.items[0].text, 'hey partner, jumping in!')
	assert.equal(receivedRpc[1].url, '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation')
	assert.deepEqual(receivedRpc[1].payload, { cascadeId: convId, killBackgroundTasks: false })
	assert.match(renderedOutput, /already chatting in desktop/)
	assert.match(renderedOutput, /hey partner, jumping in!/)
	await assert.rejects(async () => {
		const wrongKeyUrl = `${hostSession.webUrl.split('#')[0]}#AAAAAAAAAAAAAAAAAAAAAA`
		let decryptErr
		const badGuest = new Guest({
			target: wrongKeyUrl,
			name: 'intruder',
			interactive: false,
			output: { write () {} }
		})
		badGuest.addEventListener('error', ev => {
			decryptErr = ev.detail
		})
		await badGuest.connect()
		await new Promise(resolve => setTimeout(resolve, 50))
		badGuest.disconnect()
		if (decryptErr) throw decryptErr
	})
	guestSession.disconnect()
	await relay.close()
	relay = new Relay()
	await relay.open(relayPort, '127.0.0.1')
	await reconnectedDone
	await new Promise(resolve => setTimeout(resolve, 60))
	let snapshotCount = 0
	const guestAfterRestart = new Guest({
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: { write () {} }
	})
	guestAfterRestart.addEventListener('snapshot', ev => {
		snapshotCount = ev.detail.steps.length
	})
	await guestAfterRestart.connect()
	await new Promise(resolve => setTimeout(resolve, 40))
	assert.equal(snapshotCount, 4)
	guestAfterRestart.disconnect()
	hostSession.disconnect()
	assert.equal(listHosts(stateDir).length, 0)
	await relay.close()
	await new Promise(resolve => mockLs.close(resolve))
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('end-to-end Claude Code host discovers session, streams JSONL, and injects UDS frames', async () => {
	const shortTmp = fs.mkdtempSync('/tmp/wye-cc-')
	const configDir = path.join(shortTmp, 'claude')
	const sessionsDir = path.join(configDir, 'sessions')
	const workspace = path.join(shortTmp, 'proj')
	const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
	const sockPath = path.join(shortTmp, 'cc.sock')
	const projectDir = path.join(configDir, 'projects', claude.slugifyProject(workspace))
	fs.mkdirSync(sessionsDir, { recursive: true })
	fs.mkdirSync(projectDir, { recursive: true })
	fs.mkdirSync(workspace, { recursive: true })
	const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
	fs.writeFileSync(transcriptPath, [
		JSON.stringify({
			type: 'user',
			uuid: 'u-init',
			timestamp: '2026-11-14T20:00:00Z',
			message: { role: 'user', content: 'Starting in Claude Desktop' }
		}),
		JSON.stringify({
			type: 'assistant',
			uuid: 'a-init',
			timestamp: '2026-11-14T20:00:01Z',
			message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'Ready in Claude!' }] }
		})
	].join('\n') + '\n')
	const receivedFrames = []
	let resolvePromptFrame
	const promptFrameDone = new Promise(resolve => { resolvePromptFrame = resolve })
	let resolveCancelFrame
	const cancelFrameDone = new Promise(resolve => { resolveCancelFrame = resolve })
	const udsServer = net.createServer(conn => {
		let buf = ''
		conn.on('data', chunk => { buf += chunk.toString('utf8') })
		conn.on('end', () => {
			const lines = buf.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
			receivedFrames.push(lines)
			const userFrame = lines.find(l => l.type === 'user')
			if (userFrame && userFrame.priority === 'now') {
				resolveCancelFrame()
			} else if (userFrame) {
				fs.appendFileSync(transcriptPath, [
					JSON.stringify({
						type: 'user',
						uuid: 'u-guest',
						isMeta: true,
						origin: { kind: 'peer' },
						message: {
							role: 'user',
							content: `Another Claude session sent a message:\n${userFrame.message.content}\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.`
						}
					}),
					JSON.stringify({
						type: 'assistant',
						uuid: 'a-guest',
						message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'Got guest message in Claude!' }] }
					})
				].join('\n') + '\n')
				resolvePromptFrame()
			}
		})
	})
	await new Promise(resolve => udsServer.listen(sockPath, resolve))
	const canonicalSock = fs.realpathSync(sockPath)
	const sockDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSock)))
	let sockHash = ''
	for (let i = 0; i < sockDigest.byteLength; i++) sockHash += sockDigest[i].toString(16).padStart(2, '0')
	fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({
		pid: process.pid,
		sessionId,
		cwd: workspace,
		messagingSocketPath: canonicalSock,
		updatedAt: Date.now()
	}))
	fs.writeFileSync(path.join(sessionsDir, `${process.pid}.${sockHash}.key`), JSON.stringify({
		peerToken: 'claude-secret-peer-token'
	}))
	const relay = new Relay()
	const relayAddr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${relayAddr.port}`
	const hostSession = new Host({
		env: {},
		harness: 'claude',
		claudeConfigDir: configDir,
		workspace,
		relayUrl,
		name: 'wife',
		trackState: false
	})
	await hostSession.connect()
	assert.equal(hostSession.harness, 'claude')
	assert.equal(hostSession.room, sessionId)
	const seenSteps = []
	let resolveReplyStep
	const replyStepDone = new Promise(resolve => { resolveReplyStep = resolve })
	const guestSession = new Guest({
		env: {},
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: { write () {} }
	})
	guestSession.addEventListener('step', ev => {
		seenSteps.push(ev.detail)
		if (ev.detail.index === 3) resolveReplyStep()
	})
	await guestSession.connect()
	await new Promise(resolve => setTimeout(resolve, 60))
	assert.equal(seenSteps.length, 2)
	assert.equal(seenSteps[0].text, 'Starting in Claude Desktop')
	await guestSession.send('hi from jesse!')
	await promptFrameDone
	await replyStepDone
	assert.equal(seenSteps[2].role, 'user')
	assert.equal(seenSteps[2].text, 'hi from jesse!')
	assert.equal(seenSteps[3].text, 'Got guest message in Claude!')
	guestSession.cancel()
	await cancelFrameDone
	assert.deepEqual(receivedFrames[0][0], { type: 'auth', token: 'claude-secret-peer-token' })
	assert.equal(receivedFrames[0][1].message.content, 'hi from jesse!')
	assert.equal(receivedFrames[1][1].priority, 'now')
	guestSession.disconnect()
	hostSession.disconnect()
	await relay.close()
	await new Promise(resolve => udsServer.close(resolve))
	fs.rmSync(shortTmp, { recursive: true, force: true })
})

test('large multi-tool step (>100KB encrypted) streams cleanly across WebSocket frames', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wye-large-'))
	const convId = '99999999-2222-3333-4444-555555555555'
	const logDir = path.join(tmpDir, 'brain', convId, '.system_generated', 'logs')
	fs.mkdirSync(logDir, { recursive: true })
	const transcriptPath = path.join(logDir, 'transcript_full.jsonl')
	const bigChunk = 'x'.repeat(28000)
	fs.writeFileSync(transcriptPath, [
		JSON.stringify({
			step_index: 1,
			source: 'MODEL',
			type: 'PLANNER_RESPONSE',
			status: 'DONE',
			content: 'Done inspecting.',
			tool_calls: [
				{ name: 'call_mcp_tool', args: { ServerName: 'topical', ToolName: 'http_api', Arguments: { url: '/1' } } },
				{ name: 'call_mcp_tool', args: { ServerName: 'topical', ToolName: 'http_api', Arguments: { url: '/2' } } },
				{ name: 'call_mcp_tool', args: { ServerName: 'topical', ToolName: 'http_api', Arguments: { url: '/3' } } },
				{ name: 'call_mcp_tool', args: { ServerName: 'topical', ToolName: 'http_api', Arguments: { url: '/4' } } }
			]
		}),
		JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: bigChunk }),
		JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: bigChunk }),
		JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', content: bigChunk }),
		JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'DONE', content: bigChunk })
	].join('\n') + '\n')
	const relay = new Relay()
	const addr = await relay.open(0, '127.0.0.1')
	const host = new Host({
		relayUrl: `ws://127.0.0.1:${addr.port}`,
		conversationId: convId,
		appDataDir: tmpDir,
		lsAddress: '127.0.0.1:9',
		csrfToken: 'tok',
		trackState: false
	})
	await host.connect()
	let resolveSnap
	const snapDone = new Promise(resolve => { resolveSnap = resolve })
	let received = null
	const guest = new Guest({
		target: host.webUrl,
		interactive: false,
		output: { write () {} }
	})
	guest.addEventListener('snapshot', ev => {
		received = ev.detail.steps[0]
		resolveSnap()
	})
	await guest.connect()
	await snapDone
	assert.ok(received)
	assert.equal(received.tools.length, 4)
	assert.equal(received.tools[3].status, 'done')
	assert.equal(received.tools[3].output.length, 28000)
	guest.disconnect()
	host.disconnect()
	await relay.close()
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('resolveHarness reports actionable errors for missing session environments', async () => {
	const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wye-empty-'))
	await assert.rejects(
		() => resolveHarness({ env: { CLAUDE_CONFIG_DIR: emptyDir }, workspace: emptyDir }),
		err => {
			assert.match(err.message, /Antigravity or Claude Code/)
			assert.match(err.message, /`!` bash mode/)
			assert.match(err.message, /--session/)
			return true
		}
	)
	await assert.rejects(
		() => resolveHarness({ env: {}, harness: 'antigravity' }),
		err => {
			assert.match(err.message, /ANTIGRAVITY_CONVERSATION_ID, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN/)
			assert.match(err.message, /agent tool calls/)
			return true
		}
	)
	await assert.rejects(
		() => resolveHarness({ env: { ANTIGRAVITY_CONVERSATION_ID: 'conv-1' } }),
		err => {
			assert.match(err.message, /Missing Antigravity session environment \(ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN\)/)
			return true
		}
	)
	await assert.rejects(
		() => resolveHarness({ env: { CLAUDE_CONFIG_DIR: emptyDir }, harness: 'claude', workspace: emptyDir }),
		err => {
			assert.match(err.message, /Could not locate an active Claude Code session/)
			return true
		}
	)
	const cliRes = spawnSync(process.execPath, [path.resolve('bin/wye.js'), 'host'], {
		cwd: emptyDir,
		env: { PATH: process.env.PATH, HOME: emptyDir },
		encoding: 'utf8'
	})
	assert.equal(cliRes.status, 1)
	assert.match(cliRes.stderr, /Could not detect an active Antigravity or Claude Code session/)
	assert.doesNotMatch(cliRes.stderr, /\n\s+at /)
	fs.rmSync(emptyDir, { recursive: true, force: true })
})

test('relay clears old-epoch state on host restart', async () => {
	const relay = new Relay()
	const addr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${addr.port}`
	const makeStubHost = (room, steps) => new Host({
		relayUrl,
		room,
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: room,
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch (onStep) {
				for (const s of steps) onStep(s)
				return () => {}
			},
			async send () {},
			async cancel () {}
		}
	})
	const host1 = makeStubHost('shared-room', [
		{ index: 0, role: 'user', text: 'old turn 0', status: 'DONE' },
		{ index: 1, role: 'assistant', text: 'old turn 1', tools: [], status: 'DONE' }
	])
	await host1.connect()
	const oldGuestClosed = new Promise(resolve => {
		const oldGuest = new Guest({ target: host1.webUrl, name: 'old', interactive: false, output: { write () {} } })
		oldGuest.addEventListener('close', () => resolve(oldGuest))
		oldGuest.connect()
	})
	await new Promise(resolve => setTimeout(resolve, 40))
	host1.disconnect()
	const host2 = makeStubHost('shared-room', [
		{ index: 0, role: 'user', text: 'new turn 0', status: 'DONE' }
	])
	await host2.connect()
	await oldGuestClosed
	let snapshot = null
	const guest2 = new Guest({ target: host2.webUrl, name: 'alice', interactive: false, output: { write () {} } })
	const snapDone = new Promise(resolve => {
		guest2.addEventListener('snapshot', ev => {
			snapshot = ev.detail
			resolve()
		})
	})
	await guest2.connect()
	await snapDone
	assert.equal(snapshot.steps.length, 1)
	assert.equal(snapshot.steps[0].text, 'new turn 0')
	assert.deepEqual(snapshot.members.map(m => m.name), [os.userInfo().username, 'alice'])
	guest2.disconnect()
	host2.disconnect()
	await relay.close()
})

test('relay reaps unresponsive peers on heartbeat and frees rooms', async t => {
	const relay = new Relay({ pingIntervalMs: 30 })
	t.after(() => relay.close())
	const addr = await relay.open(0, '127.0.0.1')
	const rawSock = net.createConnection({ host: '127.0.0.1', port: addr.port })
	await new Promise(resolve => {
		rawSock.on('connect', () => {
			rawSock.write([
				'GET /ws/zombie-room?role=guest HTTP/1.1',
				`Host: 127.0.0.1:${addr.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'\r\n'
			].join('\r\n'))
		})
		rawSock.once('data', resolve)
	})
	rawSock.resume()
	assert.equal(relay.rooms.size, 1)
	await new Promise(resolve => { rawSock.on('close', resolve) })
	await new Promise(resolve => setTimeout(resolve, 20))
	assert.equal(relay.rooms.size, 0)
	const badWs = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/malformed-room?role=guest`)
	await new Promise(resolve => { badWs.onopen = resolve })
	badWs.send('{not json')
	await new Promise(resolve => { badWs.onclose = resolve })
	await new Promise(resolve => setTimeout(resolve, 20))
	assert.equal(relay.rooms.size, 0)
	const hugeSock = net.createConnection({ host: '127.0.0.1', port: addr.port })
	await new Promise(resolve => {
		hugeSock.on('connect', () => {
			hugeSock.write([
				'GET /ws/huge-room?role=guest HTTP/1.1',
				`Host: 127.0.0.1:${addr.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'\r\n'
			].join('\r\n'))
		})
		hugeSock.once('data', resolve)
	})
	hugeSock.resume()
	const header = new Uint8Array(10)
	header[0] = 0x81
	header[1] = 0xff
	new DataView(header.buffer).setBigUint64(2, 10_000_000n)
	hugeSock.write(header)
	await new Promise(resolve => { hugeSock.on('close', resolve) })
	await new Promise(resolve => setTimeout(resolve, 20))
	assert.equal(relay.rooms.size, 0)
})

test('guest shows working indicator, wait hint on stalled tool, and settles on cancel', async () => {
	const relay = new Relay()
	const addr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${addr.port}`
	let canceled = false
	let emitStep
	const host = new Host({
		relayUrl,
		room: 'wait-cancel-room',
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: 'wait-cancel-room',
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch (onStep) {
				emitStep = onStep
				return () => {}
			},
			async send () {},
			async cancel () { canceled = true }
		}
	})
	await host.connect()
	let output = ''
	const guest = new Guest({
		target: host.webUrl,
		name: 'alice',
		interactive: false,
		waitHintMs: 40,
		output: { write (s) { output += s } }
	})
	const snapped = new Promise(resolve => guest.addEventListener('snapshot', resolve, { once: true }))
	await guest.connect()
	await snapped
	const userDelivered = new Promise(resolve => guest.addEventListener('step', resolve, { once: true }))
	emitStep({ index: 0, role: 'user', text: 'check headers', status: 'DONE' })
	await userDelivered
	assert.match(output, /\* working…/)
	emitStep({
		index: 1,
		role: 'assistant',
		text: '',
		tools: [{ label: 'Bash', detail: 'curl -I https://example.com', status: 'running' }],
		status: 'DONE'
	})
	await new Promise(resolve => setTimeout(resolve, 90))
	assert.match(output, /\* waiting on Bash \(output or host approval · \/stop or ctrl\+c to cancel\)/)
	const updated = new Promise(resolve => {
		guest.addEventListener('step', ev => {
			if (ev.detail.tools?.[0]?.status === 'error') resolve(ev.detail)
		})
	})
	guest.cancel()
	const settled = await updated
	assert.equal(canceled, true)
	assert.equal(settled.tools[0].status, 'error')
	assert.equal(settled.tools[0].output, 'Cancelled by alice')
	assert.match(output, /Cancelled by alice/)
	guest.disconnect()
	host.disconnect()
	await relay.close()
})

test('host and guest report clear guidance when #key mismatches or rotates', async t => {
	const relay = new Relay()
	t.after(() => relay.close())
	const addr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${addr.port}`
	const makeStubHost = room => new Host({
		relayUrl,
		room,
		reconnect: false,
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: room,
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch () { return () => {} },
			async send () {},
			async cancel () {}
		}
	})
	const host1 = makeStubHost('key-rotate-room')
	await host1.connect()
	host1.disconnect()
	const host2 = makeStubHost('key-rotate-room')
	const host2Err = new Promise(resolve => {
		host2.addEventListener('error', ev => resolve(ev.detail.message), { once: true })
	})
	await host2.connect()
	let firstOutput = ''
	const badGuest = new Guest({
		target: host1.webUrl,
		name: 'stale-guest',
		interactive: false,
		output: { write (s) { firstOutput += s } }
	})
	const badErr = new Promise(resolve => {
		badGuest.addEventListener('error', ev => resolve(ev.detail))
	})
	await badGuest.connect()
	const [err, hostErrMsg] = await Promise.all([badErr, host2Err])
	assert.equal(err.name, 'KeyMismatchError')
	assert.match(firstOutput, /Decryption error \(check room #key\): Mismatched room #key\./)
	assert.match(hostErrMsg, /Ignored guest message with mismatched #key/)
	badGuest.disconnect()
	let activeOutput = ''
	const activeGuest = new Guest({
		target: host2.webUrl,
		name: 'bob',
		interactive: false,
		output: { write (s) { activeOutput += s } }
	})
	const snapped = new Promise(resolve => {
		activeGuest.addEventListener('snapshot', resolve, { once: true })
	})
	await activeGuest.connect()
	await snapped
	const otherGuest = new Guest({
		target: host1.webUrl,
		name: 'eve',
		interactive: false,
		output: { write () {} }
	})
	const activeErr = new Promise(resolve => {
		activeGuest.addEventListener('error', ev => resolve(ev.detail))
	})
	await otherGuest.connect()
	await activeErr
	assert.match(activeOutput, /Host restarted the share with a new #key — rejoin with the updated URL/)
	otherGuest.disconnect()
	activeGuest.disconnect()
	host2.disconnect()
})

test('guest does not show wait hint for running background tool once newer step arrives', async t => {
	const relay = new Relay()
	t.after(() => relay.close())
	const addr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${addr.port}`
	const host = new Host({
		relayUrl,
		room: 'bg-tool-room',
		reconnect: false,
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: 'bg-tool-room',
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch (onStep) {
				onStep({
					index: 0,
					role: 'assistant',
					text: '',
					tools: [{ label: 'Bash', detail: 'wye host', status: 'running' }],
					status: 'DONE'
				})
				onStep({
					index: 1,
					role: 'assistant',
					text: 'Live share started.',
					tools: [],
					status: 'DONE'
				})
				return () => {}
			},
			async send () {},
			async cancel () {}
		}
	})
	await host.connect()
	let output = ''
	const guest = new Guest({
		target: host.webUrl,
		name: 'alice',
		interactive: false,
		waitHintMs: 30,
		output: { write (s) { output += s } }
	})
	await guest.connect()
	await new Promise(resolve => setTimeout(resolve, 70))
	assert.doesNotMatch(output, /waiting on Bash/)
	guest.disconnect()
	host.disconnect()
})

test('rewound user step truncates superseded tail and holes live and on snapshot', async t => {
	const relay = new Relay()
	t.after(() => relay.close())
	const addr = await relay.open(0, '127.0.0.1')
	let emitStep
	const host = new Host({
		relayUrl: `ws://127.0.0.1:${addr.port}`,
		room: 'rewind-room',
		reconnect: false,
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: 'rewind-room',
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch (onStep) {
				emitStep = onStep
				onStep({ index: 0, role: 'user', text: 'hello', status: 'DONE' })
				onStep({ index: 1, role: 'assistant', text: 'hi there', tools: [], status: 'DONE' })
				onStep({ index: 2, role: 'user', text: 'abandoned prompt', status: 'DONE' })
				onStep({ index: 3, role: 'assistant', text: 'abandoned hole', tools: [], status: 'DONE' })
				onStep({ index: 4, role: 'assistant', text: 'abandoned tail', tools: [], status: 'DONE' })
				return () => {}
			},
			async send () {},
			async cancel () {}
		}
	})
	await host.connect()
	const guest1 = new Guest({ target: host.webUrl, name: 'g1', interactive: false, output: { write () {} } })
	t.after(() => {
		guest1.disconnect()
		host.disconnect()
	})
	const snap1 = new Promise(resolve => guest1.addEventListener('snapshot', resolve, { once: true }))
	await guest1.connect()
	await snap1
	assert.deepEqual([...guest1.stepsByIndex.keys()], [0, 1, 2, 3, 4])
	const truncated = new Promise(resolve => {
		guest1.addEventListener('truncate', ev => resolve(ev.detail.fromIndex), { once: true })
	})
	const gotReply = new Promise(resolve => {
		guest1.addEventListener('step', ev => {
			if (ev.detail.index === 4 && ev.detail.text === 'rewound reply') resolve()
		})
	})
	emitStep({ index: 2, role: 'user', text: 'rewound prompt', status: 'DONE' })
	emitStep({ index: 4, role: 'assistant', text: 'rewound reply', tools: [], status: 'DONE' })
	assert.equal(await truncated, 2)
	await gotReply
	assert.deepEqual([...guest1.stepsByIndex.keys()], [0, 1, 2, 4])
	assert.equal(guest1.stepsByIndex.get(2).text, 'rewound prompt')
	assert.equal(guest1.stepsByIndex.get(3), undefined)
	const guest2 = new Guest({ target: host.webUrl, name: 'g2', interactive: false, output: { write () {} } })
	const snap2 = new Promise(resolve => guest2.addEventListener('snapshot', ev => resolve(ev.detail), { once: true }))
	await guest2.connect()
	assert.deepEqual((await snap2).steps.map(s => s.index), [0, 1, 2, 4])
	guest2.disconnect()
})

test('relay bounds room count, guest count, room step bytes, and maxPayload', async t => {
	const relay = new Relay({ maxRooms: 2, maxGuests: 1, maxRoomBytes: 4000, maxPayload: 16384 })
	t.after(() => relay.close())
	const addr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${addr.port}`
	let emitStep
	const makeStubHost = room => new Host({
		relayUrl,
		room,
		reconnect: false,
		trackState: false,
		harness: {
			type: 'antigravity',
			conversationId: room,
			workspace: '/tmp/ws',
			transcriptPath: '',
			watch (onStep) {
				if (room === 'cap-room-1') emitStep = onStep
				return () => {}
			},
			async send () {},
			async cancel () {}
		}
	})
	const host1 = makeStubHost('cap-room-1')
	const host2 = makeStubHost('cap-room-2')
	const host3 = makeStubHost('cap-room-3')
	t.after(() => {
		host1.disconnect()
		host2.disconnect()
		host3.disconnect()
	})
	await host1.connect()
	await host2.connect()
	await assert.rejects(() => host3.connect())
	const guest1 = new Guest({ target: host1.webUrl, name: 'g1', interactive: false, output: { write () {} } })
	const guest2 = new Guest({ target: host1.webUrl, name: 'g2', interactive: false, output: { write () {} } })
	t.after(() => {
		guest1.disconnect()
		guest2.disconnect()
	})
	await guest1.connect()
	await assert.rejects(() => guest2.connect())
	const seenOnGuest1 = new Promise(resolve => {
		guest1.addEventListener('step', ev => {
			if (ev.detail.index === 2) resolve()
		})
	})
	emitStep({ index: 0, role: 'assistant', text: 'a'.repeat(1600), tools: [], status: 'DONE' })
	emitStep({ index: 1, role: 'assistant', text: 'b'.repeat(1600), tools: [], status: 'DONE' })
	emitStep({ index: 2, role: 'assistant', text: 'c'.repeat(1600), tools: [], status: 'DONE' })
	await seenOnGuest1
	const relayRoom = relay.rooms.get('cap-room-1')
	assert.ok(relayRoom.stepBytes <= 4000)
	assert.equal(relayRoom.steps.has(0), false)
	assert.equal(relayRoom.steps.has(2), true)
	const oversized = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/cap-room-2?role=guest`)
	await new Promise(resolve => { oversized.onopen = resolve })
	const closed = new Promise(resolve => { oversized.onclose = resolve })
	oversized.send('x'.repeat(20000))
	await closed
})

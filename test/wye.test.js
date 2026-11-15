import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { createAntigravityStepParser } from '../lib/harnesses/antigravity.js'
import { createClaudeStepParser, slugifyClaudeProject } from '../lib/harnesses/claude.js'
import { createRelay } from '../lib/relay.js'
import { connectHost, listHosts } from '../lib/host.js'
import { connectGuest, formatStep } from '../lib/join.js'

test('createAntigravityStepParser formats agy-style tools and correlates GENERIC + background outputs', () => {
	const parse = createAntigravityStepParser({ homeDir: '/Users/jesse' })
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
})

test('createClaudeStepParser coalesces assistant blocks, attaches tool_result outputs, and unwraps peer prompts', () => {
	const parse = createClaudeStepParser({ homeDir: '/Users/jesse' })
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
		toolUseResult: { stdout: 'export default 42' },
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'export default 42' }] }
	}))
	assert.equal(aAfterRes.index, 1)
	assert.equal(aAfterRes.tools[0].status, 'done')
	assert.equal(aAfterRes.tools[0].output, 'export default 42')
	const peerPrompt = parse(JSON.stringify({
		type: 'user',
		uuid: 'u-peer',
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
	let relay = createRelay()
	const relayAddr = await relay.open(0, '127.0.0.1')
	const relayPort = relayAddr.port
	const relayUrl = `ws://127.0.0.1:${relayPort}`
	let resolveReconnected
	const reconnectedDone = new Promise(resolve => { resolveReconnected = resolve })
	const hostSession = await connectHost({
		relayUrl,
		name: 'partner',
		conversationId: convId,
		appDataDir: tmpDir,
		lsAddress: `127.0.0.1:${lsPort}`,
		csrfToken: 'secret-csrf',
		workspace: '/Users/partner/project',
		stateDir,
		reconnectDelayMs: 40,
		maxReconnectDelayMs: 100,
		onError () {},
		onEvent (ev) {
			if (ev.type === 'reconnected') resolveReconnected()
		}
	})
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
	const out = new PassThrough()
	let renderedOutput = ''
	out.on('data', chunk => { renderedOutput += chunk.toString('utf8') })
	const guestSession = await connectGuest({
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: out,
		onStep (step) {
			seenSteps.push(step)
			if (step.index === 3) resolveLiveDone()
		}
	})
	await new Promise(resolve => setTimeout(resolve, 60))
	assert.equal(seenSteps.length, 2)
	const relayRoom = relay.rooms.get(convId)
	assert.ok(!JSON.stringify([...relayRoom.steps.values()]).includes('already chatting in desktop'))
	assert.ok(!JSON.stringify(relayRoom.metaBox).includes('/Users/partner/project'))
	await guestSession.sendPrompt('hey partner, jumping in!')
	await liveDone
	guestSession.sendCancel()
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
		const badGuest = await connectGuest({
			target: wrongKeyUrl,
			name: 'intruder',
			interactive: false,
			output: new PassThrough(),
			onError (err) {
				decryptErr = err
			}
		})
		await new Promise(resolve => setTimeout(resolve, 50))
		badGuest.disconnect()
		if (decryptErr) throw decryptErr
	})
	guestSession.disconnect()
	await relay.close()
	relay = createRelay()
	await relay.open(relayPort, '127.0.0.1')
	await reconnectedDone
	await new Promise(resolve => setTimeout(resolve, 60))
	let snapshotCount = 0
	const guestAfterRestart = await connectGuest({
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: new PassThrough(),
		onSnapshot (snap) {
			snapshotCount = snap.steps.length
		}
	})
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
	const projectDir = path.join(configDir, 'projects', slugifyClaudeProject(workspace))
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
	const sockHash = crypto.createHash('sha256').update(canonicalSock).digest('hex')
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
	const relay = createRelay()
	const relayAddr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${relayAddr.port}`
	const hostSession = await connectHost({
		env: {},
		harness: 'claude',
		claudeConfigDir: configDir,
		workspace,
		relayUrl,
		name: 'wife',
		trackState: false
	})
	assert.equal(hostSession.harness, 'claude')
	assert.equal(hostSession.room, sessionId)
	const seenSteps = []
	let resolveReplyStep
	const replyStepDone = new Promise(resolve => { resolveReplyStep = resolve })
	const guestSession = await connectGuest({
		env: {},
		target: hostSession.webUrl,
		name: 'jesse',
		interactive: false,
		output: new PassThrough(),
		onStep (step) {
			seenSteps.push(step)
			if (step.index === 3) resolveReplyStep()
		}
	})
	await new Promise(resolve => setTimeout(resolve, 60))
	assert.equal(seenSteps.length, 2)
	assert.equal(seenSteps[0].text, 'Starting in Claude Desktop')
	await guestSession.sendPrompt('hi from jesse!')
	await promptFrameDone
	await replyStepDone
	assert.equal(seenSteps[2].role, 'user')
	assert.equal(seenSteps[2].text, 'hi from jesse!')
	assert.equal(seenSteps[3].text, 'Got guest message in Claude!')
	guestSession.sendCancel()
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

test('large multi-tool step (>100KB encrypted) streams cleanly across WsPeer fragmentation', async () => {
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
	const relay = createRelay()
	const addr = await relay.open(0, '127.0.0.1')
	const host = await connectHost({
		relayUrl: `ws://127.0.0.1:${addr.port}`,
		conversationId: convId,
		appDataDir: tmpDir,
		lsAddress: '127.0.0.1:9',
		csrfToken: 'tok',
		trackState: false
	})
	let resolveSnap
	const snapDone = new Promise(resolve => { resolveSnap = resolve })
	let received = null
	const guest = await connectGuest({
		target: host.webUrl,
		interactive: false,
		output: new PassThrough(),
		onSnapshot (snap) {
			received = snap.steps[0]
			resolveSnap()
		}
	})
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

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { parseStep } from '../lib/transcript.js'
import { createRelay } from '../lib/relay.js'
import { connectHost } from '../lib/host.js'
import { connectGuest } from '../lib/join.js'

test('parseStep normalizes user, assistant, and error steps', () => {
	const userStep = parseStep(JSON.stringify({
		step_index: 0,
		source: 'USER_EXPLICIT',
		type: 'USER_INPUT',
		status: 'DONE',
		created_at: '2026-11-13T20:00:00Z',
		content: '<USER_REQUEST>\ninitial desktop question\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>'
	}))
	assert.equal(userStep.role, 'user')
	assert.equal(userStep.text, 'initial desktop question')
	const modelStep = parseStep(JSON.stringify({
		step_index: 3,
		source: 'MODEL',
		type: 'PLANNER_RESPONSE',
		status: 'DONE',
		created_at: '2026-11-13T20:01:05Z',
		content: 'Here is the **answer**.',
		tool_calls: [{ name: 'read_file', args: { Path: '/tmp/demo.js' } }]
	}))
	assert.equal(modelStep.role, 'assistant')
	assert.equal(modelStep.text, 'Here is the **answer**.')
	assert.deepEqual(modelStep.tools, [{ label: 'Read', detail: '/tmp/demo.js' }])
})

test('end-to-end host + relay + guest syncs existing desktop history and untouched live prompts', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'))
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
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end('{}')
		})
	})
	await new Promise(resolve => mockLs.listen(0, '127.0.0.1', resolve))
	const lsPort = mockLs.address().port
	const relay = createRelay()
	const relayAddr = await relay.open(0, '127.0.0.1')
	const relayUrl = `ws://127.0.0.1:${relayAddr.port}`
	const hostSession = await connectHost({
		relayUrl,
		name: 'partner',
		conversationId: convId,
		appDataDir: tmpDir,
		lsAddress: `127.0.0.1:${lsPort}`,
		csrfToken: 'secret-csrf',
		workspace: '/Users/partner/project'
	})
	assert.equal(hostSession.room, convId)
	const seenSteps = []
	let resolveLiveDone
	const liveDone = new Promise(resolve => { resolveLiveDone = resolve })
	const out = new PassThrough()
	let renderedOutput = ''
	out.on('data', chunk => { renderedOutput += chunk.toString('utf8') })
	const guestSession = await connectGuest({
		target: `${relayUrl}/${convId}`,
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
	assert.equal(seenSteps[0].text, 'already chatting in desktop')
	assert.equal(seenSteps[1].text, 'Prior desktop reply.')
	guestSession.sendPrompt('hey partner, jumping in!')
	await liveDone
	assert.equal(receivedRpc.length, 1)
	assert.equal(receivedRpc[0].url, '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage')
	assert.equal(receivedRpc[0].csrf, 'secret-csrf')
	assert.equal(receivedRpc[0].payload.cascadeId, convId)
	assert.equal(receivedRpc[0].payload.items[0].text, 'hey partner, jumping in!')
	assert.equal(seenSteps.length, 4)
	assert.equal(seenSteps[2].text, 'hey partner, jumping in!')
	assert.equal(seenSteps[3].text, 'Live reply to both partners!')
	assert.match(renderedOutput, / > already chatting in desktop /)
	assert.match(renderedOutput, / > hey partner, jumping in! /)
	guestSession.disconnect()
	hostSession.disconnect()
	await relay.close()
	await new Promise(resolve => mockLs.close(resolve))
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

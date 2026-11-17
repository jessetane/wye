import * as antigravity from './antigravity.js'
import * as claude from './claude.js'

export async function resolveHarness (opts = {}) {
	if (opts.harness && typeof opts.harness === 'object') return opts.harness
	const env = opts.env || process.env
	const requested = (opts.harness || '').toLowerCase()
	if (requested === 'antigravity') return antigravity.createHarness(opts)
	if (requested === 'claude') return await claude.createHarness(opts)
	if (requested) throw new Error(`Unknown harness "${requested}". Expected "antigravity" or "claude".`)
	if (opts.lsAddress || opts.conversationId || env.ANTIGRAVITY_LS_ADDRESS || env.ANTIGRAVITY_CONVERSATION_ID) {
		return antigravity.createHarness(opts)
	}
	if (opts.sessionId || opts.claudeConfigDir || opts.socketPath || env.CLAUDE_CODE_MESSAGING_SOCKET) {
		return await claude.createHarness(opts)
	}
	const session = await claude.discoverSession(opts)
	if (session) return await claude.createHarness({ ...opts, session })
	throw new Error(
		'Could not detect an active Antigravity or Claude Code session.\n' +
		'Ask the agent inside your conversation to share it (via the wye skill) instead of running `wye host` in `!` bash mode or an external terminal.\n' +
		'For Claude Code from an external terminal, pass `--session <session-id>` in the project directory.'
	)
}

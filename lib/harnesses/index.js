import { createAntigravityHarness } from './antigravity.js'
import { createClaudeHarness } from './claude.js'

export function resolveHarness (opts = {}) {
	if (opts.harness && typeof opts.harness === 'object') return opts.harness
	const env = opts.env || process.env
	const requested = (opts.harness || env.WYE_HARNESS || '').toLowerCase()
	if (requested === 'antigravity' || requested === 'agy') {
		return createAntigravityHarness(opts)
	}
	if (requested === 'claude' || requested === 'claude-code' || requested === 'cc') {
		return createClaudeHarness(opts)
	}
	if (requested) {
		throw new Error(`Unknown harness "${requested}". Expected "antigravity" or "claude".`)
	}
	if (opts.lsAddress || env.ANTIGRAVITY_LS_ADDRESS || env.ANTIGRAVITY_CONVERSATION_ID) {
		return createAntigravityHarness(opts)
	}
	if (opts.socketPath || env.CLAUDE_CODE_MESSAGING_SOCKET || env.CLAUDECODE || opts.claudeConfigDir || opts.sessionId) {
		return createClaudeHarness(opts)
	}
	return createClaudeHarness(opts)
}

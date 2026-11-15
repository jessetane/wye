import * as antigravity from './antigravity.js'
import * as claude from './claude.js'

export async function resolveHarness (opts = {}) {
	if (opts.harness && typeof opts.harness === 'object') return opts.harness
	const env = opts.env || process.env
	const requested = (opts.harness || env.WYE_HARNESS || '').toLowerCase()
	if (requested === 'antigravity') return antigravity.createHarness(opts)
	if (requested === 'claude') return await claude.createHarness(opts)
	if (requested) throw new Error(`Unknown harness "${requested}". Expected "antigravity" or "claude".`)
	if (opts.lsAddress || env.ANTIGRAVITY_LS_ADDRESS || env.ANTIGRAVITY_CONVERSATION_ID) {
		return antigravity.createHarness(opts)
	}
	return await claude.createHarness(opts)
}

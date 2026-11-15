import os from 'node:os'

const MAX_TOOL_TEXT = 32768

export function shortenHome (value, homeDir = os.homedir()) {
	const str = String(value || '')
	if (!homeDir) return str
	if (str === homeDir) return '~'
	if (str.startsWith(`${homeDir}/`)) return `~${str.slice(homeDir.length)}`
	return str
}

export function capToolText (value, maxChars = MAX_TOOL_TEXT) {
	const str = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
	if (str.length <= maxChars) return str
	const headLen = Math.floor(maxChars * 0.6)
	const tailLen = Math.floor(maxChars * 0.4)
	const omitted = str.length - headLen - tailLen
	return `${str.slice(0, headLen)}\n… [${omitted} chars truncated] …\n${str.slice(str.length - tailLen)}`
}

function formatEditDiff (oldStr, newStr) {
	const out = []
	if (oldStr) {
		for (const line of String(oldStr).replace(/\r\n/g, '\n').split('\n')) {
			out.push(`- ${line}`)
		}
	}
	if (newStr) {
		for (const line of String(newStr).replace(/\r\n/g, '\n').split('\n')) {
			out.push(`+ ${line}`)
		}
	}
	return capToolText(out.join('\n'))
}

export function normalizeToolCall (name, rawArgs = {}, homeDir = os.homedir()) {
	const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
	let label = String(name || 'Tool')
	let detail = ''
	let input = ''
	if (name === 'run_command' || name === 'Bash') {
		const cmd = String(args.CommandLine ?? args.command ?? args.toolSummary ?? args.description ?? '')
		const lines = cmd.replace(/\r\n/g, '\n').split('\n')
		label = 'Bash'
		detail = lines[0] || ''
		input = lines.length > 1 ? capToolText(cmd) : ''
	} else if (name === 'read_file' || name === 'Read') {
		const filePath = shortenHome(args.Path ?? args.file_path ?? '', homeDir)
		const start = args.StartLine ?? args.offset
		const end = args.EndLine ?? (start && args.limit ? Number(start) + Number(args.limit) - 1 : undefined)
		const range = start && end ? `:${start}-${end}` : (start ? `:${start}` : '')
		label = 'Read'
		detail = `${filePath}${range}`
	} else if (name === 'write_file' || name === 'Write') {
		const content = args.Content ?? args.content ?? ''
		label = 'Write'
		detail = shortenHome(args.Path ?? args.file_path ?? '', homeDir)
		input = content ? capToolText(content) : ''
	} else if (name === 'edit_file' || name === 'Edit') {
		label = 'Edit'
		detail = shortenHome(args.Path ?? args.file_path ?? '', homeDir)
		input = formatEditDiff(args.Target ?? args.old_string ?? '', args.Replacement ?? args.new_string ?? '')
	} else if (name === 'MultiEdit') {
		label = 'MultiEdit'
		detail = shortenHome(args.file_path ?? '', homeDir)
		const edits = Array.isArray(args.edits) ? args.edits : []
		input = capToolText(edits.map(e => formatEditDiff(e.old_string ?? '', e.new_string ?? '')).join('\n@@\n'))
	} else if (name === 'call_mcp_tool') {
		const mcpArgs = args.Arguments ?? {}
		label = `${args.ServerName || 'mcp'}/${args.ToolName || 'call'}`
		detail = JSON.stringify(mcpArgs)
		input = Object.keys(mcpArgs).length > 0 ? capToolText(JSON.stringify(mcpArgs, null, 2)) : ''
	} else if (name === 'list_resources' || name === 'read_resource') {
		const rest = { ...args }
		delete rest.ServerName
		label = `${args.ServerName || 'mcp'}/${name}`
		detail = Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''
		input = Object.keys(rest).length > 0 ? capToolText(JSON.stringify(rest, null, 2)) : ''
	} else if (/^mcp__(.+?)__(.+)$/.test(name)) {
		const m = /^mcp__(.+?)__(.+)$/.exec(name)
		label = `${m[1]}/${m[2]}`
		detail = JSON.stringify(args)
		input = Object.keys(args).length > 0 ? capToolText(JSON.stringify(args, null, 2)) : ''
	} else if (/^mcp_([^_]+)_(.+)$/.test(name)) {
		const m = /^mcp_([^_]+)_(.+)$/.exec(name)
		label = `${m[1]}/${m[2]}`
		detail = JSON.stringify(args)
		input = Object.keys(args).length > 0 ? capToolText(JSON.stringify(args, null, 2)) : ''
	} else if (name === 'search_web' || name === 'WebSearch') {
		label = 'WebSearch'
		detail = String(args.query || '')
	} else if (name === 'WebFetch') {
		label = 'WebFetch'
		detail = String(args.url || '')
		input = args.prompt ? capToolText(args.prompt) : ''
	} else if (name === 'Grep' || name === 'Glob') {
		label = name
		detail = args.path ? `${args.pattern || ''} in ${shortenHome(args.path, homeDir)}` : String(args.pattern || '')
	} else if (name === 'invoke_subagent' || name === 'Agent' || name === 'Task') {
		label = 'Subagent'
		detail = String(args.Role || args.description || args.TypeName || args.subagent_type || '')
		input = args.Prompt || args.prompt ? capToolText(args.Prompt || args.prompt) : ''
	} else {
		const hasArgs = Object.keys(args).length > 0
		detail = hasArgs ? JSON.stringify(args) : ''
		input = hasArgs ? capToolText(JSON.stringify(args, null, 2)) : ''
	}
	return {
		label,
		detail,
		input,
		status: 'running',
		output: ''
	}
}

function toBase64Url (bytes) {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url (str) {
	const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

export function generateKey () {
	const raw = new Uint8Array(16)
	crypto.getRandomValues(raw)
	return toBase64Url(raw)
}

export async function importKey (keyStr) {
	const raw = fromBase64Url(keyStr)
	if (raw.byteLength !== 16 && raw.byteLength !== 32) {
		throw new Error('Invalid room encryption key length.')
	}
	return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptJson (cryptoKey, value) {
	const iv = new Uint8Array(12)
	crypto.getRandomValues(iv)
	const plaintext = new TextEncoder().encode(JSON.stringify(value))
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext))
	const combined = new Uint8Array(iv.length + ciphertext.length)
	combined.set(iv, 0)
	combined.set(ciphertext, iv.length)
	return toBase64Url(combined)
}

export async function decryptJson (cryptoKey, box) {
	const combined = fromBase64Url(box)
	if (combined.byteLength < 28) throw new Error('Malformed encrypted payload.')
	const iv = combined.subarray(0, 12)
	const ciphertext = combined.subarray(12)
	let plaintext
	try {
		plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext)
	} catch (err) {
		if (err && err.name === 'OperationError') {
			const mismatch = new Error('Mismatched room #key.')
			mismatch.name = 'KeyMismatchError'
			throw mismatch
		}
		throw err
	}
	return JSON.parse(new TextDecoder().decode(plaintext))
}

export async function decryptRoster (cryptoKey, members) {
	return await Promise.all((members || []).map(async m => ({
		role: m.role,
		name: await decryptJson(cryptoKey, m.nameBox)
	})))
}

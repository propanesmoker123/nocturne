import { generateCode, normalizeCode } from '../together/code'

/**
 * Linking a person's own devices: one code, the same 80-bit kind as listening together, known
 * only to those devices. A QR code carries it as a nocturne:// link the phone's camera opens.
 */

const enc = new TextEncoder()
const canonical = (code: string) => (normalizeCode(code) ?? code).replace(/-/g, '')
const hexOf = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

export const newGroupCode = generateCode

/** What a QR code carries: the phone's camera opens Nocturne with it. */
export const linkFor = (code: string) => `nocturne://link?code=${code}`

/** The code from a `nocturne://link?code=…` address, or null for anything else. */
export function codeFromLink(url: string): string | null {
  const m = /^nocturne:\/\/link\/?\?code=([0-9A-Za-z-]{16,19})$/.exec(url.trim())
  return m ? normalizeCode(m[1]) : null
}

/** The topic relays see for a group: never the code itself, never a listen-together room. */
export async function groupTopic(code: string): Promise<string> {
  return `nocturne-c-${hexOf(await crypto.subtle.digest('SHA-256', enc.encode(`nocturne-connect:${canonical(code)}`))).slice(0, 16)}`
}

/** The group's AES-GCM key. */
export async function groupKey(code: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`nocturne-connect-key:${canonical(code)}`))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export const newDeviceId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')

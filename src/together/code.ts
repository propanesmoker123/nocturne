/**
 * Invite codes for listening together: 16 Crockford base32 symbols (80 random bits) in four
 * groups, e.g. K7QM-2XFD-9WRA-HT4C. The code is the room password; the room id the relays see
 * is a hash of it, so it never leaves the computer as is.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const LOOKALIKE: Record<string, string> = { O: '0', I: '1', L: '1' }
const LENGTH = 16

const group = (raw: string) => raw.match(/.{4}/g)!.join('-')

export function generateCode(): string {
  // 256 is a multiple of 32, so the low five bits of a random byte are uniform
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH))
  return group(Array.from(bytes, (b) => ALPHABET[b & 31]).join(''))
}

/** A typed or pasted code in its canonical form, or null if it is not one. */
export function normalizeCode(input: string): string | null {
  const raw = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OIL]/g, (c) => LOOKALIKE[c])
  if (raw.length !== LENGTH || ![...raw].every((c) => ALPHABET.includes(c))) return null
  return group(raw)
}

export const inviteText = (code: string) => `Слушаем вместе в Nocturne. Код: ${code}`

/** What the relays see instead of the code: the first 16 hex digits of its SHA-256. */
export async function roomIdFor(code: string): Promise<string> {
  const canonical = (normalizeCode(code) ?? code).replace(/-/g, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

import { schnorr } from '@noble/secp256k1'
import { normalizeCode } from './code'

/**
 * Everything listening together sends goes through public Nostr relays sealed with a key that
 * only the invite code gives (AES-GCM, so a changed or foreign message simply does not open).
 * The relays see a room tag and noise; ephemeral events are not even stored by them.
 */

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface EventKeys {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

const enc = new TextEncoder()
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** The room's AES key: a hash of the code, separate from the hash the relays see as the room. */
export async function roomKey(code: string): Promise<CryptoKey> {
  const canonical = (normalizeCode(code) ?? code).replace(/-/g, '')
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`nocturne-key:${canonical}`))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** base64(nonce ‖ ciphertext) of the JSON; a fresh random nonce every time. */
export async function seal(key: CryptoKey, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))))
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return toBase64(out)
}

/** The data, or null for anything that was not sealed with this key or was changed on the way. */
export async function unseal(key: CryptoKey, text: string): Promise<unknown | null> {
  const bytes = fromBase64(text)
  if (!bytes || bytes.length < 12 + 16) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return null
  }
}

/** A signed Nostr event (NIP-01): relays only pass events whose id and signature check out. */
export async function signedEvent(keys: EventKeys, kind: number, topic: string, content: string, createdAt = Math.floor(Date.now() / 1000), tagList?: string[][]): Promise<NostrEvent> {
  const pubkey = hex(keys.publicKey)
  const tags = tagList ?? [['x', topic]]
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify([0, pubkey, createdAt, kind, tags, content]))))
  const sig = await schnorr.signAsync(hash, keys.secretKey)
  return { id: hex(hash), pubkey, created_at: createdAt, kind, tags, content, sig: hex(sig) }
}

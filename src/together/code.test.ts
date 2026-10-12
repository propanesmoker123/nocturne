import { describe, expect, test } from 'vitest'
import { generateCode, inviteText, normalizeCode, roomIdFor } from './code'

const FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/

describe('invite codes', () => {
  test('a new code is 16 Crockford base32 symbols in four groups, and codes do not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, generateCode))
    expect(codes.size).toBe(200)
    for (const c of codes) expect(c).toMatch(FORMAT)
  })

  test('typed codes are forgiving about case, dashes, spaces and look-alike letters', () => {
    expect(normalizeCode('k7qm2xfd9wraht4c')).toBe('K7QM-2XFD-9WRA-HT4C')
    expect(normalizeCode(' K7QM - 2XFD 9WRA-HT4C ')).toBe('K7QM-2XFD-9WRA-HT4C')
    expect(normalizeCode('O1IL-0000-0000-0000')).toBe('0111-0000-0000-0000')
    expect(normalizeCode('K7QM-2XFD-9WRA')).toBe(null)
    expect(normalizeCode('K7QM-2XFD-9WRA-HT4#')).toBe(null)
    expect(normalizeCode('K7QM-2XFD-9WRA-HT4U')).toBe(null)
  })

  test('the invite carries the code in its grouped form (the app picks it out of the clipboard)', () => {
    expect(inviteText('K7QM-2XFD-9WRA-HT4C')).toBe('Слушаем вместе в Nocturne. Код: K7QM-2XFD-9WRA-HT4C')
  })

  test('the room id comes from the code, whatever way it was typed, and reveals nothing of it', async () => {
    const a = await roomIdFor('K7QM-2XFD-9WRA-HT4C')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(await roomIdFor('k7qm2xfd9wraht4c')).toBe(a)
    expect(await roomIdFor('K7QM-2XFD-9WRA-HT4D')).not.toBe(a)
    expect(a).not.toContain('k7qm')
  })
})

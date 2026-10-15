import { describe, expect, test } from 'vitest'
import { friendMatches } from './friends'

describe('finding a friend by name', () => {
  test('any part of the name, any case, ё and е alike', () => {
    expect(friendMatches('Алёна Петрова', 'пет')).toBe(true)
    expect(friendMatches('Алёна Петрова', 'АЛЕНА')).toBe(true)
    expect(friendMatches('Алена Петрова', 'алён')).toBe(true)
    expect(friendMatches('Алёна Петрова', 'иван')).toBe(false)
  })

  test('an empty search shows everyone', () => {
    expect(friendMatches('Кто угодно', '  ')).toBe(true)
  })
})

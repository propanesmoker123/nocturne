import { describe, expect, test } from 'vitest'
import confText from '../../src-tauri/tauri.conf.json?raw'

// The release build applies this policy (a dev build does not): what it leaves out never plays
const conf = JSON.parse(confText) as { app: { security: { csp: string } } }
const directive = (name: string) =>
  conf.app.security.csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? []

describe('the release content policy', () => {
  test("VK's own mp3 links may play, and no other outside address", () => {
    const media = directive('media-src')
    for (const host of ['https://*.vkuseraudio.ru', 'https://*.vkuseraudio.net', 'https://*.vkuseraudio.com']) expect(media).toContain(host)
    expect(media).not.toContain('https:')
    expect(media).not.toContain('*')
  })
})

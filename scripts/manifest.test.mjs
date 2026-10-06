import { describe, expect, test } from 'vitest'
import { buildManifest, repoFromEndpoint } from './manifest.mjs'

describe('buildManifest', () => {
  test('describes the Windows installer for the Tauri updater', () => {
    const m = buildManifest({
      version: '0.2.0',
      notes: 'Остров можно двигать',
      pubDate: new Date('2026-10-06T12:00:00Z'),
      repo: 'someone/nocturne',
      file: 'Nocturne_0.2.0_x64-setup.exe',
      signature: 'SIG\n',
    })
    expect(m).toEqual({
      version: '0.2.0',
      notes: 'Остров можно двигать',
      pub_date: '2026-10-06T12:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature: 'SIG',
          url: 'https://github.com/someone/nocturne/releases/download/v0.2.0/Nocturne_0.2.0_x64-setup.exe',
        },
      },
    })
  })
})

describe('repoFromEndpoint', () => {
  test('reads owner/repo from the updater endpoint', () => {
    expect(repoFromEndpoint('https://github.com/someone/nocturne/releases/latest/download/latest.json')).toBe('someone/nocturne')
  })

  test('rejects endpoints that are not GitHub releases', () => {
    expect(() => repoFromEndpoint('https://example.com/latest.json')).toThrow()
  })
})

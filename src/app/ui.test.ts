import { beforeEach, describe, expect, test } from 'vitest'
import { useUi } from './ui'

describe('useUi nowPlaying tab memory', () => {
  beforeEach(() => {
    useUi.setState({ nowPlaying: false, tab: 'queue', sideOpen: false })
  })

  test('remembers the lyrics tab across closing and reopening NowPlaying without forcing queue', () => {
    useUi.getState().openNowPlaying()
    useUi.getState().setTab('lyrics')
    useUi.getState().closeNowPlaying()

    expect(useUi.getState().nowPlaying).toBe(false)
    expect(useUi.getState().tab).toBe('lyrics')

    useUi.getState().toggleNowPlaying()
    expect(useUi.getState().nowPlaying).toBe(true)
    expect(useUi.getState().tab).toBe('lyrics')
  })

  test('remembers queue once switched back before closing', () => {
    useUi.getState().setTab('lyrics')
    useUi.getState().setTab('queue')
    useUi.getState().closeNowPlaying()
    useUi.getState().toggleNowPlaying()

    expect(useUi.getState().nowPlaying).toBe(true)
    expect(useUi.getState().tab).toBe('queue')
  })

  test('opening with explicit tab forces the requested tab and opens the side panel on first click', () => {
    useUi.getState().setTab('lyrics')
    useUi.getState().closeNowPlaying()

    useUi.getState().toggleNowPlaying('queue')
    expect(useUi.getState().nowPlaying).toBe(true)
    expect(useUi.getState().tab).toBe('queue')
    expect(useUi.getState().sideOpen).toBe(true)

    useUi.getState().closeNowPlaying()
    expect(useUi.getState().sideOpen).toBe(false)

    useUi.getState().toggleNowPlaying('lyrics')
    expect(useUi.getState().nowPlaying).toBe(true)
    expect(useUi.getState().tab).toBe('lyrics')
    expect(useUi.getState().sideOpen).toBe(true)
  })
})

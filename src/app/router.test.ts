import { beforeEach, describe, expect, test } from 'vitest'
import { useRouter } from './router'

describe('useRouter scroll history', () => {
  beforeEach(() => {
    useRouter.setState({
      stack: [{ name: 'home' }],
      scrolls: [0],
      index: 0,
      route: { name: 'home' },
      canBack: false,
      canForward: false,
    })
  })

  test('saves per-entry scroll position and restores it on back/forward while new pushes open at top', () => {
    useRouter.getState().saveScroll(640)
    expect(useRouter.getState().currentScroll()).toBe(640)

    useRouter.getState().push({ name: 'album', id: 'a1' })
    expect(useRouter.getState().currentScroll()).toBe(0)

    useRouter.getState().saveScroll(220)
    useRouter.getState().push({ name: 'home' })
    expect(useRouter.getState().currentScroll()).toBe(0)

    useRouter.getState().back()
    expect(useRouter.getState().route).toEqual({ name: 'album', id: 'a1' })
    expect(useRouter.getState().currentScroll()).toBe(220)

    useRouter.getState().back()
    expect(useRouter.getState().route).toEqual({ name: 'home' })
    expect(useRouter.getState().currentScroll()).toBe(640)

    useRouter.getState().forward()
    expect(useRouter.getState().currentScroll()).toBe(220)

    useRouter.getState().forward()
    expect(useRouter.getState().route).toEqual({ name: 'home' })
    expect(useRouter.getState().currentScroll()).toBe(0)
  })
})

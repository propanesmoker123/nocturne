import { beforeEach, describe, expect, test } from 'vitest'
import { queryClient } from '../app/queryClient'
import { getScMeId } from './api'
import { applyLoginFailed, applyStatus, useScSession } from './session'

beforeEach(() => {
  queryClient.clear()
  useScSession.setState({ phase: 'checking', user: null, signingIn: false, error: null })
})

describe('SoundCloud session in the UI', () => {
  test('signing in sets the user and who likes are for', () => {
    useScSession.setState({ signingIn: true })
    applyStatus({ state: 'signed-in', user: { id: 7, name: 'n' } })
    const s = useScSession.getState()
    expect(s.phase).toBe('signed-in')
    expect(s.user?.id).toBe(7)
    expect(s.signingIn).toBe(false)
    expect(getScMeId()).toBe(7)
  })

  test('signing out drops SoundCloud data only', () => {
    applyStatus({ state: 'signed-in', user: { id: 7, name: 'n' } })
    queryClient.setQueryData(['sc-likes', 7], { items: [] })
    queryClient.setQueryData(['tracks', 1], { items: [] })
    applyStatus({ state: 'signed-out' })
    expect(queryClient.getQueryData(['sc-likes', 7])).toBeUndefined()
    expect(queryClient.getQueryData(['tracks', 1])).toBeDefined()
    expect(useScSession.getState().user).toBeNull()
    expect(getScMeId()).toBe(0)
  })

  test('a closed login window ends signing in without an error', () => {
    useScSession.setState({ signingIn: true })
    applyLoginFailed({ message: '', cancelled: true })
    expect(useScSession.getState()).toMatchObject({ signingIn: false, error: null })
  })

  test('a failed sign-in says why', () => {
    applyLoginFailed({ message: 'X', cancelled: false })
    expect(useScSession.getState().error).toBe('X')
    applyLoginFailed({ message: '', cancelled: false })
    expect(useScSession.getState().error).toBe('Не получилось войти в SoundCloud')
  })
})

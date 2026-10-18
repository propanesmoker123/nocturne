import { describe, expect, test } from 'vitest'
import { askCaptcha, useSheet } from './sheetStore'

describe('sheets', () => {
  test('a sheet that replaces a captcha answers it (the VK request does not hang) and stays open', async () => {
    const answer = askCaptcha('https://example/captcha.png')
    useSheet.getState().open({ kind: 'notes', title: 'Что нового в 0.2.11', notes: 'Свайп стал лучше.' })
    expect(await answer).toBeNull()
    expect(useSheet.getState().sheet?.kind).toBe('notes')
  })

  test('a sheet opened again is a new one: its form starts empty, even while the last one is still fading out', () => {
    useSheet.getState().open({ kind: 'album-create' })
    const first = useSheet.getState().seq
    useSheet.getState().close()
    useSheet.getState().open({ kind: 'album-create' })
    expect(useSheet.getState().seq).not.toBe(first)
  })
})

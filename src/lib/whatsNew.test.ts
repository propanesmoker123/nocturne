import { beforeEach, describe, expect, test, vi } from 'vitest'

const store = vi.hoisted(() => ({ data: null as unknown }))
vi.mock('./persist', () => ({
  loadJSON: async () => store.data,
  saveJSON: async (_name: string, d: unknown) => void (store.data = d),
}))

const { rememberWhatsNew, splitNotes, takeWhatsNew } = await import('./whatsNew')

beforeEach(() => void (store.data = null))

describe('«Что нового»', () => {
  test('release notes read as a short list', () => {
    expect(splitNotes('Исправления: связь не рвётся; карточка показывает список; ставится сразу последняя версия.')).toEqual(['Связь не рвётся', 'Карточка показывает список', 'Ставится сразу последняя версия'])
    expect(splitNotes('Свайп переключает трек. На таймлайне волна. В «Скачанных» виден прогресс.')).toEqual(['Свайп переключает трек', 'На таймлайне волна', 'В «Скачанных» виден прогресс'])
    expect(splitNotes('  ')).toEqual([])
  })

  test('the notes of the version being installed show once, after it starts', async () => {
    await rememberWhatsNew('0.2.11', 'Свайп стал лучше.')
    expect(await takeWhatsNew('0.2.10')).toBeNull()
    expect(await takeWhatsNew('0.2.11')).toEqual({ version: '0.2.11', notes: 'Свайп стал лучше.' })
    expect(await takeWhatsNew('0.2.11')).toBeNull()
  })

  test('no notes, nothing to show', async () => {
    await rememberWhatsNew('0.2.11', undefined)
    expect(await takeWhatsNew('0.2.11')).toBeNull()
  })
})

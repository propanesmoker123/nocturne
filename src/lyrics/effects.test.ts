import { describe, expect, test } from 'vitest'
import {
  WORD_EFFECTS,
  analyzeLyricsOffline,
  classifyWordEmoji,
  classifyWordFx,
  describeLyricsMethod,
  type WordFx,
} from './effects'

describe('lyrics kinetic effects & method summary', () => {
  test('exposes 20 distinct GPU-composited cinema word effects', () => {
    expect(WORD_EFFECTS.length).toBe(20)
    const unique = new Set(WORD_EFFECTS)
    expect(unique.size).toBe(20)
    expect(WORD_EFFECTS).toContain('glitch')
    expect(WORD_EFFECTS).toContain('cash')
    expect(WORD_EFFECTS).toContain('smoke')
    expect(WORD_EFFECTS).toContain('slash')
    expect(WORD_EFFECTS).toContain('orbit')
    expect(WORD_EFFECTS).toContain('bounce')
    expect(WORD_EFFECTS).toContain('fade')
    expect(WORD_EFFECTS).toContain('poison')
  })

  test('classifies Russian & English emotional/street/cinema stems accurately', () => {
    const cases: [string, WordFx][] = [
      ['огни', 'neon'],
      ['огонь', 'fire'],
      ['холод', 'ice'],
      ['лёд', 'ice'],
      ['дождь', 'rain'],
      ['тик', 'ripple'],
      ['так', 'ripple'],
      ['сердце', 'heart'],
      ['сталь', 'metal'],
      ['хром', 'metal'],
      ['беги', 'rush'],
      ['глюк', 'glitch'],
      ['матрица', 'glitch'],
      ['деньги', 'cash'],
      ['кэш', 'cash'],
      ['дым', 'smoke'],
      ['туман', 'smoke'],
      ['кровь', 'slash'],
      ['шрам', 'slash'],
      ['космос', 'orbit'],
      ['орбита', 'orbit'],
      ['качай', 'bounce'],
      ['вайб', 'bounce'],
      ['исчезай', 'fade'],
      ['пустота', 'fade'],
      ['отрава', 'poison'],
      ['токсик', 'poison'],
      ['blinding', 'flash'],
      ['midnight', 'neon'],
      ['diamond', 'metal'],
      ['glitches', 'glitch'],
      ['venom', 'poison'],
    ]
    for (const [word, expected] of cases) {
      expect(classifyWordFx(word)).toBe(expected)
    }
  })

  test('assigns rich per-word and line-level effects without sparse starvation', () => {
    const analysis = analyzeLyricsOffline([
      { begin: 1000, text: 'Неон в ночи, огонь и дым' },
      { begin: 3000, text: 'Яд в крови, качай до утра!' },
      { begin: 5000, text: 'Тихо исчезаю в пустоте' },
      { begin: 7000, text: 'Обычные слова без словаря тоже живы' },
    ])

    const l0 = analysis.lineFx.get(0)
    expect(l0?.wordFx.get(0)).toBe('neon') // Неон
    expect(l0?.wordFx.get(2)).toBe('neon') // ночи
    expect(l0?.wordFx.get(3)).toBe('fire') // огонь
    expect(l0?.wordFx.get(5)).toBe('smoke') // дым

    const l1 = analysis.lineFx.get(1)
    expect(l1?.wordFx.get(0)).toBe('poison') // Яд
    expect(l1?.wordFx.get(2)).toBe('slash') // крови
    expect(l1?.wordFx.get(3)).toBe('bounce') // качай
    expect(l1?.textFx).toBe('big') // '!' punch

    const l2 = analysis.lineFx.get(2)
    expect(l2?.wordFx.get(1)).toBe('fade') // исчезаю
    expect(l2?.wordFx.get(3)).toBe('fade') // пустоте

    // Generic line still stays structurally coherent (no junk crash)
    expect(analysis.lineFx.has(3)).toBe(true)

    // Curated emoji cap prevents visual noise while highlighting key words
    expect(l0?.wordEmoji.size).toBe(1)
    expect(l1?.wordEmoji.size).toBe(1)
    const longAnalysis = analyzeLyricsOffline([
      { begin: 1000, text: 'Деньги огонь холод дождь сердце сталь глюк яд' },
    ])
    expect(longAnalysis.lineFx.get(0)?.wordEmoji.size).toBe(2)
  })

  test('recognizes rich multilingual slang & synonyms (RU/EN/ES/FR/DE) and avoids false substrings', () => {
    const cashSynonyms = [
      'деньги', 'денег', 'бабки', 'бабло', 'кэш', 'кеш', 'мани', 'лаве',
      'зелень', 'капуста', 'баксы', 'доллары', 'евро', 'рубли', 'наличка',
      'cash', 'money', 'bucks', 'bands', 'racks', 'guap', 'dinero', 'argent', 'geld',
    ]
    for (const w of cashSynonyms) {
      expect(classifyWordFx(w)).toBe('cash')
    }

    const crossLang: [string, WordFx][] = [
      ['fuego', 'fire'],
      ['hielo', 'ice'],
      ['lluvia', 'rain'],
      ['corazon', 'heart'],
      ['amour', 'heart'],
      ['liebe', 'heart'],
      ['кохання', 'heart'],
      ['soleil', 'glow'],
      ['lumiere', 'glow'],
      ['blut', 'slash'],
      ['sangre', 'slash'],
      ['nebel', 'smoke'],
      ['noche', 'neon'],
      ['tanzen', 'bounce'],
      ['danser', 'bounce'],
    ]
    for (const [word, expected] of crossLang) {
      expect(classifyWordFx(word)).toBe(expected)
    }

    // Substring false-positive guards
    expect(classifyWordFx('внимание')).toBeUndefined()
    expect(classifyWordFx('обмани')).toBeUndefined()
    expect(classifyWordFx('рядом')).toBeUndefined()
    expect(classifyWordFx('отпусти')).toBeUndefined()
    expect(classifyWordFx('бумаги')).toBeUndefined()

    // Contextual emoji precision
    expect(classifyWordEmoji('деньги', 'cash', 0)).toBe('\uD83D\uDCB5')
    expect(classifyWordEmoji('бентли', 'cash', 0)).toBe('\uD83C\uDFCE\uFE0F')
    expect(classifyWordEmoji('ролекс', 'cash', 0)).toBe('\uD83D\uDC8E')
    expect(classifyWordEmoji('больно', 'heart', 0)).toBe('\uD83D\uDC94')
    expect(classifyWordEmoji('луна', 'glow', 0)).toBe('\uD83C\uDF19')
    expect(classifyWordEmoji('алмаз', 'metal', 0)).toBe('\uD83D\uDC8E')
    expect(classifyWordEmoji('время', 'ripple', 0)).toBe('\u23F3')
  })

  test('rotates 4 distinct choreography variants for repeated words and keeps plain verse lines accented', () => {
    const analysis = analyzeLyricsOffline([
      { begin: 1000, text: 'Огонь горит в груди' },
      { begin: 2000, text: 'Огонь внутри меня' },
      { begin: 3000, text: 'Огонь как чистый свет' },
      { begin: 4000, text: 'Огонь сжигает всё' },
      { begin: 5000, text: 'Мы просто идём вдоль улицы домой' },
    ])

    expect(analysis.lineFx.get(0)?.wordVariant.get(0)).toBe(0)
    expect(analysis.lineFx.get(1)?.wordVariant.get(0)).toBe(1)
    expect(analysis.lineFx.get(2)?.wordVariant.get(0)).toBe(2)
    expect(analysis.lineFx.get(3)?.wordVariant.get(0)).toBe(3)

    // Broad everyday vocabulary ("улицы", "жизнь", "глаза") and poetic anchors avoid barren plain lines
    expect(analysis.lineFx.get(4)?.wordFx.size).toBeGreaterThanOrEqual(1)
    expect(classifyWordFx('глаза')).toBe('flash')
    expect(classifyWordFx('жизнь')).toBe('glow')
    expect(classifyWordFx('снова')).toBe('ripple')
    expect(classifyWordFx('молчишь')).toBe('fade')
  })

  test('formats non-AI platform/source method summary accurately', () => {
    expect(
      describeLyricsMethod(
        {
          synced: true,
          source: 'spotify',
          credits: 'Текст: Spotify',
          lines: [{ begin: 1000, text: 'один два', words: [{ begin: 1000, end: 1300, text: 'один' }] }],
        },
        true,
        false,
      ),
    ).toEqual({
      sourceLabel: 'Spotify',
      syncLabel: 'По словам',
      fxLabel: 'Кинематограф',
    })

    expect(
      describeLyricsMethod(
        {
          synced: true,
          source: 'lrclib',
          credits: 'Текст: LRCLIB',
          lines: [{ begin: 1000, text: 'строка' }],
        },
        true,
        false,
      ),
    ).toEqual({
      sourceLabel: 'LRCLIB',
      syncLabel: 'По строкам',
      fxLabel: 'Кинематограф',
    })

    expect(
      describeLyricsMethod(
        {
          synced: false,
          source: 'genius',
          credits: 'Текст: Genius',
          lines: [{ begin: 0, text: 'куплет' }],
        },
        false,
        false,
      ),
    ).toEqual({
      sourceLabel: 'Genius',
      syncLabel: 'Без таймингов',
      fxLabel: 'Без эффектов',
    })

    expect(
      describeLyricsMethod(
        { synced: false, lines: [{ begin: 0, text: 'текст' }] },
        true,
        true,
      ),
    ).toEqual({
      sourceLabel: 'ВКонтакте',
      syncLabel: 'Без таймингов',
      fxLabel: 'Кинематограф',
    })
  })
})

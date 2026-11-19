import { describe, expect, test } from 'vitest'
import { decodeHtmlEntities, geniusLyricsFromHtml, parseLrc, parseLrclibFile, parseNeteaseYrc, spotifyLines } from './parse'

describe('parseLrc', () => {
  test('expands multi-timestamp lines, sorts them, and sets end from next line begin', () => {
    const lrc = [
      '[ar:Artist Name]',
      '[ti:Track Title]',
      '[01:02.00][00:12.30]Hi there',
      '[00:20.500]Second line',
    ].join('\n')

    expect(parseLrc(lrc)).toEqual([
      { text: 'Hi there', begin: 12300, end: 20500 },
      { text: 'Second line', begin: 20500, end: 62000 },
      { text: 'Hi there', begin: 62000 },
    ])
  })

  test('renders empty timed lines as instrumental beat markers ♪', () => {
    expect(parseLrc('[00:05.00]\n[00:10.00]Word')).toEqual([
      { text: '♪', begin: 5000, end: 10000 },
      { text: 'Word', begin: 10000 },
    ])
  })

  test('applies positive and negative [offset] LRC tags to line and word timestamps', () => {
    expect(parseLrc('[offset:+250]\n[00:01.00]<00:01.00>Hi <00:01.40>there\n[00:02.00]Next')).toEqual([
      {
        text: 'Hi there',
        begin: 750,
        end: 1750,
        words: [
          { text: 'Hi', begin: 750, end: 1150 },
          { text: 'there', begin: 1150, end: 1750 },
        ],
      },
      { text: 'Next', begin: 1750 },
    ])
  })

  test('parses enhanced LRC word timestamps <mm:ss.xx>', () => {
    expect(parseLrc('[00:01.00]<00:01.00>a <00:01.50>b\n[00:03.00]c')).toEqual([
      {
        text: 'a b',
        begin: 1000,
        end: 3000,
        words: [
          { text: 'a', begin: 1000, end: 1500 },
          { text: 'b', begin: 1500, end: 3000 },
        ],
      },
      { text: 'c', begin: 3000 },
    ])
  })

  test('preserves leading text before the first <mm:ss.xx> tag in enhanced LRC', () => {
    expect(parseLrc('[00:01.00]Hello <00:01.50>world\n[00:02.50]Next')).toEqual([
      {
        text: 'Hello world',
        begin: 1000,
        end: 2500,
        words: [
          { text: 'Hello', begin: 1000, end: 1500 },
          { text: 'world', begin: 1500, end: 2500 },
        ],
      },
      { text: 'Next', begin: 2500 },
    ])
  })
})

describe('geniusLyricsFromHtml', () => {
  test('extracts clean text across multiple data-lyrics-container blocks', () => {
    const html = `
      <html><body>
        <div data-lyrics-container="true">
          <div>[Припев]</div><br/>
          <a href="/x">Эти <i>блики</i></a><br>ослепляют &amp; жгут
          <div data-exclude-from-selection="true">12 ContributorsTranslations</div>
        </div>
        <div data-lyrics-container="true">
          Вторая &quot;строка&quot;&#x27;
        </div>
      </body></html>
    `
    expect(geniusLyricsFromHtml(html)).toBe(
      '[Припев]\nЭти блики\nослепляют & жгут\nВторая "строка"\'',
    )
  })

  test('returns null when no lyrics containers are present', () => {
    expect(geniusLyricsFromHtml('<html><body><p>Not found</p></body></html>')).toBeNull()
  })
})

describe('spotifyLines', () => {
  test('treats SYLLABLE_SYNCED as synced and reconstructs word timings from syllables', () => {
    const res = spotifyLines({
      syncType: 'SYLLABLE_SYNCED',
      lines: [
        {
          startTimeMs: '1000',
          words: 'Hello world',
          syllables: [
            { startTimeMs: '1000', numChars: 3 },
            { startTimeMs: '1250', numChars: 3 },
            { startTimeMs: '1500', numChars: 5 },
          ],
        },
        {
          startTimeMs: '2400',
          words: '',
        },
      ],
    })
    expect(res.synced).toBe(true)
    expect(res.lines).toEqual([
      {
        text: 'Hello world',
        begin: 1000,
        end: 2400,
        words: [
          { text: 'Hello', begin: 1000, end: 1500 },
          { text: 'world', begin: 1500, end: 2400 },
        ],
      },
      { text: '♪', begin: 2400 },
    ])
  })

  test('handles LINE_SYNCED and UNSYNCED correctly', () => {
    expect(
      spotifyLines({
        syncType: 'LINE_SYNCED',
        lines: [{ startTimeMs: 500, words: 'Line 1' }, { startTimeMs: 1800, words: 'Line 2' }],
      }),
    ).toEqual({
      synced: true,
      lines: [
        { text: 'Line 1', begin: 500, end: 1800 },
        { text: 'Line 2', begin: 1800 },
      ],
    })

    expect(
      spotifyLines({
        syncType: 'UNSYNCED',
        lines: [{ words: 'Line 1' }, { words: '' }, { words: 'Line 2' }],
      }),
    ).toEqual({
      synced: false,
      lines: [{ text: 'Line 1' }, { text: 'Line 2' }],
    })
  })
})

describe('parseNeteaseYrc and decodeHtmlEntities', () => {
  test('parses word-synced NetEase YRC lines and filters credit/metadata header rows', () => {
    const raw = [
      '{"t":0,"c":[{"tx":"作词: Test"}]}',
      '[0,1000](0,1000,0)作词 : Max Martin',
      '[23550,120](23550,120,0)Yeah',
      '[27360,900](27360,300,0)I\'ve (27660,210,0)been (27870,390,0)tryna',
    ].join('\n')
    expect(parseNeteaseYrc(raw)).toEqual([
      {
        text: 'Yeah',
        begin: 23550,
        end: 23670,
        words: [{ text: 'Yeah', begin: 23550, end: 23670 }],
      },
      {
        text: "I've been tryna",
        begin: 27360,
        end: 28260,
        words: [
          { text: "I've", begin: 27360, end: 27660 },
          { text: 'been', begin: 27660, end: 27870 },
          { text: 'tryna', begin: 27870, end: 28260 },
        ],
      },
    ])
  })

  test('attaches standalone punctuation tokens in YRC directly onto preceding word', () => {
    const raw = '[1000,900](1000,300,0)love(1300,100,0), (1400,500,0)maybe(1900,100,0)!'
    expect(parseNeteaseYrc(raw)).toEqual([
      {
        text: 'love, maybe!',
        begin: 1000,
        end: 1900,
        words: [
          { text: 'love,', begin: 1000, end: 1400 },
          { text: 'maybe!', begin: 1400, end: 2000 },
        ],
      },
    ])
  })

  test('decodeHtmlEntities decodes named and numeric HTML entities cleanly', () => {
    expect(decodeHtmlEntities('Don&apos;t &quot;cry&quot; &amp; run&#39;s&#10;now')).toBe('Don\'t "cry" & run\'s\nnow')
  })

  test('decodeHtmlEntities leaves out-of-range and surrogate numeric entities intact instead of throwing', () => {
    expect(decodeHtmlEntities('&#99999999; &#x110000; &#xD800; &#xDFFF; &#65;')).toBe(
      '&#99999999; &#x110000; &#xD800; &#xDFFF; A',
    )
  })
})

describe('parseLrclibFile', () => {
  test('parses LRCLIB YAML lyricsfile with per-word timings, quotes, and hyphenated syllables', () => {
    const yaml = [
      'lines:',
      '- text: Подо мной M5, Asphalt 8',
      '  start_ms: 14920',
      '  end_ms: 16607',
      '  words:',
      "  - text: 'Подо '",
      '    start_ms: 14920',
      "  - text: 'мной '",
      '    start_ms: 15174',
      "  - text: 'M5'",
      '    start_ms: 15450',
      "  - text: ', '",
      '    start_ms: 15650',
      "  - text: 'Asphalt '",
      '    start_ms: 15700',
      "  - text: '8'",
      '    start_ms: 16120',
      "- text: 'It''s От-отпускай'",
      '  start_ms: 17000',
      '  words:',
      "  - text: 'It''s '",
      '    start_ms: 17000',
      "  - text: 'От-'",
      '    start_ms: 17300',
      "  - text: 'отпускай'",
      '    start_ms: 17520',
    ].join('\n')

    expect(parseLrclibFile(yaml)).toEqual([
      {
        text: 'Подо мной M5, Asphalt 8',
        begin: 14920,
        end: 16607,
        words: [
          { text: 'Подо', begin: 14920, end: 15174 },
          { text: 'мной', begin: 15174, end: 15450 },
          { text: 'M5,', begin: 15450, end: 15700 },
          { text: 'Asphalt', begin: 15700, end: 16120 },
          { text: '8', begin: 16120, end: 16607 },
        ],
      },
      {
        text: "It's От-отпускай",
        begin: 17000,
        words: [
          { text: "It's", begin: 17000, end: 17300 },
          { text: 'От-отпускай', begin: 17300 },
        ],
      },
    ])
  })

  test('drops broken forced-aligned word timings whose words collapse into ~20ms bursts', () => {
    const yaml = [
      'lines:',
      '- text: Пока не устал музыка играла',
      '  start_ms: 31610',
      '  end_ms: 34200',
      '  words:',
      "  - text: 'Пока '",
      '    start_ms: 31610',
      "  - text: 'не '",
      '    start_ms: 31625',
      "  - text: 'устал '",
      '    start_ms: 31640',
      "  - text: 'музыка '",
      '    start_ms: 31655',
      "  - text: играла",
      '    start_ms: 31670',
    ].join('\n')

    const lines = parseLrclibFile(yaml)
    expect(lines).toEqual([{ text: 'Пока не устал музыка играла', begin: 31610, end: 34200 }])
  })
})

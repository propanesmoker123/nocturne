import { describe, expect, test } from 'vitest'
import { parseCatalog, parseSection } from './catalog'
import type { RawAudio, RawCatalogResponse, RawPlaylist } from './types'

const audio = (owner: number, id: number): RawAudio => ({
  id,
  owner_id: owner,
  artist: `Artist ${id}`,
  title: `Track ${id}`,
  duration: 180,
  url: 'https://cs1-1v4.vkuseraudio.ru/s/v1/ac/x/index.m3u8',
})

const playlist = (owner: number, id: number): RawPlaylist => ({ id, owner_id: owner, title: `Playlist ${id}`, count: 10 })

const response: RawCatalogResponse = {
  catalog: {
    default_section: 'S1',
    sections: [
      {
        id: 'S1',
        title: 'Главная',
        url: 'https://vk.ru/audios1?section=general',
        next_from: 'NF',
        blocks: [
          { id: 'b0', data_type: 'audio_stream_mixes', layout: { name: 'audio_stream_mix_interactive' }, audio_stream_mixes_ids: ['common'] },
          { id: 'b1', data_type: 'none', layout: { name: 'separator' } },
          { id: 'b2', data_type: 'none', layout: { name: 'header', title: 'Мои треки' } },
          { id: 'b3', data_type: 'music_audios', layout: { name: 'triple_stacked_slider' }, audios_ids: ['1_11', '1_12', '1_999'], next_from: 'more' },
          { id: 'b4', data_type: 'none', layout: { name: 'header_extended', title: 'Собрано алгоритмами' } },
          { id: 'b5', data_type: 'music_playlists', layout: { name: 'recomms_slider' }, playlists_ids: ['1_-21', '-5_3'] },
          { id: 'b6', data_type: 'none', layout: { name: 'header', title: 'Жанры' } },
          { id: 'b7', data_type: 'action', layout: { name: 'crop_slider' } },
          { id: 'b8', data_type: 'none', layout: { name: 'header', title: 'Пусто' } },
          { id: 'b9', data_type: 'music_audios', layout: { name: 'list' }, audios_ids: ['7_7'] },
        ],
      },
      { id: 'S2', title: 'Обзор', url: 'https://vk.ru/audios1?section=explore' },
    ],
  },
  audios: [audio(1, 11), audio(1, 12)],
  playlists: [playlist(-5, 3), playlist(1, -21)],
  audio_stream_mixes: [{ id: 'common', description: 'desc', stream_mix: { id: 'common', title: 'Слушать VK Микс' } }],
}

describe('parseCatalog', () => {
  test('returns the default section first with all section ids', () => {
    const sections = parseCatalog(response, 1)
    expect(sections.map((s) => s.id)).toEqual(['S1', 'S2'])
    expect(sections[0].title).toBe('Главная')
    expect(sections[0].nextFrom).toBe('NF')
    expect(sections[1].blocks).toEqual([])
  })

  test('resolves track ids in order, drops missing ones and takes the title from the preceding header', () => {
    const [home] = parseCatalog(response, 1)
    const tracks = home.blocks.find((b) => b.kind === 'tracks')!
    expect(tracks.title).toBe('Мои треки')
    expect(tracks.kind === 'tracks' && tracks.tracks.map((t) => t.key)).toEqual(['1_11', '1_12'])
    expect(tracks.nextFrom).toBe('more')
    expect(tracks.layout).toBe('triple_stacked_slider')
  })

  test('resolves playlists in the order of playlists_ids', () => {
    const [home] = parseCatalog(response, 1)
    const pls = home.blocks.find((b) => b.kind === 'playlists')!
    expect(pls.title).toBe('Собрано алгоритмами')
    expect(pls.kind === 'playlists' && pls.playlists.map((p) => `${p.ownerId}_${p.id}`)).toEqual(['1_-21', '-5_3'])
  })

  test('keeps the VK mix block and drops unknown or empty blocks', () => {
    const [home] = parseCatalog(response, 1)
    expect(home.blocks.map((b) => b.kind)).toEqual(['mix', 'tracks', 'playlists'])
    const mix = home.blocks[0]
    expect(mix.kind === 'mix' && mix.mixId).toBe('common')
    expect(mix.title).toBe('Слушать VK Микс')
  })
})

describe('parseSection', () => {
  test('parses a catalog.getSection response', () => {
    const section = parseSection(
      {
        section: {
          id: 'EX',
          title: 'Обзор',
          next_from: 'n2',
          blocks: [
            { id: 'h', data_type: 'none', layout: { name: 'header_extended', title: 'Новинки' } },
            { id: 'a', data_type: 'music_audios', layout: { name: 'triple_stacked_slider' }, audios_ids: ['1_11'] },
          ],
        },
        audios: [audio(1, 11)],
      },
      1,
    )
    expect(section.id).toBe('EX')
    expect(section.nextFrom).toBe('n2')
    expect(section.blocks).toHaveLength(1)
    expect(section.blocks[0].title).toBe('Новинки')
  })

  test('accepts ids that carry an access key suffix', () => {
    const section = parseSection(
      { section: { id: 'X', title: 'X', blocks: [{ id: 'a', data_type: 'music_audios', audios_ids: ['1_11_abc'], title: 'Block title' }] }, audios: [audio(1, 11)] },
      1,
    )
    expect(section.blocks[0].title).toBe('Block title')
    expect(section.blocks[0].kind === 'tracks' && section.blocks[0].tracks).toHaveLength(1)
  })
})

describe('recommended playlists ("Слушайте друг друга")', () => {
  const raw: RawCatalogResponse = {
    section: {
      id: 'S',
      title: 'Главная',
      blocks: [
        { id: 'h', data_type: 'none', layout: { name: 'header_extended', title: 'Слушайте друг друга' } },
        {
          id: 'r',
          data_type: 'music_recommended_playlists',
          layout: { name: 'large_slider' },
          playlists_ids: ['5_48', '6_9', '7_1'],
          audios_ids: ['5_1', '5_2', '6_3'],
        },
      ],
    },
    audios: [audio(5, 1), audio(5, 2), audio(6, 3)],
    playlists: [playlist(5, 48), playlist(6, 9), playlist(7, 1)],
    profiles: [
      { id: 5, first_name: 'Ан', last_name: 'I', photo_100: 'https://p/5.jpg' },
      { id: 6, first_name: 'Костя', last_name: 'Пятница' },
    ],
    recommended_playlists: [
      { id: 48, owner_id: 5, audios: ['5_1', '5_2', '5_404'], color: '#3681FF', cover: 'https://bg/48.png', percentage: 0.98, percentage_title: 'совпадение с вашим вкусом' },
      { id: 9, owner_id: 6, audios: ['6_3'], color: 'url(x)', percentage: '0.93' },
    ],
  }

  test('pairs each playlist with its match, colours, owner and preview tracks', () => {
    const block = parseSection(raw, 1).blocks[0]
    expect(block.kind).toBe('recommended')
    expect(block.title).toBe('Слушайте друг друга')
    if (block.kind !== 'recommended') return
    const [a, b] = block.items
    expect(a.playlist).toMatchObject({ ownerId: 5, id: 48, title: 'Playlist 48', ownerName: 'Ан I' })
    expect(a).toMatchObject({ match: 0.98, matchTitle: 'совпадение с вашим вкусом', color: '#3681FF', background: 'https://bg/48.png', ownerPhoto: 'https://p/5.jpg' })
    expect(a.tracks.map((t) => t.key)).toEqual(['5_1', '5_2'])
    expect(b.match).toBe(0.93)
    expect(b.matchTitle).toBe('совпадение с вашим вкусом')
    expect(b.color).toBeUndefined()
  })

  test('skips playlists VK sent no match for', () => {
    const block = parseSection(raw, 1).blocks[0]
    expect(block.kind === 'recommended' && block.items.map((i) => i.playlist.id)).toEqual([48, 9])
  })
})

import { useQuery } from '@tanstack/react-query'
import { Bell, Bug, Clock3, Compass, Disc3, Heart, Home, LibraryBig, ListMusic, Plus, Rss, Search, Settings, Users } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton } from '../components/controls'
import { ServiceLogo } from '../components/ServiceLogo'
import * as sc from '../sc/api'
import { useScSession } from '../sc/session'
import * as spotify from '../spotify/api'
import { spKeys } from '../spotify/queries'
import { useSpotifySession } from '../spotify/session'
import * as vk from '../vk/api'
import s from './Sidebar.module.css'
import appIcon from '../assets/app-icon.png'
import { albumArt } from '../albums/model'
import { useAlbums } from '../albums/store'
import { routeSection, useRouter, type Route } from './router'
import { accountFor, serviceInfo, useService } from './service'
import { useSession } from './session'
import { useSheet } from './sheetStore'
import { myPlaylistsKey, playlistMenuItems } from './trackActions'
import { showMenu } from './menu'
import { useUpdates } from '../lib/updates'
import { unreadNotificationCount, useNotifications } from '../lib/notifications'
import { Spinner } from '../components/controls'

const ic = { size: 18, strokeWidth: 2 } as const

function NavItem({ route, icon, label }: { route: Route; icon: ReactNode; label: string }) {
  const current = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const active = current.name === route.name
  return (
    <button type="button" className={s.item} aria-current={active ? 'page' : undefined} onClick={() => push(route)}>
      <span className={s.itemIcon}>{icon}</span>
      <span className={`${s.itemLabel} truncate`}>{label}</span>
    </button>
  )
}

/** The search of the selected service: VK's `search`, SoundCloud's `sc-search`, or Spotify's `spotify-search`. */
function SearchField() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const replace = useRouter((r) => r.replace)
  const service = useService((x) => x.current)
  const page = service === 'spotify' ? 'spotify-search' : service === 'sc' ? 'sc-search' : 'search'
  const here = route.name === page
  const rawRouteQ = route.name === 'search' || route.name === 'sc-search' || route.name === 'spotify-search' ? (route.q ?? '') : ''
  const [value, setValue] = useState(rawRouteQ.startsWith('genre:') ? '' : rawRouteQ)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!here || rawRouteQ.startsWith('genre:')) setValue('')
  }, [here, rawRouteQ])

  const update = (q: string) => {
    setValue(q)
    if (here) replace({ name: page, q })
    else push({ name: page, q })
  }

  return (
    <div className={s.search}>
      <Search size={15} strokeWidth={2.2} />
      <input
        ref={ref}
        id="global-search"
        className={s.searchInput}
        placeholder={service === 'spotify' ? 'Поиск в Spotify' : service === 'sc' ? 'Поиск в SoundCloud' : 'Поиск в VK'}
        value={value}
        spellCheck={false}
        onFocus={() => !here && push({ name: page, q: value })}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue('')
            ref.current?.blur()
          }
        }}
      />
    </div>
  )
}

function PlaylistLinks() {
  const vkPhase = useSession((x) => x.phase)
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const q = useQuery({ queryKey: myPlaylistsKey(), queryFn: () => vk.getPlaylists(vk.getMeId(), 0, 200), enabled: vkPhase === 'ready' })
  if (vkPhase !== 'ready') return null
  if (q.isLoading) return <div className={s.hint}>Загружаем…</div>
  if (q.isError) return <div className={s.hint}>Плейлисты не загрузились</div>
  const items = q.data?.items ?? []
  if (!items.length) return <div className={s.hint}>Плейлистов пока нет</div>
  return (
    <>
      {items.map((p) => {
        const active = route.name === 'playlist' && route.id === p.id && route.ownerId === p.ownerId
        return (
          <button
            key={`${p.ownerId}_${p.id}`}
            type="button"
            className={`${s.item} ${s.playlistItem}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => push({ name: 'playlist', ownerId: p.ownerId, id: p.id, accessKey: p.accessKey })}
            onContextMenu={(e) => {
              e.preventDefault()
              showMenu(e, playlistMenuItems(p, undefined))
            }}
          >
            <Artwork src={p.cover} mosaic={p.covers} size={24} radius={5} seed={p.title} />
            <span className={`${s.itemLabel} truncate`}>{p.title}</span>
          </button>
        )
      })}
    </>
  )
}

/** The person's SoundCloud playlists (own and liked), once signed in. */
function ScPlaylistLinks() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const phase = useScSession((x) => x.phase)
  const me = useScSession((x) => x.user?.id ?? 0)
  const q = useQuery({ queryKey: ['sc-my-playlists', me], queryFn: sc.getMyPlaylists, enabled: phase === 'signed-in' && me > 0 })
  if (phase !== 'signed-in') return null
  if (!me) return <div className={s.hint}>Загружаем…</div>
  if (q.isLoading) return <div className={s.hint}>Загружаем…</div>
  if (q.isError) return <div className={s.hint}>Плейлисты не загрузились</div>
  const items = q.data ?? []
  if (!items.length) return <div className={s.hint}>Плейлистов пока нет</div>
  return (
    <>
      {items.map((p) => {
        const active = route.name === 'sc-playlist' && route.id === p.id && route.urn === p.urn
        return (
          <button
            key={`${p.id}_${p.urn ?? ''}`}
            type="button"
            className={`${s.item} ${s.playlistItem}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => push({ name: 'sc-playlist', id: p.id, urn: p.urn, title: p.title })}
          >
            <Artwork src={p.cover} size={24} radius={5} seed={p.title} />
            <span className={`${s.itemLabel} truncate`}>{p.title}</span>
          </button>
        )
      })}
    </>
  )
}

function VkNav() {
  const vkReady = useSession((x) => x.phase === 'ready')
  return (
    <>
      <div className={s.group}>
        <NavItem route={{ name: 'home' }} icon={<Home {...ic} />} label="Для вас" />
        <NavItem route={{ name: 'explore' }} icon={<Compass {...ic} />} label="Обзор" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Медиатека</div>
        <NavItem route={{ name: 'library' }} icon={<LibraryBig {...ic} />} label="Моя музыка" />
        <NavItem route={{ name: 'playlists' }} icon={<ListMusic {...ic} />} label="Плейлисты" />
        <NavItem route={{ name: 'friends' }} icon={<Users {...ic} />} label="Друзья" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>
          Мои плейлисты
          <IconButton size={22} label="Новый плейлист" disabled={!vkReady} onClick={() => useSheet.getState().open({ kind: 'playlist-create' })}>
            <Plus size={15} strokeWidth={2.4} />
          </IconButton>
        </div>
        <PlaylistLinks />
      </div>
    </>
  )
}

function ScNav() {
  return (
    <>
      <div className={s.group}>
        <NavItem route={{ name: 'sc-home' }} icon={<Home {...ic} />} label="Для вас" />
        <NavItem route={{ name: 'sc-stream' }} icon={<Rss {...ic} />} label="Лента" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Медиатека</div>
        <NavItem route={{ name: 'sc-likes' }} icon={<Heart {...ic} />} label="Лайки" />
        <NavItem route={{ name: 'sc-playlists' }} icon={<ListMusic {...ic} />} label="Плейлисты" />
        <NavItem route={{ name: 'sc-following' }} icon={<Users {...ic} />} label="Подписки" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Мои плейлисты</div>
        <ScPlaylistLinks />
      </div>
    </>
  )
}

/** «Моё»: Nocturne's own albums and what was heard, whichever service it came from. */
function MineNav() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const list = useAlbums((x) => x.list)
  const docs = useAlbums((x) => x.docs)
  const albums = list.filter((e) => !e.removedAt && docs[e.id] && !docs[e.id].meta.deletedAt)
  return (
    <>
      <div className={s.group}>
        <NavItem route={{ name: 'albums' }} icon={<Disc3 {...ic} />} label="Альбомы" />
        <NavItem route={{ name: 'recent' }} icon={<Clock3 {...ic} />} label="Недавние" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Мои альбомы</div>
        {albums.length === 0 && <div className={s.hint}>Альбомов пока нет</div>}
        {albums.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`${s.item} ${s.playlistItem}`}
            aria-current={route.name === 'album' && route.id === e.id ? 'page' : undefined}
            onClick={() => push({ name: 'album', id: e.id })}
          >
            <Artwork {...albumArt(docs[e.id])} size={24} radius={5} seed={docs[e.id].meta.name || e.name} />
            <span className={`${s.itemLabel} truncate`}>{docs[e.id].meta.name || e.name}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function UpdateCard() {
  const { phase, version, notes, progress, install } = useUpdates()
  if (phase !== 'available' && phase !== 'downloading') return null
  return (
    <div className={s.update}>
      <div className={s.updateText}>
        <div className={s.updateTitle}>Nocturne {version}</div>
        {phase === 'downloading' ? (
          <div className={s.updateSub}>Загружаем… {Math.round(progress * 100)}%</div>
        ) : notes?.trim() ? (
          <button
            type="button"
            className={`${s.updateSub} ${s.updateNotes}`}
            onClick={() => useSheet.getState().open({ kind: 'notes', title: `Что нового в ${version}`, notes, action: { label: 'Обновить', run: () => void install() } })}
          >
            Что нового
          </button>
        ) : (
          <div className={s.updateSub}>Доступно обновление</div>
        )}
      </div>
      <button type="button" className={s.updateBtn} disabled={phase === 'downloading'} onClick={() => void install()}>
        {phase === 'downloading' ? <Spinner size={14} /> : 'Обновить'}
      </button>
    </div>
  )
}

export function Sidebar() {
  const vkUser = useSession((x) => x.user)
  const vkPhase = useSession((x) => x.phase)
  const scUser = useScSession((x) => x.user)
  const scPhase = useScSession((x) => x.phase)
  const spUser = useSpotifySession((x) => x.user)
  const spPhase = useSpotifySession((x) => x.phase)
  const push = useRouter((r) => r.push)
  const service = useService((x) => x.current)
  const mine = useRouter((r) => routeSection(r.route) === 'mine')
  const feedbackOpen = useSheet((x) => x.sheet?.kind === 'feedback')
  const notificationsOpen = useSheet((x) => x.sheet?.kind === 'notifications')
  const unreadCount = useNotifications((n) => unreadNotificationCount(n.items, n.seenIds))
  // the account of the service picked on the rail
  const user = accountFor(service, vkUser, scUser, spUser)
  const signedOut =
    (service === 'vk' && vkPhase === 'none') ||
    (service === 'sc' && scPhase === 'signed-out') ||
    (service === 'spotify' && spPhase === 'signed-out')
  return (
    <nav className={s.sidebar} aria-label="Разделы">
      <div className={s.brand} data-tauri-drag-region>
        {mine ? <img src={appIcon} alt="" /> : <ServiceLogo id={service} size={22} tone="dark" />}
        {mine ? 'Моё' : serviceInfo(service).name}
      </div>
      <SearchField />
      <div className={s.scroll}>{mine ? <MineNav /> : service === 'spotify' ? <SpotifyNav /> : service === 'sc' ? <ScNav /> : <VkNav />}</div>
      <UpdateCard />
      <div className={s.footer}>
        <button type="button" className={s.user} onClick={() => push({ name: 'settings' })}>
          {user?.photo ? <img className={s.avatar} src={user.photo} alt="" referrerPolicy="no-referrer" /> : <span className={s.avatar} />}
          <span style={{ minWidth: 0 }}>
            <div className={`${s.userName} truncate`}>{user?.name ?? (signedOut ? 'Не выполнен вход' : 'Загрузка…')}</div>
            <div className={s.userSub}>Настройки</div>
          </span>
        </button>
        <div className={s.footerActions}>
          <IconButton
            size={28}
            active={notificationsOpen}
            className={s.bellBtn}
            data-unread={unreadCount > 0 ? 'true' : undefined}
            label={unreadCount > 0 ? `Уведомления: ${unreadCount} непрочитанных` : 'Уведомления и обновления'}
            onClick={() => useNotifications.getState().openSheet()}
          >
            <span className={s.bellWrap}>
              <Bell size={16} strokeWidth={2} />
              {unreadCount > 0 && <span className={s.bellBadge}>{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </span>
          </IconButton>
          <IconButton
            size={28}
            active={feedbackOpen}
            label="Обратная связь: баг или идея"
            onClick={() => useSheet.getState().open({ kind: 'feedback', defaultKind: 'bug' })}
          >
            <Bug size={16} strokeWidth={2} />
          </IconButton>
          <IconButton size={28} label="Настройки" onClick={() => push({ name: 'settings' })}>
            <Settings size={16} strokeWidth={2} />
          </IconButton>
        </div>
      </div>
    </nav>
  )
}

function SpotifyPlaylistLinks() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const phase = useSpotifySession((x) => x.phase)
  const q = useQuery({ queryKey: spKeys.myPlaylists(), queryFn: spotify.getMyPlaylists, enabled: phase === 'signed-in' })
  if (phase !== 'signed-in') return null
  if (q.isLoading) return <div className={s.hint}>Загружаем…</div>
  if (q.isError) return <div className={s.hint}>Плейлисты не загрузились</div>
  const items = q.data ?? []
  if (!items.length) return <div className={s.hint}>Плейлистов пока нет</div>
  return (
    <>
      {items.map((p) => {
        const active = route.name === 'spotify-playlist' && route.id === p.spotifyId
        return (
          <button
            key={p.spotifyId ?? p.id}
            type="button"
            className={`${s.item} ${s.playlistItem}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => push({ name: 'spotify-playlist', id: p.spotifyId!, kind: p.type, title: p.title })}
            onContextMenu={(e) => {
              e.preventDefault()
              showMenu(e, playlistMenuItems(p, undefined))
            }}
          >
            <Artwork src={p.cover} size={24} radius={5} seed={p.title} />
            <span className={`${s.itemLabel} truncate`}>{p.title}</span>
          </button>
        )
      })}
    </>
  )
}

function SpotifyNav() {
  const route = useRouter((state) => state.route)
  const push = useRouter((state) => state.push)
  const current = (page: 'home' | 'browse' | 'library' | 'liked' | 'albums' | 'artists' | 'recent') =>
    route.name === 'spotify' && !route.q && !route.link && (route.page ?? 'home') === page ? 'page' : undefined
  return (
    <>
      <div className={s.group}>
        <button type="button" className={s.item} aria-current={current('home')} onClick={() => push({ name: 'spotify', page: 'home' })}>
          <span className={s.itemIcon}><Home {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Для вас</span>
        </button>
        <button type="button" className={s.item} aria-current={current('browse')} onClick={() => push({ name: 'spotify', page: 'browse' })}>
          <span className={s.itemIcon}><Compass {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Обзор</span>
        </button>
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Медиатека</div>
        <button type="button" className={s.item} aria-current={current('liked')} onClick={() => push({ name: 'spotify', page: 'liked' })}>
          <span className={s.itemIcon}><Heart {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Любимые треки</span>
        </button>
        <button type="button" className={s.item} aria-current={current('albums')} onClick={() => push({ name: 'spotify', page: 'albums' })}>
          <span className={s.itemIcon}><Disc3 {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Альбомы</span>
        </button>
        <button type="button" className={s.item} aria-current={current('artists')} onClick={() => push({ name: 'spotify', page: 'artists' })}>
          <span className={s.itemIcon}><Users {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Исполнители</span>
        </button>
        <button type="button" className={s.item} aria-current={current('recent')} onClick={() => push({ name: 'spotify', page: 'recent' })}>
          <span className={s.itemIcon}><Clock3 {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Недавнее</span>
        </button>
        <button type="button" className={s.item} aria-current={current('library')} onClick={() => push({ name: 'spotify', page: 'library' })}>
          <span className={s.itemIcon}><ListMusic {...ic} /></span>
          <span className={`${s.itemLabel} truncate`}>Плейлисты</span>
        </button>
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Мои плейлисты</div>
        <SpotifyPlaylistLinks />
      </div>
    </>
  )
}

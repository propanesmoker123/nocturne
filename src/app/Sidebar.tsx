import { useQuery } from '@tanstack/react-query'
import { Clock3, Compass, Heart, Home, LibraryBig, ListMusic, Plus, Rss, Search, Settings, Users } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton } from '../components/controls'
import { ServiceLogo } from '../components/ServiceLogo'
import * as sc from '../sc/api'
import { useScSession } from '../sc/session'
import * as vk from '../vk/api'
import s from './Sidebar.module.css'
import { useRouter, type Route } from './router'
import { accountFor, serviceInfo, useService } from './service'
import { useSession } from './session'
import { useSheet } from './sheetStore'
import { myPlaylistsKey, playlistMenuItems } from './trackActions'
import { showMenu } from './menu'
import { useUpdates } from '../lib/updates'
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

/** The search of the selected service: VK's `search` page or SoundCloud's `sc-search`. */
function SearchField() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const replace = useRouter((r) => r.replace)
  const service = useService((x) => x.current)
  const page = service === 'sc' ? 'sc-search' : 'search'
  const here = route.name === page
  const [value, setValue] = useState(route.name === 'search' || route.name === 'sc-search' ? (route.q ?? '') : '')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!here) setValue('')
  }, [here])

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
        placeholder={service === 'sc' ? 'Поиск в SoundCloud' : 'Поиск в VK'}
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
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const q = useQuery({ queryKey: myPlaylistsKey(), queryFn: () => vk.getPlaylists(vk.getMeId(), 0, 200) })
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
        <NavItem route={{ name: 'recent' }} icon={<Clock3 {...ic} />} label="Недавние" />
        <NavItem route={{ name: 'friends' }} icon={<Users {...ic} />} label="Друзья" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>
          Мои плейлисты
          <IconButton size={22} label="Новый плейлист" onClick={() => useSheet.getState().open({ kind: 'playlist-create' })}>
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
        <NavItem route={{ name: 'recent' }} icon={<Clock3 {...ic} />} label="Недавние" />
      </div>
      <div className={s.group}>
        <div className={s.groupHead}>Мои плейлисты</div>
        <ScPlaylistLinks />
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
  const scUser = useScSession((x) => x.user)
  const push = useRouter((r) => r.push)
  const service = useService((x) => x.current)
  // the account of the service picked on the rail
  const user = accountFor(service, vkUser, scUser)
  return (
    <nav className={s.sidebar} aria-label="Разделы">
      <div className={s.brand} data-tauri-drag-region>
        <ServiceLogo id={service} size={22} />
        {serviceInfo(service).name}
      </div>
      <SearchField />
      <div className={s.scroll}>{service === 'sc' ? <ScNav /> : <VkNav />}</div>
      <UpdateCard />
      <div className={s.footer}>
        <button type="button" className={s.user} onClick={() => push({ name: 'settings' })}>
          {user?.photo ? <img className={s.avatar} src={user.photo} alt="" referrerPolicy="no-referrer" /> : <span className={s.avatar} />}
          <span style={{ minWidth: 0 }}>
            <div className={`${s.userName} truncate`}>{user?.name ?? 'Загрузка…'}</div>
            <div className={s.userSub}>Настройки</div>
          </span>
        </button>
        <IconButton size={30} label="Настройки" onClick={() => push({ name: 'settings' })}>
          <Settings size={17} strokeWidth={2} />
        </IconButton>
      </div>
    </nav>
  )
}

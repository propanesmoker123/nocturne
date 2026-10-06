import { useQuery } from '@tanstack/react-query'
import { Clock3, Compass, Home, LibraryBig, ListMusic, Plus, Search, Settings, Users } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import appIcon from '../assets/app-icon.png'
import { Artwork } from '../components/Artwork'
import { IconButton } from '../components/controls'
import * as vk from '../vk/api'
import s from './Sidebar.module.css'
import { useRouter, type Route } from './router'
import { useSession } from './session'
import { useSheet } from './sheetStore'
import { myPlaylistsKey, playlistMenuItems } from './trackActions'
import { showMenu } from './menu'

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

function SearchField() {
  const route = useRouter((r) => r.route)
  const push = useRouter((r) => r.push)
  const replace = useRouter((r) => r.replace)
  const [value, setValue] = useState(route.name === 'search' ? (route.q ?? '') : '')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (route.name !== 'search') setValue('')
  }, [route.name])

  const update = (q: string) => {
    setValue(q)
    if (route.name === 'search') replace({ name: 'search', q })
    else push({ name: 'search', q })
  }

  return (
    <div className={s.search}>
      <Search size={15} strokeWidth={2.2} />
      <input
        ref={ref}
        id="global-search"
        className={s.searchInput}
        placeholder="Поиск"
        value={value}
        spellCheck={false}
        onFocus={() => route.name !== 'search' && push({ name: 'search', q: value })}
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

export function Sidebar() {
  const user = useSession((x) => x.user)
  const push = useRouter((r) => r.push)
  return (
    <nav className={s.sidebar} aria-label="Разделы">
      <div className={s.brand} data-tauri-drag-region>
        <img src={appIcon} alt="" />
        Nocturne
      </div>
      <SearchField />
      <div className={s.scroll}>
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
      </div>
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

import { motion, MotionConfig, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ComponentType, type UIEvent } from 'react'
import { Spinner } from '../components/controls'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Wallpaper } from '../components/Wallpaper'
import { useSettings } from '../lib/settings'
import { Home } from '../pages/Home'
import { CopyJournalLink, Login } from '../pages/Login'
import s from './App.module.css'
import { useChrome } from './chrome'
import { ContextMenu } from './ContextMenu'
import { MiniPlayer } from './MiniPlayer'
import { routeService, useRouter, type Route } from './router'
import { ScrollerContext } from './scroller'
import { ServiceRail } from './ServiceRail'
import { useSession } from './session'
import { Sheets } from './Sheets'
import { Sidebar } from './Sidebar'
import { Titlebar } from './Titlebar'
import { Toasts } from './Toasts'
import { useUi } from './ui'
import { useSpotify } from '../spotify/runtime'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyNamed<T extends Record<string, ComponentType<any>>, K extends keyof T>(load: () => Promise<T>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }))
}

const NowPlaying = lazyNamed(() => import('./NowPlaying'), 'NowPlaying')
const SpotifyMiniPlayer = lazyNamed(() => import('../spotify/SpotifyMiniPlayer'), 'SpotifyMiniPlayer')

const AlbumPage = lazyNamed(() => import('../pages/albums/AlbumPage'), 'AlbumPage')
const AlbumsPage = lazyNamed(() => import('../pages/albums/AlbumsPage'), 'AlbumsPage')
const Artist = lazyNamed(() => import('../pages/Artist'), 'Artist')
const Explore = lazyNamed(() => import('../pages/Explore'), 'Explore')
const FriendPage = lazyNamed(() => import('../pages/Friends'), 'FriendPage')
const Friends = lazyNamed(() => import('../pages/Friends'), 'Friends')
const Library = lazyNamed(() => import('../pages/Library'), 'Library')
const PlaylistPage = lazyNamed(() => import('../pages/PlaylistPage'), 'PlaylistPage')
const Playlists = lazyNamed(() => import('../pages/Playlists'), 'Playlists')
const Recent = lazyNamed(() => import('../pages/Recent'), 'Recent')
const SectionPage = lazyNamed(() => import('../pages/SectionPage'), 'SectionPage')
const ScHome = lazyNamed(() => import('../pages/sc/ScHome'), 'ScHome')
const ScLikes = lazyNamed(() => import('../pages/sc/ScLikes'), 'ScLikes')
const ScPlaylistPage = lazyNamed(() => import('../pages/sc/ScPlaylistPage'), 'ScPlaylistPage')
const ScPlaylists = lazyNamed(() => import('../pages/sc/ScPlaylists'), 'ScPlaylists')
const ScFollowing = lazyNamed(() => import('../pages/sc/ScFollowing'), 'ScFollowing')
const ScSearch = lazyNamed(() => import('../pages/sc/ScSearch'), 'ScSearch')
const ScStream = lazyNamed(() => import('../pages/sc/ScStream'), 'ScStream')
const ScUser = lazyNamed(() => import('../pages/sc/ScUser'), 'ScUser')
const SearchPage = lazyNamed(() => import('../pages/Search'), 'SearchPage')
const SettingsPage = lazyNamed(() => import('../pages/Settings'), 'SettingsPage')
const SpotifyArtistPage = lazyNamed(() => import('../spotify/SpotifyPage'), 'SpotifyArtistPage')
const SpotifyPage = lazyNamed(() => import('../spotify/SpotifyPage'), 'SpotifyPage')
const SpotifyPlaylistPage = lazyNamed(() => import('../spotify/SpotifyPage'), 'SpotifyPlaylistPage')
const SpotifySearchPage = lazyNamed(() => import('../spotify/SpotifyPage'), 'SpotifySearchPage')

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'explore':
      return <Explore />
    case 'search':
      return <SearchPage q={route.q ?? ''} />
    case 'library':
      return <Library />
    case 'playlists':
      return <Playlists />
    case 'playlist':
      return <PlaylistPage ownerId={route.ownerId} id={route.id} accessKey={route.accessKey} />
    case 'friends':
      return <Friends />
    case 'friend':
      return <FriendPage id={route.id} title={route.title} />
    case 'artist':
      return <Artist id={route.id} name={route.artist} />
    case 'recent':
      return <Recent />
    case 'section':
      return <SectionPage title={route.title} id={route.id} block={route.block} cards={route.cards} />
    case 'settings':
      return <SettingsPage />
    case 'spotify':
      return <SpotifyPage />
    case 'spotify-playlist':
      return <SpotifyPlaylistPage id={route.id} kind={route.kind} title={route.title} />
    case 'spotify-artist':
      return <SpotifyArtistPage id={route.id} title={route.title} />
    case 'spotify-search':
      return <SpotifySearchPage q={route.q ?? ''} uri={route.uri} />
    case 'sc-home':
      return <ScHome />
    case 'sc-stream':
      return <ScStream />
    case 'sc-likes':
      return <ScLikes />
    case 'sc-playlists':
      return <ScPlaylists />
    case 'sc-following':
      return <ScFollowing />
    case 'sc-playlist':
      return <ScPlaylistPage id={route.id} urn={route.urn} title={route.title} />
    case 'sc-user':
      return <ScUser id={route.id} title={route.title} />
    case 'sc-search':
      return <ScSearch q={route.q ?? ''} />
    case 'albums':
      return <AlbumsPage />
    case 'album':
      return <AlbumPage id={route.id} />
  }
}

/** Search keeps one page instance while the query changes. */
const routeKey = (r: Route) => (r.name === 'search' || r.name === 'sc-search' || r.name === 'spotify-search' ? r.name : JSON.stringify(r))

/** VK login progress inside `<main>` so SoundCloud, Spotify, and «Моё» remain accessible while VK signs in. */
function VkPendingGate({ busy }: { busy: boolean }) {
  return (
    <div className={s.splash}>
      <Spinner size={24} />
      {busy && (
        <>
          <p className={s.splashNote}>VK пока не выдаёт доступ — пробуем ещё раз…</p>
          {/* VK may be down for hours: a way to look at it and to send what happened */}
          <button type="button" className={s.splashLink} onClick={() => void useSession.getState().login()}>
            Открыть окно VK
          </button>
          <CopyJournalLink />
        </>
      )}
    </div>
  )
}

function Shell() {
  const route = useRouter((r) => r.route)
  const navIndex = useRouter((r) => r.index)
  const vkPhase = useSession((x) => x.phase)
  const busy = useSession((x) => x.busy)
  const scroller = useRef<HTMLDivElement>(null)
  const restoringRef = useRef<number | null>(null)
  const setScrolled = useChrome((c) => c.setScrolled)
  const wallpaper = useSettings((x) => x.wallpaper)
  const blur = useSettings((x) => x.wallpaperBlur)
  const dim = useSettings((x) => x.wallpaperDim)
  const key = routeKey(route)
  const navKey = `${key}:${navIndex}`
  const spotifyPlaying = useSpotify((x) => x.owner && x.track !== null)
  const nowPlaying = useUi((u) => u.nowPlaying)
  const [npMounted, setNpMounted] = useState(false)
  if (nowPlaying && !npMounted) setNpMounted(true)
  const reduced = useReducedMotion()
  const needsVkAuth = routeService(route) === 'vk' && vkPhase !== 'ready'

  useLayoutEffect(() => {
    const el = scroller.current
    const target = useRouter.getState().currentScroll()
    setScrolled(target > 36)
    if (!el) return
    if (target <= 0) {
      restoringRef.current = null
      el.scrollTo({ top: 0 })
      return
    }
    restoringRef.current = target
    el.scrollTo({ top: target })
    if (el.scrollTop >= target - 2) {
      restoringRef.current = null
      return
    }
    if (typeof ResizeObserver === 'undefined') return
    const content = el.firstElementChild ?? el
    const ro = new ResizeObserver(() => {
      if (restoringRef.current === null) {
        ro.disconnect()
        return
      }
      el.scrollTo({ top: target })
      setScrolled(el.scrollTop > 36)
      if (el.scrollTop >= target - 2) {
        restoringRef.current = null
        ro.disconnect()
      }
    })
    ro.observe(content)
    const timer = window.setTimeout(() => {
      restoringRef.current = null
      ro.disconnect()
    }, 1500)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [navKey, setScrolled])

  const cancelRestore = () => {
    restoringRef.current = null
  }

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop
    setScrolled(top > 36)
    const target = restoringRef.current
    if (target !== null) {
      if (top >= target - 2) {
        restoringRef.current = null
        useRouter.getState().saveScroll(top)
      }
      return
    }
    useRouter.getState().saveScroll(top)
  }

  return (
    <ScrollerContext.Provider value={scroller}>
      <div className={s.root}>
        <Wallpaper config={wallpaper} look={{ blur, dim }} />
        <ServiceRail />
        <Sidebar />
        <main className={s.main}>
          <div
            ref={scroller}
            className={s.scroller}
            onScroll={handleScroll}
            onWheel={cancelRestore}
            onTouchStart={cancelRestore}
            onPointerDown={cancelRestore}
          >
            <motion.div
              key={key}
              className={s.page}
              initial={reduced ? false : { opacity: 0.92, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0.01 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              {needsVkAuth ? (
                vkPhase === 'pending' ? <VkPendingGate busy={busy} /> : <Login embedded />
              ) : (
                <ErrorBoundary label="page" resetKey={navKey}>
                  <Suspense fallback={<div className={s.routeFallback}><Spinner size={24} /></div>}>
                    <Page route={route} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </motion.div>
          </div>
          <Titlebar />
          {spotifyPlaying ? (
            <Suspense fallback={<MiniPlayer />}>
              <SpotifyMiniPlayer />
            </Suspense>
          ) : (
            <MiniPlayer />
          )}
        </main>
        {(nowPlaying || npMounted) && (
          <ErrorBoundary label="now-playing" resetKey={String(nowPlaying)}>
            <Suspense fallback={null}>
              <NowPlaying />
            </Suspense>
          </ErrorBoundary>
        )}
        <ContextMenu />
      </div>
    </ScrollerContext.Provider>
  )
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Shell />
      <Toasts />
      <Sheets />
    </MotionConfig>
  )
}

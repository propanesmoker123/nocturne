import { motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Spinner } from '../components/controls'
import { Wallpaper } from '../components/Wallpaper'
import { useSettings } from '../lib/settings'
import { Artist } from '../pages/Artist'
import { Explore } from '../pages/Explore'
import { FriendPage, Friends } from '../pages/Friends'
import { Home } from '../pages/Home'
import { Library } from '../pages/Library'
import { Login } from '../pages/Login'
import { PlaylistPage } from '../pages/PlaylistPage'
import { Playlists } from '../pages/Playlists'
import { Recent } from '../pages/Recent'
import { SearchPage } from '../pages/Search'
import { SettingsPage } from '../pages/Settings'
import s from './App.module.css'
import { useChrome } from './chrome'
import { ContextMenu } from './ContextMenu'
import { MiniPlayer } from './MiniPlayer'
import { NowPlaying } from './NowPlaying'
import { useRouter, type Route } from './router'
import { ScrollerContext } from './scroller'
import { useSession } from './session'
import { Sheets } from './Sheets'
import { Sidebar } from './Sidebar'
import { Titlebar } from './Titlebar'
import { Toasts } from './Toasts'

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
    case 'settings':
      return <SettingsPage />
  }
}

/** Search keeps one page instance while the query changes. */
const routeKey = (r: Route) => (r.name === 'search' ? 'search' : JSON.stringify(r))

function Shell() {
  const route = useRouter((r) => r.route)
  const scroller = useRef<HTMLDivElement>(null)
  const setScrolled = useChrome((c) => c.setScrolled)
  const wallpaper = useSettings((x) => x.wallpaper)
  const blur = useSettings((x) => x.wallpaperBlur)
  const dim = useSettings((x) => x.wallpaperDim)
  const key = routeKey(route)

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    setScrolled(false)
  }, [key, setScrolled])

  return (
    <ScrollerContext.Provider value={scroller}>
      <div className={s.root}>
        <Wallpaper config={wallpaper} look={{ blur, dim }} />
        <Sidebar />
        <main className={s.main}>
          <div ref={scroller} className={s.scroller} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 36)}>
            <motion.div key={key} className={s.page} initial={{ y: 14 }} animate={{ y: 0 }} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
              <Page route={route} />
            </motion.div>
          </div>
          <Titlebar />
          <Toasts />
          <MiniPlayer />
        </main>
        <NowPlaying />
        <ContextMenu />
        <Sheets />
      </div>
    </ScrollerContext.Provider>
  )
}

export function App() {
  const phase = useSession((x) => x.phase)
  if (phase === 'pending') {
    return (
      <div className={s.splash} data-tauri-drag-region>
        <Spinner size={24} />
      </div>
    )
  }
  if (phase === 'none') return <Login />
  return <Shell />
}

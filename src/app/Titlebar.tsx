import { ChevronLeft, ChevronRight, Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IconButton } from '../components/controls'
import { isTauri } from '../lib/tauri'
import s from './App.module.css'
import { useChrome } from './chrome'
import { useRouter } from './router'
import { useUi } from './ui'

async function win() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    let un: (() => void) | undefined
    void win().then(async (w) => {
      setMaximized(await w.isMaximized())
      un = await w.onResized(async () => setMaximized(await w.isMaximized()))
    })
    return () => un?.()
  }, [])
  if (!isTauri()) return <div />
  return (
    <div className={s.windowControls}>
      <button type="button" className={s.winBtn} aria-label="Свернуть" onClick={() => void win().then((w) => w.minimize())}>
        <Minus size={16} strokeWidth={1.8} />
      </button>
      <button type="button" className={s.winBtn} aria-label={maximized ? 'Восстановить' : 'Развернуть'} onClick={() => void win().then((w) => w.toggleMaximize())}>
        {maximized ? <Copy size={13} strokeWidth={1.8} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} strokeWidth={1.8} />}
      </button>
      <button type="button" className={s.winBtn} data-close aria-label="Закрыть" onClick={() => void win().then((w) => w.close())}>
        <X size={17} strokeWidth={1.8} />
      </button>
    </div>
  )
}

export function Titlebar() {
  const { canBack, canForward, back, forward } = useRouter()
  const title = useChrome((c) => c.title)
  const scrolled = useChrome((c) => c.scrolled)
  const overlay = useUi((u) => u.nowPlaying)
  return (
    <header className={s.titlebar} data-scrolled={scrolled || undefined} data-overlay={overlay || undefined} data-tauri-drag-region>
      <div className={s.nav} data-tauri-drag-region>
        {!overlay && (
          <>
            <IconButton size={30} label="Назад" onClick={back} disabled={!canBack}>
              <ChevronLeft size={20} strokeWidth={2.2} />
            </IconButton>
            <IconButton size={30} label="Вперёд" onClick={forward} disabled={!canForward}>
              <ChevronRight size={20} strokeWidth={2.2} />
            </IconButton>
          </>
        )}
      </div>
      <div className={`${s.inlineTitle} truncate`} data-tauri-drag-region>
        {title}
      </div>
      <WindowControls />
    </header>
  )
}

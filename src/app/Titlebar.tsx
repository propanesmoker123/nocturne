import { ChevronLeft, ChevronRight, Copy, Expand, Minus, Shrink, Square, X } from 'lucide-react'
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
  const fullscreen = useUi((u) => u.fullscreen)
  const toggleFullscreen = useUi((u) => u.toggleFullscreen)

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let un: (() => void) | undefined
    void win()
      .then(async (w) => {
        const isMax = await w.isMaximized()
        if (disposed) return
        setMaximized(isMax)
        const off = await w.onResized(async () => {
          if (disposed) return
          setMaximized(await w.isMaximized())
        })
        if (disposed) off()
        else un = off
      })
      .catch(() => {})
    return () => {
      disposed = true
      un?.()
    }
  }, [])
  if (!isTauri()) return <div />
  return (
    // the block spans the whole right part of the title bar: it must drag the window too (its buttons still click)
    <div className={s.windowControls} data-tauri-drag-region>
      <button
        type="button"
        className={s.winBtn}
        aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
        title={fullscreen ? 'Выйти из полноэкранного режима (F11)' : 'На весь экран (F11)'}
        onClick={() => void toggleFullscreen()}
      >
        {fullscreen ? <Shrink size={14} strokeWidth={1.8} /> : <Expand size={14} strokeWidth={1.8} />}
      </button>
      <button
        type="button"
        className={s.winBtn}
        aria-label="Свернуть"
        onClick={async () => {
          if (useUi.getState().fullscreen) await useUi.getState().setFullscreen(false)
          const w = await win()
          await w.minimize()
        }}
      >
        <Minus size={16} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={s.winBtn}
        aria-label={fullscreen || maximized ? 'Восстановить' : 'Развернуть'}
        onClick={async () => {
          if (useUi.getState().fullscreen) {
            await useUi.getState().setFullscreen(false)
            return
          }
          const w = await win()
          await w.toggleMaximize()
        }}
      >
        {fullscreen || maximized ? <Copy size={13} strokeWidth={1.8} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} strokeWidth={1.8} />}
      </button>
      <button type="button" className={s.winBtn} data-close aria-label="Закрыть" onClick={() => void win().then((w) => w.close())}>
        <X size={17} strokeWidth={1.8} />
      </button>
    </div>
  )
}

export function Titlebar() {
  const canBack = useRouter((r) => r.canBack)
  const canForward = useRouter((r) => r.canForward)
  const { back, forward } = useRouter.getState()
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

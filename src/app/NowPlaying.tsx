import { ChevronDown, CircleAlert, Maximize2, Minimize2, X } from 'lucide-react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton, Segmented, Spinner } from '../components/controls'
import { IconBackward, IconForward, IconLyrics, IconMore, IconPause, IconPlay, IconQueue, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { WaveComments } from '../components/WaveComments'
import { WaveformScrubber } from '../components/Waveform'
import { formatTime } from '../lib/format'
import { useSettings } from '../lib/settings'
import { ParticlesCanvas } from '../lyrics/ParticlesCanvas'
import { usePlayer } from '../player/store'
import { useControlledBy } from '../together/TogetherControls'
import type { Track } from '../vk/models'
import { CoverViewer } from './CoverViewer'
import { AlbumAddButton, HeartButton } from '../components/TrackButtons'
import s from './NowPlaying.module.css'
import { artistRoute, useRouter } from './router'
import { WindowControls } from './Titlebar'
import { LyricsPanel, QueuePanel } from './SidePanels'
import { copyTrackName, openTrackMenu } from './trackActions'
import { useUi, type NowPlayingTab } from './ui'

function LyricsSyncHint({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const open = pinned || hovered

  const clearTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  useEffect(() => () => clearTimer(), [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false)
        setHovered(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setPinned(false)
        setHovered(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={s.syncHint}
      onMouseEnter={() => {
        clearTimer()
        setHovered(true)
      }}
      onMouseLeave={() => {
        clearTimer()
        closeTimerRef.current = window.setTimeout(() => setHovered(false), 140)
      }}
    >
      <IconButton
        size={32}
        className={s.theaterBtn}
        active={open}
        label="Информация о синхронизации текста"
        title=""
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
      >
        <CircleAlert size={15} />
      </IconButton>

      {open && (
        <div className={s.syncPopover} role="dialog" aria-label="Синхронизация текста">
          <div className={s.syncPopoverHead}>
            <CircleAlert size={14} className={s.syncPopoverIcon} />
            <span>Синхронизация с треком</span>
          </div>
          <p className={s.syncPopoverText}>
            Сейчас синхронизация текста с треком может расходиться. В настройках в блоке «Тексты и анимации» её можно выключить — тогда будет просто выделяться текущая строка.
          </p>
          <button
            type="button"
            className={s.syncPopoverBtn}
            onClick={() => {
              setPinned(false)
              setHovered(false)
              onOpenSettings()
            }}
          >
            Открыть настройки
          </button>
        </div>
      )}
    </div>
  )
}

function Backdrop({ src }: { src?: string }) {
  if (!src) return null
  return (
    <div className={s.backdrop} aria-hidden="true">
      <img src={src} alt="" referrerPolicy="no-referrer" />
      <img src={src} alt="" referrerPolicy="no-referrer" />
      <img src={src} alt="" referrerPolicy="no-referrer" />
    </div>
  )
}

function BigScrubber() {
  const position = usePlayer((p) => p.position)
  const duration = usePlayer((p) => p.duration || p.current?.duration || 0)
  const buffered = usePlayer((p) => p.buffered)
  const seek = usePlayer((p) => p.seek)
  const trackKey = usePlayer((p) => p.current?.key)
  const controlledBy = useControlledBy()
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? position
  return (
    <div className={s.bigWave}>
      <WaveComments size={26} />
      <WaveformScrubber
        trackKey={trackKey}
        height={76}
        label="Позиция трека"
        value={duration ? shown / duration : 0}
        buffered={duration ? buffered / duration : 0}
        disabled={!duration || !!controlledBy}
        step={5 / Math.max(duration, 1)}
        valueText={(v) => formatTime(v * duration)}
        onChange={(v) => setDrag(v * duration)}
        onCommit={(v) => {
          setDrag(null)
          seek(v * duration)
        }}
      />
      <div className={s.times}>
        <span>{formatTime(shown)}</span>
        <span>-{formatTime(Math.max(0, duration - shown))}</span>
      </div>
    </div>
  )
}

/** The big cover; a click opens it over the whole window at full size. */
function CoverArt({ track, playing }: { track: Track; playing: boolean }) {
  const [full, setFull] = useState(false)
  const close = useCallback(() => setFull(false), [])
  const reduced = useReducedMotion()
  const big = track.cover?.l
  return (
    <>
      <motion.button
        type="button"
        className={s.artFrame}
        aria-label="Открыть обложку"
        disabled={!big}
        onClick={() => setFull(true)}
        animate={{ scale: reduced || playing ? 1 : 0.86 }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 220, damping: 20 }}
      >
        <Artwork src={track.cover?.l} size="100%" radius={14} seed={track.key} />
      </motion.button>
      <CoverViewer src={full && big ? big : null} alt={`${track.title} — ${track.artist}`} onClose={close} />
    </>
  )
}

/** Lets clicks through to the app while the sheet is sliding away. */
function PointerGate() {
  const present = useIsPresent()
  return present ? null : <style>{`[aria-label="Сейчас играет"]{pointer-events:none}`}</style>
}

export function NowPlaying() {
  const open = useUi((u) => u.nowPlaying)
  const tab = useUi((u) => u.tab)
  const current = usePlayer((p) => p.current)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const isLoading = usePlayer((p) => p.isLoading)
  const shuffle = usePlayer((p) => p.shuffle)
  const repeat = usePlayer((p) => p.repeat)
  const volume = usePlayer((p) => p.volume)
  const muted = usePlayer((p) => p.muted)
  const remoteName = usePlayer((p) => p.remoteName)
  const { toggle, next, prev, toggleShuffle, cycleRepeat, setVolume } = usePlayer.getState()
  const controlledBy = useControlledBy()
  const push = useRouter((r) => r.push)
  const particlesOn = useSettings((st) => st.lyrics.particles)
  const fullscreen = useUi((u) => u.fullscreen)
  const sideOpen = useUi((u) => u.sideOpen)
  const setSideOpen = useUi.getState().setSideOpen
  const reduced = useReducedMotion()
  const [lyricsTheater, setLyricsTheater] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const { fullscreen: isFs, sideOpen: isSideOpen } = useUi.getState()
        if (isFs) {
          e.preventDefault()
          void useUi.getState().setFullscreen(false)
        } else if (isSideOpen && window.matchMedia('(max-width: 1080px)').matches) {
          e.preventDefault()
          useUi.getState().setSideOpen(false)
        } else {
          useUi.getState().closeNowPlaying()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const setTab = (t: NowPlayingTab) => useUi.getState().setTab(t)
  const toggleSide = (t: NowPlayingTab) => {
    if (sideOpen && tab === t) setSideOpen(false)
    else {
      setTab(t)
      setSideOpen(true)
    }
  }

  return (
    <AnimatePresence>
      {open && current && (
        <motion.section
          key="now-playing"
          className={s.sheet}
          data-fullscreen={fullscreen || undefined}
          aria-label="Сейчас играет"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 36 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 36 }}
          transition={reduced ? { duration: 0.01 } : { duration: 0.19, ease: [0.22, 1, 0.36, 1] }}
        >
          <PointerGate />
          <Backdrop src={current.cover?.m} />
          <div className={s.scrim} />
          <ParticlesCanvas
            mode="ambient"
            enabled={particlesOn}
            playing={isPlaying}
            trackKey={current.key}
            duration={current.duration}
            className={s.particles}
          />
          <div className={s.chrome} data-tauri-drag-region>
            <div className={s.chromeLeft}>
              <IconButton label="Свернуть" onClick={() => useUi.getState().closeNowPlaying()}>
                <ChevronDown size={22} strokeWidth={2.2} />
              </IconButton>
            </div>
            <WindowControls />
          </div>

          <div className={s.layout} data-theater={lyricsTheater || undefined} data-fullscreen={fullscreen || undefined}>
            <div className={s.stage}>
              <CoverArt track={current} playing={isPlaying} />

              <div className={s.controls}>
                {remoteName && <div className={s.remoteNote}>Играет на устройстве «{remoteName}»</div>}
                <div className={s.titleRow}>
                  <div className={s.titleBlock}>
                    <button type="button" className={`${s.title} ${s.copyTitle} truncate`} title="Нажмите, чтобы скопировать название" onClick={() => copyTrackName(current)}>
                      {current.title}
                    </button>
                    <button
                      type="button"
                      className={`${s.artist} truncate`}
                      style={{ maxWidth: '100%' }}
                      onClick={() => {
                        useUi.getState().closeNowPlaying()
                        push(artistRoute(current))
                      }}
                    >
                      {current.artist}
                    </button>
                  </div>
                  <HeartButton className={s.roundBtn} track={current} size={34} iconSize={17} />
                  <AlbumAddButton className={s.roundBtn} track={current} size={34} iconSize={18} />
                  <IconButton className={s.roundBtn} size={34} label="Ещё" onClick={(e) => openTrackMenu(e, current, { inNowPlaying: true })}>
                    <IconMore size={18} />
                  </IconButton>
                </div>

                <BigScrubber />

                <div className={s.transport}>
                  <IconButton size={40} plain active={shuffle} label="Перемешать" onClick={toggleShuffle} disabled={!!controlledBy}>
                    <IconShuffle size={21} />
                  </IconButton>
                  <IconButton size={56} plain label="Предыдущий" onClick={() => prev()} disabled={!!controlledBy}>
                    <IconBackward size={36} />
                  </IconButton>
                  <IconButton className={s.big} size={64} plain label={isPlaying ? 'Пауза' : 'Играть'} onClick={toggle}>
                    {isLoading && isPlaying ? <Spinner size={30} /> : isPlaying ? <IconPause size={46} /> : <IconPlay size={46} />}
                  </IconButton>
                  <IconButton size={56} plain label="Следующий" onClick={() => next(true)} disabled={!!controlledBy}>
                    <IconForward size={36} />
                  </IconButton>
                  <IconButton size={40} plain active={repeat !== 'off'} label="Повтор" onClick={cycleRepeat} disabled={!!controlledBy}>
                    <IconRepeat size={21} one={repeat === 'one'} />
                  </IconButton>
                </div>

                <div className={s.volumeRow}>
                  <IconSpeaker size={16} level={0} />
                  <Slider size="sm" label="Громкость" value={muted ? 0 : volume} wheelStep={0.05} onChange={setVolume} onCommit={setVolume} />
                  <IconSpeaker size={18} level={3} />
                  <IconButton size={32} plain active={sideOpen && tab === 'lyrics'} label="Текст" onClick={() => toggleSide('lyrics')}>
                    <IconLyrics size={18} />
                  </IconButton>
                  <IconButton size={32} plain active={sideOpen && tab === 'queue'} label="Очередь" onClick={() => toggleSide('queue')}>
                    <IconQueue size={18} />
                  </IconButton>
                </div>
              </div>
            </div>

            {sideOpen && <div className={s.sideBackdrop} aria-hidden="true" onClick={() => setSideOpen(false)} />}
            <aside className={s.side} data-forced={sideOpen || undefined}>
              <div className={s.sideHeader}>
                <Segmented
                  id="np-tabs"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'queue', label: 'Далее' },
                    { value: 'lyrics', label: 'Текст' },
                  ]}
                />
                {tab === 'lyrics' && (
                  <LyricsSyncHint
                    onOpenSettings={() => {
                      push({ name: 'settings' })
                      useUi.getState().closeNowPlaying()
                    }}
                  />
                )}
                <IconButton
                  size={32}
                  className={s.theaterBtn}
                  data-active={lyricsTheater || undefined}
                  label={lyricsTheater ? 'Компактная панель' : 'Широкая панель'}
                  onClick={() => setLyricsTheater((v) => !v)}
                >
                  {lyricsTheater ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </IconButton>
                <IconButton size={32} className={s.sideCloseBtn} label="Закрыть панель" onClick={() => setSideOpen(false)}>
                  <X size={16} />
                </IconButton>
              </div>
              <div className={s.sidePanel}>{tab === 'queue' ? <QueuePanel /> : <LyricsPanel theater={lyricsTheater} />}</div>
            </aside>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}

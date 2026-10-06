import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useEffect, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton, Segmented, Spinner } from '../components/controls'
import { IconBackward, IconCheck, IconForward, IconLyrics, IconMore, IconPause, IconPlay, IconPlus, IconQueue, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { WaveformScrubber } from '../components/Waveform'
import { formatTime } from '../lib/format'
import { usePlayer } from '../player/store'
import { isInLibrary, toggleLibrary } from './library'
import s from './NowPlaying.module.css'
import { useRouter } from './router'
import { WindowControls } from './Titlebar'
import { LyricsPanel, QueuePanel } from './SidePanels'
import { openTrackMenu } from './trackActions'
import { useUi, type NowPlayingTab } from './ui'

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
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? position
  return (
    <div>
      <WaveformScrubber
        trackKey={trackKey}
        height={56}
        label="Позиция трека"
        value={duration ? position / duration : 0}
        buffered={duration ? buffered / duration : 0}
        disabled={!duration}
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
  const { toggle, next, prev, toggleShuffle, cycleRepeat, setVolume } = usePlayer.getState()
  const push = useRouter((r) => r.push)
  const [sideOpen, setSideOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useUi.getState().closeNowPlaying()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const setTab = (t: NowPlayingTab) => useUi.setState({ tab: t })
  const toggleSide = (t: NowPlayingTab) => {
    if (sideOpen && tab === t) setSideOpen(false)
    else {
      setTab(t)
      setSideOpen(true)
    }
  }
  const liked = current ? isInLibrary(current) : false

  return (
    <AnimatePresence>
      {open && current && (
        <motion.section
          key="now-playing"
          className={s.sheet}
          aria-label="Сейчас играет"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', stiffness: 240, damping: 32, mass: 0.9 }}
        >
          <PointerGate />
          <Backdrop src={current.cover?.m} />
          <div className={s.scrim} />
          <div className={s.chrome} data-tauri-drag-region>
            <IconButton label="Свернуть" onClick={() => useUi.getState().closeNowPlaying()}>
              <ChevronDown size={22} strokeWidth={2.2} />
            </IconButton>
            <WindowControls />
          </div>

          <div className={s.layout}>
            <div className={s.stage}>
              <motion.div
                className={s.artFrame}
                animate={{ scale: isPlaying ? 1 : 0.86 }}
                transition={{ type: 'spring', stiffness: 220, damping: 20 }}
              >
                <Artwork src={current.cover?.l} size="100%" radius={14} seed={current.key} />
              </motion.div>

              <div className={s.controls}>
                <div className={s.titleRow}>
                  <div className={s.titleBlock}>
                    <div className={`${s.title} truncate`}>{current.title}</div>
                    <button
                      type="button"
                      className={`${s.artist} truncate`}
                      style={{ maxWidth: '100%' }}
                      onClick={() => {
                        useUi.getState().closeNowPlaying()
                        push({ name: 'artist', id: current.artists[0]?.id, artist: current.artists[0]?.name ?? current.artist })
                      }}
                    >
                      {current.artist}
                    </button>
                  </div>
                  <IconButton className={s.roundBtn} size={34} label={liked ? 'Убрать из Моей музыки' : 'Добавить в Мою музыку'} onClick={() => void toggleLibrary(current)}>
                    {liked ? <IconCheck size={18} /> : <IconPlus size={18} />}
                  </IconButton>
                  <IconButton className={s.roundBtn} size={34} label="Ещё" onClick={(e) => openTrackMenu(e, current, { inNowPlaying: true })}>
                    <IconMore size={18} />
                  </IconButton>
                </div>

                <BigScrubber />

                <div className={s.transport}>
                  <IconButton size={40} plain active={shuffle} label="Перемешать" onClick={toggleShuffle}>
                    <IconShuffle size={21} />
                  </IconButton>
                  <IconButton size={56} plain label="Предыдущий" onClick={prev}>
                    <IconBackward size={36} />
                  </IconButton>
                  <IconButton className={s.big} size={64} plain label={isPlaying ? 'Пауза' : 'Играть'} onClick={toggle}>
                    {isLoading && isPlaying ? <Spinner size={30} /> : isPlaying ? <IconPause size={46} /> : <IconPlay size={46} />}
                  </IconButton>
                  <IconButton size={56} plain label="Следующий" onClick={() => next(true)}>
                    <IconForward size={36} />
                  </IconButton>
                  <IconButton size={40} plain active={repeat !== 'off'} label="Повтор" onClick={cycleRepeat}>
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

            <aside className={s.side} data-forced={sideOpen || undefined}>
              <Segmented
                id="np-tabs"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'queue', label: 'Далее' },
                  { value: 'lyrics', label: 'Текст' },
                ]}
              />
              <div className={s.sidePanel}>{tab === 'queue' ? <QueuePanel /> : <LyricsPanel />}</div>
            </aside>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}

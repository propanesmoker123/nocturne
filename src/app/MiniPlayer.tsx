import { Heart, MonitorSmartphone, MoreHorizontal, Send, Users } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import { albumMenuItems } from '../albums/addMenu'
import { Artwork } from '../components/Artwork'
import { DevicesButton, openDevicesPanel } from '../connect/DevicesPanel'
import { IconButton, Spinner } from '../components/controls'
import { IconBackward, IconForward, IconLyrics, IconNote, IconPause, IconPlay, IconQueue, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { AlbumAddButton, HeartButton } from '../components/TrackButtons'
import { WaveformScrubber } from '../components/Waveform'
import { formatTime, fullTrackName } from '../lib/format'
import { usePlayer } from '../player/store'
import { openTogetherPanel, TogetherBanner, TogetherButton, useControlledBy } from '../together/TogetherControls'
import { useTogether } from '../together/session'
import { isInLibrary, likeLabel, toggleLibrary } from './library'
import { showMenu, type MenuItem } from './menu'
import s from './MiniPlayer.module.css'
import { artistRoute, useRouter } from './router'
import { copyTrackName, shareTrack } from './trackActions'
import { useUi } from './ui'

export function speakerLevel(volume: number, muted: boolean): 0 | 1 | 2 | 3 {
  if (muted || volume === 0) return 0
  return volume < 0.34 ? 1 : volume < 0.67 ? 2 : 3
}

/** Inline volume slider on wide bars, floating popover + wheel control when the bar turns compact. */
export function VolumeControl({
  volume,
  muted,
  label,
  muteLabel,
  showSlider = true,
  onToggleMute,
  onChange,
  onCommit,
}: {
  volume: number
  muted: boolean
  label: string
  muteLabel: string
  showSlider?: boolean
  onToggleMute(): void
  onChange(v: number): void
  onCommit(v: number): void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inlineRef = useRef<HTMLDivElement>(null)
  const display = muted ? 0 : volume

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const handleSpeakerClick = () => {
    if (showSlider && inlineRef.current && getComputedStyle(inlineRef.current).display === 'none') {
      setOpen((v) => !v)
    } else {
      onToggleMute()
    }
  }

  const handleWheel = (e: WheelEvent<HTMLButtonElement>) => {
    if (!showSlider) return
    const next = Math.max(0, Math.min(1, Math.round((display + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100))
    onChange(next)
    onCommit(next)
  }

  return (
    <div ref={wrapRef} className={s.volumeWrap} data-open={open || undefined}>
      <IconButton size={32} active={open} label={open ? `${label}: ${Math.round(display * 100)}%` : muteLabel} onClick={handleSpeakerClick} onWheel={handleWheel}>
        <IconSpeaker size={19} level={speakerLevel(volume, muted)} />
      </IconButton>
      {showSlider && (
        <>
          <div ref={inlineRef} className={s.volume}>
            <Slider
              size="sm"
              label={label}
              value={display}
              wheelStep={0.05}
              valueText={(v) => `${Math.round(v * 100)}%`}
              onChange={onChange}
              onCommit={onCommit}
            />
          </div>
          {open && (
            <div className={s.volumePopover} role="dialog" aria-label={label}>
              <span className={s.volumePercent}>{Math.round(display * 100)}%</span>
              <div className={s.volumeSlider}>
                <Slider
                  orientation="vertical"
                  size="sm"
                  label={label}
                  value={display}
                  wheelStep={0.05}
                  valueText={(v) => `${Math.round(v * 100)}%`}
                  onChange={onChange}
                  onCommit={onCommit}
                />
              </div>
              <IconButton size={26} label={muteLabel} onClick={onToggleMute}>
                <IconSpeaker size={16} level={speakerLevel(volume, muted)} />
              </IconButton>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function Scrubber({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const position = usePlayer((p) => p.position)
  const duration = usePlayer((p) => p.duration || p.current?.duration || 0)
  const buffered = usePlayer((p) => p.buffered)
  const seek = usePlayer((p) => p.seek)
  const trackKey = usePlayer((p) => p.current?.key)
  const controlledBy = useControlledBy()
  const [drag, setDrag] = useState<number | null>(null)
  useEffect(() => setDrag(null), [trackKey])
  const shown = drag ?? position
  return (
    <div className={s.timeline}>
      <span>{formatTime(shown)}</span>
      <div className={s.waveBox}>
        <WaveformScrubber
          trackKey={trackKey}
          height={size === 'sm' ? 26 : 40}
          label="Позиция трека"
          value={duration ? shown / duration : 0}
          buffered={duration ? buffered / duration : 0}
          disabled={!trackKey || !duration || !!controlledBy}
          step={5 / Math.max(duration, 1)}
          valueText={(v) => formatTime(v * duration)}
          onChange={(v) => setDrag(v * duration)}
          onCommit={(v) => {
            setDrag(null)
            seek(v * duration)
          }}
          onCancel={() => setDrag(null)}
        />
      </div>
      <span>-{formatTime(Math.max(0, duration - shown))}</span>
    </div>
  )
}

export function MiniPlayer() {
  const current = usePlayer((p) => p.current)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const isLoading = usePlayer((p) => p.isLoading)
  const shuffle = usePlayer((p) => p.shuffle)
  const repeat = usePlayer((p) => p.repeat)
  const volume = usePlayer((p) => p.volume)
  const muted = usePlayer((p) => p.muted)
  const { toggle, next, prev, toggleShuffle, cycleRepeat, setVolume, toggleMute } = usePlayer.getState()
  const { openNowPlaying, toggleNowPlaying } = useUi.getState()
  const nowPlayingTab = useUi((u) => (u.nowPlaying ? u.tab : null))
  const remoteName = usePlayer((p) => p.remoteName)
  const togetherRole = useTogether((t) => t.role)
  const push = useRouter((r) => r.push)
  // Listening together, the host seeks and skips; the listener keeps pause and volume
  const controlledBy = useControlledBy()
  const locked = !current || !!controlledBy

  const openMoreMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = []
    if (current) {
      const liked = isInLibrary(current)
      items.push(
        { label: likeLabel(current, liked), icon: <Heart size={15} fill={liked ? 'currentColor' : 'none'} />, onSelect: () => void toggleLibrary(current) },
        { label: 'Добавить в альбом Nocturne', submenu: async () => albumMenuItems([current]) },
        { label: 'Поделиться треком', icon: <Send size={15} />, onSelect: () => void shareTrack(current) },
        { separator: true },
      )
    }
    items.push(
      { label: remoteName ? `Устройства (${remoteName})` : 'Устройства', icon: <MonitorSmartphone size={15} />, onSelect: openDevicesPanel },
      { label: togetherRole ? 'Слушать вместе (активно)' : 'Слушать вместе', icon: <Users size={15} />, onSelect: openTogetherPanel },
    )
    showMenu(e, items)
  }

  return (
    <div className={s.wrap}>
      <div className={s.bar} role="region" aria-label="Плеер">
        <TogetherBanner />
        <div className={s.meta}>
          {current ? (
            <>
              <button type="button" className={s.artButton} onClick={() => openNowPlaying()} aria-label="Открыть «Сейчас играет»">
                <Artwork src={current.cover?.s} size={52} radius={8} seed={current.key} />
              </button>
              <div className={s.titles}>
                <div className={s.title}>
                  <button type="button" className={`${s.copyTitle} truncate`} title={`${fullTrackName(current)} — нажмите, чтобы скопировать`} onClick={() => copyTrackName(current)}>
                    {current.title}
                  </button>
                  {current.explicit && <span className={s.explicit} aria-label="Нецензурное">E</span>}
                </div>
                <div className={`${s.artist} truncate`}>
                  <button type="button" onClick={() => push(artistRoute(current))}>
                    {current.artist}
                  </button>
                </div>
                {remoteName && <div className={`${s.remote} truncate`}>Играет на «{remoteName}»</div>}
              </div>
              <div className={s.marks}>
                <HeartButton track={current} size={30} iconSize={17} />
                <AlbumAddButton className={s.markAdd} track={current} size={30} iconSize={18} />
              </div>
            </>
          ) : (
            <>
              <div className={s.placeholderArt}>
                <IconNote size={22} />
              </div>
              <span className={s.empty}>Ничего не играет</span>
            </>
          )}
        </div>

        <div className={s.center}>
          <div className={s.transport}>
            <IconButton className={s.transportExtra} size={32} plain active={shuffle} label={shuffle ? 'Выключить перемешивание' : 'Перемешать'} onClick={toggleShuffle} disabled={locked}>
              <IconShuffle size={17} />
            </IconButton>
            <IconButton size={36} plain label="Предыдущий" onClick={() => prev()} disabled={locked}>
              <IconBackward size={22} />
            </IconButton>
            <IconButton className={s.play} size={40} plain label={isPlaying ? 'Пауза' : 'Играть'} onClick={toggle} disabled={!current}>
              {isLoading && isPlaying ? <Spinner size={20} /> : isPlaying ? <IconPause size={26} /> : <IconPlay size={26} />}
            </IconButton>
            <IconButton size={36} plain label="Следующий" onClick={() => next(true)} disabled={locked}>
              <IconForward size={22} />
            </IconButton>
            <IconButton
              className={s.transportExtra}
              size={32}
              plain
              active={repeat !== 'off'}
              label={repeat === 'off' ? 'Повторять очередь' : repeat === 'all' ? 'Повторять трек' : 'Не повторять'}
              onClick={cycleRepeat}
              disabled={locked}
            >
              <IconRepeat size={17} one={repeat === 'one'} />
            </IconButton>
          </div>
          <Scrubber />
        </div>

        <div className={s.right}>
          <DevicesButton buttonClassName={s.secondaryBtn} />
          <TogetherButton buttonClassName={s.secondaryBtn} />
          <IconButton className={s.secondaryBtn} size={32} label="Поделиться треком" onClick={() => current && shareTrack(current)} disabled={!current}>
            <Send size={17} strokeWidth={2} />
          </IconButton>
          <IconButton className={s.moreBtn} size={32} active={Boolean(remoteName || togetherRole)} label="Ещё" onClick={openMoreMenu}>
            <MoreHorizontal size={18} />
          </IconButton>
          <IconButton size={32} label="Текст" active={nowPlayingTab === 'lyrics'} onClick={() => toggleNowPlaying('lyrics')} disabled={!current}>
            <IconLyrics size={18} />
          </IconButton>
          <IconButton size={32} label="Очередь" active={nowPlayingTab === 'queue'} onClick={() => toggleNowPlaying('queue')} disabled={!current}>
            <IconQueue size={18} />
          </IconButton>
          <VolumeControl
            volume={volume}
            muted={muted}
            label="Громкость"
            muteLabel={muted ? 'Включить звук' : 'Выключить звук'}
            onToggleMute={toggleMute}
            onChange={setVolume}
            onCommit={setVolume}
          />
        </div>
      </div>
    </div>
  )
}

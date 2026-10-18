import { Send } from 'lucide-react'
import { useState } from 'react'
import { Artwork } from '../components/Artwork'
import { DevicesButton } from '../connect/DevicesPanel'
import { IconButton, Spinner } from '../components/controls'
import { IconBackward, IconCheck, IconForward, IconNote, IconPause, IconPlay, IconPlus, IconQueue, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { WaveformScrubber } from '../components/Waveform'
import { formatTime, fullTrackName } from '../lib/format'
import { usePlayer } from '../player/store'
import { TogetherBanner, TogetherButton, useControlledBy } from '../together/TogetherControls'
import { isInLibrary, likeLabel, toggleLibrary } from './library'
import s from './MiniPlayer.module.css'
import { artistRoute, useRouter } from './router'
import { copyTrackName, shareTrack } from './trackActions'
import { useUi } from './ui'

export function speakerLevel(volume: number, muted: boolean): 0 | 1 | 2 | 3 {
  if (muted || volume === 0) return 0
  return volume < 0.34 ? 1 : volume < 0.67 ? 2 : 3
}

export function Scrubber({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const position = usePlayer((p) => p.position)
  const duration = usePlayer((p) => p.duration || p.current?.duration || 0)
  const buffered = usePlayer((p) => p.buffered)
  const seek = usePlayer((p) => p.seek)
  const trackKey = usePlayer((p) => p.current?.key)
  const controlledBy = useControlledBy()
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? position
  return (
    <div className={s.timeline}>
      <span>{formatTime(shown)}</span>
      <WaveformScrubber
        trackKey={trackKey}
        height={size === 'sm' ? 26 : 40}
        label="Позиция трека"
        value={duration ? position / duration : 0}
        buffered={duration ? buffered / duration : 0}
        disabled={!trackKey || !duration || !!controlledBy}
        step={5 / Math.max(duration, 1)}
        valueText={(v) => formatTime(v * duration)}
        onChange={(v) => setDrag(v * duration)}
        onCommit={(v) => {
          setDrag(null)
          seek(v * duration)
        }}
      />
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
  const { openNowPlaying, toggleNowPlaying } = useUi()
  const nowPlayingTab = useUi((u) => (u.nowPlaying ? u.tab : null))
  const remoteName = usePlayer((p) => p.remoteName)
  const push = useRouter((r) => r.push)
  const liked = current ? isInLibrary(current) : false
  // Listening together, the host seeks and skips; the listener keeps pause and volume
  const controlledBy = useControlledBy()
  const locked = !current || !!controlledBy

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
              <IconButton size={30} label={likeLabel(current, liked)} active={liked} onClick={() => void toggleLibrary(current)}>
                {liked ? <IconCheck size={18} /> : <IconPlus size={18} />}
              </IconButton>
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
            <IconButton size={32} plain active={shuffle} label={shuffle ? 'Выключить перемешивание' : 'Перемешать'} onClick={toggleShuffle} disabled={locked}>
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
          <DevicesButton />
          <TogetherButton />
          <IconButton size={32} label="Поделиться треком" onClick={() => current && shareTrack(current)} disabled={!current}>
            <Send size={17} strokeWidth={2} />
          </IconButton>
          <IconButton size={32} label="Очередь" active={nowPlayingTab === 'queue'} onClick={() => toggleNowPlaying('queue')} disabled={!current}>
            <IconQueue size={18} />
          </IconButton>
          <IconButton size={32} label={muted ? 'Включить звук' : 'Выключить звук'} onClick={toggleMute}>
            <IconSpeaker size={19} level={speakerLevel(volume, muted)} />
          </IconButton>
          <div className={s.volume}>
            <Slider size="sm" label="Громкость" value={muted ? 0 : volume} wheelStep={0.05} valueText={(v) => `${Math.round(v * 100)}%`} onChange={setVolume} onCommit={setVolume} />
          </div>
        </div>
      </div>
    </div>
  )
}

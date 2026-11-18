import { Heart } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton } from '../components/controls'
import { IconBackward, IconForward, IconPause, IconPlay, IconRepeat, IconShuffle } from '../components/Icons'
import { WaveformScrubber } from '../components/Waveform'
import { formatTime } from '../lib/format'
import { useRouter } from '../app/router'
import { VolumeControl } from '../app/MiniPlayer'
import s from '../app/MiniPlayer.module.css'
import { ensureSpotifyWaveform } from '../player/waveform'
import { spotifyControl, spotifyPosition, useSpotify } from './runtime'

const run = (...args: Parameters<typeof spotifyControl>) => void spotifyControl(...args).catch(() => {})

/** Ticks twice a second while Spotify plays, from its last reading. */
function useSpotifyPosition() {
  const playing = useSpotify(x => x.playing)
  const at = useSpotify(x => x.at)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(timer)
  }, [playing, at])
  return spotifyPosition()
}

/** The bottom bar while Spotify is the player and another page is open: Spotify's own bar is not on screen then. */
export function SpotifyMiniPlayer() {
  const track = useSpotify(x => x.track)
  const playing = useSpotify(x => x.playing)
  const push = useRouter(r => r.push)
  const position = useSpotifyPosition()
  const [drag, setDrag] = useState<number | null>(null)
  const trackKey = track ? (track.trackId ? `sp_${track.trackId}` : `sp_live_${track.title}_${track.artist}`) : undefined
  const waveformSeed = track?.trackId || trackKey || ''
  const trackDuration = track?.duration ?? 0
  useEffect(() => {
    if (!trackKey || !waveformSeed) return
    ensureSpotifyWaveform(trackKey, waveformSeed, trackDuration)
  }, [trackKey, waveformSeed, trackDuration])
  if (!track) return null
  const duration = track.duration
  const bufferedRatio = duration > 0 && typeof track.buffered === 'number' ? Math.min(1, Math.max(0, track.buffered / duration)) : 1
  const vol = track.volume ?? 1
  const muted = vol <= 0.001
  const shown = drag ?? position
  const open = () => push({ name: 'spotify' })
  return (
    <div className={s.wrap}>
      <div className={s.bar} role="region" aria-label="Плеер Spotify">
        <div className={s.meta}>
          <button type="button" className={s.artButton} onClick={open} aria-label="Открыть Spotify">
            <Artwork src={track.cover} size={52} radius={8} seed={`spotify:${track.title}`} />
          </button>
          <div className={s.titles}>
            <div className={s.title}><button type="button" className={`${s.copyTitle} truncate`} title={track.title} onClick={open}>{track.title}</button></div>
            <div className={`${s.artist} truncate`}><button type="button" onClick={open}>{track.artist}</button></div>
            <div className={`${s.remote} truncate`}>Spotify</div>
          </div>
          {track.liked !== null && (
            <div className={s.marks}>
              <IconButton size={30} active={track.liked} label={track.liked ? 'Убрать из любимых треков Spotify' : 'Добавить в любимые треки Spotify'} onClick={() => run('like')}>
                <Heart size={17} strokeWidth={2} fill={track.liked ? 'currentColor' : 'none'} />
              </IconButton>
            </div>
          )}
        </div>
        <div className={s.center}>
          <div className={s.transport}>
            <IconButton className={s.transportExtra} size={32} plain active={track.shuffle} label={track.shuffle ? 'Выключить перемешивание' : 'Перемешать'} onClick={() => run('shuffle')}><IconShuffle size={17} /></IconButton>
            <IconButton size={36} plain label="Предыдущий" onClick={() => run('previous')}><IconBackward size={22} /></IconButton>
            <IconButton className={s.play} size={40} plain label={playing ? 'Пауза' : 'Играть'} onClick={() => run('toggle')}>
              {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
            </IconButton>
            <IconButton size={36} plain label="Следующий" onClick={() => run('next')}><IconForward size={22} /></IconButton>
            <IconButton className={s.transportExtra} size={32} plain active={track.repeat !== 'off'} label={track.repeat === 'off' ? 'Повторять' : track.repeat === 'all' ? 'Повторять трек' : 'Не повторять'} onClick={() => run('repeat')}>
              <IconRepeat size={17} one={track.repeat === 'one'} />
            </IconButton>
          </div>
          <div className={s.timeline}>
            <span>{formatTime(shown)}</span>
            <div className={s.waveBox}>
              <WaveformScrubber
                trackKey={trackKey}
                height={26}
                label="Позиция трека"
                value={duration ? shown / duration : 0}
                buffered={bufferedRatio}
                disabled={!duration}
                step={5 / Math.max(duration, 1)}
                valueText={v => formatTime(v * duration)}
                onChange={v => setDrag(v * duration)}
                onCommit={v => { setDrag(null); run('seek', v * duration) }}
              />
            </div>
            <span>-{formatTime(Math.max(0, duration - shown))}</span>
          </div>
        </div>
        <div className={s.right}>
          <VolumeControl
            volume={vol}
            muted={muted}
            label="Громкость Spotify"
            muteLabel="Звук Spotify"
            showSlider={track.volume !== null}
            onToggleMute={() => run('mute')}
            onChange={(v) => run('volume', v)}
            onCommit={(v) => run('volume', v)}
          />
        </div>
      </div>
    </div>
  )
}

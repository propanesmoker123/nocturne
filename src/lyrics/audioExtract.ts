import { getActiveAudioCapture, readWhole } from '../player/waveform'
import type { Track } from '../vk/models'

const TARGET_RATE = 16_000

async function decodeWithContext(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const Ctx = globalThis.AudioContext
  if (!Ctx) throw new Error('Web Audio API недоступна')
  const ctx = new Ctx()
  try {
    return await ctx.decodeAudioData(bytes)
  } finally {
    await ctx.close().catch(() => {})
  }
}

export async function audioBufferTo16kMono(audio: AudioBuffer): Promise<Float32Array> {
  if (audio.sampleRate === TARGET_RATE && audio.numberOfChannels === 1) {
    return audio.getChannelData(0).slice()
  }
  const length = Math.max(1, Math.ceil(audio.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, length, TARGET_RATE)
  const src = offline.createBufferSource()
  src.buffer = audio
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

export async function decodeBufferTo16kMono(raw: ArrayBuffer): Promise<Float32Array> {
  const audio = await decodeWithContext(raw)
  return audioBufferTo16kMono(audio)
}

function concatBytes(a: Uint8Array, b: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out.buffer
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function extractTrackPcm16k(track: Track, onStatus?: (text: string) => void): Promise<Float32Array> {
  if (track.service === 'spotify') {
    throw new Error('Локальный анализ аудио недоступен для защищённых потоков Spotify.')
  }

  let cap = getActiveAudioCapture(track.key)

  if (cap?.drm) {
    throw new Error('Локальный анализ аудио недоступен для DRM-трека.')
  }

  // Fallback for direct non-HLS VK audio links if stream hasn't been opened in Waveform Capture yet
  if (!cap && (!track.service || track.service === 'vk') && track.url && !track.url.includes('.m3u8')) {
    onStatus?.('Загружаем аудиофайл для анализа…')
    const raw = await readWhole(track.url)
    onStatus?.('Подготовка звука (16 кГц)…')
    return decodeBufferTo16kMono(raw)
  }

  if (!cap) {
    throw new Error('Включите воспроизведение этого трека, чтобы нейросеть услышала аудиопоток.')
  }

  if (!cap.isHls) {
    onStatus?.('Загружаем аудиофайл для анализа…')
    const raw = await readWhole(cap.url)
    onStatus?.('Подготовка звука (16 кГц)…')
    return decodeBufferTo16kMono(raw)
  }

  // Boost HLS buffer temporarily so remaining segments of the active track load fast
  if (cap.hls) {
    onStatus?.('Подгружаем фрагменты аудиопотока…')
    const prevMax = cap.hls.config.maxBufferLength
    cap.hls.config.maxBufferLength = Math.max(prevMax, 360)
    cap.hls.config.maxBufferSize = Math.max(cap.hls.config.maxBufferSize, 24 * 1024 * 1024)
    cap.hls.startLoad()

    let prevCount = cap.segments.length
    let stableTicks = 0
    for (let step = 0; step < 12; step++) {
      await sleep(300)
      const latest = getActiveAudioCapture(track.key)
      if (!latest) break
      if (latest.segments.length === prevCount) stableTicks++
      else {
        prevCount = latest.segments.length
        stableTicks = 0
      }
      if (stableTicks >= 3 && prevCount > 0) break
    }
    cap = getActiveAudioCapture(track.key) ?? cap
  }

  const ordered = [...cap.segments].sort((a, b) => a.start - b.start)
  if (!ordered.length) {
    throw new Error('Аудиопоток ещё не успел буферизоваться. Подождите пару секунд.')
  }

  onStatus?.(`Декодируем ${ordered.length} аудиосегментов…`)
  const estDur = Math.max(track.duration || 0, (ordered.at(-1)?.start ?? 0) + 12)
  const out = new Float32Array(Math.ceil(estDur * TARGET_RATE))
  let maxSample = 0

  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i]
    const bytes = cap.container === 'audio/mp4' && cap.init ? concatBytes(cap.init, seg.bytes) : seg.bytes.slice().buffer
    try {
      const pcm = await decodeBufferTo16kMono(bytes)
      const offset = Math.max(0, Math.round(seg.start * TARGET_RATE))
      const end = Math.min(out.length, offset + pcm.length)
      for (let j = offset; j < end; j++) {
        out[j] = pcm[j - offset]
      }
      if (end > maxSample) maxSample = end
    } catch {
      /* tolerate occasional malformed trailing segment */
    }
  }

  if (maxSample < TARGET_RATE * 0.5) {
    throw new Error('Не удалось декодировать аудиопоток трека.')
  }

  return out.slice(0, maxSample)
}

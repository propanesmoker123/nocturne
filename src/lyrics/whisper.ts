import { create } from 'zustand'
import { queryClient } from '../app/queryClient'
import { useSettings, type WhisperModelSize } from '../lib/settings'
import { invoke, isTauri, listen } from '../lib/tauri'
import type { Lyrics, Track } from '../vk/models'
import { alignWhisperToLines, whisperWordsToLyrics, type WhisperWordChunk } from './align'
import { extractTrackPcm16k } from './audioExtract'
import { writeCachedLyrics } from './cache'

interface WhisperState {
  busy: boolean
  activeTrackKey: string | null
  stage: string
  progress: number | null
  error: string | null
  diskBytes: number
  filesCount: number
  refreshDiskStatus(): Promise<void>
  clearModelCache(): Promise<void>
}

export const useWhisperState = create<WhisperState>((set) => ({
  busy: false,
  activeTrackKey: null,
  stage: '',
  progress: null,
  error: null,
  diskBytes: 0,
  filesCount: 0,
  async refreshDiskStatus() {
    if (!isTauri()) return
    try {
      const s = await invoke<{ bytes: number; files: number }>('whisper_model_status')
      set({ diskBytes: s.bytes, filesCount: s.files })
    } catch {
      /* ignore */
    }
  },
  async clearModelCache() {
    if (!isTauri()) return
    if (useWhisperState.getState().busy) return
    terminateWorker()
    await invoke('whisper_model_clear')
    set({ diskBytes: 0, filesCount: 0, stage: '', error: null })
  },
}))

interface ProbeReply {
  status: number
  contentLength?: number
  contentType?: string
  contentRange?: string
}

const WORKER_IDLE_TTL_MS = 60_000

let worker: Worker | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let jobSeq = 1
const pendingJobs = new Map<number, { resolve: (chunks: WhisperWordChunk[]) => void; reject: (err: Error) => void }>()
let progressListening = false

function clearIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function terminateWorker(reason?: Error) {
  clearIdleTimer()
  const w = worker
  worker = null
  if (w) {
    try {
      w.terminate()
    } catch {
      /* ignore */
    }
  }
  if (pendingJobs.size) {
    const err = reason ?? new Error('Whisper worker terminated')
    const jobs = [...pendingJobs.values()]
    pendingJobs.clear()
    for (const job of jobs) job.reject(err)
  }
}

function scheduleIdleTerminate() {
  clearIdleTimer()
  if (!worker || pendingJobs.size > 0 || useWhisperState.getState().busy) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pendingJobs.size === 0 && !useWhisperState.getState().busy) terminateWorker()
  }, WORKER_IDLE_TTL_MS)
}

function ensureWorker(): Worker {
  clearIdleTimer()
  if (worker) return worker
  const w = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' })
  worker = w

  const onCrash = (message: string) => {
    if (worker !== w) return
    terminateWorker(new Error(message))
  }

  w.addEventListener('error', (ev: ErrorEvent) => {
    onCrash(ev.message || 'Whisper worker crashed')
  })

  w.addEventListener('messageerror', () => {
    onCrash('Whisper worker message deserialization failed')
  })

  w.addEventListener('message', async (ev: MessageEvent) => {
    if (worker !== w) return
    const msg = ev.data as
      | { type: 'net-fetch'; id: number; url: string; isProbe: boolean }
      | { type: 'progress'; jobId: number; stage: string; progress?: number }
      | { type: 'done'; jobId: number; chunks: WhisperWordChunk[] }
      | { type: 'error'; jobId: number; error: string }

    if (msg.type === 'net-fetch') {
      if (!isTauri()) {
        if (worker === w) {
          w.postMessage({ type: 'net-reply', id: msg.id, reply: { ok: false, status: 500, error: 'Tauri required' } })
        }
        return
      }
      try {
        if (msg.isProbe) {
          const p = await invoke<ProbeReply>('whisper_probe_asset', { url: msg.url })
          if (worker !== w) return
          w.postMessage({
            type: 'net-reply',
            id: msg.id,
            reply: {
              ok: p.status >= 200 && p.status < 400,
              status: p.status,
              isProbe: true,
              contentLength: p.contentLength,
              contentType: p.contentType,
              contentRange: p.contentRange,
            },
          })
        } else {
          const bytes = await invoke<ArrayBuffer>('whisper_fetch_asset', { url: msg.url })
          if (worker !== w) return
          w.postMessage(
            {
              type: 'net-reply',
              id: msg.id,
              reply: {
                ok: true,
                status: 200,
                contentLength: bytes.byteLength,
                contentType: msg.url.endsWith('.json') ? 'application/json' : 'application/octet-stream',
                bytes,
              },
            },
            [bytes],
          )
        }
      } catch (e) {
        if (worker !== w) return
        const s = String(e)
        const is404 = s.includes('HTTP_404')
        w.postMessage({
          type: 'net-reply',
          id: msg.id,
          reply: { ok: false, status: is404 ? 404 : 500, error: s },
        })
      }
      return
    }

    if (msg.type === 'progress') {
      useWhisperState.setState((prev) => ({
        stage: msg.stage,
        progress: msg.progress !== undefined ? msg.progress : prev.progress,
      }))
      return
    }

    const job = pendingJobs.get(msg.jobId)
    if (!job) return
    pendingJobs.delete(msg.jobId)
    if (msg.type === 'done') job.resolve(msg.chunks)
    else job.reject(new Error(msg.error || 'Ошибка Whisper AI'))
  })

  if (!progressListening && isTauri()) {
    progressListening = true
    void listen<{ loaded: number; total: number }>('whisper:progress', (e) => {
      if (!useWhisperState.getState().busy) return
      const { loaded, total } = e.payload
      if (total > 0) {
        const pct = Math.min(99, Math.round((loaded / total) * 100))
        useWhisperState.setState({
          stage: `Загружаем модель (${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ)…`,
          progress: pct,
        })
      }
    }).catch(() => {
      progressListening = false
    })
  }

  return w
}

export async function preloadWhisperModel(modelSize?: WhisperModelSize): Promise<void> {
  if (useWhisperState.getState().busy) return
  const model = modelSize ?? useSettings.getState().lyrics.whisperModel
  useWhisperState.setState({ busy: true, activeTrackKey: null, stage: 'Подключаем модель Whisper…', progress: 0, error: null })
  try {
    const w = ensureWorker()
    const jobId = jobSeq++
    await new Promise<WhisperWordChunk[]>((resolve, reject) => {
      pendingJobs.set(jobId, { resolve, reject })
      w.postMessage({ type: 'preload', jobId, model })
    })
    await useWhisperState.getState().refreshDiskStatus()
    useWhisperState.setState({ busy: false, stage: 'Модель готова к работе', progress: 100 })
  } catch (e) {
    useWhisperState.setState({ busy: false, stage: '', progress: null, error: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    scheduleIdleTerminate()
  }
}

function guessLanguage(track: Track, existing?: Lyrics | null): 'auto' | 'ru' | 'en' {
  const sample = `${track.artist} ${track.title} ${existing?.lines.slice(0, 3).map((l) => l.text).join(' ') ?? ''}`
  if (/[а-яё]/i.test(sample)) return 'ru'
  return 'auto'
}

export async function runWhisperForTrack(track: Track, existingLyrics?: Lyrics | null): Promise<Lyrics | null> {
  if (useWhisperState.getState().busy) return null
  const model = useSettings.getState().lyrics.whisperModel
  useWhisperState.setState({ busy: true, activeTrackKey: track.key, stage: 'Читаем аудио…', progress: null, error: null })

  try {
    const pcm = await extractTrackPcm16k(track, (stage) => useWhisperState.setState({ stage }))
    const w = ensureWorker()
    const jobId = jobSeq++
    useWhisperState.setState({ stage: 'Анализируем вокал (Whisper AI)…', progress: null })

    const chunks = await new Promise<WhisperWordChunk[]>((resolve, reject) => {
      pendingJobs.set(jobId, { resolve, reject })
      w.postMessage({ type: 'transcribe', jobId, model, language: guessLanguage(track, existingLyrics), audio: pcm }, [pcm.buffer])
    })

    await useWhisperState.getState().refreshDiskStatus()

    let finalLyrics: Lyrics | null = null
    if (existingLyrics?.lines.length) {
      const aligned = alignWhisperToLines(existingLyrics.lines, chunks)
      finalLyrics = {
        synced: true,
        source: 'ai',
        lines: aligned,
        credits: existingLyrics.credits
          ? `${existingLyrics.credits.replace(/\s*· тайминг Whisper AI$/, '')} · тайминг Whisper AI`
          : 'Тайминг: Whisper AI (локально)',
      }
    } else {
      finalLyrics = whisperWordsToLyrics(chunks)
    }

    if (!finalLyrics?.lines.length) {
      throw new Error('Нейросеть не распознала вокал в этом треке.')
    }

    writeCachedLyrics(track.key, finalLyrics)
    queryClient.setQueryData(['lyrics', track.key], finalLyrics)
    useWhisperState.setState({ busy: false, activeTrackKey: null, stage: '', progress: null, error: null })
    return finalLyrics
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    useWhisperState.setState({ busy: false, activeTrackKey: null, stage: '', progress: null, error: msg })
    return null
  } finally {
    scheduleIdleTerminate()
  }
}

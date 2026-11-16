import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import type { WhisperModelSize } from '../lib/settings'
import type { WhisperWordChunk } from './align'

interface WorkerGlobalLike {
  location: Location
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
}

const workerGlobal = globalThis as unknown as WorkerGlobalLike

interface NetReply {
  ok: boolean
  status: number
  isProbe?: boolean
  bytes?: ArrayBuffer
  contentLength?: number
  contentType?: string
  contentRange?: string
  error?: string
}

const pendingNet = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>()
let nextNetId = 1

function isLocalAssetUrl(url: string): boolean {
  if (url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:')) return true
  try {
    return new URL(url, workerGlobal.location.origin).origin === workerGlobal.location.origin
  } catch {
    return false
  }
}

function bridgedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (isLocalAssetUrl(url)) {
    return fetch(input, init)
  }

  const hdrs = new Headers(init?.headers)
  const isProbe = (init?.method ?? 'GET').toUpperCase() === 'HEAD' || hdrs.has('Range')
  const id = nextNetId++

  return new Promise<Response>((resolve, reject) => {
    pendingNet.set(id, { resolve, reject })
    workerGlobal.postMessage({ type: 'net-fetch', id, url, isProbe })
  })
}

let envConfigured = false
function ensureEnvConfigured() {
  if (envConfigured) return
  envConfigured = true

  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.useBrowserCache = false
  env.useWasmCache = true
  env.fetch = bridgedFetch as typeof env.fetch

  const onnx = env.backends.onnx as {
    versions?: { web?: string }
    wasm?: { numThreads?: number; proxy?: boolean; wasmPaths?: { mjs?: string; wasm?: string } | string }
  }
  if (onnx?.wasm) {
    onnx.wasm.numThreads = 1
    onnx.wasm.proxy = false
    const ver = onnx.versions?.web || '1.31.0-dev.20260914-8d85527a0'
    onnx.wasm.wasmPaths = {
      mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', workerGlobal.location.origin).href,
      wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
    }
  }
}

let cachedModelId = ''
let pipePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

async function getPipeline(modelSize: WhisperModelSize, jobId: number): Promise<AutomaticSpeechRecognitionPipeline> {
  ensureEnvConfigured()
  const modelId = modelSize === 'base' ? 'onnx-community/whisper-base' : 'onnx-community/whisper-tiny'
  if (pipePromise && cachedModelId === modelId) return pipePromise

  cachedModelId = modelId
  pipePromise = pipeline('automatic-speech-recognition', modelId, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
      workerGlobal.postMessage({
        type: 'progress',
        jobId,
        stage: info?.status === 'ready' ? 'Модель готова' : info?.file ? `Загрузка ${info.file}` : 'Инициализация Whisper AI…',
        progress: typeof info?.progress === 'number' ? Math.round(info.progress) : undefined,
      })
    },
  }).catch((err: unknown) => {
    pipePromise = null
    cachedModelId = ''
    throw err
  })

  return pipePromise
}

function normalizeChunks(raw: unknown): WhisperWordChunk[] {
  const obj = raw as { chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }> } | null
  const rawChunks = Array.isArray(obj?.chunks) ? obj!.chunks! : []
  const words: WhisperWordChunk[] = []

  for (const ch of rawChunks) {
    const text = typeof ch?.text === 'string' ? ch.text.trim() : ''
    if (!text) continue
    const t0 = typeof ch.timestamp?.[0] === 'number' && Number.isFinite(ch.timestamp[0]) ? ch.timestamp[0] : 0
    const t1 = typeof ch.timestamp?.[1] === 'number' && Number.isFinite(ch.timestamp[1]) ? ch.timestamp[1] : t0 + 0.45
    const bMs = Math.max(0, Math.round(t0 * 1000))
    const eMs = Math.max(bMs + 80, Math.round(t1 * 1000))

    const tokens = text.split(/\s+/).filter(Boolean)
    if (tokens.length === 1) {
      words.push({ text: tokens[0], beginMs: bMs, endMs: eMs })
      continue
    }

    const totalLen = tokens.reduce((s, t) => s + t.length, 0) || tokens.length
    let cursor = bMs
    const span = eMs - bMs
    for (let i = 0; i < tokens.length; i++) {
      const slice = i === tokens.length - 1 ? eMs - cursor : Math.max(40, Math.round((span * tokens[i].length) / totalLen))
      words.push({ text: tokens[i], beginMs: cursor, endMs: cursor + slice })
      cursor += slice
    }
  }

  return words
}

workerGlobal.addEventListener('message', async (ev: MessageEvent) => {
  const msg = ev.data as
    | { type: 'net-reply'; id: number; reply: NetReply }
    | { type: 'preload'; jobId: number; model: WhisperModelSize }
    | { type: 'transcribe'; jobId: number; model: WhisperModelSize; language: 'auto' | 'ru' | 'en'; audio: Float32Array }

  if (msg.type === 'net-reply') {
    const pending = pendingNet.get(msg.id)
    if (!pending) return
    pendingNet.delete(msg.id)
    const r = msg.reply
    if (!r.ok) {
      if (r.status === 404) {
        pending.resolve(new Response(null, { status: 404, statusText: 'Not Found' }))
      } else {
        pending.reject(new Error(r.error || `HTTP ${r.status}`))
      }
      return
    }
    const headers = new Headers()
    if (r.contentType) headers.set('content-type', r.contentType)
    if (r.contentLength !== undefined) headers.set('content-length', String(r.contentLength))
    if (r.contentRange) headers.set('content-range', r.contentRange)
    if (r.isProbe) {
      pending.resolve(new Response(new Uint8Array(r.status === 206 ? [0] : []), { status: r.status || 200, headers }))
    } else {
      pending.resolve(new Response(r.bytes ?? new ArrayBuffer(0), { status: r.status || 200, headers }))
    }
    return
  }

  if (msg.type === 'preload') {
    try {
      await getPipeline(msg.model, msg.jobId)
      workerGlobal.postMessage({ type: 'done', jobId: msg.jobId, chunks: [] })
    } catch (e) {
      workerGlobal.postMessage({ type: 'error', jobId: msg.jobId, error: String(e) })
    }
    return
  }

  if (msg.type === 'transcribe') {
    try {
      const pipe = await getPipeline(msg.model, msg.jobId)
      workerGlobal.postMessage({ type: 'progress', jobId: msg.jobId, stage: 'Распознаём речь в аудио…' })
      const opts = {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(msg.language !== 'auto' ? { language: msg.language } : {}),
      }
      let result: unknown
      try {
        result = await pipe(msg.audio, { ...opts, return_timestamps: 'word' })
      } catch {
        result = await pipe(msg.audio, { ...opts, return_timestamps: true })
      }
      const chunks = normalizeChunks(result)
      workerGlobal.postMessage({ type: 'done', jobId: msg.jobId, chunks })
    } catch (e) {
      workerGlobal.postMessage({ type: 'error', jobId: msg.jobId, error: String(e) })
    }
  }
})

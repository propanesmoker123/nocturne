import { LoadStats, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js'
import { invoke } from '../lib/tauri'
import { getPreloadedResource } from './preload'

/** hls.js loader that fetches playlists, segments and AES keys through the Rust proxy
 *  (no CORS, vk.ru headers). One instance per request, as hls.js expects. */
export class TauriLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null
  stats = new LoadStats()
  private abortRequest: (() => void) | null = null

  constructor(_config: unknown) {}

  destroy() {
    this.abort()
    this.context = null
  }

  abort() {
    this.abortRequest?.()
  }

  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.abort()
    this.context = context
    const stats = (this.stats = new LoadStats())
    stats.loading.start = performance.now()
    const limit = config.loadPolicy?.maxLoadTimeMs || config.timeout || 20000
    const finish = () => {
      if (this.abortRequest !== abort) return false
      this.abortRequest = null
      clearTimeout(timer)
      return true
    }
    const abort = () => {
      if (!finish()) return
      stats.aborted = true
      callbacks.onAbort?.(stats, context, null)
    }
    const timer = setTimeout(() => {
      if (finish()) callbacks.onTimeout(stats, context, null)
    }, limit)
    this.abortRequest = abort

    const range = context.rangeEnd ? [context.rangeStart ?? 0, context.rangeEnd] : undefined
    const pre = range ? null : getPreloadedResource(context.url)
    const fetchBytes = () => invoke<ArrayBuffer>('proxy_fetch', { url: context.url, ...(range ? { range } : {}) })
    const req = pre
      ? Promise.resolve(pre)
          .then((buf) => (buf && buf.byteLength > 0 ? buf : this.abortRequest === abort ? fetchBytes() : null))
          .catch(() => (this.abortRequest === abort ? fetchBytes() : null))
      : fetchBytes()
    req
      .then((buf) => {
        if (!buf || !finish()) return
        const now = performance.now()
        stats.loading.first = Math.max(stats.loading.start, now - 1)
        stats.loading.end = now
        stats.loaded = stats.total = buf.byteLength
        const data = context.responseType === 'arraybuffer' ? buf : new TextDecoder().decode(buf)
        callbacks.onSuccess({ url: context.url, data, code: range ? 206 : 200 }, stats, context, null)
      }, (e: unknown) => {
        if (!finish()) return
        const text = String(e)
        const code = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? 0)
        callbacks.onError({ code, text }, context, null, stats)
      })
  }
}

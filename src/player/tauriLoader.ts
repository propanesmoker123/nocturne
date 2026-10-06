import { LoadStats, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js'
import { invoke } from '../lib/tauri'

/** hls.js loader that fetches playlists, segments and AES keys through the Rust proxy
 *  (no CORS, vk.ru headers). One instance per request, as hls.js expects. */
export class TauriLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null
  stats = new LoadStats()
  private done = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(_config: unknown) {}

  destroy() {
    this.abort()
    this.context = null
  }

  abort() {
    if (this.done) return
    this.done = true
    this.stats.aborted = true
    clearTimeout(this.timer)
  }

  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.context = context
    this.done = false
    const stats = (this.stats = new LoadStats())
    stats.loading.start = performance.now()
    const limit = config.loadPolicy?.maxLoadTimeMs || config.timeout || 20000
    this.timer = setTimeout(() => {
      if (this.done) return
      this.done = true
      callbacks.onTimeout(stats, context, null)
    }, limit)

    invoke<ArrayBuffer>('proxy_fetch', { url: context.url })
      .then((buf) => {
        if (this.done) return
        this.done = true
        clearTimeout(this.timer)
        const now = performance.now()
        stats.loading.first = Math.max(stats.loading.start, now - 1)
        stats.loading.end = now
        stats.loaded = stats.total = buf.byteLength
        const data = context.responseType === 'arraybuffer' ? buf : new TextDecoder().decode(buf)
        callbacks.onSuccess({ url: context.url, data, code: 200 }, stats, context, null)
      })
      .catch((e: unknown) => {
        if (this.done) return
        this.done = true
        clearTimeout(this.timer)
        const text = String(e)
        const code = Number(/HTTP (\d{3})/.exec(text)?.[1] ?? 0)
        callbacks.onError({ code, text }, context, null, stats)
      })
  }
}

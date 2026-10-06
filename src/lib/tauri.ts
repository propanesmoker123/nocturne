import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event'

/** True inside the Tauri webview, false in a plain browser (mock/dev mode). */
export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

export async function listen<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  const ev = await import('@tauri-apps/api/event')
  return ev.listen<T>(event, cb)
}

export async function emitTo(target: string, event: string, payload?: unknown): Promise<void> {
  if (!isTauri()) return
  const ev = await import('@tauri-apps/api/event')
  await ev.emitTo(target, event, payload)
}

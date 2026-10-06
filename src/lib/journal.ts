import { invoke, isTauri } from './tauri'

/**
 * Adds a line to the troubleshooting journal (Rust keeps it, rotated, ~10 MB max).
 * Never pass tokens, URLs with queries, track titles or anything else personal.
 */
export function journal(area: string, message: string) {
  if (isTauri()) void invoke('journal_write', { area, message }).catch(() => {})
}

/** The newest part of the journal, ready to paste into a message. */
export async function journalTail(): Promise<string> {
  return isTauri() ? invoke<string>('journal_tail') : ''
}

export async function openJournalFolder(): Promise<void> {
  if (isTauri()) await invoke('journal_open_dir')
}

/** Copies the journal to the clipboard; returns false when there is nothing to copy. */
export async function copyJournal(): Promise<boolean> {
  const text = await journalTail()
  if (!text.trim()) return false
  await navigator.clipboard.writeText(text)
  return true
}

/** Uncaught errors are the first thing to look at when something "just stops working". */
export function journalUncaughtErrors() {
  window.addEventListener('error', (e) => journal('ui', `uncaught: ${e.message} at ${e.filename?.split('/').pop() ?? '?'}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => journal('ui', `unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason)}`))
}

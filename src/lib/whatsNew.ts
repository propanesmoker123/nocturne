import { loadJSON, saveJSON } from './persist'

/**
 * «Что нового»: the notes of the version being installed are kept, and shown once when that
 * version starts — a short summary with every update.
 */

interface Kept {
  version: string
  notes: string
}

const NAME = 'whats-new'

/** Before installing `version`: keep its notes for the first start after. */
export async function rememberWhatsNew(version: string, notes: string | undefined) {
  await saveJSON(NAME, notes?.trim() ? ({ version, notes: notes.trim() } satisfies Kept) : null)
}

/** The kept notes if `current` is the version they belong to — once; then they are forgotten. */
export async function takeWhatsNew(current: string): Promise<Kept | null> {
  const kept = await loadJSON<Partial<Kept>>(NAME)
  if (!kept || typeof kept.version !== 'string' || typeof kept.notes !== 'string') return null
  if (kept.version !== current) return null
  await saveJSON(NAME, null)
  return { version: kept.version, notes: kept.notes }
}

/** Release notes as a list: one point per clause or sentence, without the «Исправления:» lead-in. */
export function splitNotes(notes: string): string[] {
  const body = notes.trim().replace(/^[А-ЯЁA-Z][а-яёa-z]+:\s+/, '')
  return body
    .split(/;\s+|\.\s+(?=[А-ЯЁA-Z«"])/)
    .map((p) => p.trim().replace(/[.;]+$/, ''))
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
}

import { create } from 'zustand'
import { DEFAULT_HOTKEYS, type HotkeyAction, type HotkeyMap } from './hotkeys'
import { debouncedSaver, loadJSON } from './persist'

export const WALLPAPER_PRESETS = ['aurora', 'dusk', 'ocean', 'ember'] as const
export type WallpaperPreset = (typeof WALLPAPER_PRESETS)[number]

export type WallpaperConfig =
  | { kind: 'dynamic' }
  | { kind: 'preset'; preset: WallpaperPreset }
  | { kind: 'image' | 'video'; src: string }
  | { kind: 'none' }

export interface IslandSettings {
  enabled: boolean
  expandOn: 'hover' | 'click'
  /** 'always': whenever something is loaded; 'background': only while the main window is hidden or unfocused */
  visibility: 'always' | 'background'
  showOnTrackChange: boolean
  hideInFullscreen: boolean
  /** Monitor name, or null for the primary monitor. */
  monitor: string | null
  /** Window top-left in physical screen px when the user dragged it; null = top centre. */
  position: { x: number; y: number } | null
  /** Pinned in place: dragging is disabled. */
  locked: boolean
  /** 0 = solid black, up to ISLAND_MAX_TRANSPARENCY = mostly see-through. */
  transparency: number
}

export const ISLAND_MAX_TRANSPARENCY = 0.7

export interface Settings {
  wallpaper: WallpaperConfig
  wallpaperBlur: number
  wallpaperDim: number
  /** 'auto' (from artwork) or a hex color */
  accent: string
  island: IslandSettings
  hotkeys: HotkeyMap
  hotkeysEnabled: boolean
  closeToTray: boolean
  broadcastStatus: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  wallpaper: { kind: 'dynamic' },
  wallpaperBlur: 0,
  wallpaperDim: 0.55,
  accent: 'auto',
  island: { enabled: true, expandOn: 'hover', visibility: 'always', showOnTrackChange: true, hideInFullscreen: true, monitor: null, position: null, locked: false, transparency: 0 },
  hotkeys: DEFAULT_HOTKEYS,
  hotkeysEnabled: true,
  closeToTray: true,
  broadcastStatus: false,
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d)
const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T => (options.includes(v as T) ? (v as T) : d)

function wallpaper(v: unknown): WallpaperConfig {
  if (!isObj(v)) return DEFAULT_SETTINGS.wallpaper
  switch (v.kind) {
    case 'dynamic':
    case 'none':
      return { kind: v.kind }
    case 'preset':
      return WALLPAPER_PRESETS.includes(v.preset as WallpaperPreset) ? { kind: 'preset', preset: v.preset as WallpaperPreset } : DEFAULT_SETTINGS.wallpaper
    case 'image':
    case 'video':
      return typeof v.src === 'string' && v.src ? { kind: v.kind, src: v.src } : DEFAULT_SETTINGS.wallpaper
    default:
      return DEFAULT_SETTINGS.wallpaper
  }
}

/** Validates a persisted settings document against the current schema. */
export function mergeSettings(saved: unknown): Settings {
  const d = DEFAULT_SETTINGS
  if (!isObj(saved)) return d
  const hk = isObj(saved.hotkeys) ? saved.hotkeys : {}
  const hotkeys = { ...d.hotkeys }
  for (const action of Object.keys(d.hotkeys) as HotkeyAction[]) {
    if (typeof hk[action] === 'string') hotkeys[action] = hk[action] as string
  }
  const isl = isObj(saved.island) ? saved.island : {}
  return {
    wallpaper: wallpaper(saved.wallpaper),
    wallpaperBlur: num(saved.wallpaperBlur, d.wallpaperBlur, 0, 60),
    wallpaperDim: num(saved.wallpaperDim, d.wallpaperDim, 0, 0.9),
    accent: typeof saved.accent === 'string' && /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : 'auto',
    island: {
      enabled: bool(isl.enabled, d.island.enabled),
      expandOn: oneOf(isl.expandOn, ['hover', 'click'] as const, d.island.expandOn),
      visibility: oneOf(isl.visibility, ['always', 'background'] as const, d.island.visibility),
      showOnTrackChange: bool(isl.showOnTrackChange, d.island.showOnTrackChange),
      hideInFullscreen: bool(isl.hideInFullscreen, d.island.hideInFullscreen),
      monitor: typeof isl.monitor === 'string' && isl.monitor ? isl.monitor : null,
      position:
        isObj(isl.position) && Number.isFinite(isl.position.x) && Number.isFinite(isl.position.y)
          ? { x: Math.round(isl.position.x as number), y: Math.round(isl.position.y as number) }
          : null,
      locked: bool(isl.locked, d.island.locked),
      transparency: num(isl.transparency, d.island.transparency, 0, ISLAND_MAX_TRANSPARENCY),
    },
    hotkeys,
    hotkeysEnabled: bool(saved.hotkeysEnabled, d.hotkeysEnabled),
    closeToTray: bool(saved.closeToTray, d.closeToTray),
    broadcastStatus: bool(saved.broadcastStatus, d.broadcastStatus),
  }
}

interface SettingsState extends Settings {
  loaded: boolean
  update(patch: Partial<Settings>): void
  updateIsland(patch: Partial<IslandSettings>): void
}

const saver = debouncedSaver('settings', 400)

const pick = (s: SettingsState): Settings => ({
  wallpaper: s.wallpaper,
  wallpaperBlur: s.wallpaperBlur,
  wallpaperDim: s.wallpaperDim,
  accent: s.accent,
  island: s.island,
  hotkeys: s.hotkeys,
  hotkeysEnabled: s.hotkeysEnabled,
  closeToTray: s.closeToTray,
  broadcastStatus: s.broadcastStatus,
})

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  update(patch) {
    set(patch)
    saver.save(pick(get()))
  },
  updateIsland(patch) {
    set({ island: { ...get().island, ...patch } })
    saver.save(pick(get()))
  },
}))

export function currentSettings(): Settings {
  return pick(useSettings.getState())
}

export async function initSettings() {
  const saved = await loadJSON<unknown>('settings')
  useSettings.setState({ ...mergeSettings(saved), loaded: true })
}

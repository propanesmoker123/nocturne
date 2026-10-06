import { convertFileSrc } from '@tauri-apps/api/core'
import type { WallpaperConfig } from './settings'
import { invoke, isTauri } from './tauri'

const VIDEO = /\.(mp4|webm|mov|m4v)$/i
export const WALLPAPER_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'avif']

/** Browser demo keeps picked files in memory only. */
const demoSaved: string[] = []
const demoVideo = new Set<string>()

export const wallpaperKind = (src: string): 'video' | 'image' => (VIDEO.test(src) || demoVideo.has(src) ? 'video' : 'image')

/** Imported wallpapers, newest first (they stay until the user deletes them). */
export async function listWallpapers(): Promise<string[]> {
  return isTauri() ? invoke<string[]>('list_wallpapers') : [...demoSaved]
}

export async function deleteWallpaper(src: string): Promise<void> {
  if (isTauri()) {
    await invoke('delete_wallpaper', { path: src })
    return
  }
  const i = demoSaved.indexOf(src)
  if (i >= 0) demoSaved.splice(i, 1)
}

/** Lets the user choose an image or video; Tauri copies it into the app's wallpaper folder. */
export async function pickWallpaper(): Promise<WallpaperConfig | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Картинки и видео', extensions: WALLPAPER_EXTENSIONS }] })
    if (!path || Array.isArray(path)) return null
    const stored = await invoke<string>('import_wallpaper', { path })
    return { kind: VIDEO.test(stored) ? 'video' : 'image', src: stored }
  }
  // Browser demo: an object URL that lives until reload.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = WALLPAPER_EXTENSIONS.map((e) => `.${e}`).join(',')
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      const src = URL.createObjectURL(f)
      demoSaved.unshift(src)
      if (VIDEO.test(f.name)) demoVideo.add(src)
      resolve({ kind: VIDEO.test(f.name) ? 'video' : 'image', src })
    }
    input.click()
  })
}

/** Filesystem path → URL the webview can load (asset protocol). */
export function wallpaperUrl(src: string): string {
  if (src.startsWith('blob:') || src.startsWith('http') || src.startsWith('data:')) return src
  return isTauri() ? convertFileSrc(src) : src
}

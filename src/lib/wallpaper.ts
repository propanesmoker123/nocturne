import { convertFileSrc } from '@tauri-apps/api/core'
import type { WallpaperConfig } from './settings'
import { invoke, isTauri } from './tauri'

const VIDEO = /\.(mp4|webm|mov|m4v)$/i
export const WALLPAPER_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'avif']

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
      resolve({ kind: VIDEO.test(f.name) ? 'video' : 'image', src: URL.createObjectURL(f) })
    }
    input.click()
  })
}

/** Filesystem path → URL the webview can load (asset protocol). */
export function wallpaperUrl(src: string): string {
  if (src.startsWith('blob:') || src.startsWith('http') || src.startsWith('data:')) return src
  return isTauri() ? convertFileSrc(src) : src
}

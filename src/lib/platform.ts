/** Which shell the interface runs in. The Android build says so at compile time; the browser
 *  demo shows the phone layout with `#android` in the address. */
export function platformOf(env: string | undefined, hash: string): 'android' | 'desktop' {
  if (env === 'android') return 'android'
  return /(^#|&)android(&|$)/.test(hash) ? 'android' : 'desktop'
}

export const isAndroid = platformOf(import.meta.env.TAURI_ENV_PLATFORM, typeof location === 'undefined' ? '' : location.hash) === 'android'

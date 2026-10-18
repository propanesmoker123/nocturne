import { isTauri } from '../lib/tauri'

/** Opens a SoundCloud page in the browser; anything that is not soundcloud.com is ignored. */
export async function openInSoundCloud(url: string | null | undefined): Promise<void> {
  if (!url || !/^https:\/\/(?:[a-z0-9-]+\.)*soundcloud\.com\//i.test(url)) return
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

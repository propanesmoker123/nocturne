import './styles/global.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { applyDemoHash } from './app/demo'
import { toggleLibrary } from './app/library'
import { queryClient } from './app/queryClient'
import { initSession, useSession } from './app/session'
import { askCaptcha, useSheet } from './app/sheetStore'
import { installShortcuts } from './app/shortcuts'
import { startSystemSync } from './app/systemSync'
import { toast } from './app/toast'
import { startConnect } from './connect/runtime'
import { startGlobalHotkeys } from './lib/globalHotkeys'
import { journalUncaughtErrors } from './lib/journal'
import { startServerTimeSync } from './lib/serverTime'
import { startUpdateChecks } from './lib/updates'
import { takeWhatsNew } from './lib/whatsNew'
import { initSettings, useSettings } from './lib/settings'
import { invoke, isTauri } from './lib/tauri'
import { startBridges } from './player/bridges'
import { openQuickSearch, startQuickSearch } from './quicksearch/bridge'
import { initPlayer, usePlayer } from './player/store'
import { setCaptchaHandler } from './vk/api'

async function showMainWindow(toggle = false) {
  if (!isTauri()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  if (toggle && (await w.isVisible()) && (await w.isFocused())) {
    await w.hide()
    return
  }
  await w.unminimize()
  await w.show()
  await w.setFocus()
}

/** The first start after an update: «Что нового» once, from the notes kept before installing. */
async function showWhatsNew() {
  if (!isTauri()) return
  const { getVersion } = await import('@tauri-apps/api/app')
  const kept = await takeWhatsNew(await getVersion())
  if (kept) useSheet.getState().open({ kind: 'notes', title: `Что нового в ${kept.version}`, notes: kept.notes })
}

async function boot() {
  journalUncaughtErrors()
  setCaptchaHandler((e) => (e.captchaImg ? askCaptcha(e.captchaImg) : Promise.resolve(null)))
  installShortcuts()
  await initSettings()
  if (isTauri()) void invoke('set_user_agent', { ua: navigator.userAgent }).catch(() => {})

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )

  await initSession()
  void showWhatsNew().catch(() => {})
  await initPlayer()
  startServerTimeSync()
  void startConnect()
  void applyDemoHash()
  const actions = { toggleLike: () => void toggleLibrary(usePlayer.getState().current), showWindow: () => void showMainWindow() }
  startBridges(actions)
  startQuickSearch()
  startSystemSync()
  startUpdateChecks()
  startGlobalHotkeys({
    playPause: () => usePlayer.getState().toggle(),
    next: () => usePlayer.getState().next(true),
    prev: () => usePlayer.getState().prev(),
    volUp: () => usePlayer.getState().nudgeVolume(0.05),
    volDown: () => usePlayer.getState().nudgeVolume(-0.05),
    toggleLike: actions.toggleLike,
    seekFwd: () => usePlayer.getState().seekBy(10),
    seekBack: () => usePlayer.getState().seekBy(-10),
    shuffle: () => usePlayer.getState().toggleShuffle(),
    repeat: () => usePlayer.getState().cycleRepeat(),
    toggleIsland: () => {
      const enabled = !useSettings.getState().island.enabled
      useSettings.getState().updateIsland({ enabled })
      toast(enabled ? 'Остров включён' : 'Остров скрыт', 'info')
    },
    toggleWindow: () => void showMainWindow(true),
    // Signed out there is nothing to search: bring up the sign-in screen instead
    quickSearch: () => (useSession.getState().phase === 'ready' ? openQuickSearch() : void showMainWindow()),
  })
}

void boot()

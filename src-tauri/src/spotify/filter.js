// Nocturne's Spotify web-session bridge and bounded ad filter.
// Runs only on https://open.spotify.com inside Nocturne's hidden WebView2.
(() => {
  'use strict';
  if (window.location.origin !== 'https://open.spotify.com' || window.__nocturneSpotifyLab) return;
  try {
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
  } catch {}
  const counters = {
    enabled: true,
    removed: 0,
    intercepted: 0,
    unsupported: 0,
    startPending: false,
    lastPlayMethod: '',
    lastPlayError: '',
    lastPlaybackError: '',
    capped: false,
    expectedTrackId: '',
    actualTrackId: '',
    lastShuffle: null,
    disallowNext: false,
    trackEnded: false,
    endedTrackId: '',
    preloaded: 0,
    preloadHits: 0,
  };
  let lastHarmonyTrackUri = '';
  let lastHarmonyPosMs = 0;
  let lastHarmonyDurMs = 0;
  let lastHarmonyWasPlaying = false;
  let bleedTrackId = '';
  let bleedPauseSent = false;
  let seamlessAdoptedTrackId = '';
  let unwantedBleedMuted = false;
  let unwantedBleedTimer = 0;
  let switchMuteUntilTarget = false;
  let switchMuteTimer = 0;
  let startAutoResumeUsed = false;
  let sawDesiredActive = false;
  let desiredActivePosMs = 0;
  let desiredActiveDurMs = 0;
  let desiredActivePlayingSince = 0;
  const ignoredEndedMedia = typeof WeakSet === 'function' ? new WeakSet() : null;
  let hardPaused = false;
  let lastHardPauseEnforceAt = 0;
  let lastTrackStartAt = 0;
  let lastTrackStartSec = 0;
  let switchFromTrackId = '';
  let switchFromPosSec = 0;
  let lastAdSeekTrackUri = '';
  let wasHarmonyAd = false;
  let adMutedActive = false;
  const PRELOAD_AUDIO_RANGE_END = 512 * 1024 - 1;
  const PRELOAD_MAX_BYTES = 576 * 1024;
  const PRELOAD_TTL_MS = 90_000;
  const B62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let preloadedNextTrackId = '';
  let preloadGen = 0;
  let preloadState = null;
  let observedSpclientOrigin = 'https://spclient.wg.spotify.com';
  let observedResolveTemplate = '';
  let observedAudioFormat = '';
  const observedFileFormats = new Map();
  function ad(value) {
    return typeof value === 'string' && (value.startsWith('spotify:ad:') || value.includes(':ad:'));
  }
  function song(value) {
    return typeof value === 'string' && /^spotify:(?:track|episode):/.test(value);
  }
  function isAdTrack(track) {
    if (!track || typeof track !== 'object') return false;
    const u = track.uri || track.metadata?.uri || '';
    if (ad(u)) return true;
    return track.type === 'ad' || track.content_type === 'AD' || track.metadata?.is_advertisement === true;
  }
  function callHarmonyPause() {
    try {
      const target = typeof spotifyPlayerApi?.pause === 'function' ? spotifyPlayerApi : (harmonyPlayer || harmonyController);
      if (typeof target?.pause === 'function') void Promise.resolve(target.pause()).catch(() => {});
    } catch {}
  }
  function callHarmonyResume() {
    try {
      const target = typeof spotifyPlayerApi?.resume === 'function' ? spotifyPlayerApi : (harmonyPlayer || harmonyController);
      if (typeof target?.resume === 'function') void Promise.resolve(target.resume()).catch(() => {});
    } catch {}
  }
  function enforceHardPause(includeApi = true) {
    for (const el of elements()) {
      if (!getNativeMuted(el)) setNativeMuted(el, true);
      if (getNativeVol(el) !== 0) setNativeVol(el, 0);
      try { if (!el.paused && typeof el.pause === 'function') el.pause(); } catch {}
    }
    if (!includeApi) return;
    const now = Date.now();
    if (now - lastHardPauseEnforceAt < 450) return;
    lastHardPauseEnforceAt = now;
    callHarmonyPause();
  }
  const diagnostics = [];
  let lastDiag = '';
  function pushDiag(msg) {
    if (typeof msg !== 'string') return;
    const clean = msg.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 180);
    if (!clean || clean === lastDiag) return;
    lastDiag = clean;
    diagnostics.push(clean);
    if (diagnostics.length > 24) diagnostics.shift();
  }
  const auth = {
    token: '',
    tokenExpiresAt: 0,
    clientToken: '',
    clientTokenExpiresAt: 0,
    clientId: 'd8a5ed958d274c2e8ee717e6a4b0971d',
    clientVersion: '',
    market: '',
    deviceId: '',
    appVersion: '896000000',
    appPlatform: 'WebPlayer',
    acceptLanguage: 'ru',
    homeVars: null,
  };
  const hashes = {
    profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
    fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
    libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
    fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
    getAlbum: '0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f',
    queryArtistOverview: 'eafb1620d783ece118e72fbfede2b0064483e029d3c1aafafa1c2de0e25a89e7',
    queryArtistRelated: '3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3',
    searchDesktop: 'eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03',
    home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
    browseAll: 'dbd8b55e09a58afc52eab438bc228ba28fd72ac2f2148c6c26354980e4579001',
    browsePage: 'f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b',
    browseSection: 'b13c1cccbfcb6947753c2613411b3566485c21fd5f36d80a80bb64be61ba2d51',
    recents: '94be830be40f0f3759ef83a4ea6e4dd1bef1f6108f7502c11ee1fa7fb1bb1658',
    fetchEntitiesForRecentlyPlayed: 'cf5d2e94ffd82788470788ae1f6090cc3e9e774fb8fd383580634c6e6f50f7be',
    decorateContextTracks: '383de00240775c39a6afe0b1055dc562b2a3930894201f9762f3fc32a74971c7',
    editablePlaylists: 'd5c4b8096437dcc2ac9528c91dfcd299e35b747cda2f8f75d28f41f49c5092ba',
    addToPlaylist: 'b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a',
    removeFromPlaylist: 'b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a',
    areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
    addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    getTrack: 'e7b1bf4e95cb3d733d48b442f93006e9712fd504e8b88d7a82e6e3bac9306a6b',
    trackPreview: 'fc26ffc7a1a4f93bd4c2d705649f7dba1de34005b3dc2915549847a9959405d8',
    internalLinkRecommenderTrack: '642923b2e705fceb9984697c1620fecd42615fd8b116b8a9faf2786b389d3e4a',
    similarAlbumsBasedOnThisTrack: '1d1f93a737498adca2c892c73af87fc0b052afe4e1a33c989540c32413dfae17',
  };
  const pfCache = Object.create(null);
  const pfCacheOrder = [];
  const pfTtl = new Map();
  const pfInFlight = new Map();
  const MAX_PF_CACHE = 192;
  const CACHEABLE_PF = new Set(['profileAttributes', 'libraryV3', 'home', 'fetchLibraryTracks', 'browseAll', 'browsePage', 'browseSection', 'recents', 'editablePlaylists', 'getTrack']);
  function setPfTtl(k, entry) {
    if (!k) return;
    if (pfTtl.has(k)) pfTtl.delete(k);
    else if (pfTtl.size >= MAX_PF_CACHE) {
      const oldest = pfTtl.keys().next().value;
      if (oldest !== undefined) pfTtl.delete(oldest);
    }
    pfTtl.set(k, entry);
  }
  function setPfCache(k, val) {
    if (!k) return;
    if (!(k in pfCache)) {
      pfCacheOrder.push(k);
      while (pfCacheOrder.length > MAX_PF_CACHE) {
        const oldKey = pfCacheOrder.shift();
        if (oldKey) delete pfCache[oldKey];
      }
    }
    pfCache[k] = val;
  }
  let rateLimitedUntil = 0;
  let lastAdSkipAt = 0;
  let pfActiveCount = 0;
  const pfWaitQueue = [];
  function acquirePfSlot() {
    if (pfActiveCount < 5) {
      pfActiveCount++;
      return Promise.resolve();
    }
    return new Promise(resolve => pfWaitQueue.push(resolve));
  }
  function releasePfSlot() {
    const next = pfWaitQueue.shift();
    if (next) {
      setTimeout(next, 10);
    } else {
      pfActiveCount = Math.max(0, pfActiveCount - 1);
    }
  }
  function pfCacheKey(op, vars) {
    if (op === 'libraryV3') {
      const f = Array.isArray(vars?.filters) && vars.filters.length ? vars.filters.join(',') : 'all';
      const off = Number(vars?.offset) || 0;
      const lim = Number(vars?.limit) || 50;
      return `libraryV3:${f}:${off}:${lim}`;
    }
    if (op === 'fetchLibraryTracks') {
      const off = Number(vars?.offset) || 0;
      const lim = Number(vars?.limit) || 50;
      return `fetchLibraryTracks:${off}:${lim}`;
    }
    if (op === 'browsePage') {
      return `browsePage:${vars?.uri || ''}:${Number(vars?.pagePagination?.offset) || 0}:${Number(vars?.pagePagination?.limit) || 0}`;
    }
    if (op === 'browseSection') {
      return `browseSection:${vars?.uri || ''}:${Number(vars?.pagination?.offset) || 0}:${Number(vars?.pagination?.limit) || 0}`;
    }
    if (op === 'getTrack') {
      return `getTrack:${vars?.uri || ''}`;
    }
    return op;
  }
  let tokenWaitPromise = null;
  let lastTokenFallbackAt = 0;
  let clientTokenPromise = null;
  let clientTokenCooldownUntil = 0;
  let harmonyPlayer = null;
  let harmonyController = null;
  let spotifyPlayerApi = null;
  let lastHarmonyClock = null;
  const hookedHarmony = typeof WeakSet === 'function' ? new WeakSet() : null;
  function hookHarmony(player) {
    if (!player || typeof player.addListener !== 'function') return;
    if (hookedHarmony) {
      if (hookedHarmony.has(player)) return;
      hookedHarmony.add(player);
    }
    try {
      player.addListener('playback_capped', () => {
        counters.capped = true;
        pushDiag('harmony event: playback_capped');
      });
      player.addListener('local_player_disabled', () => {
        pushDiag('harmony event: local_player_disabled');
      });
      player.addListener('error', ev => {
        const err = ev?.data?.error ?? ev?.error ?? ev?.data ?? ev;
        const code = err?.code || err?.name || '';
        const msg = err?.message || '';
        const text = [code, msg].filter(Boolean).join(': ').slice(0, 140) || 'unknown_error';
        counters.lastPlaybackError = text;
        pushDiag(`harmony error: ${text}`);
      });
      player.addListener('state_changed', ev => {
        const st =
          ev?.data?.state ??
          ev?.state ??
          (ev && (ev.track_window || ev.position !== undefined || ev.duration !== undefined) ? ev : null);
        if (!st) return;
        const sh = st.shuffle_mode !== undefined ? Boolean(st.shuffle_mode) : (st.options?.shuffling_context !== undefined ? Boolean(st.options.shuffling_context) : null);
        if (sh !== null) counters.lastShuffle = sh;
        counters.disallowNext = Boolean(st.disallows?.skipping_next);
        const curTrack = st.track_window?.current_track;
        const curUri = curTrack?.uri || '';
        const curId = extractTrackId(curUri);
        const linkedId = extractTrackId(curTrack?.linked_from?.uri || curTrack?.linked_from?.id);
        const m = typeof curUri === 'string' ? curUri.match(/^spotify:track:([A-Za-z0-9]{22})$/) : null;
        if (m) counters.actualTrackId = m[1];
        const curPosMs = Number(st.position ?? st.position_as_of_timestamp);
        const curDurMs = Number(st.duration ?? curTrack?.duration_ms);
        const isPaused = Boolean(st.paused || st.isPaused);
        const sameTrack = !curUri || !lastHarmonyTrackUri || curUri === lastHarmonyTrackUri;
        const advancing = !isPaused && !st.loading;
        const matchesDesired = Boolean(desiredTrackId && (curId === desiredTrackId || linkedId === desiredTrackId));
        const now = Date.now();
        if (desiredActivePlayingSince > 0) {
          const elapsed = Math.max(0, now - desiredActivePlayingSince);
          desiredActivePosMs = desiredActiveDurMs > 0
            ? Math.min(desiredActiveDurMs, desiredActivePosMs + elapsed)
            : desiredActivePosMs + elapsed;
        }
        const priorDesiredPosMs = desiredActivePosMs;
        if (matchesDesired) {
          sawDesiredActive = true;
          if (Number.isFinite(curDurMs) && curDurMs > 0) desiredActiveDurMs = curDurMs;
          if (Number.isFinite(curPosMs) && curPosMs >= 0) desiredActivePosMs = curPosMs;
          desiredActivePlayingSince = advancing ? now : 0;
        } else {
          desiredActivePlayingSince = 0;
        }
        const lastId = extractTrackId(lastHarmonyTrackUri);
        const prevList = Array.isArray(st.track_window?.previous_tracks) ? st.track_window.previous_tracks : [];
        const lastPrev = prevList.length ? prevList[prevList.length - 1] : null;
        const prevMatched = Boolean(
          sawDesiredActive &&
          desiredTrackId &&
          lastPrev &&
          (extractTrackId(lastPrev?.uri) === desiredTrackId || extractTrackId(lastPrev?.linked_from?.uri) === desiredTrackId)
        );
        if (lastSeekTargetSec !== null && now - lastSeekAt >= 2000) {
          lastSeekTargetSec = null;
          lastSeekFromSec = null;
        }
        const desiredNearEnd =
          sawDesiredActive &&
          (desiredActiveDurMs <= 15000 ||
            priorDesiredPosMs >= desiredActiveDurMs - Math.min(20000, desiredActiveDurMs * 0.5));
        const nearPriorEnd =
          sawDesiredActive &&
          lastId === desiredTrackId &&
          desiredActiveDurMs > 0 &&
          priorDesiredPosMs >= desiredActiveDurMs - Math.min(10000, desiredActiveDurMs / 2);
        const curIsAd = isAdTrack(curTrack) || ad(curUri);
        if (hardPaused) {
          wasHarmonyAd = curIsAd;
          enforceHardPause(advancing);
          if (curUri) lastHarmonyTrackUri = curUri;
          if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
          if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
          lastHarmonyWasPlaying = false;
          lastHarmonyClock = null;
          return;
        }
        if (
          curIsAd &&
          !counters.startPending &&
          desiredTrackId &&
          ((prevMatched && desiredNearEnd) || nearPriorEnd)
        ) {
          // Track finished and Spotify Free entered a post-roll ad break: signal ended immediately so Nocturne advances cleanly.
          wasHarmonyAd = true;
          bleedTrackId = desiredTrackId;
          counters.trackEnded = true;
          counters.endedTrackId = desiredTrackId;
          desiredTrackId = '';
          setUnwantedBleedMute(true);
          if (curUri) lastHarmonyTrackUri = curUri;
          if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
          if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
          lastHarmonyWasPlaying = false;
          lastHarmonyClock = null;
          return;
        }
        if (curIsAd || wasHarmonyAd || adMutedActive) {
          wasHarmonyAd = curIsAd;
          for (const el of elements()) applyMediaSettings(el);
        }
        if (switchMuteUntilTarget && matchesDesired) {
          setSwitchMute(false);
        }
        if (
          !isAdPlaying() &&
          !counters.startPending &&
          bleedTrackId &&
          (!curId || (curId !== bleedTrackId && linkedId !== bleedTrackId))
        ) {
          counters.trackEnded = true;
          counters.endedTrackId = bleedTrackId;
          setUnwantedBleedMute(true);
          for (const el of elements()) {
            try { if (!el.paused && typeof el.pause === 'function') el.pause(); } catch {}
          }
          if (advancing && !bleedPauseSent) {
            bleedPauseSent = true;
            callHarmonyPause();
          }
          if (curUri) lastHarmonyTrackUri = curUri;
          if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
          if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
          lastHarmonyWasPlaying = false;
          lastHarmonyClock = null;
          return;
        }
        if (
          !isAdPlaying() &&
          !counters.startPending &&
          desiredTrackId &&
          curId &&
          !matchesDesired &&
          ((prevMatched && desiredNearEnd) || nearPriorEnd)
        ) {
          if (preloadedNextTrackId && (curId === preloadedNextTrackId || linkedId === preloadedNextTrackId)) {
            // Harmony already advanced gaplessly into Nocturne's exact next track: keep it playing without muting or pausing!
            seamlessAdoptedTrackId = curId;
            counters.trackEnded = true;
            counters.endedTrackId = desiredTrackId;
            desiredTrackId = '';
            if (curUri) lastHarmonyTrackUri = curUri;
            if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
            if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
            lastHarmonyWasPlaying = advancing;
            lastHarmonyClock = !isPaused && !st.loading && Number(st.timestamp) > 0 ? { ts: Number(st.timestamp), localAt: Date.now() } : null;
            return;
          }
          bleedTrackId = desiredTrackId;
          counters.trackEnded = true;
          counters.endedTrackId = desiredTrackId;
          desiredTrackId = '';
          setUnwantedBleedMute(true);
          for (const el of elements()) {
            try { if (!el.paused && typeof el.pause === 'function') el.pause(); } catch {}
          }
          if (!bleedPauseSent) {
            bleedPauseSent = true;
            callHarmonyPause();
          }
          if (curUri) lastHarmonyTrackUri = curUri;
          if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
          if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
          lastHarmonyWasPlaying = false;
          lastHarmonyClock = null;
          return;
        }
        if (
          !isAdPlaying() &&
          !counters.startPending &&
          !bleedTrackId &&
          sawDesiredActive &&
          lastHarmonyWasPlaying &&
          matchesDesired &&
          isPaused &&
          !st.loading &&
          !startAutoResumeUsed &&
          lastTrackStartAt > 0 &&
          Date.now() - lastTrackStartAt < 2500 &&
          Number.isFinite(curPosMs) &&
          curPosMs > 50 &&
          curPosMs < 3500
        ) {
          // Recover in 0ms if an earlier track-end pause RPC raced into a freshly playing track.
          startAutoResumeUsed = true;
          pushDiag('auto-resumed start micro-pause');
          callHarmonyResume();
        }
        if (advancing) {
          if (!bleedTrackId && !unwantedBleedMuted) {
            counters.trackEnded = false;
            counters.endedTrackId = '';
          }
          counters.lastPlaybackError = '';
        } else if (
          !isAdPlaying() &&
          isPaused && !st.loading &&
          sameTrack &&
          Number.isFinite(curDurMs) &&
          curDurMs > 0 &&
          Number.isFinite(curPosMs) &&
          (curPosMs >= curDurMs || (lastHarmonyWasPlaying && lastSeekTargetSec === null &&
            Math.max(lastHarmonyPosMs, priorDesiredPosMs) >= curDurMs - Math.min(3000, curDurMs / 2) && curPosMs <= 1500))
        ) {
          counters.trackEnded = true;
          counters.endedTrackId = curId || linkedId || desiredTrackId || '';
        }
        if (curUri) lastHarmonyTrackUri = curUri;
        if (Number.isFinite(curDurMs) && curDurMs > 0) lastHarmonyDurMs = curDurMs;
        if (Number.isFinite(curPosMs) && curPosMs >= 0) lastHarmonyPosMs = curPosMs;
        lastHarmonyWasPlaying = advancing;
        if (!isPaused && !st.loading && Number(st.timestamp) > 0) {
          lastHarmonyClock = { ts: Number(st.timestamp), localAt: Date.now() };
        } else {
          lastHarmonyClock = null;
        }
      });
    } catch {}
  }
  try {
    Object.defineProperty(Object.prototype, '_harmony', {
      configurable: true,
      get() { return undefined; },
      set(val) {
        try {
          Object.defineProperty(this, '_harmony', { value: val, writable: true, enumerable: true, configurable: true });
          if (val && typeof val.playTracks === 'function') {
            harmonyPlayer = val;
            hookHarmony(val);
            if (val._controller && !val._controller._hidden && !val._controller._disableProgress && !val._controller._observerMode) {
              harmonyController = val._controller;
            }
            if (val._controller && typeof val._controller.addListener === 'function') hookHarmony(val._controller);
          }
          if (val && typeof this.play === 'function' && typeof this.skipToNext === 'function') spotifyPlayerApi = this;
        } catch {}
      },
    });
    Object.defineProperty(Object.prototype, '_playerClient', {
      configurable: true,
      get() { return undefined; },
      set(val) {
        try {
          Object.defineProperty(this, '_playerClient', { value: val, writable: true, enumerable: true, configurable: true });
          if (val && typeof this.playTracks === 'function' && !this._hidden && !this._disableProgress && !this._observerMode) harmonyController = this;
        } catch {}
      },
    });
    Object.defineProperty(Object.prototype, '_controller', {
      configurable: true,
      get() { return undefined; },
      set(val) {
        try {
          Object.defineProperty(this, '_controller', { value: val, writable: true, enumerable: true, configurable: true });
          const activeHost = !this._hidden && !this._disableProgress && !this._observerMode;
          if (val && typeof val.playURI === 'function' && activeHost && !val._hidden && !val._disableProgress && !val._observerMode) {
            harmonyController = val;
          }
          if (val && typeof val.addListener === 'function' && typeof this.playTracks === 'function' && activeHost) hookHarmony(val);
          if (val && typeof this.playTracks === 'function' && activeHost) {
            harmonyPlayer = this;
            hookHarmony(this);
          }
        } catch {}
      },
    });
  } catch {}
  const jobs = Object.create(null);
  let desiredVolume = 0.8;
  let desiredMuted = false;
  let desiredTrackId = '';
  let playTimer = 0;
  let seekTimer = 0;
  let playSeq = 0;
  let lastSeekTargetSec = null;
  let lastSeekFromSec = null;
  let lastSeekAt = 0;

  let styleInjected = false;
  function injectPerfStyle() {
    if (styleInjected || typeof document === 'undefined') return false;
    const target = document.head || document.documentElement;
    if (!target || typeof target.appendChild !== 'function') return false;
    try {
      const style = document.createElement?.('style');
      if (style) {
        style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}@media (max-width:80px){body>*{content-visibility:hidden!important;contain:strict!important}}';
        target.appendChild(style);
        styleInjected = true;
        return true;
      }
    } catch {}
    return false;
  }
  if (!injectPerfStyle() && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => { injectPerfStyle(); }, { once: true });
  }

  const media = [];
  const mediaPrototype = window.HTMLMediaElement?.prototype;
  const nativeVolDesc = mediaPrototype ? Object.getOwnPropertyDescriptor(mediaPrototype, 'volume') : null;
  const nativeMutedDesc = mediaPrototype ? Object.getOwnPropertyDescriptor(mediaPrototype, 'muted') : null;
  function setNativeVol(el, v) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    if (nativeVolDesc?.set) {
      try { nativeVolDesc.set.call(el, clamped); return; } catch {}
    }
    try { el.volume = clamped; } catch {}
  }
  function getNativeVol(el) {
    if (nativeVolDesc?.get) {
      try { return nativeVolDesc.get.call(el); } catch {}
    }
    return el?.volume ?? 1;
  }
  function setNativeMuted(el, m) {
    const flag = Boolean(m);
    if (nativeMutedDesc?.set) {
      try { nativeMutedDesc.set.call(el, flag); return; } catch {}
    }
    try { el.muted = flag; } catch {}
  }
  function getNativeMuted(el) {
    if (nativeMutedDesc?.get) {
      try { return nativeMutedDesc.get.call(el); } catch {}
    }
    return Boolean(el?.muted);
  }
  function isCanvasVideo(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    if (el.mediaKeys) return false;
    if (el.loop === true) return true;
    if (hardPaused || isAdPlaying()) return false;
    return Boolean(el.isConnected && Number.isFinite(el.duration) && el.duration > 0 && el.duration <= 12 && !el.webkitAudioDecodedByteCount);
  }
  function setUnwantedBleedMute(on) {
    clearTimeout(unwantedBleedTimer);
    unwantedBleedTimer = 0;
    unwantedBleedMuted = Boolean(on);
    if (unwantedBleedMuted) {
      unwantedBleedTimer = setTimeout(() => {
        unwantedBleedTimer = 0;
        if (!unwantedBleedMuted) return;
        unwantedBleedMuted = false;
        for (const el of elements()) applyMediaSettings(el);
      }, 1500);
    }
    for (const el of elements()) applyMediaSettings(el);
  }
  function setSwitchMute(on) {
    clearTimeout(switchMuteTimer);
    switchMuteTimer = 0;
    switchMuteUntilTarget = Boolean(on);
    if (switchMuteUntilTarget) {
      switchMuteTimer = setTimeout(() => {
        switchMuteTimer = 0;
        if (!switchMuteUntilTarget) return;
        switchMuteUntilTarget = false;
        for (const el of elements()) applyMediaSettings(el);
      }, 1500);
    }
    for (const el of elements()) applyMediaSettings(el);
  }
  function trackMediaElement(el) {
    if (!el || typeof el !== 'object') return el;
    for (let i = media.length - 1; i >= 0; i--) {
      if (!media[i].deref()) media.splice(i, 1);
    }
    if (!media.some(reference => reference.deref() === el)) {
      if (media.length >= 48) {
        const dropIdx = media.findIndex(reference => {
          const node = reference.deref();
          return !node || isCanvasVideo(node) || (!node.mediaKeys && node.paused && !node.isConnected);
        });
        media.splice(dropIdx >= 0 ? dropIdx : 0, 1);
      }
      media.push(new WeakRef(el));
      try {
        const sync = () => applyMediaSettings(el);
        for (const ev of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'durationchange', 'volumechange']) {
          el.addEventListener?.(ev, sync);
        }
      } catch {}
    }
    applyMediaSettings(el);
    return el;
  }
  if (mediaPrototype) {
    if (nativeVolDesc?.get && nativeVolDesc?.set && nativeVolDesc.configurable !== false) {
      try {
        Object.defineProperty(mediaPrototype, 'volume', {
          configurable: true,
          enumerable: true,
          get() { return getNativeVol(this); },
          set(v) {
            if (isCanvasVideo(this)) {
              setNativeVol(this, v);
              return;
            }
            const adNow = counters.enabled && isAdPlaying();
            const target = hardPaused || adNow || unwantedBleedMuted || switchMuteUntilTarget || desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume));
            setNativeVol(this, target);
          },
        });
      } catch {}
    }
    if (nativeMutedDesc?.get && nativeMutedDesc?.set && nativeMutedDesc.configurable !== false) {
      try {
        Object.defineProperty(mediaPrototype, 'muted', {
          configurable: true,
          enumerable: true,
          get() { return getNativeMuted(this); },
          set(m) {
            if (isCanvasVideo(this)) {
              setNativeMuted(this, Boolean(m));
              return;
            }
            const adNow = counters.enabled && isAdPlaying();
            setNativeMuted(this, hardPaused || adNow || unwantedBleedMuted || switchMuteUntilTarget ? true : Boolean(desiredMuted));
          },
        });
      } catch {}
    }
    const play = mediaPrototype.play;
    if (typeof play === 'function') {
      mediaPrototype.play = function(...args) {
        trackMediaElement(this);
        if (hardPaused && !isCanvasVideo(this)) {
          setNativeMuted(this, true);
          setNativeVol(this, 0);
          enforceHardPause(true);
          return Promise.resolve();
        }
        return play.apply(this, args);
      };
    }
    const load = mediaPrototype.load;
    if (typeof load === 'function') {
      mediaPrototype.load = function(...args) {
        trackMediaElement(this);
        return load.apply(this, args);
      };
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const origCreateElement = document.createElement;
    document.createElement = function(tagName, ...rest) {
      const el = origCreateElement.call(this, tagName, ...rest);
      if (typeof tagName === 'string' && /^(?:audio|video)$/i.test(tagName)) {
        trackMediaElement(el);
      }
      return el;
    };
  }
  function elements() {
    const list = [...media.map(reference => reference.deref()).filter(Boolean), ...(typeof document !== 'undefined' ? (document.querySelectorAll?.('audio,video') ?? []) : [])];
    return [...new Set(list)].filter(el => !isCanvasVideo(el));
  }
  function activeElement() {
    const list = elements();
    return list.find(el => !el.paused && !el.ended)
      ?? list.find(el => Boolean(el.mediaKeys) || !el.isConnected)
      ?? list.find(el => Number.isFinite(el.duration) && el.duration > 0)
      ?? list[0]
      ?? null;
  }
  function isAdPlaying() {
    const hTrack = harmonyState()?.track_window?.current_track;
    const hUri = hTrack?.uri;
    if (isAdTrack(hTrack)) return true;
    // Harmony _state is authoritative: once it reports a real song, lagging DOM "Реклама" labels must never mute or skip it.
    if (typeof hUri === 'string' && song(hUri)) return false;
    if (typeof document === 'undefined' || !document.querySelector) return false;
    const adSlot = document.querySelector('[data-testid="now-playing-widget"] [data-testid="context-item-info-ad-subtitle"], [data-testid="ad-slot-container"]');
    if (adSlot) {
      const hasContent = adSlot.childElementCount === undefined || adSlot.childElementCount > 0 || Boolean(adSlot.textContent?.trim());
      if (hasContent) return true;
    }
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    const label = widget?.getAttribute?.('aria-label') || '';
    if (/(?:^|\s)(?:Advertisement|Реклама)(?:\s|$)/i.test(label)) return true;
    const title = widget?.querySelector?.('[data-testid="context-item-info-title"]')?.textContent?.trim() || '';
    if (/^(?:Advertisement|Реклама)$/i.test(title)) return true;
    const metaTitle = window.navigator?.mediaSession?.metadata?.title || '';
    if (/^(?:Advertisement|Реклама)$/i.test(metaTitle.trim())) return true;
    return false;
  }
  function skipActiveAd() {
    if (hardPaused || counters.startPending) return;
    const now = Date.now();
    if (now - lastAdSkipAt < 1500) return;
    lastAdSkipAt = now;
    const player = harmonyPlayer || harmonyController;
    const clickNextDom = () => {
      const nextBtn = typeof document !== 'undefined' ? document.querySelector?.('[data-testid="control-button-skip-forward"]') : null;
      if (nextBtn && !nextBtn.disabled) {
        try { nextBtn.click(); } catch {}
      }
    };
    if (player && typeof player.nextTrack === 'function') {
      try {
        void Promise.resolve(player.nextTrack()).catch(() => clickNextDom());
        return;
      } catch {}
    }
    clickNextDom();
  }
  function applyMediaSettings(el) {
    if (!el || isCanvasVideo(el)) return;
    if (hardPaused) {
      if (!getNativeMuted(el)) setNativeMuted(el, true);
      if (getNativeVol(el) !== 0) setNativeVol(el, 0);
      try { if (!el.paused && typeof el.pause === 'function') el.pause(); } catch {}
      return;
    }
    if (unwantedBleedMuted || switchMuteUntilTarget) {
      if (!getNativeMuted(el)) setNativeMuted(el, true);
      if (getNativeVol(el) !== 0) setNativeVol(el, 0);
      return;
    }
    if (counters.enabled && isAdPlaying()) {
      adMutedActive = true;
      // Mark ad audio elements so when a 30s ad finishes with ended=true it can NEVER false-end real tracks.
      ignoredEndedMedia?.add(el);
      if (!getNativeMuted(el)) setNativeMuted(el, true);
      if (getNativeVol(el) !== 0) setNativeVol(el, 0);
      const ready = typeof el.readyState === 'number' ? el.readyState >= 2 : true;
      const dur = el.duration;
      if (ready && Number.isFinite(dur) && dur > 0.5 && dur < 180) {
        const bufEnd = bufferedEndSec(el, el.currentTime);
        const target =
          bufEnd >= dur - 0.25
            ? Math.max(0, dur - 0.1)
            : bufEnd > (el.currentTime || 0) + 1.0
              ? Math.min(dur - 0.1, bufEnd - 0.15)
              : -1;
        if (target > (el.currentTime || 0) + 0.15) {
          try {
            el.currentTime = target;
            const adUri = harmonyState()?.track_window?.current_track?.uri || `dom:${Math.round(dur)}`;
            if (adUri !== lastAdSeekTrackUri) {
              lastAdSeekTrackUri = adUri;
              counters.removed++;
            }
          } catch {}
        }
        if (el.playbackRate !== 4) {
          try { el.playbackRate = 4; } catch {}
        }
      }
      if (!desiredTrackId && !counters.expectedTrackId) skipActiveAd();
      return;
    }
    adMutedActive = false;
    lastAdSeekTrackUri = '';
    if (!el.paused && !el.ended) ignoredEndedMedia?.delete(el);
    try { if (el.playbackRate > 1.01) el.playbackRate = 1; } catch {}
    const targetVol = desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume));
    const targetMuted = Boolean(desiredMuted);
    if (Math.abs(getNativeVol(el) - targetVol) > 0.002) setNativeVol(el, targetVol);
    if (getNativeMuted(el) !== targetMuted) setNativeMuted(el, targetMuted);
  }
  if (typeof setInterval === 'function') {
    setInterval(() => { for (const el of elements()) applyMediaSettings(el); }, 600);
  }

  function playing() {
    if (hardPaused) return false;
    if (counters.trackEnded && !counters.startPending) return false;
    const list = elements();
    if (list.some(element => !element.paused && !element.ended)) return true;
    const hs = harmonyState();
    if (hs && (hs.paused !== undefined || hs.isPaused !== undefined)) {
      if (list.some(element => element.ended && !ignoredEndedMedia?.has(element) && Number.isFinite(element.duration) && element.duration > 15)) {
        return false;
      }
      return !hs.paused && !hs.isPaused && !hs.loading;
    }
    if (list.length) return false;
    const state = window.navigator?.mediaSession?.playbackState;
    if (state === 'playing' || state === 'paused') return state === 'playing';
    return null;
  }

  const seen = new Set();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const trackObj = (machine, state) => Number.isInteger(state?.track) ? machine.tracks[state.track] : null;
  const uri = (machine, state) => trackObj(machine, state)?.metadata?.uri ?? null;
  const stateIsAd = (machine, state) => {
    const t = trackObj(machine, state);
    return ad(t?.metadata?.uri) || isAdTrack(t);
  };
  function cleanRestrictions(target) {
    if (!object(target)) return false;
    let changed = false;
    for (const key of ['disallow_seeking', 'disallow_skipping_next', 'disallow_skipping_prev', 'disallow_pausing', 'disallow_resuming']) {
      if (key in target) { delete target[key]; changed = true; }
    }
    return changed;
  }
  function patch(machine) {
    if (!object(machine) || !Array.isArray(machine.states) || !Array.isArray(machine.tracks) || machine.states.length > 2000 || machine.tracks.length > 5000) return false;
    let cleaned = false;
    if (cleanRestrictions(machine.restrictions)) cleaned = true;
    if (cleanRestrictions(machine.disallows)) cleaned = true;
    const states = machine.states, replacements = new Map();
    const nextStateIndex = st => {
      const adv = st?.transitions?.advance?.state_index;
      if (adv !== undefined && adv !== null) return adv;
      return st?.transitions?.skip_next?.state_index;
    };
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      if (cleanRestrictions(state?.restrictions)) cleaned = true;
      if (cleanRestrictions(state?.disallows)) cleaned = true;
      if (!stateIsAd(machine, state)) continue;
      const visited = new Set([i]);
      let next = nextStateIndex(state);
      while (Number.isInteger(next) && next >= 0 && next < states.length && !visited.has(next)) {
        visited.add(next);
        if (song(uri(machine, states[next])) && !stateIsAd(machine, states[next]) && typeof states[next]?.state_id === 'string') { replacements.set(i, next); break; }
        if (!stateIsAd(machine, states[next])) break;
        next = nextStateIndex(states[next]);
      }
      // When Spotify omits transitions.advance/skip_next on an ad break, only replace if the next song state is explicitly linked.
      if (!replacements.has(i)) counters.unsupported++;
    }
    if (!replacements.size) return cleaned;
    machine.states = states.map((state, index) => replacements.has(index) ? structuredClone(states[replacements.get(index)]) : state);
    for (const index of replacements.keys()) {
      const key = String(machine.state_machine_id) + ':' + String(states[index]?.state_id) + ':' + uri(machine, states[index]);
      if (!seen.has(key)) {
        if (seen.size >= 256) seen.delete(seen.values().next().value);
        seen.add(key); counters.removed++;
      }
    }
    return true;
  }
  function transform(data) {
    if (!counters.enabled || !object(data)) return false;
    counters.intercepted++;
    let changed = patch(data.state_machine);
    if (Array.isArray(data.payloads) && data.payloads.length <= 100) for (const payload of data.payloads) {
      if (payload?.type === 'replace_state') changed = patch(payload.state_machine) || changed;
    }
    if (object(data.commands) && Object.keys(data.commands).length <= 100) for (const command of Object.values(data.commands)) {
      if (command?.type === 'replace_state') changed = patch(command.state_machine) || changed;
    }
    return changed;
  }
  function parseUrl(input) {
    try {
      return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://open.spotify.com');
    } catch { return null; }
  }
  function isSpclient(url) {
    return Boolean(url && url.protocol === 'https:' && !url.username && !url.password && !url.port && /^(?:[a-z0-9-]+[-.])?spclient\.(?:wg\.)?spotify\.com$/i.test(url.hostname));
  }
  function stateEndpoint(input) {
    const url = parseUrl(input);
    return isSpclient(url) && /^\/track-playback\/v1\/devices\/[^/]+\/(?:state|state_conflict)$/.test(url.pathname);
  }
  function adEndpoint(input) {
    const url = parseUrl(input);
    return isSpclient(url) && /^\/(?:ads|ad-logic|pendragon|sponsoredplaylist|leavebehinds|ad-dsa-metadata-lookup)\//.test(url.pathname);
  }
  function noteHeader(name, value) {
    if (typeof name !== 'string' || typeof value !== 'string') return;
    const lower = name.toLowerCase();
    if (lower === 'authorization' && value.startsWith('Bearer ') && value.length > 30) {
      if (auth.token !== value || !auth.tokenExpiresAt) {
        auth.tokenExpiresAt = Date.now() + 30 * 60_000;
      }
      auth.token = value;
    } else if (lower === 'client-token' && value.length > 20) {
      if (auth.clientToken !== value || !auth.clientTokenExpiresAt) {
        auth.clientTokenExpiresAt = Date.now() + 6 * 3600_000;
      }
      auth.clientToken = value;
    } else if (lower === 'spotify-app-version' && value) auth.appVersion = value;
    else if (lower === 'app-platform' && value) auth.appPlatform = value;
    else if (lower === 'accept-language' && value) auth.acceptLanguage = value;
  }
  function noteTokenPayload(url, txt) {
    if (typeof txt !== 'string' || !txt) return;
    try {
      const isAnon = /"isAnonymous"\s*:\s*true\b/i.test(txt);
      const m = !isAnon ? txt.match(/"accessToken"\s*:\s*"([A-Za-z0-9_-]{30,})"/) : null;
      if (m) {
        auth.token = 'Bearer ' + m[1];
        const expMatch = txt.match(/"accessTokenExpirationTimestampMs"\s*:\s*(\d{10,15})/);
        if (expMatch) auth.tokenExpiresAt = Number(expMatch[1]);
        const cidMatch = txt.match(/"clientId"\s*:\s*"([A-Za-z0-9]{20,64})"/);
        if (cidMatch) auth.clientId = cidMatch[1];
      } else if (!isAnon) {
        const cidMatch = txt.match(/"clientId"\s*:\s*"([A-Za-z0-9]{20,64})"/);
        if (cidMatch) auth.clientId = cidMatch[1];
      }
      if (url && url.hostname === 'clienttoken.spotify.com') {
        const json = JSON.parse(txt);
        const gt = json?.granted_token;
        if (typeof gt?.token === 'string' && gt.token.length > 20) {
          auth.clientToken = gt.token;
          const ttlSec = Number(gt.expires_after_seconds);
          auth.clientTokenExpiresAt = Date.now() + (Number.isFinite(ttlSec) && ttlSec > 60 ? ttlSec * 1000 : 6 * 3600_000);
        }
      }
    } catch {}
  }
  function capturePathfinderMeta(url, rawBody) {
    if (!url || !url.pathname.includes('/pathfinder/')) return '';
    try {
      if (typeof rawBody === 'string') {
        const parsed = JSON.parse(rawBody);
        const op = parsed?.operationName;
        const hash = parsed?.extensions?.persistedQuery?.sha256Hash;
        if (typeof op === 'string' && typeof hash === 'string' && hash.length === 64) hashes[op] = hash;
        if (op === 'home' && object(parsed?.variables)) auth.homeVars = parsed.variables;
        return typeof op === 'string' && CACHEABLE_PF.has(op) ? pfCacheKey(op, parsed?.variables) : '';
      }
      if (url.search) {
        const op = url.searchParams.get('operationName') || '';
        const ext = url.searchParams.get('extensions');
        const vars = url.searchParams.get('variables');
        let parsedVars = null;
        if (ext) {
          const parsedExt = JSON.parse(ext);
          const hash = parsedExt?.persistedQuery?.sha256Hash;
          if (op && typeof hash === 'string' && hash.length === 64) hashes[op] = hash;
        }
        if (vars) {
          parsedVars = JSON.parse(vars);
          if (op === 'home' && object(parsedVars)) auth.homeVars = parsedVars;
        }
        return op && CACHEABLE_PF.has(op) ? pfCacheKey(op, parsedVars) : '';
      }
    } catch {}
    return '';
  }
  function captureHeaders(input, init) {
    try {
      const url = parseUrl(input);
      if (!url || url.protocol !== 'https:' || !/(?:^|\.)spotify\.com$/i.test(url.hostname)) return '';
      const devMatch = url.pathname.match(/\/(?:track-playback\/v1\/devices\/|connect-state\/v1\/devices\/hobs_)([a-f0-9]{32,64})/i);
      if (devMatch) auth.deviceId = devMatch[1];
      for (const source of [init?.headers, typeof Request !== 'undefined' && input instanceof Request ? input.headers : null]) {
        if (!source) continue;
        const h = new Headers(source);
        for (const key of ['authorization', 'client-token', 'spotify-app-version', 'app-platform', 'accept-language']) {
          const v = h.get(key);
          if (v) noteHeader(key, v);
        }
      }
      return capturePathfinderMeta(url, init?.body);
    } catch {}
    return '';
  }

  function spotifyIdToGidHex(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(id)) return '';
    try {
      let n = 0n;
      for (let i = 0; i < id.length; i++) {
        const idx = B62_CHARS.indexOf(id[i]);
        if (idx < 0) return '';
        n = n * 62n + BigInt(idx);
      }
      const hex = n.toString(16);
      return hex.length <= 32 ? hex.padStart(32, '0') : '';
    } catch {
      return '';
    }
  }
  function isAudioCdnUrl(url) {
    return Boolean(
      url &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /(?:^|\.)(?:scdn\.co|spotifycdn\.com|akamaized\.net|cloudfront\.net|fastly\.net|gcdn\.co|spotify\.com)$/i.test(url.hostname)
    );
  }
  function matchMetadataTrackUrl(url) {
    if (!isSpclient(url)) return '';
    const m = url.pathname.match(/^\/metadata\/4\/track\/([a-f0-9]{32})$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function matchStorageResolveUrl(url) {
    if (!isSpclient(url)) return null;
    const m = url.pathname.match(/^\/storage-resolve\/v2\/files\/audio\/interactive\/([^/]+)\/([a-f0-9]{40})$/i);
    return m ? { profile: m[1], fileId: m[2].toLowerCase() } : null;
  }
  function observeMetadataPayload(url, txt) {
    if (!url || typeof txt !== 'string' || !txt || txt.length > 512 * 1024) return;
    try {
      observedSpclientOrigin = url.origin;
      const meta = JSON.parse(txt);
      const files = [
        ...(Array.isArray(meta?.file) ? meta.file : []),
        ...(Array.isArray(meta?.alternative) ? meta.alternative.flatMap(a => (Array.isArray(a?.file) ? a.file : [])) : []),
      ];
      for (const f of files) {
        const fid = typeof f?.file_id === 'string' ? f.file_id.toLowerCase() : '';
        const fmt = typeof f?.format === 'string' ? f.format : '';
        if (/^[a-f0-9]{40}$/.test(fid) && fmt) {
          if (observedFileFormats.size >= 64) {
            const oldest = observedFileFormats.keys().next().value;
            if (oldest !== undefined) observedFileFormats.delete(oldest);
          }
          observedFileFormats.set(fid, fmt);
        }
      }
    } catch {}
  }
  function observeStorageResolveRequest(url) {
    const hit = matchStorageResolveUrl(url);
    if (!hit) return;
    observedSpclientOrigin = url.origin;
    observedResolveTemplate = `/storage-resolve/v2/files/audio/interactive/${hit.profile}/{FILE_ID}${url.search || ''}`;
    const fmt = observedFileFormats.get(hit.fileId);
    if (fmt) observedAudioFormat = fmt;
  }
  function pickPreferredAudioFile(meta) {
    const files = [
      ...(Array.isArray(meta?.file) ? meta.file : []),
      ...(Array.isArray(meta?.alternative) ? meta.alternative.flatMap(a => (Array.isArray(a?.file) ? a.file : [])) : []),
    ].filter(f => typeof f?.file_id === 'string' && /^[a-f0-9]{40}$/i.test(f.file_id));
    if (!files.length) return null;
    const pref = [
      observedAudioFormat,
      'MP4_256',
      'MP4_256_DUAL',
      'MP4_128',
      'MP4_128_DUAL',
      'MP4_128_CBCS',
      'MP4_256_CBCS',
    ].filter(Boolean);
    for (const fmt of pref) {
      const hit = files.find(f => f.format === fmt);
      if (hit) return { fileId: hit.file_id.toLowerCase(), format: hit.format || fmt };
    }
    const anyMp4 = files.find(f => typeof f.format === 'string' && f.format.startsWith('MP4_'));
    if (anyMp4) return { fileId: anyMp4.file_id.toLowerCase(), format: anyMp4.format };
    return { fileId: files[0].file_id.toLowerCase(), format: files[0].format || '' };
  }
  function parseContentRangeTotal(header, fallbackLen) {
    if (typeof header === 'string') {
      const m = header.match(/bytes\s+\d+-\d+\/(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return fallbackLen;
  }
  function clearPreloadCache() {
    preloadGen++;
    preloadedNextTrackId = '';
    preloadState = null;
  }
  function matchPreloadResponse(url, method, rangeHeader, acceptHeader) {
    if (!url || !preloadState) return null;
    if (String(method || 'GET').toUpperCase() !== 'GET') return null;
    if (Date.now() - preloadState.at > PRELOAD_TTL_MS) {
      preloadState = null;
      return null;
    }
    const wantsJson = typeof acceptHeader === 'string' && /application\/json|\bjson\b/i.test(acceptHeader);
    const gid = matchMetadataTrackUrl(url);
    // Only serve cached JSON metadata if caller explicitly accepts JSON (never feed JSON into Harmony's protobuf decoder!).
    if (gid && gid === preloadState.gidHex && preloadState.metaText && wantsJson) {
      return {
        status: 200,
        statusText: 'OK',
        body: preloadState.metaText,
        contentType: preloadState.metaType || 'application/json',
        kind: 'meta',
      };
    }
    const resHit = matchStorageResolveUrl(url);
    const wantsResolveJson = wantsJson || url.searchParams.get('alt') === 'json';
    if (resHit && resHit.fileId === preloadState.fileId && preloadState.resolveText && wantsResolveJson) {
      return {
        status: 200,
        statusText: 'OK',
        body: preloadState.resolveText,
        contentType: preloadState.resolveType || 'application/json',
        kind: 'resolve',
      };
    }
    if (
      preloadState.audioBytes &&
      url.protocol === 'https:' &&
      (url.href === preloadState.cdnUrl || (isAudioCdnUrl(url) && preloadState.cdnPathKey && url.pathname === preloadState.cdnPathKey))
    ) {
      const buf = preloadState.audioBytes;
      const total = preloadState.audioTotal || buf.byteLength;
      if (typeof rangeHeader === 'string' && rangeHeader.trim()) {
        const m = rangeHeader.trim().match(/^bytes=(\d+)-(\d*)$/i);
        if (!m) return null;
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= buf.byteLength) return null;
        const slice = buf.slice(start, end + 1);
        return {
          status: 206,
          statusText: 'Partial Content',
          bytes: slice,
          contentRange: `bytes ${start}-${end}/${total}`,
          contentType: preloadState.audioType || 'audio/mp4',
          kind: 'audio',
        };
      }
      if (buf.byteLength === total) {
        return {
          status: 200,
          statusText: 'OK',
          bytes: buf.slice(0),
          contentType: preloadState.audioType || 'audio/mp4',
          kind: 'audio',
        };
      }
    }
    return null;
  }
  function warmNextTrack(trackId) {
    if (typeof trackId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(trackId)) {
      clearPreloadCache();
      return false;
    }
    if (
      preloadedNextTrackId === trackId &&
      preloadState &&
      preloadState.trackId === trackId &&
      Date.now() - preloadState.at < PRELOAD_TTL_MS &&
      preloadState.stage === 'audio'
    ) {
      return true;
    }
    preloadedNextTrackId = trackId;
    const gen = ++preloadGen;
    const gidHex = spotifyIdToGidHex(trackId);
    if (!gidHex) return false;
    void (async () => {
      try {
        await ensureToken(2000);
        await ensureClientToken(false);
        if (gen !== preloadGen || !auth.token) return;
        const metaRes = await fetch.call(window, `${observedSpclientOrigin}/metadata/4/track/${gidHex}?market=from_token`, {
          headers: apiHeaders(),
        });
        if (gen !== preloadGen || !metaRes.ok) return;
        const metaText = await metaRes.text();
        if (gen !== preloadGen || !metaText || metaText.length > 512 * 1024) return;
        const metaType = metaRes.headers.get('content-type') || 'application/json';
        const meta = JSON.parse(metaText);
        const state = {
          trackId,
          gidHex,
          metaText,
          metaType,
          fileId: '',
          resolveText: '',
          resolveType: '',
          cdnUrl: '',
          cdnPathKey: '',
          audioBytes: null,
          audioTotal: 0,
          audioType: '',
          at: Date.now(),
          stage: 'meta',
        };
        preloadState = state;
        const chosen = pickPreferredAudioFile(meta);
        if (!chosen) return;
        let resolvePath = observedResolveTemplate
          ? observedResolveTemplate.replace('{FILE_ID}', chosen.fileId)
          : `/storage-resolve/v2/files/audio/interactive/11/${chosen.fileId}?version=10000000&product=9&platform=39&alt=json`;
        if (!/(?:^|[?&])alt=json(?:&|$)/i.test(resolvePath)) {
          resolvePath += (resolvePath.includes('?') ? '&' : '?') + 'alt=json';
        }
        const resolveRes = await fetch.call(window, `${observedSpclientOrigin}${resolvePath}`, {
          headers: apiHeaders(),
        });
        if (gen !== preloadGen || !resolveRes.ok) return;
        const resolveText = await resolveRes.text();
        if (gen !== preloadGen || !resolveText || resolveText.length > 128 * 1024) return;
        const resolveType = resolveRes.headers.get('content-type') || 'application/json';
        const resolved = JSON.parse(resolveText);
        const cdnList = Array.isArray(resolved?.cdnurl) ? resolved.cdnurl : [];
        const cdnUrl = cdnList.find(u => isAudioCdnUrl(parseUrl(u))) || '';
        const parsedCdn = cdnUrl ? parseUrl(cdnUrl) : null;
        state.fileId = chosen.fileId;
        state.resolveText = resolveText;
        state.resolveType = resolveType;
        state.cdnUrl = cdnUrl;
        state.cdnPathKey = parsedCdn ? parsedCdn.pathname : '';
        state.at = Date.now();
        state.stage = 'resolved';
        if (!cdnUrl) return;
        const audioRes = await fetch.call(window, cdnUrl, {
          headers: { Range: `bytes=0-${PRELOAD_AUDIO_RANGE_END}` },
        });
        if (gen !== preloadGen || (audioRes.status !== 206 && audioRes.status !== 200)) return;
        const buf = await audioRes.arrayBuffer();
        if (gen !== preloadGen || !buf || buf.byteLength === 0 || buf.byteLength > PRELOAD_MAX_BYTES) return;
        state.audioBytes = new Uint8Array(buf);
        state.audioTotal = parseContentRangeTotal(audioRes.headers.get('content-range'), buf.byteLength);
        state.audioType = audioRes.headers.get('content-type') || 'audio/mp4';
        state.at = Date.now();
        state.stage = 'audio';
        counters.preloaded++;
      } catch {}
    })();
    return true;
  }

  const xhrProto = window.XMLHttpRequest?.prototype;
  if (xhrProto) {
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    const origAbort = xhrProto.abort;
    const setHeader = xhrProto.setRequestHeader;
    if (origOpen) {
      xhrProto.open = function(method, url) {
        this._nocturneMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
        this._nocturneUrl = typeof url === 'string' ? url : '';
        this._nocturneRange = '';
        this._nocturneAccept = '';
        this._nocturneAborted = false;
        return origOpen.apply(this, arguments);
      };
    }
    if (origAbort) {
      xhrProto.abort = function() {
        this._nocturneAborted = true;
        return origAbort.apply(this, arguments);
      };
    }
    if (setHeader) {
      xhrProto.setRequestHeader = function(name, value) {
        if (typeof name === 'string' && typeof value === 'string') {
          const lower = name.toLowerCase();
          if (lower === 'range') this._nocturneRange = value;
          else if (lower === 'accept') this._nocturneAccept = value;
        }
        const u = parseUrl(this._nocturneUrl);
        if (!u || /(?:^|\.)spotify\.com$/i.test(u.hostname)) {
          noteHeader(name, value);
        }
        return setHeader.apply(this, arguments);
      };
    }
    if (origSend) {
      xhrProto.send = function(body) {
        const rawUrl = this._nocturneUrl;
        const pfOp = captureHeaders(rawUrl, typeof body === 'string' ? { body } : undefined);
        const rUrl = parseUrl(rawUrl);
        if (rUrl) observeStorageResolveRequest(rUrl);
        const preloadHit = matchPreloadResponse(rUrl, this._nocturneMethod, this._nocturneRange, this._nocturneAccept);
        const rt = this.responseType || '';
        const canServeXhr = preloadHit && (
          preloadHit.bytes
            ? rt === 'arraybuffer'
            : (rt === '' || rt === 'text' || rt === 'json')
        );
        if (canServeXhr) {
          counters.preloadHits++;
          const defer = typeof queueMicrotask === 'function' ? queueMicrotask : fn => Promise.resolve().then(fn);
          const hdrs = { 'content-type': preloadHit.contentType };
          if (preloadHit.bytes) {
            hdrs['content-length'] = String(preloadHit.bytes.byteLength);
            hdrs['accept-ranges'] = 'bytes';
            if (preloadHit.contentRange) hdrs['content-range'] = preloadHit.contentRange;
          }
          defer(() => {
            if (this._nocturneAborted) return;
            try {
              const respVal = preloadHit.bytes
                ? preloadHit.bytes.buffer.slice(preloadHit.bytes.byteOffset, preloadHit.bytes.byteOffset + preloadHit.bytes.byteLength)
                : rt === 'json'
                  ? JSON.parse(preloadHit.body)
                  : preloadHit.body;
              Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
              Object.defineProperty(this, 'status', { configurable: true, value: preloadHit.status });
              Object.defineProperty(this, 'statusText', { configurable: true, value: preloadHit.statusText });
              Object.defineProperty(this, 'responseURL', { configurable: true, value: rUrl.href });
              Object.defineProperty(this, 'response', { configurable: true, value: respVal });
              if (!preloadHit.bytes && (rt === '' || rt === 'text')) {
                Object.defineProperty(this, 'responseText', { configurable: true, value: preloadHit.body });
              }
              this.getResponseHeader = name => hdrs[String(name || '').toLowerCase()] ?? null;
              this.getAllResponseHeaders = () => Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n');
              const fire = type => {
                const ev = typeof Event === 'function' ? new Event(type) : { type, target: this, currentTarget: this };
                try { this['on' + type]?.call(this, ev); } catch {}
                try { this.dispatchEvent?.(ev); } catch {}
              };
              fire('readystatechange');
              fire('progress');
              fire('load');
              fire('loadend');
            } catch {}
          });
          return;
        }
        if (rUrl && /(?:^|\.)spotify\.com$/i.test(rUrl.hostname) && typeof this.addEventListener === 'function') {
          this.addEventListener('load', () => {
            try {
              if (this.responseType !== '' && this.responseType !== 'text') return;
              if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string' && this.responseText.length < 2 * 1024 * 1024) {
                noteTokenPayload(rUrl, this.responseText);
                if (matchMetadataTrackUrl(rUrl)) observeMetadataPayload(rUrl, this.responseText);
                if (pfOp) {
                  const json = JSON.parse(this.responseText);
                  if (json?.data) {
                    setPfCache(pfOp, json.data);
                    setPfTtl(pfOp, { data: json.data, at: Date.now() });
                    if (pfOp.startsWith('libraryV3:all:0:') || pfOp.startsWith('libraryV3:Playlists:0:')) {
                      setPfCache('libraryV3', json.data);
                      setPfCache('libraryV3:Playlists', json.data);
                    }
                    if (pfOp.startsWith('fetchLibraryTracks:0:')) {
                      setPfCache('fetchLibraryTracks', json.data);
                      setPfCache('fetchLibraryTracks:0', json.data);
                    }
                  }
                }
              }
            } catch {}
          }, { once: true });
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  const fetch = window.fetch;
  window.fetch = async function(input, init) {
    const pfOp = captureHeaders(input, init);
    if (counters.enabled && adEndpoint(input)) {
      counters.removed++;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rUrl = parseUrl(input);
    const reqMethod = (init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    let reqRange = '';
    let reqAccept = '';
    try {
      for (const source of [init?.headers, typeof Request !== 'undefined' && input instanceof Request ? input.headers : null]) {
        if (!source) continue;
        const h = new Headers(source);
        if (!reqRange) { const r = h.get('range'); if (r) reqRange = r; }
        if (!reqAccept) { const a = h.get('accept'); if (a) reqAccept = a; }
      }
    } catch {}
    if (rUrl) observeStorageResolveRequest(rUrl);
    const preloadHit = matchPreloadResponse(rUrl, reqMethod, reqRange, reqAccept);
    if (preloadHit) {
      counters.preloadHits++;
      const headers = new Headers({ 'Content-Type': preloadHit.contentType });
      if (preloadHit.bytes) {
        headers.set('Content-Length', String(preloadHit.bytes.byteLength));
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Access-Control-Allow-Origin', '*');
        if (preloadHit.contentRange) headers.set('Content-Range', preloadHit.contentRange);
      }
      const cachedResp = new Response(preloadHit.bytes ?? preloadHit.body, {
        status: preloadHit.status,
        statusText: preloadHit.statusText,
        headers,
      });
      try { Object.defineProperty(cachedResp, 'url', { value: rUrl.href }); } catch {}
      return cachedResp;
    }
    const response = await fetch.call(this, input, init);
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      try {
        const tokenLike = rUrl && (rUrl.hostname === 'clienttoken.spotify.com' || rUrl.pathname.endsWith('/api/token') || rUrl.pathname.endsWith('/get_access_token'));
        const metaTrack = Boolean(rUrl && matchMetadataTrackUrl(rUrl));
        const cLen = Number(response.headers.get('content-length')) || 0;
        if (rUrl && /(?:^|\.)spotify\.com$/i.test(rUrl.hostname) && cLen <= 2 * 1024 * 1024 && (tokenLike || pfOp || metaTrack)) {
          response.clone().text().then(txt => {
            if (txt.length > 2 * 1024 * 1024) return;
            noteTokenPayload(rUrl, txt);
            if (metaTrack) observeMetadataPayload(rUrl, txt);
            if (pfOp) {
              const json = JSON.parse(txt);
              if (json?.data) {
                setPfCache(pfOp, json.data);
                setPfTtl(pfOp, { data: json.data, at: Date.now() });
                if (pfOp.startsWith('libraryV3:all:0:') || pfOp.startsWith('libraryV3:Playlists:0:')) {
                  setPfCache('libraryV3', json.data);
                  setPfCache('libraryV3:Playlists', json.data);
                }
                if (pfOp.startsWith('fetchLibraryTracks:0:')) {
                  setPfCache('fetchLibraryTracks', json.data);
                  setPfCache('fetchLibraryTracks:0', json.data);
                }
              }
            }
          }).catch(() => {});
        }
      } catch {}
    }
    if (!counters.enabled || !stateEndpoint(input) || !response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
    try {
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) return response;
      const text = await response.clone().text();
      if (text.length > 2 * 1024 * 1024) return response;
      const data = JSON.parse(text);
      if (!transform(data)) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      const replacement = new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
      for (const key of ['url', 'redirected', 'type']) Object.defineProperty(replacement, key, { value: response[key] });
      return replacement;
    } catch { return response; }
  };

  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      const parsed = new URL(this.url);
      if (parsed.protocol !== 'wss:' || !/^(?:[a-z0-9-]+-)?dealer\.(?:[a-z0-9-]+\.)?spotify\.com$/i.test(parsed.hostname)) return;
      const add = NativeSocket.prototype.addEventListener, remove = NativeSocket.prototype.removeEventListener;
      const listeners = new WeakMap(), events = new WeakMap();
      const message = event => {
        if (!counters.enabled || typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return event;
        if (events.has(event)) return events.get(event);
        let result = event;
        try {
          const data = JSON.parse(event.data);
          if (transform(data)) {
            result = new MessageEvent(event.type, { data: JSON.stringify(data), origin: event.origin, lastEventId: event.lastEventId });
            for (const key of ['target', 'currentTarget']) Object.defineProperty(result, key, { value: event[key] });
          }
        } catch { /* Unknown messages stay untouched. */ }
        events.set(event, result);
        return result;
      };
      const wrapped = callback => {
        if ((typeof callback !== 'function' && !object(callback)) || callback === null) return callback;
        if (!listeners.has(callback)) listeners.set(callback, event => {
          if (typeof callback === 'function') callback.call(this, message(event));
          else callback.handleEvent(message(event));
        });
        return listeners.get(callback);
      };
      this.addEventListener = (type, callback, options) => add.call(this, type, type === 'message' ? wrapped(callback) : callback, options);
      this.removeEventListener = (type, callback, options) => remove.call(this, type, type === 'message' ? listeners.get(callback) ?? callback : callback, options);
      let handler = null;
      const propertyListener = event => handler?.call(this, message(event));
      Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: value => {
        if (handler) remove.call(this, 'message', propertyListener);
        handler = typeof value === 'function' ? value : null;
        if (handler) add.call(this, 'message', propertyListener);
      } });
    }
  };

  // What the web player shows in its bottom bar: read-only, display fields only.
  const testid = id => (typeof document !== 'undefined' ? (document.querySelector?.('[data-testid="' + id + '"]') ?? null) : null);
  const clip = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const clock = value => {
    const parts = clip(value).replace(/^-/, '').split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d{1,2}$/.test(part))) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  };
  const cdn = src => typeof src === 'string' && /^https:\/\/(?:[a-z0-9-]+\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)\/[^\s"'<>]{1,500}$/i.test(src) ? src : null;
  const range = id => testid(id)?.querySelector?.('input[type="range"]') ?? null;
  const checked = id => { const value = testid(id)?.getAttribute?.('aria-checked'); return value === 'true' ? true : value === 'mixed' ? 'mixed' : value === 'false' ? false : null; };
  function harmonyState() {
    try {
      for (const c of [
        harmonyPlayer?._state,
        harmonyController?._state,
        harmonyPlayer?._controller?._state,
      ]) {
        if (c && typeof c === 'object' && typeof c.then !== 'function' && (c.duration !== undefined || c.position !== undefined || c.track_window !== undefined)) {
          return c;
        }
      }
      if (typeof harmonyPlayer?.getState === 'function') {
        const maybe = harmonyPlayer.getState();
        if (maybe && typeof maybe.then === 'function') {
          maybe.catch?.(() => {});
        } else if (maybe && typeof maybe === 'object' && (maybe.duration !== undefined || maybe.position !== undefined || maybe.track_window !== undefined)) {
          return maybe;
        }
      }
    } catch {}
    return null;
  }
  function harmonyDurationSec() {
    try {
      const st = harmonyState();
      const ms = Number(
        st?.duration ??
        st?.track_window?.current_track?.duration_ms ??
        st?.item?.duration?.milliseconds ??
        st?.track?.duration_ms
      );
      if (Number.isFinite(ms) && ms >= 1000) return ms / 1000;
    } catch {}
    return 0;
  }
  function harmonyServerNowMs(rawTs) {
    // Spotify stores _state.timestamp in server epoch (_serverTime.getApproximate()), not Date.now();
    // mixing them injects the user's PC clock skew directly into playback position and lyrics sync.
    for (const host of [harmonyController, harmonyPlayer?._controller, harmonyPlayer]) {
      const srv = host?._serverTime;
      if (!srv || typeof srv.getApproximate !== 'function') continue;
      if ('_serverTimeFetchedAt' in srv && (srv._serverTimeFetchedAt === null || srv._serverTimeFetchedAt === undefined)) continue;
      if ('_serverTime' in srv && !Number.isFinite(Number(srv._serverTime))) continue;
      try {
        const now = Number(srv.getApproximate());
        if (Number.isFinite(now) && now > 0) return now;
      } catch {}
    }
    if (lastHarmonyClock && lastHarmonyClock.ts === rawTs) {
      return rawTs + Math.max(0, Date.now() - lastHarmonyClock.localAt);
    }
    return Date.now();
  }
  function harmonyPositionSec() {
    try {
      const st = harmonyState();
      if (!st) return null;
      const posMs = Number(st.position ?? st.position_as_of_timestamp);
      if (!Number.isFinite(posMs) || posMs < 0) return null;
      const durMs = Number(st.duration);
      const rawTs = Number(st.timestamp);
      if (!st.paused && !st.isPaused && !st.loading && rawTs > 0) {
        if (!lastHarmonyClock || lastHarmonyClock.ts !== rawTs) {
          lastHarmonyClock = { ts: rawTs, localAt: Date.now() };
        }
        const speed = Number(st.playback_speed) > 0 ? Number(st.playback_speed) : 1;
        const elapsed = Math.max(0, (harmonyServerNowMs(rawTs) - rawTs) * speed);
        const advanced = posMs + elapsed;
        return (Number.isFinite(durMs) && durMs > 0 ? Math.min(durMs, advanced) : advanced) / 1000;
      }
      return posMs / 1000;
    } catch {
      return null;
    }
  }
  function progress() {
    const adNow = isAdPlaying();
    const el = activeElement();
    const input = range('playback-progressbar');
    const max = Number(input?.max), value = Number(input?.value);
    const barPos = input && Number.isFinite(max) && max > 0 && Number.isFinite(value) ? Math.max(0, value) / 1000 : null;
    const barDur = input && Number.isFinite(max) && max > 0 ? max / 1000 : 0;
    const rawDurText = testid('playback-duration')?.textContent;
    const clockPos = clock(testid('playback-position')?.textContent);
    const clockDur = rawDurText && !clip(rawDurText).startsWith('-') ? (clock(rawDurText) ?? 0) : 0;
    const stateDur = adNow ? 0 : harmonyDurationSec();
    const statePos = adNow ? null : harmonyPositionSec();
    const elDur = el && Number.isFinite(el.duration) && el.duration > 1 && !adNow ? el.duration : 0;
    const elPos = el && !adNow ? Math.max(0, el.currentTime || 0) : null;
    const duration = stateDur || barDur || clockDur || elDur || 0;
    let position = 0;
    if (!adNow && lastSeekTargetSec !== null && Date.now() - lastSeekAt < 2000) {
      const seekAgeMs = Date.now() - lastSeekAt;
      // Treat immediate <audio> jumps toward target as live, while holding stale pre-seek positions until settled.
      const elMoved =
        elPos !== null &&
        (lastSeekFromSec === null ||
          Math.abs(lastSeekTargetSec - lastSeekFromSec) <= 0.15 ||
          Math.abs(elPos - lastSeekFromSec) > 0.15);
      if (statePos !== null && seekAgeMs >= 120 && Math.abs(statePos - lastSeekTargetSec) <= 0.85) {
        lastSeekTargetSec = null;
        lastSeekFromSec = null;
        position = statePos;
      } else if (elPos !== null && !el.paused && Math.abs(elPos - lastSeekTargetSec) <= 0.85 && (seekAgeMs >= 120 || elMoved)) {
        position = elPos;
      } else if (barPos !== null && seekAgeMs >= 120 && Math.abs(barPos - lastSeekTargetSec) <= 0.85) {
        position = barPos;
      } else {
        position = lastSeekTargetSec;
      }
    } else {
      lastSeekTargetSec = null;
      lastSeekFromSec = null;
      const st = adNow ? null : harmonyState();
      const inStartWindow = lastTrackStartAt > 0 && Date.now() - lastTrackStartAt < 4000;
      const harmonyLaggingPaused = Boolean(!inStartWindow && st && (st.paused || st.isPaused) && !st.loading && el && !el.paused && !el.ended);
      const alignedElPos =
        elPos !== null && !el.paused && (barPos === null || Math.abs(elPos - barPos) <= 2.5)
          ? elPos
          : null;
      // Never let a stale DOM playback-progressbar from the outgoing track override Harmony's fresh 0s start position!
      const stateStuckBehind =
        !inStartWindow &&
        statePos !== null &&
        ((statePos < 0.5 && el && !el.paused && alignedElPos !== null && alignedElPos > 2 && barPos !== null && barPos > 2) ||
          (harmonyLaggingPaused && ((barPos !== null && barPos > statePos + 1) || (alignedElPos !== null && alignedElPos > statePos + 1))));
      const reliableStatePos = statePos !== null && !stateStuckBehind ? statePos : null;
      let candidate = reliableStatePos ?? alignedElPos ?? barPos ?? clockPos ?? elPos ?? 0;
      // During a 0s switch from another track, suppress any single transition frame carrying the outgoing track's position.
      if (
        inStartWindow &&
        Date.now() - lastTrackStartAt < 2500 &&
        lastTrackStartSec === 0 &&
        switchFromTrackId &&
        switchFromTrackId !== desiredTrackId &&
        switchFromPosSec > 5 &&
        candidate > 5 &&
        Math.abs(candidate - switchFromPosSec) <= 6
      ) {
        candidate = 0;
      }
      position = candidate;
    }
    return { position, duration };
  }
  function extractTrackId(value) {
    if (typeof value !== 'string' || !value) return null;
    try { value = decodeURIComponent(value); } catch {}
    if (/^[A-Za-z0-9]{22}$/.test(value)) return value;
    const m = value.match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]{22})/);
    return m ? m[1] : null;
  }
  function nowPlayingTrackId(widget) {
    try {
      const state = harmonyState();
      const cur = state?.track_window?.current_track;
      const fromState = extractTrackId(cur?.uri || cur?.id || state?.item?.uri || state?.track?.uri || state?.uri);
      if (fromState) return fromState;
    } catch {}
    if (widget?.querySelectorAll) {
      for (const a of widget.querySelectorAll('a[href]')) {
        const id = extractTrackId(a.getAttribute?.('href') || a.href || '');
        if (id) return id;
      }
    }
    return null;
  }
  function nowPlayingLinkedFromId() {
    try {
      const state = harmonyState();
      const cur = state?.track_window?.current_track;
      return extractTrackId(cur?.linked_from?.uri || cur?.linked_from?.id);
    } catch {}
    return null;
  }
  function bufferedEndSec(el, posSec) {
    try {
      const b = el?.buffered;
      if (!b || !b.length) return 0;
      const t = Number.isFinite(posSec) ? posSec : (Number.isFinite(el.currentTime) ? el.currentTime : 0);
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) - 0.5 <= t && t <= b.end(i) + 0.5) return Math.max(0, b.end(i));
      }
      return 0;
    } catch {}
    return 0;
  }
  function isTrackEndedNow(el) {
    if (counters.trackEnded && counters.endedTrackId) return true;
    if (counters.startPending || isAdPlaying()) return false;
    if (counters.trackEnded) return true;
    const list = elements();
    const isFreshSongEnd = m =>
      Boolean(
        m?.ended &&
        !ignoredEndedMedia?.has(m) &&
        Number.isFinite(m.duration) &&
        m.duration > 15
      );
    const node = el === undefined ? activeElement() : el;
    if (isFreshSongEnd(node)) return true;
    return list.some(m => isFreshSongEnd(m) && !list.some(other => other !== m && !other.paused && !other.ended));
  }
  function nowPlaying() {
    const adNow = isAdPlaying();
    const widget = testid('now-playing-widget');
    const meta = window.navigator?.mediaSession?.metadata;
    const hTrack = adNow ? null : harmonyState()?.track_window?.current_track;
    const title =
      clip(hTrack?.name) ||
      clip(meta?.title) ||
      clip(widget?.querySelector?.('[data-testid="context-item-info-title"]')?.textContent);
    if (!title && !adNow) return null;
    const hArtists = Array.isArray(hTrack?.artists) ? hTrack.artists.map(a => clip(a?.name)).filter(Boolean).join(', ') : '';
    const artist =
      hArtists ||
      clip(meta?.artist) ||
      clip(widget?.querySelector?.('[data-testid="context-item-info-subtitles"]')?.textContent);
    const artwork = [...(meta?.artwork ?? [])].map(item => ({ src: cdn(item?.src), size: parseInt(item?.sizes, 10) || 0 })).filter(item => item.src).sort((a, b) => a.size - b.size);
    const hImages = [...(hTrack?.album?.images ?? [])].map(item => ({ src: cdn(item?.url), size: Number(item?.width) || 300 })).filter(item => item.src).sort((a, b) => a.size - b.size);
    const fallback = cdn(widget?.querySelector?.('img')?.src);
    const small = hImages[0]?.src ?? artwork.find(item => item.size >= 64)?.src ?? artwork[0]?.src ?? fallback ?? null;
    const large = hImages[hImages.length - 1]?.src ?? artwork[artwork.length - 1]?.src ?? fallback ?? small;
    const like = widget?.querySelector?.('[data-testid="add-button"][aria-checked]');
    const volume = range('volume-bar');
    const level = volume ? Number(volume.value) / (Number(volume.max) || 1) : null;
    const el = activeElement();
    const elVol = el ? getNativeVol(el) : null;
    const reportedVol =
      adNow || unwantedBleedMuted || switchMuteUntilTarget || hardPaused
        ? (desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume)))
        : (Number.isFinite(elVol) ? Math.min(1, Math.max(0, elVol)) : (Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : null));
    const repeat = checked('control-button-repeat');
    const playback = playing();
    const prog = progress();
    return {
      trackId: adNow ? null : nowPlayingTrackId(widget),
      linkedFromTrackId: adNow ? null : nowPlayingLinkedFromId(),
      isAd: adNow,
      paused: playback !== true,
      title: adNow ? 'Реклама' : title,
      artist,
      album: clip(hTrack?.album?.name) || clip(meta?.album),
      cover: small,
      coverLarge: large,
      ...prog,
      buffered: adNow ? null : bufferedEndSec(el, prog.position),
      trackEnded: isTrackEndedNow(el),
      endedTrackId: counters.endedTrackId || null,
      liked: like ? like.getAttribute?.('aria-checked') === 'true' : null,
      shuffle: checked('control-button-shuffle') === true,
      repeat: repeat === 'mixed' ? 'one' : repeat === true ? 'all' : 'off',
      volume: reportedVol,
    };
  }
  function setRange(input, value) {
    if (!input || input.disabled) return false;
    const min = Number(input.min) || 0, max = Number(input.max);
    if (!Number.isFinite(max) || max <= min) return false;
    try { if (Number(input.step) > 100) input.step = '1'; } catch {}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(Math.min(max, Math.max(min, value))));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function click(selector) {
    const target = typeof document !== 'undefined' ? document.querySelector?.(selector) : null;
    if (!target || target.disabled) return false;
    target.click();
    return true;
  }

  function getDeviceId() {
    if (auth.deviceId) return auth.deviceId;
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('nocturne_sp_did') : '';
      if (saved && /^[a-f0-9]{32}$/.test(saved)) { auth.deviceId = saved; return saved; }
      const bytes = new Uint8Array(16);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      auth.deviceId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('nocturne_sp_did', auth.deviceId); } catch {}
    } catch { auth.deviceId = '0123456789abcdef0123456789abcdef'; }
    return auth.deviceId;
  }
  function readServerConfig() {
    if (typeof document === 'undefined' || typeof atob !== 'function') return;
    try {
      const raw = document.getElementById?.('appServerConfig')?.textContent?.trim();
      if (!raw) return;
      const cfg = JSON.parse(atob(raw));
      if (typeof cfg?.clientVersion === 'string' && cfg.clientVersion) auth.clientVersion = cfg.clientVersion;
      if (typeof cfg?.market === 'string' && cfg.market) auth.market = cfg.market;
      if (typeof cfg?.locale?.locale === 'string' && cfg.locale.locale) auth.acceptLanguage = cfg.locale.locale;
    } catch {}
  }
  function tokenValid() {
    return Boolean(auth.token && (!auth.tokenExpiresAt || Date.now() < auth.tokenExpiresAt - 15_000));
  }
  function readDomSessionToken() {
    if (tokenValid()) return auth.token;
    readServerConfig();
    if (typeof document === 'undefined') return '';
    try {
      const scripts = [
        document.getElementById?.('session'),
        ...(document.querySelectorAll?.('script') ?? []),
      ];
      for (const el of scripts) {
        const txt = el?.textContent || '';
        if (!txt || !txt.includes('accessToken')) continue;
        noteTokenPayload(null, txt);
        if (tokenValid()) return auth.token;
      }
    } catch {}
    return '';
  }
  async function ensureClientToken(force = false) {
    if (!force && auth.clientToken && (!auth.clientTokenExpiresAt || Date.now() < auth.clientTokenExpiresAt - 60_000)) {
      return auth.clientToken;
    }
    if (clientTokenPromise) return clientTokenPromise;
    if (Date.now() < clientTokenCooldownUntil) return auth.clientToken;
    readServerConfig();
    clientTokenPromise = (async () => {
      try {
        const res = await fetch.call(window, 'https://clienttoken.spotify.com/v1/clienttoken', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_data: {
              client_version: auth.clientVersion || '1.2.88.442',
              client_id: auth.clientId || 'd8a5ed958d274c2e8ee717e6a4b0971d',
              js_sdk_data: {
                device_brand: 'unknown',
                device_model: 'unknown',
                os: 'windows',
                os_version: 'NT 10.0',
                container_version: '1.0',
                device_id: getDeviceId(),
                device_type: 'computer',
                platform_identifier: 'web_player',
              },
            },
          }),
        });
        if (res.status === 429) {
          clientTokenCooldownUntil = Date.now() + 10_000;
          return auth.clientToken;
        }
        if (res.ok) {
          const txt = await res.text();
          noteTokenPayload(new URL('https://clienttoken.spotify.com/v1/clienttoken'), txt);
        } else {
          clientTokenCooldownUntil = Date.now() + 5_000;
        }
      } catch {
        clientTokenCooldownUntil = Date.now() + 3_000;
      } finally {
        clientTokenPromise = null;
      }
      return auth.clientToken;
    })();
    return clientTokenPromise;
  }
  async function tryFetchSessionTokenOnce() {
    const now = Date.now();
    if (tokenValid() || now - lastTokenFallbackAt < 15_000) return auth.token;
    lastTokenFallbackAt = now;
    try {
      const res = await fetch.call(window, 'https://open.spotify.com/api/token?reason=init&productType=web-player', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        noteTokenPayload(null, await res.text());
      } else if (res.status === 429) {
        lastTokenFallbackAt = now + 30_000;
      }
    } catch {}
    return auth.token;
  }
  async function ensureToken(timeoutMs = 5000) {
    if (readDomSessionToken()) {
      await ensureClientToken(false);
      return auth.token;
    }
    if (!tokenWaitPromise) {
      tokenWaitPromise = (async () => {
        const deadline = Date.now() + timeoutMs;
        let triedFallback = false;
        while (Date.now() < deadline) {
          if (readDomSessionToken()) {
            await ensureClientToken(false);
            return auth.token;
          }
          if (!triedFallback && (document.readyState !== 'loading' || deadline - Date.now() < Math.max(0, timeoutMs - 200))) {
            triedFallback = true;
            await tryFetchSessionTokenOnce();
            if (tokenValid()) {
              await ensureClientToken(false);
              return auth.token;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        return auth.token;
      })().finally(() => { tokenWaitPromise = null; });
    }
    return tokenWaitPromise;
  }
  function domMe() {
    const widget = testid('user-widget-link');
    const name = clip(widget?.getAttribute?.('aria-label')) || clip(widget?.textContent) || 'Spotify';
    const avatar = cdn(widget?.querySelector?.('img')?.src);
    return {
      id: 'spotify_user',
      display_name: name,
      images: avatar ? [{ url: avatar, width: 300 }] : [],
    };
  }
  function domPlaylists() {
    const seen = new Set();
    const items = [];
    const selector = [
      '[data-testid="left-sidebar"] a[href^="/playlist/"]',
      '[aria-label*="Медиатека"] a[href^="/playlist/"]',
      '[aria-label*="Your Library"] a[href^="/playlist/"]',
      '[data-testid="rootlist"] a[href^="/playlist/"]',
    ].join(', ');
    for (const a of document.querySelectorAll?.(selector) ?? []) {
      if (a.closest?.('main, aside, [data-testid="home-page"], [data-testid="component-shelf"], [data-testid="now-playing-bar"]')) continue;
      const href = a.getAttribute?.('href') || '';
      const m = href.match(/^\/playlist\/([A-Za-z0-9]{22})/);
      if (!m || seen.has(m[1])) continue;
      const card = a.closest?.('[data-encore-id="card"], [role="listitem"], [role="row"], li') || a.parentElement;
      const name = clip(a.textContent) || clip(a.getAttribute?.('aria-label')) || clip(card?.textContent);
      if (!name) continue;
      seen.add(m[1]);
      const img = cdn(card?.querySelector?.('img')?.src);
      items.push({
        id: m[1],
        type: 'playlist',
        name: name.slice(0, 120),
        images: img ? [{ url: img, width: 300 }] : [],
      });
    }
    return { items };
  }
  function invalidatePfCache(prefix) {
    for (const k of pfTtl.keys()) {
      if (!prefix || k.startsWith(prefix)) pfTtl.delete(k);
    }
    if (!prefix) {
      for (const k of Object.keys(pfCache)) delete pfCache[k];
    } else {
      for (const k of Object.keys(pfCache)) {
        if (k.startsWith(prefix)) delete pfCache[k];
      }
    }
  }
  function apiHeaders() {
    const headers = {
      Accept: 'application/json',
      'app-platform': auth.appPlatform || 'WebPlayer',
      'spotify-app-version': auth.appVersion || '896000000',
    };
    if (auth.token) headers.authorization = auth.token;
    if (auth.clientToken) headers['client-token'] = auth.clientToken;
    if (auth.acceptLanguage) headers['accept-language'] = auth.acceptLanguage;
    return headers;
  }
  async function changeLibraryViaWebApi(method, uris) {
    if (!uris.length) throw new Error('MISSING_LIBRARY_URI');
    if (!await ensureToken(2500)) throw new Error('SIGNED_OUT');
    await ensureClientToken(false);
    const query = new URLSearchParams({ uris: uris.join(',') });
    const res = await fetch.call(window, `https://api.spotify.com/v1/me/library?${query}`, { method, headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
  }
  async function queryPathfinder(operationName, variables = {}, opts = {}) {
    const key = operationName + ':' + JSON.stringify(variables);
    const cKey = CACHEABLE_PF.has(operationName) ? pfCacheKey(operationName, variables) : '';
    const ttlMs = opts.ttlMs ?? (CACHEABLE_PF.has(operationName) ? 45_000 : 20_000);
    if (!opts.fresh && ttlMs > 0) {
      const cached = pfTtl.get(key) || (cKey ? pfTtl.get(cKey) : null);
      if (cached && Date.now() - cached.at < ttlMs) return cached.data;
    }
    if (pfInFlight.has(key)) return pfInFlight.get(key);
    const fallbackCached = () => {
      if (opts.fresh) return null;
      const stale = pfTtl.get(key)?.data || (cKey ? pfCache[cKey] : null);
      if (stale) return stale;
      if (operationName === 'libraryV3' && (Number(variables?.offset) || 0) === 0 && pfCache['libraryV3:all']) return pfCache['libraryV3:all'];
      if (operationName === 'fetchLibraryTracks' && (Number(variables?.offset) || 0) === 0 && pfCache.fetchLibraryTracks) return pfCache.fetchLibraryTracks;
      return null;
    };

    const storeResult = data => {
      if (cKey) {
        setPfCache(cKey, data);
        if (cKey.startsWith('libraryV3:all:0:') || cKey.startsWith('libraryV3:Playlists:0:')) {
          setPfCache('libraryV3', data);
          setPfCache('libraryV3:Playlists', data);
        } else if (cKey.startsWith('fetchLibraryTracks:0:')) {
          setPfCache('fetchLibraryTracks', data);
          setPfCache('fetchLibraryTracks:0', data);
        } else if (!cKey.includes(':')) {
          setPfCache(operationName, data);
        }
        if (ttlMs > 0) setPfTtl(cKey, { data, at: Date.now() });
      }
      if (ttlMs > 0) setPfTtl(key, { data, at: Date.now() });
    };

    const reqPromise = (async () => {
      if (Date.now() < rateLimitedUntil) {
        const fb = fallbackCached();
        if (fb) return fb;
        const waitMs = rateLimitedUntil - Date.now();
        if (waitMs > 3500) throw new Error('HTTP_429');
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      await ensureToken(4500);
      await ensureClientToken(false);
      const sha256Hash = hashes[operationName];
      if (!sha256Hash || !auth.token) throw new Error('SIGNED_OUT');

      await acquirePfSlot();
      try {
        const body = JSON.stringify({
          variables,
          operationName,
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        });
        let retriedAuth = false;
        let retried429 = false;
        let lastErr = 'PF_FAILED';
        for (const endpoint of [
          'https://api-partner.spotify.com/pathfinder/v2/query',
          'https://api-partner.spotify.com/pathfinder/v1/query',
        ]) {
          try {
            const headers = { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' };
            let res = await fetch.call(window, endpoint, { method: 'POST', headers, body });
            if (res.status === 429 && !retried429) {
              const fb = fallbackCached();
              if (fb) return fb;
              retried429 = true;
              const retrySec = Number(res.headers.get('retry-after')) || 2;
              const pauseMs = Math.min(3000, Math.max(1200, retrySec * 1000));
              rateLimitedUntil = Date.now() + pauseMs;
              await new Promise(resolve => setTimeout(resolve, pauseMs));
              res = await fetch.call(window, endpoint, { method: 'POST', headers, body });
            }
            if (res.status === 429) {
              const retrySec = Number(res.headers.get('retry-after')) || 3;
              rateLimitedUntil = Date.now() + Math.min(20_000, Math.max(2_500, retrySec * 1000));
              const fb = fallbackCached();
              if (fb) return fb;
              lastErr = 'HTTP_429';
              break;
            }
            if ((res.status === 401 || res.status === 403) && !retriedAuth) {
              retriedAuth = true;
              if (res.status === 401) {
                auth.token = '';
                auth.tokenExpiresAt = 0;
                await ensureToken(4500);
              }
              await ensureClientToken(true);
              const retryHeaders = { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' };
              const retryRes = await fetch.call(window, endpoint, { method: 'POST', headers: retryHeaders, body });
              if (retryRes.ok) {
                const json = await retryRes.json();
                if (json?.data) {
                  storeResult(json.data);
                  return json.data;
                }
              }
              lastErr = `HTTP_${retryRes.status}`;
              if (retryRes.status === 401) { auth.token = ''; auth.tokenExpiresAt = 0; break; }
              continue;
            }
            if (!res.ok) {
              lastErr = `HTTP_${res.status}`;
              if (res.status !== 404) break;
              continue;
            }
            const json = await res.json();
            if (json?.data) {
              storeResult(json.data);
              return json.data;
            }
            if (Array.isArray(json?.errors) && json.errors[0]?.message) {
              lastErr = 'GQL_' + String(json.errors[0].message).slice(0, 40).replace(/\s+/g, '_');
              break;
            }
          } catch {
            lastErr = 'NETWORK_ERROR';
          }
        }
        if (lastErr !== 'HTTP_401') {
          const fb = fallbackCached();
          if (fb) return fb;
        }
        throw new Error(lastErr);
      } finally {
        releasePfSlot();
      }
    })().finally(() => { pfInFlight.delete(key); });

    pfInFlight.set(key, reqPromise);
    return reqPromise;
  }
  async function getHomeData(fresh = false) {
    const cachedHome = !fresh ? pfTtl.get('home') : null;
    if (cachedHome && Date.now() - cachedHome.at < 45_000 && cachedHome.data?.home) return cachedHome.data.home;
    const spTCookie = (typeof document !== 'undefined' && document.cookie || '').match(/(?:^|;\s*)sp_t=([^;]+)/)?.[1] || '';
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat?.().resolvedOptions?.().timeZone) || 'Europe/Moscow';
    const vars = auth.homeVars || {
      homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
      includeHomeChapterVideoCards: false,
      includeEpisodeContentRatingsV2: false,
      timeZone: tz,
      sp_t: spTCookie,
      facet: '',
      sectionItemsLimit: 12,
    };
    const data = await queryPathfinder('home', vars, { fresh });
    return data?.home;
  }
  function extractHomeItems(homeObj, wrapperType) {
    const out = [];
    const sections = homeObj?.sectionContainer?.sections?.items ?? [];
    for (const sec of sections) {
      for (const entry of sec?.sectionItems?.items ?? []) {
        const content = entry?.content;
        if (content?.__typename === wrapperType && content?.data) {
          out.push({ ...content.data, uri: content.data.uri || entry.uri });
        }
      }
    }
    return out;
  }
  async function getArtistOverview(id) {
    const cacheKey = 'artist_' + id;
    const cached = pfTtl.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.data;
    const data = await queryPathfinder('queryArtistOverview', {
      uri: `spotify:artist:${id}`,
      locale: '',
      preReleaseV2: false,
      includeMusicVideoPreviews: false,
    }).catch(err => {
      if (pfCache[cacheKey]) return { artistUnion: pfCache[cacheKey] };
      throw err;
    });
    if (data?.artistUnion) {
      setPfCache(cacheKey, data.artistUnion);
      setPfTtl(cacheKey, { data: data.artistUnion, at: Date.now() });
    }
    return data?.artistUnion;
  }
  async function embedEntity(kind, id) {
    const res = await fetch.call(window, `https://open.spotify.com/embed/${kind}/${id}`, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error('no embed data');
    const json = JSON.parse(match[1]);
    const entity = json?.props?.pageProps?.state?.data?.entity;
    if (!entity) throw new Error('missing entity');
    return { source: 'embed', entity };
  }
  const artistImgInFlight = new Map();
  let webApiArtistsBlockedUntil = 0;
  function timeoutSignal(ms) {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  }
  function artistIdOf(a) {
    const raw = a?.id || a?.uri || a?._uri || '';
    const m = String(raw).match(/([A-Za-z0-9]{22})$/);
    return m ? m[1] : '';
  }
  function artistHasAvatar(a) {
    if (!a || typeof a !== 'object') return false;
    if (Array.isArray(a.images) && a.images.some(x => cdn(x?.url))) return true;
    if (Array.isArray(a.images?.sources) && a.images.sources.some(x => cdn(x?.url))) return true;
    if (Array.isArray(a.visuals?.avatarImage?.sources) && a.visuals.avatarImage.sources.some(x => cdn(x?.url))) return true;
    if (Array.isArray(a.visuals?.avatar?.sources) && a.visuals.avatar.sources.some(x => cdn(x?.url))) return true;
    if (Array.isArray(a.visualIdentity?.image) && a.visualIdentity.image.some(x => cdn(x?.url))) return true;
    if (Array.isArray(a.cardRepresentation?.artwork?.sources) && a.cardRepresentation.artwork.sources.some(x => cdn(x?.url))) return true;
    return false;
  }
  function extractArtistVisualMeta(src) {
    if (!artistHasAvatar(src)) return null;
    const meta = {};
    if (Array.isArray(src.images) && src.images.some(x => cdn(x?.url))) meta.images = src.images;
    if (src.visuals?.avatarImage?.sources?.some?.(x => cdn(x?.url))) {
      meta.visuals = { avatarImage: src.visuals.avatarImage };
    } else if (src.visuals?.avatar?.sources?.some?.(x => cdn(x?.url))) {
      meta.visuals = { avatar: src.visuals.avatar };
    }
    if (src.visualIdentity?.image?.some?.(x => cdn(x?.url))) meta.visualIdentity = src.visualIdentity;
    if (src.cardRepresentation?.artwork?.sources?.some?.(x => cdn(x?.url))) meta.cardRepresentation = src.cardRepresentation;
    if (src.followers) meta.followers = src.followers;
    if (src.stats) meta.stats = src.stats;
    if (Array.isArray(src.genres) && src.genres.length) meta.genres = src.genres;
    return meta;
  }
  function applyArtistVisualMeta(target, meta) {
    if (!target || typeof target !== 'object' || !meta) return target;
    if (meta.images && !target.images?.some?.(x => cdn(x?.url))) target.images = meta.images;
    if (meta.visuals && !target.visuals?.avatarImage?.sources?.some?.(x => cdn(x?.url))) {
      target.visuals = { ...(target.visuals || {}), ...meta.visuals };
    }
    if (meta.visualIdentity && !target.visualIdentity?.image?.some?.(x => cdn(x?.url))) target.visualIdentity = meta.visualIdentity;
    if (meta.cardRepresentation && !target.cardRepresentation?.artwork?.sources?.some?.(x => cdn(x?.url))) {
      target.cardRepresentation = meta.cardRepresentation;
    }
    if (meta.followers && !target.followers) target.followers = meta.followers;
    if (meta.stats && !target.stats) target.stats = meta.stats;
    if (meta.genres && !target.genres) target.genres = meta.genres;
    return target;
  }
  function cacheArtistVisualMeta(id, src) {
    if (!id) return null;
    const meta = extractArtistVisualMeta(src);
    if (meta) pfCache['artist_img_' + id] = meta;
    return meta;
  }
  function getCachedArtistVisualMeta(id) {
    if (!id) return null;
    if (pfCache['artist_img_' + id]) return pfCache['artist_img_' + id];
    const full = pfCache['artist_' + id];
    return full ? cacheArtistVisualMeta(id, full) : null;
  }
  async function fetchSingleArtistVisualMeta(id, allowOverviewFallback) {
    const cached = getCachedArtistVisualMeta(id);
    if (cached) return cached;
    if (artistImgInFlight.has(id)) return artistImgInFlight.get(id);
    const p = (async () => {
      try {
        const signal = timeoutSignal(2500);
        const res = await fetch.call(
          window,
          `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/artist/${id}`)}`,
          { credentials: 'omit', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) },
        );
        if (res.ok) {
          const json = await res.json().catch(() => null);
          const url = cdn(json?.thumbnail_url);
          if (url) {
            const meta = cacheArtistVisualMeta(id, {
              images: [{ url, width: Number(json?.thumbnail_width) || 320, height: Number(json?.thumbnail_height) || 320 }],
            });
            if (meta) return meta;
          }
        }
      } catch {}
      try {
        const emb = await embedEntity('artist', id);
        const meta = cacheArtistVisualMeta(id, emb?.entity);
        if (meta) return meta;
      } catch {}
      if (allowOverviewFallback) {
        try {
          const ar = await getArtistOverview(id);
          const meta = cacheArtistVisualMeta(id, ar);
          if (meta) return meta;
        } catch {}
      }
      return null;
    })().finally(() => { artistImgInFlight.delete(id); });
    artistImgInFlight.set(id, p);
    return p;
  }
  async function hydrateArtistAvatars(items, { maxItems = 15, allowOverviewFallback = false } = {}) {
    if (!Array.isArray(items) || !items.length) return items;
    const deadline = Date.now() + 5500;
    const applyPass = () => {
      const missing = [];
      const seenMissing = new Set();
      for (const item of items.slice(0, maxItems)) {
        const id = artistIdOf(item);
        if (!id) continue;
        if (artistHasAvatar(item)) {
          cacheArtistVisualMeta(id, item);
          continue;
        }
        const cached = getCachedArtistVisualMeta(id);
        if (cached) {
          applyArtistVisualMeta(item, cached);
        } else if (!seenMissing.has(id)) {
          seenMissing.add(id);
          missing.push(id);
        }
      }
      return missing;
    };
    let missing = applyPass();
    if (!missing.length) return items;

    if (auth.token && Date.now() >= webApiArtistsBlockedUntil && Date.now() < deadline) {
      try {
        const signal = timeoutSignal(2500);
        const res = await fetch.call(window, `https://api.spotify.com/v1/artists?ids=${missing.slice(0, 50).join(',')}`, {
          headers: { Accept: 'application/json', authorization: auth.token },
          ...(signal ? { signal } : {}),
        });
        if (res.status === 429) {
          webApiArtistsBlockedUntil = Date.now() + 30_000;
        } else if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
          webApiArtistsBlockedUntil = Date.now() + 5 * 60_000;
        } else if (res.ok) {
          const json = await res.json().catch(() => null);
          for (const ar of json?.artists ?? []) {
            const aid = artistIdOf(ar);
            if (aid) cacheArtistVisualMeta(aid, ar);
          }
        }
      } catch {
        webApiArtistsBlockedUntil = Date.now() + 60_000;
      }
      missing = applyPass();
      if (!missing.length) return items;
    }

    if (Date.now() < deadline) {
      let cursor = 0;
      let timer = 0;
      const workers = Math.min(4, missing.length);
      await Promise.race([
        Promise.all(Array.from({ length: workers }, async () => {
          while (cursor < missing.length && Date.now() < deadline) {
            const id = missing[cursor++];
            await fetchSingleArtistVisualMeta(id, allowOverviewFallback);
          }
        })).finally(() => clearTimeout(timer)),
        new Promise(resolve => { timer = setTimeout(resolve, Math.max(200, deadline - Date.now())); }),
      ]);
      applyPass();
    }
    return items;
  }
  async function fetchSeedRadio(seedUri) {
    await ensureToken(3500);
    await ensureClientToken(false);
    const idMatch = seedUri.match(/spotify:(track|artist|album):([A-Za-z0-9]{22})/);
    const kind = idMatch?.[1] || '';
    const seedId = idMatch?.[2] || '';
    if (auth.token) {
      try {
        const url = `https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/${encodeURIComponent(seedUri)}?response-format=json`;
        const res = await fetch.call(window, url, { headers: apiHeaders() });
        if (res.ok) {
          const json = await res.json();
          const candidates = [
            json?.mediaItems?.[0]?.uri,
            json?.playlistUri,
            json?.uri,
          ].filter(Boolean);
          for (const c of candidates) {
            const m = String(c).match(/spotify:playlist:([A-Za-z0-9]{22})/);
            if (m) {
              const pl = await queryPathfinder('fetchPlaylist', {
                uri: `spotify:playlist:${m[1]}`,
                offset: 0,
                limit: 50,
                enableWatchFeedEntrypoint: false,
              });
              if (pl?.playlistV2?.content?.items?.length) {
                return { playlistUri: `spotify:playlist:${m[1]}`, name: pl.playlistV2.name || '', items: pl.playlistV2.content.items };
              }
            }
          }
        }
      } catch {}
    }
    if (kind === 'track' && seedId) {
      const rec = await queryPathfinder('internalLinkRecommenderTrack', { uri: seedUri, limit: 25 }).catch(() => null);
      const tracks = (rec?.seoRecommendedTrack?.items ?? []).map(x => x?.data ?? x).filter(Boolean);
      if (tracks.length) return { items: tracks };
    }
    if (kind === 'artist' && seedId) {
      const ar = await getArtistOverview(seedId).catch(() => null);
      const top = (ar?.discography?.topTracks?.items ?? []).map(x => x?.track ?? x).filter(Boolean);
      if (top.length) return { items: top };
    }
    if (kind === 'album' && seedId) {
      const al = await queryPathfinder('getAlbum', { uri: seedUri, locale: '', offset: 0, limit: 30 }).catch(() => null);
      const trs = (al?.albumUnion?.tracksV2?.items ?? []).map(x => x?.track ?? x).filter(Boolean);
      if (trs.length) return { items: trs };
    }
    return { items: [] };
  }
  async function runSpec(spec) {
    if (spec.kind === 'embed') return await embedEntity(spec.entity, spec.id);
    if (spec.kind === 'waveform') {
      const token = await ensureToken(2500);
      if (token) {
        await ensureClientToken(false);
        try {
          const res = await fetch.call(window, `https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/${spec.id}?format=json`, { headers: apiHeaders() });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data?.segments) && data.segments.length > 0) {
              return { segments: data.segments.map(s => [Number(s.start) || 0, Number(s.duration) || 0, Number(s.loudness_max) || -30]) };
            }
          }
        } catch {}
      }
      try {
        const { entity } = await embedEntity('track', spec.id);
        if (entity?.audioPreview?.url) {
          return { previewUrl: entity.audioPreview.url, durationMs: entity?.duration ?? 0 };
        }
      } catch {}
      if (token) {
        try {
          const data = await queryPathfinder('trackPreview', { uris: [`spotify:track:${spec.id}`] });
          const item = data?.lookup?.[0]?.data;
          const url = item?.previews?.audioPreviewsV2?.items?.[0]?.url || item?.previews?.audioPreviews?.items?.[0]?.url || null;
          if (url) return { previewUrl: url, durationMs: Number(item?.duration?.totalMilliseconds) || 0 };
        } catch {}
      }
      return { previewUrl: null };
    }

    const parsedPath = new URL(spec.path, 'https://open.spotify.com');
    const route = parsedPath.pathname;
    const params = parsedPath.searchParams;
    const method = (spec.method || 'GET').toUpperCase();

    if (route === '/me') {
      try {
        const data = pfCache.profileAttributes || await queryPathfinder('profileAttributes', {});
        const p = data?.me?.profile;
        if (p) {
          return {
            id: p.uri?.split(':').pop() || p.username || 'spotify_user',
            uri: p.uri,
            display_name: p.name || p.username || 'Spotify',
            images: p.avatar?.sources || [],
          };
        }
      } catch {}
      return domMe();
    }

    if (route === '/home') {
      const homeObj = await getHomeData(params.get('fresh') === '1');
      if (!homeObj) throw new Error('PF_FAILED');
      const sections = (homeObj.sectionContainer?.sections?.items ?? []).map(sec => ({
        uri: sec?.uri || '',
        typename: sec?.data?.__typename || '',
        title: sec?.data?.title?.transformedLabel || '',
        subtitle: sec?.data?.subtitle?.transformedLabel || '',
        items: (sec?.sectionItems?.items ?? []).map(entry => ({
          uri: entry?.uri || entry?.content?.data?.uri || '',
          typename: entry?.content?.__typename || entry?.content?.data?.__typename || '',
          data: entry?.content?.data || null,
        })).filter(it => it.data),
      })).filter(s => s.items.length > 0);
      const unhydratedArtists = [];
      for (const sec of sections) {
        for (const it of sec.items) {
          if (it.typename === 'ArtistResponseWrapper' && it.data && !artistHasAvatar(it.data)) {
            unhydratedArtists.push(it.data);
          }
        }
      }
      if (unhydratedArtists.length) {
        await hydrateArtistAvatars(unhydratedArtists, { maxItems: 15, allowOverviewFallback: false });
      }
      return {
        greeting: homeObj?.greeting?.transformedLabel || '',
        sections,
      };
    }

    if (route === '/browse') {
      const catQ = (params.get('q') || '').trim();
      const catId = (params.get('id') || '').trim();
      const rawUri = (params.get('uri') || '').trim();
      const pageUri = /^spotify:(?:page|genre):[A-Za-z0-9_-]+$/i.test(rawUri)
        ? rawUri
        : /^[A-Za-z0-9_-]{8,64}$/.test(catId)
          ? `spotify:page:${catId}`
          : '';
      if (pageUri || catQ || catId) {
        const playlists = [];
        const albums = [];
        const artists = [];
        const tracks = [];
        const sections = [];
        const subcategories = [];
        const seenPl = new Set();
        const seenAl = new Set();
        const seenAr = new Set();
        const seenTr = new Set();
        let headerTitle = catQ;

        if (pageUri) {
          try {
            const pageData = await queryPathfinder('browsePage', {
              pagePagination: { offset: 0, limit: 10 },
              sectionPagination: { offset: 0, limit: 12 },
              uri: pageUri,
              browseEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
              includeEpisodeContentRatingsV2: false,
            });
            const br = pageData?.browse;
            const rawHeaderTitle = br?.header?.title?.transformedLabel;
            if (typeof rawHeaderTitle === 'string' && rawHeaderTitle.trim()) {
              headerTitle = rawHeaderTitle.trim();
            }
            for (const sec of br?.sections?.items ?? []) {
              const secTitle = clip(sec?.data?.title?.transformedLabel || sec?.data?.heading?.transformedLabel || '');
              const secPlaylists = [];
              const secAlbums = [];
              const secArtists = [];
              const secTracks = [];
              for (const entry of sec?.sectionItems?.items ?? []) {
                const c = entry?.content;
                const d = c?.data;
                if (!d) continue;
                const tn = c?.__typename || d?.__typename || '';
                const u = String(d?.uri || entry?.uri || '');
                if (tn === 'BrowseSectionContainerWrapper' || tn === 'BrowseSectionContainer') {
                  const cr = d?.data?.cardRepresentation;
                  const subTitle = clip(cr?.title?.transformedLabel || d?.title?.transformedLabel || '');
                  const subUri = String(entry?.uri || d?.uri || '');
                  const subImg = cr?.artwork?.sources?.[0]?.url || d?.artwork?.sources?.[0]?.url || '';
                  const subColor = cr?.backgroundColor?.hex || d?.backgroundColor?.hex || '';
                  if (subTitle && subUri) subcategories.push({ uri: subUri, title: subTitle, color: subColor, image: subImg });
                  continue;
                }
                const itemWithUri = { ...d, uri: u || d?.uri };
                const mPl = u.match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
                if (mPl || tn === 'PlaylistResponseWrapper' || tn === 'Playlist') {
                  const pid = mPl?.[1] || u.split(':').pop();
                  if (pid) {
                    secPlaylists.push(itemWithUri);
                    if (!seenPl.has(pid)) {
                      seenPl.add(pid);
                      playlists.push(itemWithUri);
                    }
                  }
                  continue;
                }
                const mAl = u.match(/^spotify:album:([A-Za-z0-9]{22})$/);
                if (mAl || tn === 'AlbumResponseWrapper' || tn === 'Album') {
                  const aid = mAl?.[1] || u.split(':').pop();
                  if (aid) {
                    secAlbums.push(itemWithUri);
                    if (!seenAl.has(aid)) {
                      seenAl.add(aid);
                      albums.push(itemWithUri);
                    }
                  }
                  continue;
                }
                const mAr = u.match(/^spotify:artist:([A-Za-z0-9]{22})$/);
                if (mAr || tn === 'ArtistResponseWrapper' || tn === 'Artist') {
                  const arid = mAr?.[1] || u.split(':').pop();
                  if (arid) {
                    secArtists.push(itemWithUri);
                    if (!seenAr.has(arid)) {
                      seenAr.add(arid);
                      artists.push(itemWithUri);
                    }
                  }
                  continue;
                }
                const mTr = u.match(/^spotify:track:([A-Za-z0-9]{22})$/);
                if (mTr || tn === 'TrackResponseWrapper' || tn === 'Track') {
                  const tid = mTr?.[1] || u.split(':').pop();
                  if (tid) {
                    secTracks.push(itemWithUri);
                    if (!seenTr.has(tid)) {
                      seenTr.add(tid);
                      tracks.push(itemWithUri);
                    }
                  }
                }
              }
              if (secPlaylists.length || secAlbums.length || secArtists.length || secTracks.length) {
                sections.push({
                  id: sec?.uri || secTitle || `sec_${sections.length}`,
                  title: secTitle || 'Подборки',
                  playlists: secPlaylists,
                  albums: secAlbums,
                  artists: secArtists,
                  tracks: secTracks,
                });
              }
            }
          } catch {}
        }

        if (!playlists.length && !albums.length && !tracks.length) {
          const GENRE_QUERIES = {
            'рок': ['Rock Classics', 'русский рок хиты плейлист'],
            'хип-хоп': ['RapCaviar Hip Hop', 'русский хип-хоп рэп'],
            'поп': ['Today Top Hits Pop', 'поп хиты плейлист'],
            'метал': ['Metal Essentials Heavy Metal', 'metal core hits'],
            'фонк': ['drift phonk playlist', 'phonk хиты'],
            'инди': ['Indie Pop Chill', 'инди музыка плейлист'],
            'джаз': ['Jazz Classics', 'smooth jazz lounge'],
            'классика': ['Classical Essentials', 'классическая музыка'],
            'эмбиент': ['Deep Ambient', 'ambient chill атмосферу'],
            'панк': ['Punk Rock Classics', 'панк рок плейлист'],
            'блюз': ['Blues Classics', 'blues guitar hits'],
            'фолк и акустическая музыка': ['Acoustic Hits Folk', 'акустическая музыка'],
            'аниме': ['Anime Now Hits', 'anime openings ost'],
            'для геймеров': ['Top Gaming Tracks', 'gaming electronic'],
            'музыка для тренировок': ['Beast Mode Workout', 'музыка для тренировок'],
            'в машине': ['Night Drive Hits', 'музыка в машину'],
            'сон': ['Deep Sleep Ambient', 'музыка для сна'],
            'фокус': ['Deep Focus Study Lo-Fi', 'музыка для работы и учебы'],
            'релакс': ['Chill Hits Relax', 'расслабляющая музыка'],
            'вечеринка': ['Party Hits Dance', 'музыка для вечеринки'],
            'чарты': ['Top 50 Global Hits', 'топ чарт хиты'],
            'новые релизы': ['New Music Friday', 'новинки недели'],
            'танцевальная и электронная': ['Mint Dance Electronic', 'электронная музыка'],
            'dance': ['Mint Dance Electronic', 'dance hits club'],
            'r&b': ['Are & Be R&B', 'r&b soul chill'],
            'k-pop': ['K-Pop ON! Hits', 'kpop hits'],
            'афро': ['African Heat Afrobeats', 'afrobeats hits'],
            'соул': ['Soul Classics', 'neo soul chill'],
            'латино': ['Viva Latino', 'latino hits reggaeton'],
            'кантри': ['Hot Country', 'country hits'],
            'регги': ['Reggae Classics', 'reggae chill'],
            'альтернатива': ['Alternative Rock Hits', 'альтернативный рок'],
            'инструментальная музыка': ['Instrumental Study Peace', 'инструментальная музыка'],
            'любовь': ['Love Pop Ballads', 'песни о любви романтика'],
            'настроение': ['Mood Booster Feel Good', 'хорошее настроение хиты'],
            'для дома': ['Cozy At Home Chill', 'уютная музыка для дома'],
            'в дорогу': ['Road Trip Classic Drive', 'музыка в дорогу'],
          };
          const lower = catQ.toLowerCase();
          const terms = GENRE_QUERIES[lower] || [catQ ? `${catQ} playlist` : 'Top Hits', catQ || 'Popular Music'];
          const uniqueTerms = [...new Set(terms.filter(Boolean))];
          const searchResults = await Promise.allSettled(
            uniqueTerms.map(term =>
              queryPathfinder('searchDesktop', {
                searchTerm: term,
                offset: 0,
                limit: 20,
                numberOfTopResults: 5,
                includeAudiobooks: false,
                includeArtistHasConcertsField: false,
                includePreReleases: true,
                includeAlbumPreReleases: true,
                includeAuthors: false,
              })
            )
          );
          for (const r of searchResults) {
            if (r.status !== 'fulfilled') continue;
            const s = r.value?.searchV2;
            for (const it of s?.playlists?.items ?? []) {
              const d = it?.data || it;
              const u = d?.uri || '';
              const m = String(u).match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
              if (!m || seenPl.has(m[1])) continue;
              seenPl.add(m[1]);
              playlists.push(it);
            }
            for (const it of s?.albumsV2?.items ?? []) {
              const d = it?.data || it;
              const u = d?.uri || '';
              const m = String(u).match(/^spotify:album:([A-Za-z0-9]{22})$/);
              if (!m || seenAl.has(m[1])) continue;
              seenAl.add(m[1]);
              albums.push(it);
            }
          }
        }
        if (!tracks.length) {
          const firstPlId = [...seenPl][0];
          if (firstPlId) {
            try {
              const plData = await queryPathfinder('fetchPlaylist', {
                uri: `spotify:playlist:${firstPlId}`,
                offset: 0,
                limit: 35,
                enableWatchFeedEntrypoint: false,
              });
              for (const item of plData?.playlistV2?.content?.items ?? []) tracks.push(item);
            } catch {}
          }
        }
        return { title: headerTitle, sections, subcategories, playlists, albums: albums.slice(0, 18), artists: artists.slice(0, 18), tracks };
      }
      const data = await queryPathfinder('browseAll', {
        pagePagination: { offset: 0, limit: 10 },
        sectionPagination: { offset: 0, limit: 99 },
        browseEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
      });
      const sections = data?.browseStart?.sections?.items ?? [];
      const cards = [];
      for (const sec of sections) {
        for (const entry of sec?.sectionItems?.items ?? []) {
          const raw = entry?.content?.data;
          if (!raw) continue;
          const cr = raw?.data?.cardRepresentation;
          const title = cr?.title?.transformedLabel || raw?.title?.transformedLabel || raw?.name || '';
          const color = cr?.backgroundColor?.hex || raw?.backgroundColor?.hex || '';
          const img =
            cr?.artwork?.sources?.[0]?.url ||
            raw?.artwork?.sources?.[0]?.url ||
            raw?.iconOverlay?.sources?.[0]?.url ||
            raw?.images?.items?.[0]?.sources?.[0]?.url ||
            '';
          const uri = entry?.uri || raw?.featureUri || raw?.uri || '';
          if (title) cards.push({ uri, title, color, image: img });
        }
      }
      return { items: cards };
    }

    if (route === '/me/tracks' && method === 'GET') {
      const offset = Number(params.get('offset')) || 0;
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
      const data = await queryPathfinder('fetchLibraryTracks', { offset, limit }).catch(err => {
        if (offset === 0 && (pfCache['fetchLibraryTracks:0'] || pfCache.fetchLibraryTracks)) {
          return pfCache['fetchLibraryTracks:0'] || pfCache.fetchLibraryTracks;
        }
        throw err;
      });
      const tracks = data?.me?.library?.tracks;
      return {
        total: tracks?.totalCount ?? (tracks?.items?.length || 0),
        items: tracks?.items ?? [],
      };
    }

    async function mutateLibrary(add, uris) {
      const op = add ? 'addToLibrary' : 'removeFromLibrary';
      const attempts = add
        ? [{ libraryItemUris: uris, interactionId: null }, { libraryItemUris: uris }, { uris }]
        : [{ libraryItemUris: uris }, { uris }];
      for (const vars of attempts) {
        try {
          return await queryPathfinder(op, vars, { fresh: true, ttlMs: 0 });
        } catch (err) {
          const msg = String(err?.message || '');
          if (msg === 'SIGNED_OUT' || msg === 'HTTP_429') throw err;
        }
      }
      return await changeLibraryViaWebApi(add ? 'PUT' : 'DELETE', uris);
    }

    if (route === '/me/tracks' && (method === 'PUT' || method === 'DELETE')) {
      const ids = (params.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      const uris = ids.map(id => `spotify:track:${id}`);
      await mutateLibrary(method === 'PUT', uris);
      invalidatePfCache('fetchLibraryTracks');
      invalidatePfCache('libraryV3');
      return { ok: true };
    }

    if (route === '/me/albums' && (method === 'PUT' || method === 'DELETE')) {
      const ids = (params.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      const uris = ids.map(id => `spotify:album:${id}`);
      await mutateLibrary(method === 'PUT', uris);
      invalidatePfCache('libraryV3');
      return { ok: true };
    }

    if (route === '/me/following' && (method === 'PUT' || method === 'DELETE')) {
      const ids = (params.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      const uris = ids.map(id => `spotify:artist:${id}`);
      await mutateLibrary(method === 'PUT', uris);
      invalidatePfCache('libraryV3');
      return { ok: true };
    }

    if (route === '/me/playlists') {
      const items = [];
      const seenIds = new Set();
      const pushItem = raw => {
        const u = raw?.uri || raw?._uri || raw?.id || '';
        const id = u.split(':').pop();
        if (!id || seenIds.has(id)) return;
        seenIds.add(id);
        items.push(raw);
      };
      let libraryErr = null;
      let data = null;
      try {
        data = await queryPathfinder('libraryV3', {
          filters: ['Playlists'],
          order: null,
          textFilter: null,
          features: ['YOUR_EPISODES_V2'],
          limit: 50,
          offset: 0,
          flatten: false,
          expandedFolders: [],
          folderUri: null,
          includeFoldersWhenFlattening: true,
        });
      } catch (err) {
        libraryErr = err;
        data = pfCache['libraryV3:Playlists'] || pfCache['libraryV3:all'] || pfCache.libraryV3 || null;
      }
      const libItems = data?.me?.libraryV3?.items;
      if (Array.isArray(libItems)) {
        for (const entry of libItems) {
          const it = entry?.item;
          if (it?.__typename === 'PlaylistResponseWrapper' && it?.data) {
            pushItem({ ...it.data, uri: it.data.uri || it._uri });
          }
        }
        return { items };
      }
      for (const d of domPlaylists().items) pushItem(d);
      if (!items.length && libraryErr) throw libraryErr;
      return { items };
    }

    if (route === '/me/albums' && method === 'GET') {
      const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 50));
      const offset = Number(params.get('offset')) || 0;
      const data = await queryPathfinder('libraryV3', {
        filters: ['Albums'],
        order: null,
        textFilter: null,
        features: [],
        limit,
        offset,
        flatten: false,
        expandedFolders: [],
        folderUri: null,
        includeFoldersWhenFlattening: true,
      });
      const items = [];
      for (const entry of data?.me?.libraryV3?.items ?? []) {
        const it = entry?.item;
        if (it?.__typename === 'AlbumResponseWrapper' && it?.data) {
          items.push({ ...it.data, uri: it.data.uri || it._uri });
        }
      }
      return { items, total: data?.me?.libraryV3?.totalCount ?? items.length };
    }

    if (route === '/me/following' && method === 'GET') {
      const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 50));
      const offset = Number(params.get('offset')) || 0;
      const data = await queryPathfinder('libraryV3', {
        filters: ['Artists'],
        order: null,
        textFilter: null,
        features: [],
        limit,
        offset,
        flatten: false,
        expandedFolders: [],
        folderUri: null,
        includeFoldersWhenFlattening: true,
      });
      const items = [];
      for (const entry of data?.me?.libraryV3?.items ?? []) {
        const it = entry?.item;
        if (it?.__typename === 'ArtistResponseWrapper' && it?.data) {
          items.push({ ...it.data, uri: it._uri || it.data.uri });
        }
      }
      if (items.some(it => !artistHasAvatar(it))) {
        await hydrateArtistAvatars(items, { maxItems: 20, allowOverviewFallback: false });
      }
      return { items };
    }

    if (route === '/me/editable-playlists') {
      const items = [];
      const seenIds = new Set();
      const pushPl = raw => {
        if (!raw) return;
        const u = raw.uri || raw._uri || '';
        const m = String(u).match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
        if (!m || seenIds.has(m[1])) return;
        seenIds.add(m[1]);
        items.push({ ...raw, uri: u });
      };
      try {
        const probeUri = params.get('track_uri') || 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
        const data = await queryPathfinder('editablePlaylists', {
          offset: 0,
          limit: 50,
          textFilter: '',
          folderUri: null,
          uris: [probeUri],
          features: [],
        });
        for (const entry of data?.me?.editablePlaylists?.items ?? []) {
          const it = entry?.item;
          if (it?.__typename === 'PlaylistResponseWrapper' && it?.data) {
            pushPl({ ...it.data, uri: it.data.uri || it._uri });
          }
        }
      } catch {}
      if (!items.length) {
        try {
          const prof = pfCache.profileAttributes || await queryPathfinder('profileAttributes', {}).catch(() => null);
          const myUri = prof?.me?.profile?.uri || '';
          const lib = pfCache.libraryV3 || await queryPathfinder('libraryV3', {
            filters: ['Playlists'],
            order: null,
            textFilter: null,
            features: ['YOUR_EPISODES_V2'],
            limit: 50,
            offset: 0,
            flatten: false,
            expandedFolders: [],
            folderUri: null,
            includeFoldersWhenFlattening: true,
          });
          for (const entry of lib?.me?.libraryV3?.items ?? []) {
            const it = entry?.item;
            const d = it?.__typename === 'PlaylistResponseWrapper' ? it?.data : null;
            if (!d) continue;
            const ownerUri = d?.ownerV2?.data?.uri || '';
            if (myUri && ownerUri === myUri) {
              pushPl({ ...d, uri: d.uri || it._uri });
            }
          }
        } catch {}
      }
      return { items };
    }

    if (route === '/me/top/tracks') {
      const items = [];
      const data = await queryPathfinder('fetchLibraryTracks', { offset: 0, limit: 24 }).catch(() => pfCache.fetchLibraryTracks);
      for (const entry of data?.me?.library?.tracks?.items ?? []) {
        if (entry?.track) items.push(entry.track);
      }
      try {
        const homeObj = await getHomeData();
        for (const tr of extractHomeItems(homeObj, 'TrackResponseWrapper')) items.push(tr);
      } catch {}
      return { items };
    }

    if (route === '/me/player/recently-played') {
      const items = [];
      try {
        const rec = await queryPathfinder('recents', { uris: ['spotify:list:recents:page'], offset: 0, limit: 30 });
        const rawEntries = rec?.lists?.[0]?.items?.items ?? [];
        const trackUris = rawEntries.map(e => e?.entity?._uri || '').filter(u => /^spotify:track:[A-Za-z0-9]{22}$/.test(u)).slice(0, 25);
        if (trackUris.length) {
          const decorated = await queryPathfinder('decorateContextTracks', { uris: trackUris }).catch(() => null);
          for (const tr of decorated?.tracks ?? []) {
            if (tr?.__typename === 'Track') items.push({ track: tr });
          }
          if (!items.length) {
            const hydrated = await queryPathfinder('fetchEntitiesForRecentlyPlayed', { uris: trackUris });
            for (const entry of hydrated?.lookup ?? []) {
              if (entry?.data?.__typename === 'Track') items.push({ track: entry.data });
            }
          }
        }
      } catch {}
      if (!items.length) {
        try {
          const homeObj = await getHomeData();
          for (const tr of extractHomeItems(homeObj, 'TrackResponseWrapper')) items.push({ track: tr });
        } catch {}
      }
      if (!items.length) {
        try {
          const data = pfCache.fetchLibraryTracks || await queryPathfinder('fetchLibraryTracks', { offset: 0, limit: 20 });
          for (const entry of data?.me?.library?.tracks?.items ?? []) {
            if (entry?.track) items.push({ track: entry.track });
          }
        } catch {}
      }
      return { items };
    }

    if (route === '/me/top/artists') {
      const limit = Math.min(20, Math.max(1, Number(params.get('limit')) || 15));
      const items = [];
      const seenArtists = new Set();
      const pushArtist = a => {
        const id = artistIdOf(a);
        if (!id || seenArtists.has(id)) return;
        seenArtists.add(id);
        items.push({ ...a });
      };
      try {
        const data = await queryPathfinder('libraryV3', {
          filters: ['Artists'],
          order: null,
          textFilter: null,
          features: [],
          limit: 20,
          offset: 0,
          flatten: false,
          expandedFolders: [],
          folderUri: null,
          includeFoldersWhenFlattening: true,
        });
        for (const entry of data?.me?.libraryV3?.items ?? []) {
          if (entry?.item?.__typename === 'ArtistResponseWrapper' && entry?.item?.data) {
            pushArtist({ ...entry.item.data, uri: entry.item._uri || entry.item.data.uri });
          }
        }
      } catch {}
      try {
        let libTracks = pfCache.fetchLibraryTracks;
        if (!libTracks && items.length < limit) {
          libTracks = await queryPathfinder('fetchLibraryTracks', { offset: 0, limit: 24 }).catch(() => pfCache.fetchLibraryTracks || null);
        }
        const tracks = libTracks?.me?.library?.tracks?.items ?? [];
        for (const entry of tracks) {
          for (const ar of entry?.track?.data?.artists?.items ?? []) {
            if (ar?.uri && ar?.profile?.name) pushArtist(ar);
          }
        }
      } catch {}
      let homeObj = null;
      try {
        homeObj = await getHomeData();
        for (const ar of extractHomeItems(homeObj, 'ArtistResponseWrapper')) pushArtist(ar);
      } catch {}
      if (items.length < 4 && homeObj) {
        for (const tr of extractHomeItems(homeObj, 'TrackResponseWrapper')) {
          for (const ar of tr?.artists?.items ?? []) {
            if (ar?.uri && ar?.profile?.name) pushArtist(ar);
          }
        }
      }
      const sliced = items.slice(0, limit);
      await hydrateArtistAvatars(sliced, { maxItems: limit, allowOverviewFallback: true });
      return { items: sliced };
    }

    const plMatch = route.match(/^\/playlists\/([A-Za-z0-9]{22})(?:\/(tracks|followers))?$/);
    if (plMatch) {
      const pid = plMatch[1];
      const sub = plMatch[2];
      if (sub === 'followers' && (method === 'PUT' || method === 'DELETE')) {
        const add = method === 'PUT';
        const token = await ensureToken(2500);
        if (!token) throw new Error('SIGNED_OUT');
        await ensureClientToken(false);
        let username = resolveProfileUsername();
        if (!username) {
          const prof = await queryPathfinder('profileAttributes', {}).catch(() => null);
          username = resolveProfileUsername(prof?.me?.profile);
        }
        let saved = false;
        if (username) {
          const op = add
            ? {
                kind: 'ADD',
                add: {
                  addFirst: true,
                  items: [{ uri: `spotify:playlist:${pid}`, attributes: { timestamp: String(Date.now()) } }],
                },
              }
            : {
                kind: 'REM',
                rem: {
                  itemsAsKey: true,
                  items: [{ uri: `spotify:playlist:${pid}` }],
                },
              };
          const rootUrl = `https://spclient.wg.spotify.com/playlist/v2/user/${encodeURIComponent(username)}/rootlist/changes`;
          const body = JSON.stringify({
            deltas: [{ ops: [op], info: { source: { client: 'WEBPLAYER' } } }],
            wantResultingRevisions: false,
            wantSyncResult: false,
            nonces: [],
          });
          let res = await fetch.call(window, rootUrl, {
            method: 'POST',
            headers: { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' },
            body,
          });
          if (res.status === 401 || res.status === 403) {
            if (res.status === 401) {
              auth.token = '';
              auth.tokenExpiresAt = 0;
              await ensureToken(4500);
            }
            await ensureClientToken(true);
            res = await fetch.call(window, rootUrl, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' },
              body,
            });
          }
          saved = Boolean(res.ok);
          if (res.status === 429) throw new Error('HTTP_429');
        }
        if (!saved) {
          await changeLibraryViaWebApi(method, [`spotify:playlist:${pid}`]);
        }
        invalidatePfCache('libraryV3');
        invalidatePfCache('editablePlaylists');
        invalidatePfCache('fetchPlaylist:');
        return { ok: true };
      }
      if (sub === 'tracks' && method === 'POST') {
        const ids = (params.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9]{22}$/.test(s));
        if (!ids.length) throw new Error('MISSING_TRACK_IDS');
        const uris = ids.map(id => `spotify:track:${id}`);
        const plUri = `spotify:playlist:${pid}`;
        let added = false;
        for (const moveType of ['BottomOfPlaylist', 'BOTTOM_OF_PLAYLIST']) {
          try {
            await queryPathfinder('addToPlaylist', {
              playlistUri: plUri,
              playlistItemUris: uris,
              newPosition: { moveType, fromUid: null },
            }, { fresh: true, ttlMs: 0 });
            added = true;
            break;
          } catch (err) {
            const msg = String(err?.message || '');
            if (msg === 'SIGNED_OUT' || msg === 'HTTP_429') throw err;
          }
        }
        if (!added) {
          if (!await ensureToken(2500)) throw new Error('SIGNED_OUT');
          await ensureClientToken(false);
          const res = await fetch.call(window, `https://api.spotify.com/v1/playlists/${pid}/tracks`, {
            method: 'POST',
            headers: { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify({ uris }),
          });
          if (!res.ok) throw new Error(`HTTP_${res.status}`);
        }
        invalidatePfCache('fetchPlaylist:');
        invalidatePfCache('editablePlaylists');
        invalidatePfCache('libraryV3');
        return { ok: true };
      }
      if (sub === 'tracks' && method === 'DELETE') {
        const uids = (params.get('uids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
        if (!uids.length) throw new Error('MISSING_TRACK_UIDS');
        try {
          await queryPathfinder('removeFromPlaylist', {
            playlistUri: `spotify:playlist:${pid}`,
            uids,
          }, { fresh: true, ttlMs: 0 });
        } catch (err) {
          const msg = String(err?.message || '');
          if (msg === 'SIGNED_OUT' || msg === 'HTTP_429') throw err;
          if (!await ensureToken(2500)) throw new Error('SIGNED_OUT');
          await ensureClientToken(false);
          const res = await fetch.call(window, `https://spclient.wg.spotify.com/playlist/v2/playlist/${pid}/changes`, {
            method: 'POST',
            headers: { ...apiHeaders(), 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify({
              deltas: [{
                ops: [{ kind: 'REM', rem: { itemsAsKey: false, items: uids.map(uid => ({ attributes: { itemId: uid } })) } }],
                info: { source: { client: 'WEBPLAYER' } },
              }],
              wantResultingRevisions: false,
              wantSyncResult: false,
              nonces: [],
            }),
          });
          if (!res.ok) throw err;
        }
        invalidatePfCache('fetchPlaylist:');
        invalidatePfCache('editablePlaylists');
        invalidatePfCache('libraryV3');
        return { ok: true };
      }
      const offset = Number(params.get('offset')) || 0;
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 100));
      try {
        const data = await queryPathfinder('fetchPlaylist', {
          uri: `spotify:playlist:${pid}`,
          offset,
          limit,
          enableWatchFeedEntrypoint: false,
        });
        if (data?.playlistV2?.__typename === 'Playlist') {
          return sub === 'tracks' ? (data.playlistV2.content ?? { items: [] }) : data.playlistV2;
        }
      } catch (err) {
        if (String(err?.message).includes('HTTP_429') || String(err?.message).includes('SIGNED_OUT')) throw err;
      }
      return await embedEntity('playlist', pid);
    }

    const alMatch = route.match(/^\/albums\/([A-Za-z0-9]{22})(?:\/(tracks))?$/);
    if (alMatch) {
      const aid = alMatch[1];
      const sub = alMatch[2];
      const offset = Number(params.get('offset')) || 0;
      const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
      try {
        const data = await queryPathfinder('getAlbum', {
          uri: `spotify:album:${aid}`,
          locale: '',
          offset,
          limit,
        });
        if (data?.albumUnion?.__typename === 'Album') {
          return sub === 'tracks' ? (data.albumUnion.tracksV2 ?? { items: [] }) : data.albumUnion;
        }
      } catch (err) {
        if (String(err?.message).includes('HTTP_429') || String(err?.message).includes('SIGNED_OUT')) throw err;
      }
      return await embedEntity('album', aid);
    }

    const arMatch = route.match(/^\/artists\/([A-Za-z0-9]{22})(?:\/(top-tracks|albums|related|related-artists))?$/);
    if (arMatch) {
      const id = arMatch[1];
      const sub = arMatch[2];
      if (sub === 'related' || sub === 'related-artists') {
        const rel = await queryPathfinder('queryArtistRelated', { uri: `spotify:artist:${id}` }).catch(() => null);
        const relItems = rel?.artistUnion?.relatedContent?.relatedArtists?.items ?? [];
        if (relItems.length) return { items: relItems };
      }
      const artist = await getArtistOverview(id);
      if (!artist) throw new Error('ARTIST_NOT_FOUND');
      if (!sub) return artist;
      if (sub === 'related' || sub === 'related-artists') return { items: artist.relatedContent?.relatedArtists?.items ?? [] };
      if (sub === 'top-tracks') {
        return { tracks: (artist.discography?.topTracks?.items ?? []).map(x => x?.track ?? x) };
      }
      const albumGroups = (artist.discography?.albums?.items ?? []).flatMap(g => g?.releases?.items ?? [g]).filter(Boolean);
      const singleGroups = (artist.discography?.singles?.items ?? []).flatMap(g => g?.releases?.items ?? [g]).filter(Boolean);
      const popReleases = artist.discography?.popularReleasesAlbums?.items ?? [];
      const releases = [
        ...albumGroups.map(r => (r && typeof r === 'object' ? { ...r, _releaseGroup: r.type || 'ALBUM' } : r)),
        ...singleGroups.map(r => (r && typeof r === 'object' ? { ...r, _releaseGroup: r.type || 'SINGLE' } : r)),
        ...popReleases.map(r => (r && typeof r === 'object' ? { ...r, _releaseGroup: r.type || 'ALBUM' } : r)),
      ];
      const seenRel = new Set();
      const unique = releases.filter(r => {
        const u = r?.uri || r?.id;
        if (!u || seenRel.has(u)) return false;
        seenRel.add(u);
        return true;
      });
      return { items: unique };
    }

    const trMatch = route.match(/^\/tracks\/([A-Za-z0-9]{22})(?:\/(lyrics|related))?$/);
    if (trMatch) {
      const tid = trMatch[1];
      const sub = trMatch[2];
      if (sub === 'lyrics') {
        await ensureToken(3500);
        await ensureClientToken(false);
        if (!auth.token) throw new Error('SIGNED_OUT');
        const img = params.get('img') || '';
        const endpoints = [];
        if (img && cdn(img)) {
          endpoints.push(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${tid}/image/${encodeURIComponent(img)}?format=json&vocalRemoval=false&market=from_token`);
        }
        endpoints.push(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${tid}?format=json&vocalRemoval=false&market=from_token`);
        for (const ep of endpoints) {
          try {
            const res = await fetch.call(window, ep, { headers: apiHeaders() });
            if (res.status === 404) return { lyrics: null };
            if (res.ok) {
              const json = await res.json();
              return { lyrics: json?.lyrics ?? null };
            }
          } catch {}
        }
        return { lyrics: null };
      }
      if (sub === 'related') {
        const [trRes, alRes] = await Promise.allSettled([
          queryPathfinder('internalLinkRecommenderTrack', { uri: `spotify:track:${tid}`, limit: 20 }),
          queryPathfinder('similarAlbumsBasedOnThisTrack', { uri: `spotify:track:${tid}`, limit: 12, albumsOnly: true }),
        ]);
        return {
          tracks: trRes.status === 'fulfilled' ? (trRes.value?.seoRecommendedTrack?.items ?? []).map(x => x?.data ?? x).filter(Boolean) : [],
          albums: alRes.status === 'fulfilled' ? (alRes.value?.seoRecommendedTrackAlbum?.items ?? []).map(x => x?.data ?? x).filter(Boolean) : [],
        };
      }
      try {
        const data = await queryPathfinder('getTrack', { uri: `spotify:track:${tid}` });
        if (data?.trackUnion?.__typename === 'Track') return data.trackUnion;
      } catch {}
      return await embedEntity('track', tid);
    }

    if (route === '/radio' || route === '/recommendations') {
      const directUri = params.get('uri') || '';
      const seedTrack = (params.get('seed_tracks') || '').split(',')[0]?.trim();
      const seedArtist = (params.get('seed_artists') || '').split(',')[0]?.trim();
      let seedUri = directUri;
      if (!seedUri && /^[A-Za-z0-9]{22}$/.test(seedTrack)) seedUri = `spotify:track:${seedTrack}`;
      if (!seedUri && /^[A-Za-z0-9]{22}$/.test(seedArtist)) seedUri = `spotify:artist:${seedArtist}`;
      if (!seedUri) {
        const lib = await queryPathfinder('fetchLibraryTracks', { offset: 0, limit: 10 }).catch(() => pfCache.fetchLibraryTracks);
        const first = lib?.me?.library?.tracks?.items?.[0]?.track?.data?.uri;
        if (first) seedUri = first;
      }
      if (!seedUri) return { tracks: [], items: [] };
      const radio = await fetchSeedRadio(seedUri);
      return { tracks: radio.items ?? [], items: radio.items ?? [], playlistUri: radio.playlistUri, name: radio.name };
    }

    if (route === '/search') {
      const q = params.get('q') || '';
      const data = await queryPathfinder('searchDesktop', {
        searchTerm: q,
        offset: 0,
        limit: 20,
        numberOfTopResults: 5,
        includeAudiobooks: false,
        includeArtistHasConcertsField: false,
        includePreReleases: true,
        includeAlbumPreReleases: true,
        includeAuthors: false,
      });
      const s = data?.searchV2;
      return {
        tracks: { items: s?.tracksV2?.items ?? [] },
        artists: { items: s?.artists?.items ?? [] },
        playlists: { items: s?.playlists?.items ?? [] },
        albums: { items: s?.albumsV2?.items ?? [] },
      };
    }

    if (spec.fallbackEmbed) {
      return await embedEntity(spec.fallbackEmbed.entity, spec.fallbackEmbed.id);
    }
    throw new Error('UNSUPPORTED_ROUTE');
  }

  function spaNavigate(path) {
    try {
      const prevIdx = Number(window.history?.state?.idx) || 0;
      const nextState = { idx: prevIdx + 1, key: Math.random().toString(36).slice(2, 10) };
      window.history?.pushState?.(nextState, '', path);
      window.dispatchEvent?.(new PopStateEvent('popstate', { state: nextState }));
    } catch {}
  }

  function resolveProfileUsername(profile) {
    const p = profile || pfCache.profileAttributes?.me?.profile;
    const rawUser = (typeof p?.username === 'string' && p.username.trim()) ||
      (typeof p?.uri === 'string' && p.uri.startsWith('spotify:user:') ? p.uri.slice('spotify:user:'.length) : '');
    return rawUser && /^[A-Za-z0-9._-]+$/.test(rawUser) ? rawUser : '';
  }

  function resolveCollectionUri() {
    const user = resolveProfileUsername();
    return user ? `spotify:user:${user}:collection` : '';
  }

  function resolveContextTarget(context) {
    if (!context || typeof context !== 'object') return '';
    const ctx = typeof context.contextUri === 'string' ? context.contextUri.trim() : '';
    if (ctx === 'spotify:collection:tracks') {
      return resolveCollectionUri();
    }
    if (/^spotify:(?:playlist|album|artist):[A-Za-z0-9]{22}$/.test(ctx)) {
      return ctx;
    }
    const albumId = typeof context.albumId === 'string' ? context.albumId.trim() : '';
    if (/^[A-Za-z0-9]{22}$/.test(albumId)) {
      return `spotify:album:${albumId}`;
    }
    return '';
  }

  async function tryPlayUriTarget(playUri, playOpts, methodName) {
    const ctrl = harmonyController || harmonyPlayer?._controller;
    const p = harmonyPlayer || harmonyController;
    const targetVol = desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume));
    try { (harmonyPlayer || ctrl)?.setVolume?.(targetVol); } catch {}
    try { (harmonyPlayer || ctrl)?.setMuted?.(Boolean(desiredMuted)); } catch {}
    for (const el of elements()) applyMediaSettings(el);

    if (harmonyPlayer && typeof harmonyPlayer.playURI === 'function') {
      try {
        await harmonyPlayer.playURI(playUri, null, playOpts);
        counters.lastPlayMethod = methodName;
        counters.lastPlayError = '';
        return true;
      } catch (err) {
        const msg = String(err?.message || err || 'HARMONY_URI_ERR').slice(0, 120);
        counters.lastPlayError = msg;
        pushDiag(`${methodName} failed: ${msg}`);
        return false;
      }
    }

    if (harmonyPlayer && typeof harmonyPlayer._canStartNewContext === 'function') {
      try { await harmonyPlayer._canStartNewContext(null); } catch {}
    }
    if (harmonyPlayer?._autoActivateElement && typeof harmonyPlayer?._activateElement === 'function') {
      try { harmonyPlayer._activateElement(); } catch {}
    }

    if (ctrl && typeof ctrl.playURI === 'function') {
      try {
        await ctrl.playURI(playUri, undefined, playOpts);
        counters.lastPlayMethod = methodName;
        counters.lastPlayError = '';
        return true;
      } catch (err) {
        const msg = String(err?.message || err || 'PLAY_URI_ERR').slice(0, 120);
        counters.lastPlayError = msg;
        pushDiag(`${methodName}(ctrl) failed: ${msg}`);
      }
    }

    if (playUri.startsWith('spotify:track:') && p && typeof p.playTracks === 'function') {
      try {
        await p.playTracks([playUri], null, { ...playOpts, contextURI: playUri, trackURI: playUri, index: 0 });
        counters.lastPlayMethod = 'harmony.playTracks';
        counters.lastPlayError = '';
        return true;
      } catch (err) {
        const msg = String(err?.message || err || 'PLAY_TRACKS_ERR').slice(0, 120);
        counters.lastPlayError = msg;
        pushDiag(`harmony.playTracks failed: ${msg}`);
      }
    }
    return false;
  }

  async function tryHarmonyPlay(trackId, startAt, context) {
    const uri = `spotify:track:${trackId}`;
    const ms = startAt > 0 ? Math.round(startAt * 1000) : 0;
    const baseOpts = {
      ...(ms > 0 ? { initialOffset: ms, seekTo: ms } : {}),
      shuffle: false,
      repeatMode: 0,
      playOrigin: { featureIdentifier: 'track' },
    };
    const ctxUri = resolveContextTarget(context);
    const trackUid = typeof context?.trackUid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(context.trackUid) ? context.trackUid : '';
    const preferContext = context?.preferContext === true && Boolean(ctxUri);

    const playSingle = async () => {
      if (spotifyPlayerApi && typeof spotifyPlayerApi.play === 'function') {
        try {
          const targetVol = desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume));
          try { (harmonyPlayer || harmonyController)?.setVolume?.(targetVol); } catch {}
          try { (harmonyPlayer || harmonyController)?.setMuted?.(Boolean(desiredMuted)); } catch {}
          const ctx = { uri };
          const origin = { featureIdentifier: 'track' };
          const opts = { ...(ms > 0 ? { seekTo: ms } : {}), shuffle: false };
          await spotifyPlayerApi.play(ctx, origin, opts);
          counters.lastPlayMethod = 'playerApi.play';
          counters.lastPlayError = '';
          return true;
        } catch (err) {
          const msg = String(err?.message || err || 'API_PLAY_ERR').slice(0, 120);
          counters.lastPlayError = msg;
          pushDiag(`playerApi.play failed: ${msg}`);
        }
      }
      return await tryPlayUriTarget(uri, baseOpts, 'harmony.playURI');
    };

    const playInContext = async () => {
      if (!ctxUri) return false;
      const feature = ctxUri.startsWith('spotify:album:') ? 'album' : ctxUri.includes(':collection') ? 'collection' : 'playlist';
      if (spotifyPlayerApi && typeof spotifyPlayerApi.play === 'function') {
        try {
          const skipTo = trackUid ? { uri, uid: trackUid } : { uri };
          await spotifyPlayerApi.play({ uri: ctxUri }, { featureIdentifier: feature }, { ...(ms > 0 ? { seekTo: ms } : {}), shuffle: false, skipTo });
          counters.lastPlayMethod = 'playerApi.contextPlay';
          counters.lastPlayError = '';
          return true;
        } catch (err) {
          const msg = String(err?.message || err || 'API_CTX_ERR').slice(0, 120);
          counters.lastPlayError = msg;
          pushDiag(`playerApi.contextPlay failed: ${msg}`);
        }
      }
      const ctxOpts = {
        ...baseOpts,
        contextURI: ctxUri,
        trackURI: uri,
        ...(trackUid ? { trackUID: trackUid } : {}),
        playOrigin: { featureIdentifier: feature },
      };
      return await tryPlayUriTarget(ctxUri, ctxOpts, 'harmony.contextPlayURI');
    };

    if (preferContext) {
      if (await playInContext()) return true;
      return await playSingle();
    }
    if (await playSingle()) return true;
    if (ctxUri) return await playInContext();
    return false;
  }

  function seekHarmonyMs(ms) {
    const streamer = harmonyPlayer?._streamer;
    const ctrl = harmonyController || harmonyPlayer?._controller;
    const lp = streamer?._listPlayer;
    if (typeof streamer?.seek === 'function' && !ctrl?.shouldRedirectPlayerCommand?.() && (!lp || lp._currentTrack)) {
      try {
        void Promise.resolve(streamer.seek(ms)).catch(() => { try { ctrl?.seek?.(ms); } catch {} });
        return true;
      } catch {}
    }
    try {
      if (typeof ctrl?.seek === 'function') {
        ctrl.seek(ms);
        return true;
      }
      if (typeof spotifyPlayerApi?.seekTo === 'function') {
        spotifyPlayerApi.seekTo(ms);
        return true;
      }
      if (typeof harmonyPlayer?.seek === 'function') {
        harmonyPlayer.seek(ms);
        return true;
      }
      if (typeof harmonyPlayer?._seek === 'function') {
        harmonyPlayer._seek(ms);
        return true;
      }
    } catch {}
    return setRange(range('playback-progressbar'), ms);
  }

  async function startTrackPlayback(trackId, startAt, context) {
    // Fast path: Harmony already transitioned gaplessly into Nocturne's preloaded next track — adopt it with 0ms interruption!
    if (startAt === 0 && seamlessAdoptedTrackId && seamlessAdoptedTrackId === trackId) {
      const hs = harmonyState();
      const curTrack = hs?.track_window?.current_track;
      const curId = extractTrackId(curTrack?.uri || curTrack?.id);
      const linkedId = extractTrackId(curTrack?.linked_from?.uri || curTrack?.linked_from?.id);
      const curPos = harmonyPositionSec() ?? 0;
      if ((curId === trackId || linkedId === trackId) && !hs?.paused && !hs?.isPaused && curPos < 5) {
        hardPaused = false;
        bleedTrackId = '';
        bleedPauseSent = false;
        seamlessAdoptedTrackId = '';
        startAutoResumeUsed = false;
        sawDesiredActive = true;
        desiredActivePosMs = Math.max(0, Math.round(curPos * 1000));
        desiredActiveDurMs = Number(hs?.duration) > 0 ? Number(hs.duration) : 0;
        desiredActivePlayingSince = Date.now();
        desiredTrackId = trackId;
        counters.expectedTrackId = trackId;
        counters.actualTrackId = curId || trackId;
        counters.startPending = false;
        counters.trackEnded = false;
        counters.endedTrackId = '';
        counters.lastPlayMethod = 'harmony.seamless';
        counters.lastPlayError = '';
        counters.lastPlaybackError = '';
        setSwitchMute(false);
        setUnwantedBleedMute(false);
        lastTrackStartAt = Date.now();
        lastTrackStartSec = 0;
        switchFromTrackId = '';
        switchFromPosSec = 0;
        lastSeekTargetSec = null;
        lastSeekFromSec = null;
        lastSeekAt = 0;
        clearTimeout(playTimer);
        clearTimeout(seekTimer);
        playSeq++;
        for (const el of elements()) applyMediaSettings(el);
        return true;
      }
    }
    const prevId = desiredTrackId || nowPlayingTrackId(testid('now-playing-widget')) || '';
    const prevPos = prevId && prevId !== trackId ? (harmonyPositionSec() ?? (lastHarmonyPosMs > 0 ? lastHarmonyPosMs / 1000 : 0)) : 0;
    hardPaused = false;
    bleedTrackId = '';
    bleedPauseSent = false;
    seamlessAdoptedTrackId = '';
    startAutoResumeUsed = false;
    sawDesiredActive = false;
    desiredActivePosMs = 0;
    desiredActiveDurMs = 0;
    desiredActivePlayingSince = 0;
    for (const m of elements()) {
      if (m?.ended) ignoredEndedMedia?.add(m);
    }
    desiredTrackId = trackId;
    counters.expectedTrackId = trackId;
    counters.startPending = true;
    setSwitchMute(false);
    setUnwantedBleedMute(false);
    lastTrackStartAt = Date.now();
    lastTrackStartSec = startAt;
    switchFromTrackId = prevId !== trackId ? prevId : '';
    switchFromPosSec = prevPos;
    lastAdSeekTrackUri = '';
    wasHarmonyAd = false;
    counters.actualTrackId = '';
    counters.lastPlayError = '';
    counters.lastPlaybackError = '';
    counters.trackEnded = false;
    counters.endedTrackId = '';
    lastHarmonyTrackUri = '';
    lastHarmonyPosMs = 0;
    lastHarmonyDurMs = 0;
    lastHarmonyWasPlaying = false;
    lastHarmonyClock = null;
    const runId = ++playSeq;
    const isCurrent = () => playSeq === runId && desiredTrackId === trackId;
    const clearPending = () => {
      if (playSeq === runId) {
        counters.startPending = false;
        setSwitchMute(false);
      }
    };
    const settleSeek = () => {
      if (startAt > 0.5) {
        const ms = Math.round(startAt * 1000);
        clearTimeout(seekTimer);
        seekTimer = setTimeout(() => {
          if (!isCurrent()) return;
          const cur = harmonyPositionSec();
          if (cur !== null && Math.abs(cur - startAt) <= 0.9) return;
          seekHarmonyMs(ms);
        }, 350);
      }
    };
    if (startAt > 0) {
      lastSeekTargetSec = startAt;
      lastSeekFromSec = null;
      lastSeekAt = Date.now();
    } else {
      lastSeekTargetSec = null;
      lastSeekFromSec = null;
      lastSeekAt = 0;
    }
    clearTimeout(playTimer);
    clearTimeout(seekTimer);
    const started = await tryHarmonyPlay(trackId, startAt, context);
    if (!isCurrent()) {
      if (started && !desiredTrackId) {
        if (hardPaused) enforceHardPause(true);
        else callHarmonyPause();
      }
      return false;
    }
    if (started) {
      clearPending();
      settleSeek();
      return true;
    }
    let attempts = 0;
    let navigated = false;
    let clickedDomPlay = false;
    const scheduleNext = ms => {
      if (!isCurrent()) return;
      playTimer = setTimeout(tryClickPlay, ms);
    };
    const findTrackPagePlayBtn = path => {
      if (typeof document === 'undefined' || window.location?.pathname !== path) return null;
      return document.querySelector?.('[data-testid="action-bar-row"] [data-testid="play-button"]');
    };
    const tryClickPlay = () => {
      if (!isCurrent()) return;
      if (++attempts > 60) {
        pushDiag(`play timeout for ${trackId} (hasHarmony=${Boolean(harmonyPlayer || harmonyController)} err=${counters.lastPlayError || 'none'})`);
        clearPending();
        return;
      }
      if (playing() === true && nowPlayingTrackId(testid('now-playing-widget')) === trackId) {
        clearPending();
        return;
      }
      if (spotifyPlayerApi || harmonyPlayer || harmonyController) {
        void tryHarmonyPlay(trackId, startAt, context).then(ok => {
          if (!isCurrent()) return;
          if (ok) {
            clearPending();
            settleSeek();
            return;
          }
          const path = `/track/${trackId}`;
          if (attempts >= 3 && !navigated) {
            navigated = true;
            pushDiag(`fallback dom nav -> ${path} (err=${counters.lastPlayError || 'none'})`);
            if (window.location?.pathname !== path) spaNavigate(path);
          }
          if (navigated && !clickedDomPlay) {
            const btn = findTrackPagePlayBtn(path);
            if (btn && !btn.disabled) {
              clickedDomPlay = true;
              btn.click();
              counters.lastPlayMethod = 'dom.playButton';
            }
          }
          scheduleNext(attempts < 6 ? 120 : 200);
        });
        return;
      }
      const path = `/track/${trackId}`;
      if (!navigated) {
        navigated = true;
        pushDiag(`no harmony, dom nav -> ${path}`);
        if (window.location?.pathname !== path) spaNavigate(path);
      }
      const btn = findTrackPagePlayBtn(path);
      if (btn && !btn.disabled && !clickedDomPlay) {
        clickedDomPlay = true;
        btn.click();
        counters.lastPlayMethod = 'dom.playButton';
        if (startAt > 1) {
          clearTimeout(seekTimer);
          seekTimer = setTimeout(() => { if (isCurrent()) setRange(range('playback-progressbar'), Math.round(startAt * 1000)); }, 500);
        }
      }
      scheduleNext(140);
    };
    scheduleNext(90);
    return true;
  }

  Object.defineProperty(window, '__nocturneSpotifyLab', { value: Object.freeze({
    configure: enabled => { counters.enabled = enabled === true; },
    stats: () => ({
      ...counters,
      trackEnded: isTrackEndedNow(),
      hasApi: Boolean(spotifyPlayerApi),
      hasHarmony: Boolean(harmonyPlayer || harmonyController),
      preloadedTrackId: preloadedNextTrackId,
      preloadStage: preloadState?.stage || '',
    }),
    takeDiagnostics: () => diagnostics.splice(0, diagnostics.length),
    playing,
    nowPlaying: () => { try { return nowPlaying(); } catch { return null; } },
    account: () => testid('login-button') || testid('signup-button') ? 'out' : testid('user-widget-link') || auth.token ? 'in' : null,
    warmNextTrack: trackId => warmNextTrack(trackId),
    playTrack: (trackId, startAt, vol, muted, context) => {
      if (typeof trackId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(trackId)) return false;
      if (typeof vol === 'number' && Number.isFinite(vol)) desiredVolume = Math.min(1, Math.max(0, vol));
      if (typeof muted === 'boolean') desiredMuted = muted;
      void startTrackPlayback(trackId, Number(startAt) || 0, context);
      return true;
    },
    setVolume: (vol, muted) => {
      if (typeof vol === 'number' && Number.isFinite(vol)) desiredVolume = Math.min(1, Math.max(0, vol));
      if (typeof muted === 'boolean') desiredMuted = muted;
      const targetVol = desiredMuted ? 0 : Math.min(1, Math.max(0, desiredVolume));
      try { (harmonyPlayer || harmonyController || harmonyPlayer?._controller)?.setVolume?.(targetVol); } catch {}
      try { (harmonyPlayer || harmonyController || harmonyPlayer?._controller)?.setMuted?.(Boolean(desiredMuted)); } catch {}
      for (const el of elements()) applyMediaSettings(el);
      return true;
    },
    startJob: (key, spec) => {
      if (typeof key !== 'string' || !key) return false;
      const now = Date.now();
      for (const k of Object.keys(jobs)) {
        if (jobs[k]?.at && now - jobs[k].at > 60_000) delete jobs[k];
      }
      jobs[key] = { done: false, ok: false, data: null, error: '', at: now };
      void runSpec(spec).then(
        data => { if (jobs[key]) jobs[key] = { done: true, ok: true, data, error: '', at: now }; },
        err => { if (jobs[key]) jobs[key] = { done: true, ok: false, data: null, error: String(err?.message || err || 'ERROR'), at: now }; },
      );
      return true;
    },
    pollJob: key => {
      const job = jobs[key];
      if (!job) return { done: true, ok: false, error: 'MISSING' };
      if (job.done) delete jobs[key];
      return job;
    },
    dropJob: key => {
      if (typeof key === 'string' && key && key in jobs) {
        delete jobs[key];
        return true;
      }
      return false;
    },
    control: (action, value) => {
      const p = harmonyPlayer || harmonyController;
      if (action === 'pause') {
        const wasPending = counters.startPending;
        const wasPlaying = playing() === true;
        hardPaused = true;
        bleedTrackId = '';
        bleedPauseSent = false;
        seamlessAdoptedTrackId = '';
        setSwitchMute(false);
        setUnwantedBleedMute(false);
        desiredTrackId = '';
        playSeq++;
        clearTimeout(playTimer);
        clearTimeout(seekTimer);
        counters.startPending = false;
        counters.trackEnded = false;
        counters.endedTrackId = '';
        enforceHardPause(false);
        if (!wasPlaying) {
          callHarmonyPause();
          if (wasPending) {
            return true;
          }
          return false;
        }
      } else if (action === 'play') {
        const wasHardPaused = hardPaused;
        hardPaused = false;
        bleedTrackId = '';
        setUnwantedBleedMute(false);
        if (!desiredTrackId && counters.expectedTrackId) desiredTrackId = counters.expectedTrackId;
        counters.trackEnded = false;
        counters.endedTrackId = '';
        counters.lastPlaybackError = '';
        for (const el of elements()) applyMediaSettings(el);
        if (!wasHardPaused && playing() === true) return false;
      } else if (action === 'toggle') {
        hardPaused = false;
        bleedTrackId = '';
        setUnwantedBleedMute(false);
        counters.endedTrackId = '';
        for (const el of elements()) applyMediaSettings(el);
      } else if (action === 'next' || action === 'previous') {
        hardPaused = false;
        bleedTrackId = '';
        setUnwantedBleedMute(false);
        desiredTrackId = '';
        counters.expectedTrackId = '';
        counters.trackEnded = false;
        counters.endedTrackId = '';
        for (const el of elements()) applyMediaSettings(el);
      }
      const selectors = {
        toggle: '[data-testid="control-button-playpause"]', play: '[data-testid="control-button-playpause"]', pause: '[data-testid="control-button-playpause"]',
        next: '[data-testid="control-button-skip-forward"]', previous: '[data-testid="control-button-skip-back"]',
        shuffle: '[data-testid="control-button-shuffle"]', repeat: '[data-testid="control-button-repeat"]',
        mute: '[data-testid="volume-bar-toggle-mute-button"]', like: '[data-testid="now-playing-widget"] [data-testid="add-button"]',
      };
      if (selectors[action]) {
        if (action === 'pause') {
          if (spotifyPlayerApi?.pause) { try { void Promise.resolve(spotifyPlayerApi.pause()).catch(() => {}); return true; } catch {} }
          if (p?.pause) { try { void Promise.resolve(p.pause()).catch(() => {}); return true; } catch {} }
          const btn = typeof document !== 'undefined' ? document.querySelector?.(selectors[action]) : null;
          const lbl = btn?.getAttribute?.('aria-label') || '';
          if (/^(?:play|играть|воспроизвести)\b/i.test(lbl)) return false;
        } else if (action === 'play') {
          if (spotifyPlayerApi?.resume) { try { void Promise.resolve(spotifyPlayerApi.resume()).catch(() => {}); return true; } catch {} }
          if (p?.resume) { try { void Promise.resolve(p.resume()).catch(() => {}); return true; } catch {} }
          const btn = typeof document !== 'undefined' ? document.querySelector?.(selectors[action]) : null;
          const lbl = btn?.getAttribute?.('aria-label') || '';
          if (/^(?:pause|пауза)\b/i.test(lbl)) return false;
        }
        if (click(selectors[action])) return true;
        try {
          if (action === 'toggle' && p?.togglePlay) {
            void Promise.resolve(p.togglePlay()).catch(() => {});
            return true;
          }
          if (action === 'next' && (spotifyPlayerApi?.skipToNext || p?.nextTrack)) {
            void Promise.resolve((spotifyPlayerApi?.skipToNext ?? p?.nextTrack).call(spotifyPlayerApi?.skipToNext ? spotifyPlayerApi : p)).catch(() => {});
            return true;
          }
          if (action === 'previous' && (spotifyPlayerApi?.skipToPrevious || p?.previousTrack)) {
            void Promise.resolve((spotifyPlayerApi?.skipToPrevious ?? p?.previousTrack).call(spotifyPlayerApi?.skipToPrevious ? spotifyPlayerApi : p)).catch(() => {});
            return true;
          }
        } catch {}
        return Boolean(
          (action === 'toggle' || action === 'play' || action === 'pause') &&
          (spotifyPlayerApi || p)
        );
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (action === 'seek') {
        bleedTrackId = '';
        switchFromTrackId = '';
        switchFromPosSec = 0;
        setUnwantedBleedMute(false);
        counters.trackEnded = false;
        counters.endedTrackId = '';
        counters.lastPlaybackError = '';
        const clampedSec = Math.max(0, value);
        const ms = Math.round(clampedSec * 1000);
        lastHarmonyPosMs = ms;
        const preSeekPos = progress().position;
        lastSeekFromSec = Number.isFinite(preSeekPos) ? preSeekPos : null;
        lastSeekTargetSec = clampedSec;
        lastSeekAt = Date.now();
        const sought = seekHarmonyMs(ms);
        const el = activeElement();
        if (!sought && el && Number.isFinite(el.duration) && el.duration > 0) {
          try { el.currentTime = clampedSec; } catch {}
        }
        return sought || Boolean(el);
      }
      if (action === 'volume') {
        desiredVolume = Math.min(1, Math.max(0, value));
        desiredMuted = false;
        for (const el of elements()) applyMediaSettings(el);
        const input = range('volume-bar');
        if (!elements().length && input) setRange(input, desiredVolume * (Number(input.max) || 1));
        return true;
      }
      return false;
    },
  }), configurable: false });
})();

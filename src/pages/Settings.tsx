import { ImagePlus, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSession } from '../app/session'
import { toast } from '../app/toast'
import { Button, Segmented, Switch } from '../components/controls'
import { HotkeyInput } from '../components/HotkeyInput'
import { PageHeader } from '../components/PageHeader'
import { Slider } from '../components/Slider'
import { PRESETS, PresetLayer } from '../components/Wallpaper'
import { useHotkeyStatus } from '../lib/globalHotkeys'
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, findDuplicateHotkeys, type HotkeyAction } from '../lib/hotkeys'
import { WALLPAPER_PRESETS, useSettings, type WallpaperConfig } from '../lib/settings'
import { isTauri } from '../lib/tauri'
import { pickWallpaper } from '../lib/wallpaper'
import { useUpdates } from '../lib/updates'
import { usePlayer } from '../player/store'
import s from './Settings.module.css'

const ACCENTS = ['#ff375f', '#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#40cbe0', '#0a84ff', '#5e5ce6', '#bf5af2']

function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className={s.group}>
      <h2 className={s.groupTitle}>{title}</h2>
      <div className={s.card}>{children}</div>
      {note && <p className={s.note}>{note}</p>}
    </section>
  )
}

function Row({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowText}>
        <div className={s.rowTitle}>{title}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

function WallpaperSwatch({ active, label, onClick, children }: { active: boolean; label: string; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className={s.swatch} aria-pressed={active} aria-label={label} onClick={onClick}>
      {children}
      <span className={s.swatchLabel}>{label}</span>
    </button>
  )
}

function useMonitors() {
  const [list, setList] = useState<string[]>([])
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/window').then(async (w) => {
      const ms = await w.availableMonitors()
      setList(ms.map((m) => m.name ?? '').filter(Boolean))
    })
  }, [])
  return list
}

function AboutRow() {
  const { phase, version, error, check, install } = useUpdates()
  const [current, setCurrent] = useState('')
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setCurrent)
  }, [])
  const status =
    phase === 'checking'
      ? 'Проверяем…'
      : phase === 'none'
        ? 'Установлена последняя версия'
        : phase === 'available'
          ? `Доступна версия ${version}`
          : phase === 'downloading'
            ? 'Загружаем обновление…'
            : phase === 'error'
              ? `Не удалось проверить: ${error ?? ''}`.slice(0, 120)
              : 'Обновления ставятся автоматически по вашему подтверждению'
  return (
    <Row title={`Nocturne ${current}`} sub={status}>
      {phase === 'available' ? (
        <Button variant="primary" onClick={() => void install()}>
          Обновить
        </Button>
      ) : (
        <Button disabled={phase === 'checking' || phase === 'downloading' || !isTauri()} onClick={() => void check(true)}>
          Проверить обновления
        </Button>
      )}
    </Row>
  )
}

export function SettingsPage() {
  const st = useSettings()
  const user = useSession((x) => x.user)
  const logout = useSession((x) => x.logout)
  const failed = useHotkeyStatus((h) => h.failed)
  const monitors = useMonitors()
  const cover = usePlayer((p) => p.current?.cover?.s)
  const dupes = new Set(findDuplicateHotkeys(st.hotkeys))
  const wp = st.wallpaper
  const setWallpaper = (w: WallpaperConfig) => st.update({ wallpaper: w })

  return (
    <div className={s.wrap}>
      <PageHeader title="Настройки" />

      <Group title="Аккаунт">
        <div className={s.row}>
          {user?.photo ? <img className={s.avatar} src={user.photo} alt="" referrerPolicy="no-referrer" /> : <span className={s.avatar} />}
          <div className={s.rowText}>
            <div className={s.rowTitle}>{user?.name ?? 'Аккаунт VK'}</div>
            <div className={s.rowSub}>Вход через веб-сессию VK. Доступ хранится только в памяти приложения.</div>
          </div>
          <Button variant="danger" onClick={() => void logout()}>
            Выйти
          </Button>
        </div>
      </Group>

      <Group title="Обои" note="Свои обои — картинка, GIF или видео (MP4, WebM). Видео играет без звука и ставится на паузу, когда окно скрыто.">
        <div className={s.row}>
          <div className={s.swatches}>
            <WallpaperSwatch active={wp.kind === 'dynamic'} label="По обложке" onClick={() => setWallpaper({ kind: 'dynamic' })}>
              {cover ? <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(6px) saturate(1.5)', transform: 'scale(1.3)' }} referrerPolicy="no-referrer" /> : <PresetLayer preset="dusk" />}
            </WallpaperSwatch>
            {WALLPAPER_PRESETS.map((p) => (
              <WallpaperSwatch key={p} active={wp.kind === 'preset' && wp.preset === p} label={PRESETS[p].name} onClick={() => setWallpaper({ kind: 'preset', preset: p })}>
                <span style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg, ${PRESETS[p].colors.join(', ')})` }} />
              </WallpaperSwatch>
            ))}
            <WallpaperSwatch active={wp.kind === 'none'} label="Без обоев" onClick={() => setWallpaper({ kind: 'none' })}>
              <span style={{ position: 'absolute', inset: 0, background: '#000' }} />
            </WallpaperSwatch>
            <WallpaperSwatch
              active={wp.kind === 'image' || wp.kind === 'video'}
              label={wp.kind === 'video' ? 'Своё видео' : wp.kind === 'image' ? 'Своя картинка' : 'Свой файл…'}
              onClick={async () => {
                try {
                  const picked = await pickWallpaper()
                  if (picked) setWallpaper(picked)
                } catch (e) {
                  toast(`Не получилось поставить обои: ${String(e)}`, 'error')
                }
              }}
            >
              <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-3)', color: 'var(--label-2)' }}>
                <ImagePlus size={20} strokeWidth={1.8} />
              </span>
            </WallpaperSwatch>
          </div>
        </div>
        <Row title="Размытие" sub={`${Math.round(st.wallpaperBlur)} px`}>
          <div className={s.sliderBox}>
            <Slider label="Размытие обоев" value={st.wallpaperBlur / 60} onChange={(v) => st.update({ wallpaperBlur: Math.round(v * 60) })} onCommit={(v) => st.update({ wallpaperBlur: Math.round(v * 60) })} />
          </div>
        </Row>
        <Row title="Затемнение" sub={`${Math.round(st.wallpaperDim * 100)} %`}>
          <div className={s.sliderBox}>
            <Slider label="Затемнение обоев" value={st.wallpaperDim / 0.9} onChange={(v) => st.update({ wallpaperDim: v * 0.9 })} onCommit={(v) => st.update({ wallpaperDim: v * 0.9 })} />
          </div>
        </Row>
        <Row title="Акцентный цвет" sub={st.accent === 'auto' ? 'Берётся из обложки текущего трека' : 'Фиксированный'}>
          <div className={s.accentDots}>
            <button
              type="button"
              className={s.accentDot}
              aria-pressed={st.accent === 'auto'}
              aria-label="Из обложки"
              title="Из обложки"
              style={{ background: 'conic-gradient(#ff375f, #ff9f0a, #30d158, #0a84ff, #bf5af2, #ff375f)' }}
              onClick={() => st.update({ accent: 'auto' })}
            />
            {ACCENTS.map((c) => (
              <button key={c} type="button" className={s.accentDot} aria-pressed={st.accent === c} aria-label={c} style={{ background: c }} onClick={() => st.update({ accent: c })} />
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Остров" note="Остров — мини-плеер в стиле Dynamic Island сверху экрана. Клики мимо него проходят к окнам под ним.">
        <Row title="Показывать остров">
          <Switch label="Показывать остров" checked={st.island.enabled} onChange={(v) => st.updateIsland({ enabled: v })} />
        </Row>
        <Row title="Раскрывать" sub="Наведение — с небольшой задержкой, чтобы не мешать">
          <Segmented
            id="island-expand"
            value={st.island.expandOn}
            onChange={(v) => st.updateIsland({ expandOn: v })}
            options={[
              { value: 'hover', label: 'Наведением' },
              { value: 'click', label: 'Кликом' },
            ]}
          />
        </Row>
        <Row title="Когда показывать">
          <select className={s.select} value={st.island.visibility} onChange={(e) => st.updateIsland({ visibility: e.target.value as 'always' | 'background' })}>
            <option value="always">Всегда, пока есть трек</option>
            <option value="background">Только когда окно свёрнуто или в фоне</option>
          </select>
        </Row>
        <Row title="Монитор">
          <select className={s.select} value={st.island.monitor ?? ''} onChange={(e) => st.updateIsland({ monitor: e.target.value || null })}>
            <option value="">Основной</option>
            {monitors.map((m, i) => (
              <option key={m} value={m}>
                Монитор {i + 1} ({m.replace(/^\\\\\.\\/, '')})
              </option>
            ))}
          </select>
        </Row>
        <Row title="Положение" sub={st.island.position ? 'Там, куда вы перетащили остров' : 'Сверху по центру монитора. Раскройте остров и тяните за пустое место'}>
          <Button disabled={!st.island.position} onClick={() => st.updateIsland({ position: null })}>
            Вернуть наверх
          </Button>
        </Row>
        <Row title="Закрепить на месте" sub="Остров не сдвинется случайно">
          <Switch label="Закрепить на месте" checked={st.island.locked} onChange={(v) => st.updateIsland({ locked: v })} />
        </Row>
        <Row title="Показывать при смене трека">
          <Switch label="Показывать при смене трека" checked={st.island.showOnTrackChange} onChange={(v) => st.updateIsland({ showOnTrackChange: v })} />
        </Row>
        <Row title="Прятать в полноэкранных приложениях" sub="Игры, видео на весь экран, презентации">
          <Switch label="Прятать в полноэкранных приложениях" checked={st.island.hideInFullscreen} onChange={(v) => st.updateIsland({ hideInFullscreen: v })} />
        </Row>
      </Group>

      <Group
        title="Горячие клавиши"
        note={
          failed.length ? (
            <span className={s.warn}>Не удалось назначить: {failed.map((a) => HOTKEY_LABELS[a]).join(', ')} — сочетание занято другой программой.</span>
          ) : (
            'Работают во всей системе, даже когда Nocturne свёрнут. Медиаклавиши клавиатуры работают всегда.'
          )
        }
      >
        <Row title="Глобальные горячие клавиши">
          <Switch label="Глобальные горячие клавиши" checked={st.hotkeysEnabled} onChange={(v) => st.update({ hotkeysEnabled: v })} />
        </Row>
        {(Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]).map((a) => (
          <Row key={a} title={HOTKEY_LABELS[a]}>
            <HotkeyInput
              label={HOTKEY_LABELS[a]}
              value={st.hotkeys[a]}
              conflict={dupes.has(a)}
              failed={failed.includes(a)}
              onChange={(acc) => st.update({ hotkeys: { ...st.hotkeys, [a]: acc } })}
            />
          </Row>
        ))}
        <Row title="Вернуть стандартные сочетания">
          <Button onClick={() => st.update({ hotkeys: DEFAULT_HOTKEYS })}>
            <RotateCcw size={14} /> Сбросить
          </Button>
        </Row>
      </Group>

      <Group title="Приложение">
        <Row title="Закрывать в трей" sub="Крестик прячет окно, музыка продолжает играть">
          <Switch label="Закрывать в трей" checked={st.closeToTray} onChange={(v) => st.update({ closeToTray: v })} />
        </Row>
        <Row title="Транслировать в статус VK" sub="Друзья увидят, что вы слушаете">
          <Switch label="Транслировать в статус VK" checked={st.broadcastStatus} onChange={(v) => st.update({ broadcastStatus: v })} />
        </Row>
      </Group>

      <Group title="О программе" note="Nocturne — неофициальный клиент. Он не связан с VK и работает через вашу веб-сессию vk.ru, как браузер. Если VK изменит веб-версию, часть функций может временно перестать работать.">
        <AboutRow />
      </Group>
    </div>
  )
}

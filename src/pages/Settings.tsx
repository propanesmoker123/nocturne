import { useQuery } from '@tanstack/react-query'
import { ImagePlus, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from '../app/router'
import { useSession } from '../app/session'
import { useSheet } from '../app/sheetStore'
import { renameDevice, unlinkAll, unlinkHere, useDevices } from '../connect/devices'
import { onlineDevices } from '../connect/logic'
import { toast } from '../app/toast'
import { Button, Segmented, Spinner, Switch } from '../components/controls'
import { HotkeyInput } from '../components/HotkeyInput'
import { PageHeader } from '../components/PageHeader'
import { ServiceLogo } from '../components/ServiceLogo'
import { Slider } from '../components/Slider'
import { PRESETS, PresetLayer } from '../components/Wallpaper'
import { useHotkeyStatus } from '../lib/globalHotkeys'
import { copyJournal, openJournalFolder } from '../lib/journal'
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, findDuplicateHotkeys, type HotkeyAction } from '../lib/hotkeys'
import { ISLAND_MAX_TRANSPARENCY, WALLPAPER_PRESETS, useSettings, type WallpaperConfig } from '../lib/settings'
import { isTauri } from '../lib/tauri'
import { deleteWallpaper, listWallpapers, pickWallpaper, wallpaperKind, wallpaperUrl } from '../lib/wallpaper'
import { useUpdates } from '../lib/updates'
import { usePlayer } from '../player/store'
import { useScSession } from '../sc/session'
import { IslandProgressPicker } from '../components/IslandProgressPicker'
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

function Row({ title, sub, stacked, children }: { title: string; sub?: ReactNode; stacked?: boolean; children?: ReactNode }) {
  return (
    <div className={stacked ? `${s.row} ${s.rowStacked}` : s.row}>
      <div className={s.rowText}>
        <div className={s.rowTitle}>{title}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

/** The SoundCloud row of «Аккаунты»: who is signed in, and the way out or in. */
function SoundCloudAccount() {
  const sc = useScSession()
  const signedIn = sc.phase !== 'signed-out'
  const push = useRouter((r) => r.push)
  const me = sc.user
  return (
    <div className={s.row}>
      {sc.user?.avatar ? <img className={s.avatar} src={sc.user.avatar} alt="" referrerPolicy="no-referrer" /> : <ServiceLogo id="sc" size={36} />}
      <div className={s.rowText}>
        <div className={s.rowTitle}>{sc.user?.name || 'SoundCloud'}</div>
        <div className={s.rowSub}>{signedIn ? 'Вход выполнен. В России SoundCloud играет только через VPN.' : 'Вход не выполнен'}</div>
      </div>
      {signedIn ? (
        <>
          {me && me.id > 0 && <Button onClick={() => push({ name: 'sc-user', id: me.id, title: me.name })}>Мой профиль</Button>}
          <Button variant="danger" onClick={() => void sc.logout()}>
            Выйти
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={sc.signingIn} onClick={() => void sc.login()}>
          {sc.signingIn && <Spinner size={14} />} Войти в SoundCloud
        </Button>
      )}
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

/** An imported wallpaper: a live thumbnail, and a cross that deletes the file. */
function SavedWallpaper({ src, active, onPick, onDelete }: { src: string; active: boolean; onPick(): void; onDelete(): void }) {
  const url = wallpaperUrl(src)
  const video = wallpaperKind(src) === 'video'
  return (
    <div className={s.saved}>
      <WallpaperSwatch active={active} label={video ? 'Видео' : 'Картинка'} onClick={onPick}>
        {video ? (
          <video className={s.thumb} src={`${url}#t=0.5`} muted preload="metadata" playsInline />
        ) : (
          <img className={s.thumb} src={url} alt="" draggable={false} />
        )}
      </WallpaperSwatch>
      <button type="button" className={s.savedDelete} aria-label="Удалить эти обои" title="Удалить" onClick={onDelete}>
        <X size={12} strokeWidth={2.8} />
      </button>
    </div>
  )
}

/** Preset swatches, an "automatic" choice and any colour from the system picker. */
function ColorDots({ value, onChange, auto }: { value: string; onChange(v: string): void; auto: { value: string; label: string; background: string } }) {
  const custom = value !== auto.value && !ACCENTS.includes(value)
  return (
    <div className={s.accentDots}>
      <button type="button" className={s.accentDot} aria-pressed={value === auto.value} aria-label={auto.label} title={auto.label} style={{ background: auto.background }} onClick={() => onChange(auto.value)} />
      {ACCENTS.map((c) => (
        <button key={c} type="button" className={s.accentDot} aria-pressed={value === c} aria-label={c} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
      <label className={`${s.accentDot} ${s.customDot}`} data-active={custom || undefined} title="Свой цвет" style={custom ? { background: value } : undefined}>
        {!custom && <Plus size={14} strokeWidth={2.4} />}
        <input type="color" className={s.colorInput} aria-label="Свой цвет" value={custom ? value : '#ff375f'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
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
  const devices = useDevices()
  const online = onlineDevices(devices.devices, Date.now())
  const logout = useSession((x) => x.logout)
  const failed = useHotkeyStatus((h) => h.failed)
  const monitors = useMonitors()
  const cover = usePlayer((p) => p.current?.cover?.s)
  const dupes = new Set(findDuplicateHotkeys(st.hotkeys))
  const wp = st.wallpaper
  const setWallpaper = (w: WallpaperConfig) => st.update({ wallpaper: w })
  const saved = useQuery({ queryKey: ['wallpapers'], queryFn: listWallpapers, staleTime: Infinity })

  return (
    <div className={s.wrap}>
      <PageHeader title="Настройки" />

      <Group title="Аккаунты">
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
        <SoundCloudAccount />
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
            {(saved.data ?? []).map((src) => (
              <SavedWallpaper
                key={src}
                src={src}
                active={(wp.kind === 'image' || wp.kind === 'video') && wp.src === src}
                onPick={() => setWallpaper({ kind: wallpaperKind(src), src })}
                onDelete={async () => {
                  try {
                    await deleteWallpaper(src)
                    if ((wp.kind === 'image' || wp.kind === 'video') && wp.src === src) setWallpaper({ kind: 'dynamic' })
                    void saved.refetch()
                  } catch (e) {
                    toast(String(e), 'error')
                  }
                }}
              />
            ))}
            <WallpaperSwatch
              active={false}
              label="Добавить…"
              onClick={async () => {
                try {
                  const picked = await pickWallpaper()
                  if (picked) setWallpaper(picked)
                  void saved.refetch()
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
          <ColorDots
            value={st.accent}
            onChange={(accent) => st.update({ accent })}
            auto={{ value: 'auto', label: 'Из обложки', background: 'conic-gradient(#ff375f, #ff9f0a, #30d158, #0a84ff, #bf5af2, #ff375f)' }}
          />
        </Row>
        <Row title="Цвет волны" sub={st.waveColor === 'accent' ? 'Как акцентный цвет' : 'Свой цвет для проигранной части'}>
          <ColorDots
            value={st.waveColor}
            onChange={(waveColor) => st.update({ waveColor })}
            auto={{ value: 'accent', label: 'Как акцент', background: 'var(--accent)' }}
          />
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
        <Row title="Прозрачность" sub={`${Math.round(st.island.transparency * 100)} %`}>
          <div className={s.sliderBox}>
            <Slider
              label="Прозрачность острова"
              value={st.island.transparency / ISLAND_MAX_TRANSPARENCY}
              onChange={(v) => st.updateIsland({ transparency: v * ISLAND_MAX_TRANSPARENCY })}
              onCommit={(v) => st.updateIsland({ transparency: v * ISLAND_MAX_TRANSPARENCY })}
            />
          </div>
        </Row>
        <Row title="Прогресс трека" sub="Как свёрнутый островок показывает, сколько прошло" stacked>
          <IslandProgressPicker value={st.island.progress} onChange={(progress) => st.updateIsland({ progress })} />
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

      <Group title="Мои устройства" note="Связанные устройства видят друг друга: музыку можно перенести с той же секунды, а одно устройство становится пультом для другого. Связь зашифрована кодом, который знают только ваши устройства.">
        <Row title="Это устройство">
          <input className={s.nameInput} defaultValue={devices.name} key={devices.name} maxLength={40} onBlur={(e) => renameDevice(e.target.value)} aria-label="Имя этого устройства" />
        </Row>
        <Row title="Связь" sub={devices.code ? (online.length ? `В сети: ${online.map((d) => d.presence.name).join(', ')}` : 'Других устройств сейчас нет в сети') : 'Это устройство ни с чем не связано'}>
          <Button onClick={() => useSheet.getState().open({ kind: 'link-device' })}>{devices.code ? 'Связать ещё' : 'Связать устройство'}</Button>
        </Row>
        {devices.code && (
          <Row title="Отвязать" sub="«Все» меняет код: остальные устройства потеряют связь">
            <Button
              onClick={() =>
                useSheet.getState().open({ kind: 'confirm', title: 'Отвязать это устройство?', message: 'Оно перестанет видеть остальные ваши устройства. Альбомы на этом устройстве удалятся (на других останутся).', confirmLabel: 'Отвязать', danger: true, onConfirm: unlinkHere })
              }
            >
              Это устройство
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                useSheet.getState().open({ kind: 'confirm', title: 'Отвязать все устройства?', message: 'Код сменится, и остальные устройства придётся связать заново. Коды всех альбомов тоже сменятся: друзьям из общих альбомов нужно будет дать новый код.', confirmLabel: 'Отвязать все', danger: true, onConfirm: unlinkAll })
              }
            >
              Все
            </Button>
          </Row>
        )}
      </Group>

      <Group
        title="Журнал"
        note="Записи о входе, ошибках VK, воспроизведения и обновлений — чтобы разобраться, если что-то сломалось. Без паролей, токенов, ссылок и названий треков. Хранится только на этом компьютере, не больше 10 МБ: старые записи удаляются сами."
      >
        <Row title="Журнал работы" sub="Скопируйте и отправьте тому, кто помогает разобраться">
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              onClick={async () => {
                try {
                  toast((await copyJournal()) ? 'Журнал скопирован' : 'Журнал пока пуст', 'info')
                } catch (e) {
                  toast(`Не получилось скопировать: ${String(e)}`, 'error')
                }
              }}
            >
              Скопировать
            </Button>
            <Button onClick={() => void openJournalFolder().catch((e) => toast(`Не получилось открыть папку: ${String(e)}`, 'error'))}>Открыть папку</Button>
          </div>
        </Row>
      </Group>

      <Group title="О программе" note="Nocturne — неофициальный клиент. Он не связан с VK и работает через вашу веб-сессию vk.ru, как браузер. Если VK изменит веб-версию, часть функций может временно перестать работать.">
        <AboutRow />
      </Group>
    </div>
  )
}

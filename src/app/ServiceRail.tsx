import { useScSession } from '../sc/session'
import { ServiceLogo } from '../components/ServiceLogo'
import { SERVICES, useService } from './service'
import s from './ServiceRail.module.css'

/** The column of services at the window's left edge (like servers in Discord). */
export function ServiceRail() {
  const current = useService((x) => x.current)
  const select = useService((x) => x.select)
  const scPhase = useScSession((x) => x.phase)
  return (
    <nav className={s.rail} aria-label="Сервисы">
      <div className={s.drag} data-tauri-drag-region />
      <div className={s.list} role="tablist" aria-orientation="vertical" aria-label="Сервисы">
        {SERVICES.map((info) => {
          const on = info.id === current
          const out = info.id === 'sc' && scPhase === 'signed-out'
          return (
            <button
              key={info.id}
              type="button"
              role="tab"
              aria-selected={on}
              title={out ? `${info.name} — войти` : info.name}
              className={s.service}
              data-on={on || undefined}
              data-out={out || undefined}
              style={{ ['--ring' as string]: info.color }}
              onClick={() => select(info.id)}
            >
              <ServiceLogo id={info.id} size={36} tone="dark" />
            </button>
          )
        })}
      </div>
      <div className={s.rest} data-tauri-drag-region />
    </nav>
  )
}

import { ChevronRight } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Spinner } from '../components/controls'
import { useMenu, type MenuItem } from './menu'
import s from './overlays.module.css'

function place(el: HTMLElement | null, x: number, y: number) {
  if (!el) return { left: x, top: y }
  const r = el.getBoundingClientRect()
  const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
  return { left, top }
}

function MenuList({ items, x, y, onDone, nested }: { items: MenuItem[]; x: number; y: number; onDone: () => void; nested?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [sub, setSub] = useState<{ index: number; items: MenuItem[] | null; x: number; y: number } | null>(null)

  useLayoutEffect(() => setPos(place(ref.current, x, y)), [x, y, items])

  const openSub = (index: number, item: MenuItem, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const sx = r.right + 4 + 240 > window.innerWidth ? r.left - 244 : r.right + 4
    setSub({ index, items: null, x: sx, y: r.top - 5 })
    void item.submenu!().then((loaded) => setSub((cur) => (cur && cur.index === index ? { ...cur, items: loaded } : cur)))
  }

  return (
    <>
      <motion.div
        ref={ref}
        role="menu"
        className={s.menu}
        style={pos}
        initial={{ opacity: 0, scale: nested ? 1 : 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className={s.menuSep} />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={s.menuItem}
              disabled={item.disabled}
              data-danger={item.danger || undefined}
              data-open={sub?.index === i || undefined}
              onMouseEnter={(e) => (item.submenu ? openSub(i, item, e.currentTarget) : setSub(null))}
              onClick={(e) => {
                if (item.submenu) {
                  openSub(i, item, e.currentTarget)
                  return
                }
                item.onSelect?.()
                onDone()
              }}
            >
              <span className={s.menuIcon}>{item.icon}</span>
              <span className={s.menuLabel}>{item.label}</span>
              {item.submenu && <ChevronRight size={14} strokeWidth={2.2} />}
            </button>
          ),
        )}
      </motion.div>
      {sub &&
        (sub.items ? (
          <MenuList nested items={sub.items} x={sub.x} y={sub.y} onDone={onDone} />
        ) : (
          <div className={s.menu} style={{ left: sub.x, top: sub.y }}>
            <div className={s.menuLoading}>
              <Spinner size={16} />
            </div>
          </div>
        ))}
    </>
  )
}

export function ContextMenu() {
  const { open, x, y, items, close } = useMenu()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  if (!open) return null
  return (
    <>
      {(
        <div
          className={s.menuLayer}
          onMouseDown={(e) => e.target === e.currentTarget && close()}
          onContextMenu={(e) => {
            e.preventDefault()
            close()
          }}
        >
          <MenuList items={items} x={x} y={y} onDone={close} />
        </div>
      )}
    </>
  )
}

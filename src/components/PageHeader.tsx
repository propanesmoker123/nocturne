import { useEffect, type ReactNode } from 'react'
import { useChrome } from '../app/chrome'
import s from './PageHeader.module.css'

/** iOS large title; also feeds the inline title shown in the navigation bar on scroll. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  const setTitle = useChrome((c) => c.setTitle)
  useEffect(() => setTitle(title), [title, setTitle])
  return (
    <div className={s.header}>
      <div style={{ minWidth: 0 }}>
        <h1 className={s.largeTitle}>{title}</h1>
        {subtitle && <p className={s.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={s.headerActions}>{actions}</div>}
    </div>
  )
}

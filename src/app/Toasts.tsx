import { AlertTriangle, Info, ListPlus, Minus } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { IconCheck } from '../components/Icons'
import s from './overlays.module.css'
import { useToasts, type ToastIcon } from './toast'

function Glyph({ kind }: { kind: ToastIcon }) {
  const p = { size: 13, strokeWidth: 2.6 } as const
  switch (kind) {
    case 'added':
      return <IconCheck size={14} />
    case 'removed':
      return <Minus {...p} />
    case 'error':
      return <AlertTriangle size={12} strokeWidth={2.6} />
    case 'queue':
      return <ListPlus {...p} />
    default:
      return <Info {...p} />
  }
}

export function Toasts() {
  const toasts = useToasts((t) => t.toasts)
  const dismiss = useToasts((t) => t.dismiss)
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={s.toast}
            data-plain={!t.action || undefined}
            initial={{ opacity: 0, y: 16, scale: 0.94, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 8, scale: 0.96, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          >
            <span className={s.toastIcon} data-kind={t.icon}>
              <Glyph kind={t.icon} />
            </span>
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className={s.toastAction}
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

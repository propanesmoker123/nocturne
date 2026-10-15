import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { IconButton } from '../components/controls'
import s from './CoverViewer.module.css'

/** The cover over the whole player at full size. A click anywhere, ✕ or Esc closes it — Esc closes only the cover. */
export function CoverViewer({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // captured first, so the player's own Esc (collapse) never sees it
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [src, onClose])

  return (
    <AnimatePresence>
      {src && (
        <motion.div
          key="cover"
          className={s.viewer}
          role="dialog"
          aria-modal="true"
          aria-label="Обложка"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            draggable={false}
            initial={{ scale: 0.94 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          />
          <IconButton className={s.close} size={36} label="Закрыть" onClick={onClose}>
            <X size={20} strokeWidth={2.2} />
          </IconButton>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

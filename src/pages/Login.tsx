import { motion } from 'motion/react'
import appIcon from '../assets/app-icon.png'
import { useSession } from '../app/session'
import { WindowControls } from '../app/Titlebar'
import { Button, Spinner } from '../components/controls'
import { Wallpaper } from '../components/Wallpaper'
import s from './Login.module.css'

export function Login() {
  const loggingIn = useSession((x) => x.loggingIn)
  const login = useSession((x) => x.login)
  return (
    <div className={s.screen}>
      <Wallpaper config={{ kind: 'preset', preset: 'dusk' }} look={{ blur: 0, dim: 0.45 }} />
      <div className={s.chrome} data-tauri-drag-region>
        <WindowControls />
      </div>
      <motion.div
        className={s.card}
        initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ type: 'spring', stiffness: 160, damping: 22 }}
      >
        <img className={s.icon} src={appIcon} alt="" />
        <h1 className={s.title}>Nocturne</h1>
        <p className={s.lead}>Ваша VK Музыка на компьютере: рекомендации, плейлисты, остров сверху экрана и горячие клавиши.</p>
        <div className={s.actions}>
          {loggingIn ? (
            <>
              <div className={s.waiting}>
                <Spinner size={18} />
                Войдите в открывшемся окне VK
              </div>
              <button type="button" className={s.link} onClick={() => void login()}>
                Открыть окно входа ещё раз
              </button>
            </>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void login()}>
              Войти через VK
            </Button>
          )}
          <p className={s.note}>Вход идёт на странице VK в отдельном окне — пароль Nocturne не видит. Доступ хранится только в памяти, пока приложение открыто.</p>
        </div>
      </motion.div>
      <div className={s.disclaimer}>Неофициальный клиент. Nocturne не связан с VK.</div>
    </div>
  )
}

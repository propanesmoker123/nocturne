import type { ReactNode } from 'react'
import { Button, Spinner } from '../../components/controls'
import { ServiceLogo } from '../../components/ServiceLogo'
import { useScSession } from '../../sc/session'
import s from './sc.module.css'

/** A SoundCloud page shows only once the account is there; until then, the way in. */
export function ScGate({ children }: { children: ReactNode }) {
  const phase = useScSession((x) => x.phase)
  if (phase === 'checking')
    return (
      <div className={s.center}>
        <Spinner size={22} />
      </div>
    )
  if (phase === 'signed-out') return <ScSignIn />
  return <>{children}</>
}

export function ScSignIn() {
  const signingIn = useScSession((x) => x.signingIn)
  const error = useScSession((x) => x.error)
  const login = useScSession((x) => x.login)
  return (
    <div className={s.signin}>
      <ServiceLogo id="sc" size={56} />
      <h1 className={s.signinTitle}>SoundCloud</h1>
      <p className={s.signinText}>Рекомендации, лента и лайки вашего аккаунта SoundCloud — прямо в Nocturne.</p>
      <Button variant="primary" size="lg" disabled={signingIn} onClick={() => void login()}>
        {signingIn && <Spinner size={15} />} Войти в SoundCloud
      </Button>
      {error && (
        <p className={s.signinError} role="alert">
          {error}
        </p>
      )}
      <p className={s.signinNote}>В России SoundCloud играет только через VPN</p>
    </div>
  )
}

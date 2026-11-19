import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** When this key changes, a caught error state resets automatically (e.g. route change). */
  resetKey?: string
  label?: string
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label ?? 'view'}]`, error, info.componentStack)
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          minHeight: '220px',
          height: '100%',
          padding: '32px',
          textAlign: 'center',
          color: 'var(--label, #fff)',
        }}
      >
        <div style={{ fontSize: '18px', fontWeight: 600 }}>Не удалось отобразить экран</div>
        <div style={{ fontSize: '13px', color: 'var(--label-2, rgba(235,235,245,0.68))', maxWidth: '420px', wordBreak: 'break-word' }}>
          {error.message || 'Произошла непредвиденная ошибка интерфейса.'}
        </div>
        <button
          type="button"
          onClick={this.reset}
          style={{
            marginTop: '4px',
            padding: '8px 18px',
            borderRadius: '999px',
            background: 'var(--accent, #ff375f)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Повторить
        </button>
      </div>
    )
  }
}

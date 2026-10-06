import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function Boot() {
  return <div style={{ color: '#fff', font: '600 28px system-ui', padding: 40 }}>Nocturne</div>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
)

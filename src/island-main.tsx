import '@fontsource-variable/inter/opsz.css'
import './styles/tokens.css'
import './island/island-base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { IslandApp } from './island/IslandApp'

createRoot(document.getElementById('island-root')!).render(
  <StrictMode>
    <IslandApp />
  </StrictMode>,
)

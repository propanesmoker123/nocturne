import '@fontsource-variable/inter/opsz.css'
import './styles/tokens.css'
import './quicksearch/quicksearch-base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickSearchApp } from './quicksearch/QuickSearchApp'

createRoot(document.getElementById('search-root')!).render(
  <StrictMode>
    <QuickSearchApp />
  </StrictMode>,
)

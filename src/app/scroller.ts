import { createContext, useContext } from 'react'

/** The main page scroller, so virtualized lists can share the window's single scrollbar. */
export const ScrollerContext = createContext<{ current: HTMLDivElement | null }>({ current: null })

export const useScroller = () => useContext(ScrollerContext)

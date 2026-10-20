/** Enter plays a row only when the row itself has the focus (not a button or a link inside it). */
export const enterPlays = (e: { key: string; target: unknown; currentTarget: unknown }) => e.key === 'Enter' && e.target === e.currentTarget

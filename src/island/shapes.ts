/** Rounded rectangle traced clockwise from the middle of its top edge, so progress starts where the eye expects. */
export function roundedPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M ${x + w / 2} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
}

/**
 * Categorical series colours, assigned in this fixed order and never cycled.
 * The order is what keeps adjacent series distinguishable under colour-vision
 * deficiency, so do not reorder it without re-validating. Each scheme has its
 * own steps of the same eight hues, chosen for its surface.
 */
export const categorical = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
} as const

/** The hues of the categorical palette, in its default order. */
export const hues = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'] as const
export type Hue = (typeof hues)[number]

/**
 * Other orders of the same hues a chart can take. Each passes the same checks
 * as the default in both schemes: every adjacent pair stays apart for
 * protanopia and deuteranopia and for full colour vision, and so do all pairs
 * of the first three, which is all a scatter chart uses.
 */
export const palettes = {
  default: hues,
  fresh: ['aqua', 'blue', 'orange', 'violet', 'yellow', 'magenta', 'green', 'red'],
  warm: ['orange', 'violet', 'aqua', 'blue', 'yellow', 'magenta', 'green', 'red'],
} as const satisfies Record<string, readonly Hue[]>
export type PaletteName = Exclude<keyof typeof palettes, 'default'>

export const hueColor = (hue: Hue, scheme: ChartColorScheme): string => categorical[scheme][hues.indexOf(hue)]!

/** The colours of a palette in its order. */
export const paletteColors = (name: PaletteName | undefined, scheme: ChartColorScheme): string[] => palettes[name ?? 'default'].map((hue) => hueColor(hue, scheme))

/**
 * One blue, light to dark, for magnitude: a heatmap's cells, a funnel's
 * stages. On the dark surface more is lighter, so the ramp is read the other
 * way round there.
 */
export const sequential = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'] as const

/**
 * Steps of the ramp for ordered marks, such as a funnel's stages, most first.
 * The step nearest the surface still stands out from it: on the light surface
 * none lighter than #86b6ef, on the dark none darker than #184f95.
 */
export function ordinal(count: number, scheme: ChartColorScheme): string[] {
  const steps = scheme === 'light' ? sequential.slice(3).reverse() : sequential.slice(0, 11)
  if (count <= 1) return [steps[Math.floor(steps.length / 2)]!]
  return Array.from({ length: count }, (_, i) => steps[Math.round((i * (steps.length - 1)) / (count - 1))]!)
}

/** The ramp for magnitude, from least to most, as the scheme reads it. */
export const magnitude = (scheme: ChartColorScheme): string[] => (scheme === 'light' ? [...sequential] : [...sequential].reverse().slice(1))

export const chrome = {
  light: { surface: '#ffffff', tableHeader: '#eef1f5', text: '#11141a', textSecondary: '#5d6575', grid: '#eceef2', axis: '#cdd2db', up: '#006300', down: '#d92d20' },
  dark: { surface: '#15181e', tableHeader: '#262d38', text: '#eceef2', textSecondary: '#9ba3b4', grid: '#252a33', axis: '#3d4450', up: '#0ca30c', down: '#f0605a' },
} as const

export type ChartColorScheme = keyof typeof categorical

/** The colours around the marks: text, lines and the surface they are drawn on. */
export type Ink = Record<keyof (typeof chrome)['light'], string>

/** Mixes share of a #rrggbb colour into another, as color-mix in srgb does. */
export function mix(color: string, share: number, base: string): `#${string}` {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  return `#${[1, 3, 5].map((at) => Math.round(channel(color, at) * share + channel(base, at) * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

/**
 * A cell shaded by a conditional format: the hue mixed into the surface, light
 * enough that the text on it reads at 4.5:1 or more for every hue, and the hue
 * drawn toward the text for its icon.
 */
export function highlightInk(hue: Hue, scheme: ChartColorScheme, ink: Ink): { background: string; icon: string } {
  const color = hueColor(hue, scheme)
  return { background: mix(color, scheme === 'light' ? 0.22 : 0.35, ink.surface), icon: mix(color, 0.65, ink.text) }
}

/**
 * The colours a chart is drawn in on a surface. Without one it is the
 * scheme's own; a surface of the author's own, as #rrggbb, is drawn on with
 * the scheme whose text reads on it, and table headers are tinted from it.
 */
export function inkFor(scheme: ChartColorScheme, surface?: string): Ink {
  const ink = chrome[scheme]
  return surface ? { ...ink, surface, tableHeader: mix(ink.text, 0.07, surface) } : ink
}

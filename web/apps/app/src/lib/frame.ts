// How a widget's box looks. See .agents/design/chart-dashboard.md 3.14.
import { hueColor, mix, type ChartColorScheme, type Hue } from '@supabi/charts'
import { themeVariables, tokensFor } from '@supabi/ui'
import type { CSSProperties } from 'react'

export type Padding = 'compact' | 'normal' | 'comfortable'
export const paddings: Padding[] = ['compact', 'normal', 'comfortable']

/**
 * What is behind a widget: the theme's surface, which the page has too, where
 * a default would give another; a light grey, a tint of one of the palette's
 * hues, or a colour of the author's own as #rrggbb.
 */
export type Background = 'default' | 'neutral' | Hue | `#${string}`

/**
 * How a widget's box looks. What is left out follows the dashboard's frame on
 * charts and text, and the widget type's own look otherwise.
 */
export interface Frame {
  /** The background in the light scheme, and in the dark one unless backgroundDark says otherwise. */
  background?: Background
  /**
   * The background in the dark scheme. Left out, the dark scheme follows the
   * light one: a grey or a hue in its own step, a colour of the author's own as it is.
   */
  backgroundDark?: Background
  /** How far the background lets through what is behind it, in percent: 0 is opaque, 100 lets everything through. The same in both schemes. */
  transparency?: number
  border?: boolean
  padding?: Padding
}

export type FramedType = 'chart' | 'tabs' | 'title' | 'text' | 'query'

/** What each type of widget looks like when nothing says otherwise: charts, tab containers, text and the query container are cards; a title is not. */
const typeFrames: Record<FramedType, Frame> = { chart: { border: true }, tabs: { border: true }, text: { border: true }, title: { border: false }, query: { border: true } }

/** The frame a widget is drawn with: its own, over the dashboard's for charts, tab containers and text, over its type's. */
export function frameOf(type: FramedType, own: Frame | undefined, board?: Frame): Frame {
  const layers = [typeFrames[type], ...(type === 'title' || type === 'query' ? [] : [board]), own]
  const frame: Frame = { padding: 'normal' }
  for (const layer of layers) {
    if (!layer) continue
    if (layer.border !== undefined) frame.border = layer.border
    if (layer.transparency !== undefined) frame.transparency = layer.transparency
    if (layer.padding) frame.padding = layer.padding
    // A background of its own is followed by the dark scheme, unless that has one of its own too.
    if (layer.background) {
      frame.background = layer.background
      delete frame.backgroundDark
    }
    if (layer.backgroundDark) frame.backgroundDark = layer.backgroundDark
  }
  if (frame.background === 'default') delete frame.background
  return frame
}

/** A colour of the author's own: # and six hex digits. */
export const isHexColor = (value: string | undefined): value is `#${string}` => value !== undefined && /^#[0-9a-f]{6}$/i.test(value)

/** The relative luminance of a #rrggbb colour, as WCAG reckons it. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** The scheme whose text reads best on a colour of the author's own: the light scheme's dark text, or the dark scheme's light text. */
export function schemeOn(hex: string): ChartColorScheme {
  const background = luminance(hex)
  return contrast(background, luminance(tokensFor('light').colorText)) >= contrast(background, luminance(tokensFor('dark').colorText)) ? 'light' : 'dark'
}

/** The background a frame shows in a scheme other than its type's own, if any, with a colour of the author's own in lower case. */
export function backgroundIn(frame: Frame, scheme: ChartColorScheme): Exclude<Background, 'default'> | undefined {
  const value = scheme === 'dark' && frame.backgroundDark ? frame.backgroundDark : frame.background
  if (!value || value === 'default') return undefined
  return isHexColor(value) ? value.toLowerCase() as `#${string}` : value
}

export interface FrameLook {
  className: string
  style: CSSProperties
  /** With a background: its colour, for charts to be drawn on, and the scheme they are drawn in. */
  surface?: string
  scheme?: ChartColorScheme
}

/** The colour a background is shown as among the swatches for a scheme: the surface, a mid grey, the hue itself, or the author's own. */
export function swatchOf(background: Background, scheme: ChartColorScheme): `#${string}` {
  const tokens = tokensFor(scheme)
  if (background === 'default') return tokens.colorSurface as `#${string}`
  if (background === 'neutral') return mix(tokens.colorText, 0.3, tokens.colorSurface)
  return isHexColor(background) ? background.toLowerCase() as `#${string}` : hueColor(background, scheme) as `#${string}`
}

/** The light tint a grey or a hue makes on the scheme's own surface. */
export function tintOf(background: 'neutral' | Hue, scheme: ChartColorScheme): `#${string}` {
  const tokens = tokensFor(scheme)
  return background === 'neutral' ? mix(tokens.colorText, 0.05, tokens.colorSurface) : mix(hueColor(background, scheme), scheme === 'dark' ? 0.18 : 0.12, tokens.colorSurface)
}

/** A #rrggbb colour letting through what is behind it, as CSS writes it. */
function seeThrough(hex: string, opacity: number): string {
  if (opacity >= 1) return hex
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16)
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${Math.round(opacity * 100) / 100})`
}

/**
 * How a frame is drawn in a scheme. The default background is the theme's
 * surface, the page's own colour. A light grey or a hue is a light tint in the scheme's own step,
 * under the theme's text. A colour of the author's own is shown as it is, and
 * what is inside is drawn in the scheme whose text reads on it. A background
 * lets through what is behind it as far as its transparency says; what is
 * inside is drawn for the colour it then makes on the page's surface. That
 * colour is written onto the box as its surface, with the scheme's variables,
 * which .lb-ink makes the theme's derived colours follow.
 */
export function frameLook(frame: Frame, scheme: ChartColorScheme): FrameLook {
  const classes = [frame.border ? 'bordered' : 'borderless', `pad-${frame.padding ?? 'normal'}`]
  const background = backgroundIn(frame, scheme)
  const opacity = 1 - (frame.transparency ?? 0) / 100
  const page = tokensFor(scheme).colorSurface
  // Kept off its edges with a background in either scheme, so its words do not move when the scheme changes.
  if (backgroundIn(frame, 'light') || backgroundIn(frame, 'dark') || frame.border) classes.push('boxed')
  // The page's own colour: let through, it is drawn on as it is.
  if (!background) return { className: classes.join(' '), style: { background: seeThrough(page, opacity) } }
  const own = isHexColor(background) ? background : undefined
  const color = own ?? tintOf(background as 'neutral' | Hue, scheme)
  const surface = opacity < 1 ? mix(color, opacity, page) : color
  const ink = own ? schemeOn(surface) : scheme
  classes.push('lb-ink', ...(own ? ['own-color'] : []), ...(ink === 'dark' ? ['dark'] : []))
  return { className: classes.join(' '), style: { ...themeVariables(ink), '--lb-color-surface': surface, background: seeThrough(color, opacity), color: 'var(--lb-color-text)' } as CSSProperties, surface, scheme: ink }
}

const said = (value: Background | undefined): Background => (!value || value === 'default' ? 'default' : value.toLowerCase() as Background)
const lightOf = (frame: Frame) => said(frame.background)
const darkOf = (frame: Frame) => (frame.backgroundDark ? said(frame.backgroundDark) : lightOf(frame))

/**
 * What of a frame is to be kept: only what differs from what the widget would
 * be drawn with without it, or nothing. Colours are kept in lower case. A
 * light background of its own is followed by the dark scheme, so a dark one
 * is kept only where it differs; without a light one of its own, a dark one
 * is kept wherever it differs from what would be inherited.
 */
export function keptFrame(frame: Frame, inherited: Frame): Frame | undefined {
  const kept: Frame = {}
  const light = lightOf(frame) !== lightOf(inherited)
  if (light) kept.background = lightOf(frame)
  if ((light && darkOf(frame) !== lightOf(frame)) || (!light && darkOf(frame) !== darkOf(inherited))) kept.backgroundDark = darkOf(frame)
  if ((frame.transparency ?? 0) !== (inherited.transparency ?? 0)) kept.transparency = frame.transparency ?? 0
  if (Boolean(frame.border) !== Boolean(inherited.border)) kept.border = Boolean(frame.border)
  if ((frame.padding ?? 'normal') !== (inherited.padding ?? 'normal')) kept.padding = frame.padding
  return Object.keys(kept).length ? kept : undefined
}

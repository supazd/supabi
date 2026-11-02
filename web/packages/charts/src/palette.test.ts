import { describe, expect, it } from 'vitest'
import { chrome, highlightInk, hues } from './palette'

/** WCAG's contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('conditional format shades', () => {
  it.each(['light', 'dark'] as const)('keeps the text reading on every hue, and the icon showing, on the %s surface', (scheme) => {
    const ink = chrome[scheme]
    for (const hue of hues) {
      const { background, icon } = highlightInk(hue, scheme, ink)
      expect(contrast(ink.text, background), hue).toBeGreaterThanOrEqual(4.5)
      expect(contrast(icon, background), hue).toBeGreaterThanOrEqual(3)
      expect(background, hue).not.toBe(ink.surface)
    }
  })
})

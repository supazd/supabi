import { describe, expect, it } from 'vitest'
import { backgroundIn, frameLook, frameOf, isHexColor, keptFrame, schemeOn, swatchOf, tintOf } from './frame'

describe('widget frames', () => {
  it('takes # and six hex digits as a colour of the author’s own', () => {
    expect(['#1f3a5f', '#FFAA00'].every(isHexColor)).toBe(true)
    expect(['#f00', '1f3a5f', '#1f3a5g', '#1f3a5f0', 'blue', undefined].some(isHexColor)).toBe(false)
  })

  it('draws on a colour of the author’s own in whichever scheme’s text stands further from it', () => {
    expect(['#ffffff', '#fff3c4', '#eda100', '#7fb3ff'].map(schemeOn)).toEqual(['light', 'light', 'light', 'light'])
    expect(['#000000', '#1f3a5f', '#4a3aa7', '#d92d20'].map(schemeOn)).toEqual(['dark', 'dark', 'dark', 'dark'])
  })

  it('lays the widget’s own frame over the dashboard’s, which only charts and text follow, over the type’s', () => {
    const board = { border: false, padding: 'compact' as const, background: '#eef2ff' as const, backgroundDark: '#16202e' as const, transparency: 30 }
    expect(frameOf('chart', undefined)).toEqual({ border: true, padding: 'normal' })
    expect(frameOf('title', undefined, board)).toEqual({ border: false, padding: 'normal' })
    expect(frameOf('text', undefined, board)).toEqual(board)
    // A light background of its own is followed by the dark scheme; the default is the type's own.
    expect(frameOf('chart', { background: 'blue', border: true }, board)).toEqual({ border: true, padding: 'compact', background: 'blue', transparency: 30 })
    expect(frameOf('chart', { background: 'default', transparency: 0 }, board)).toEqual({ border: false, padding: 'compact', transparency: 0 })
    // A dark one of its own leaves the light one as it is.
    expect(frameOf('chart', { backgroundDark: 'default' }, board)).toEqual({ ...board, backgroundDark: 'default' })
  })

  it('shows the light or the dark background as the scheme asks, the dark following the light unless it has its own', () => {
    expect(backgroundIn({ background: '#1F3A5F', backgroundDark: '#0d1b2a' }, 'light')).toBe('#1f3a5f')
    expect(backgroundIn({ background: '#1F3A5F', backgroundDark: '#0d1b2a' }, 'dark')).toBe('#0d1b2a')
    expect(backgroundIn({ background: '#1f3a5f' }, 'dark')).toBe('#1f3a5f')
    expect(backgroundIn({ background: 'blue', backgroundDark: 'neutral' }, 'dark')).toBe('neutral')
    expect(backgroundIn({ background: 'blue', backgroundDark: 'default' }, 'dark')).toBeUndefined()
    expect(backgroundIn({ backgroundDark: 'violet' }, 'light')).toBeUndefined()
  })

  it('tints a grey or a hue under the theme’s text, and draws on a colour of the author’s own in the scheme that reads on it', () => {
    // The default is the page's own colour, the same for every widget.
    expect(frameLook({ border: true, padding: 'normal' }, 'light')).toEqual({ className: 'bordered pad-normal boxed', style: { background: '#ffffff' } })
    expect(frameLook({ padding: 'normal' }, 'dark')).toEqual({ className: 'borderless pad-normal', style: { background: '#15181e' } })
    expect(tintOf('blue', 'light')).toBe('#e5effa')
    expect(tintOf('neutral', 'light')).toBe('#f3f3f4')
    const tinted = frameLook({ background: 'blue', padding: 'compact' }, 'dark')
    expect(tinted).toMatchObject({ className: 'borderless pad-compact boxed lb-ink dark', surface: tintOf('blue', 'dark'), scheme: 'dark' })
    expect(tinted.style).toMatchObject({ background: tintOf('blue', 'dark'), '--lb-color-surface': tintOf('blue', 'dark') })
    const own = frameLook({ background: '#1f3a5f', backgroundDark: '#ffd966' }, 'light')
    expect(own).toMatchObject({ className: 'borderless pad-normal boxed lb-ink own-color dark', surface: '#1f3a5f', scheme: 'dark' })
    expect(own.style).toMatchObject({ background: '#1f3a5f', '--lb-color-surface': '#1f3a5f', '--lb-color-text': '#eceef2' })
    expect(frameLook({ background: '#1f3a5f', backgroundDark: '#ffd966' }, 'dark')).toMatchObject({ surface: '#ffd966', scheme: 'light' })
  })

  it('lets through what is behind a background as far as its transparency says, drawing for the colour it then makes', () => {
    // The page's own colour, half let through, or all of it.
    expect(frameLook({ border: true, transparency: 50 }, 'light').style).toEqual({ background: 'rgba(255, 255, 255, 0.5)' })
    expect(frameLook({ transparency: 100 }, 'dark').style).toEqual({ background: 'rgba(21, 24, 30, 0)' })
    // Navy mostly let through over white is light enough for the light scheme's dark text.
    const navy = frameLook({ background: '#1f3a5f', transparency: 80 }, 'light')
    expect(navy.style).toMatchObject({ background: 'rgba(31, 58, 95, 0.2)', '--lb-color-surface': '#d2d8df' })
    expect(navy).toMatchObject({ surface: '#d2d8df', scheme: 'light' })
    expect(frameLook({ background: '#1f3a5f', transparency: 20 }, 'light').scheme).toBe('dark')
  })

  it('shows each background among the swatches as the scheme being set has it', () => {
    expect(swatchOf('default', 'light')).toBe('#ffffff')
    expect(swatchOf('default', 'dark')).toBe('#15181e')
    expect(swatchOf('blue', 'light')).toBe('#2a78d6')
    expect(swatchOf('blue', 'dark')).toBe('#3987e5')
    expect(swatchOf('neutral', 'light')).not.toBe(swatchOf('neutral', 'dark'))
    expect(swatchOf('#1F3A5F', 'dark')).toBe('#1f3a5f')
  })

  it('keeps only what differs from what the widget would be drawn with', () => {
    const inherited = { border: true, padding: 'normal' as const }
    expect(keptFrame(inherited, inherited)).toBeUndefined()
    expect(keptFrame({ border: false, padding: 'normal' }, inherited)).toEqual({ border: false })
    expect(keptFrame({ border: true, padding: 'comfortable', background: '#1F3A5F', backgroundDark: '#1f3a5f' }, inherited)).toEqual({ padding: 'comfortable', background: '#1f3a5f' })
    expect(keptFrame({ border: true, background: '#1f3a5f', backgroundDark: '#0D1B2A' }, inherited)).toEqual({ background: '#1f3a5f', backgroundDark: '#0d1b2a' })
    // The type's own background where the default gives another is said outright.
    expect(keptFrame({ border: true }, { border: true, background: 'neutral' })).toEqual({ background: 'default' })
    // Only the dark scheme's own, over a light one inherited.
    expect(keptFrame({ border: true, background: 'neutral', backgroundDark: 'default' }, { border: true, background: 'neutral' })).toEqual({ backgroundDark: 'default' })
    // Following the light one again, where the default gave the dark scheme its own.
    expect(keptFrame({ border: true, background: 'neutral' }, { border: true, background: 'neutral', backgroundDark: 'blue' })).toEqual({ backgroundDark: 'neutral' })
    // Transparency is kept where it differs, opaque included.
    expect(keptFrame({ border: true, transparency: 40 }, inherited)).toEqual({ transparency: 40 })
    expect(keptFrame({ border: true, transparency: 0 }, { border: true, transparency: 30 })).toEqual({ transparency: 0 })
  })
})

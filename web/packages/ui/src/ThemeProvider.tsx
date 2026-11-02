import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { LocaleContext, type Locale } from './locale'
import './styles.css'
import { ToastHost } from './Toast'
import { tokensFor, type ColorScheme, type ThemeTokens } from './tokens'

export interface ThemeProviderProps {
  colorScheme: ColorScheme
  locale: Locale
  children: ReactNode
}

/** CSS custom properties let plain stylesheets use the same tokens as components. */
export function themeVariables(scheme: ColorScheme): Record<string, string> {
  return cssVariables(tokensFor(scheme))
}

function cssVariables(t: ThemeTokens): Record<string, string> {
  return {
    '--lb-color-primary': t.colorPrimary,
    '--lb-color-danger': t.colorDanger,
    '--lb-color-success': t.colorSuccess,
    '--lb-color-warning': t.colorWarning,
    '--lb-color-text': t.colorText,
    '--lb-color-text-secondary': t.colorTextSecondary,
    '--lb-color-bg': t.colorBg,
    '--lb-color-surface': t.colorSurface,
    '--lb-color-border': t.colorBorder,
    '--lb-color-dimension': t.colorDimension,
    '--lb-color-measure': t.colorMeasure,
    '--lb-color-metric': t.colorMetric,
    '--lb-code-keyword': t.codeKeyword,
    '--lb-code-string': t.codeString,
    '--lb-code-number': t.codeNumber,
    '--lb-code-comment': t.codeComment,
    '--lb-radius': `${t.radius}px`,
    '--lb-font-size': `${t.fontSize}px`,
    '--lb-font-family': t.fontFamily,
    '--lb-font-mono': t.fontFamilyMono,
  }
}

/**
 * Controls fade their colours over a fraction of a second, while the rest of
 * the page changes at once. On a change of scheme that reads as a flicker, so
 * the fades are off until the new colours have been painted.
 */
function suspendTransitions() {
  const style = document.createElement('style')
  style.textContent = '*, *::before, *::after { transition: none !important; }'
  document.head.appendChild(style)
  // The new colours are computed while the fades are off.
  void getComputedStyle(document.body).color
  // A timer, not an animation frame: a tab in the background gets no frames.
  setTimeout(() => style.remove(), 50)
}

export function ThemeProvider({ colorScheme, locale, children }: ThemeProviderProps) {
  const tokens = tokensFor(colorScheme)
  const painted = useRef(colorScheme)

  useLayoutEffect(() => {
    if (painted.current === colorScheme) return
    painted.current = colorScheme
    suspendTransitions()
  }, [colorScheme])

  useLayoutEffect(() => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(cssVariables(tokens))) {
      root.style.setProperty(name, value)
    }
    root.style.colorScheme = colorScheme
    root.classList.toggle('dark', colorScheme === 'dark')
    root.lang = locale
  }, [tokens, colorScheme, locale])

  return (
    <LocaleContext value={locale}>
      <ToastHost colorScheme={colorScheme}>{children}</ToastHost>
    </LocaleContext>
  )
}

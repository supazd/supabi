/**
 * Design tokens. Every colour, radius and font in the product comes from here;
 * the underlying component library is themed from these values, never the
 * other way round. White-labelling replaces this object.
 */
export interface ThemeTokens {
  colorPrimary: string
  colorDanger: string
  /** Something went well or is in working order: a check passed, a source is reachable. */
  colorSuccess: string
  /** Something wants a look but is not wrong: unchecked, stale, still needed. */
  colorWarning: string
  colorText: string
  colorTextSecondary: string
  colorBg: string
  colorSurface: string
  colorBorder: string
  /** What a field is used as, wherever it appears: on a chip, a column, a heading. */
  colorDimension: string
  colorMeasure: string
  colorMetric: string
  /** Colours of code, as the code editor highlights it. */
  codeKeyword: string
  codeString: string
  codeNumber: string
  codeComment: string
  radius: number
  fontSize: number
  fontFamily: string
  fontFamilyMono: string
}

export type ColorScheme = 'light' | 'dark'

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif'

const fontFamilyMono = 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace'

// Cool neutrals with a hint of blue, so that data and the colours of charts
// read cleanly against them, and one indigo for what can be acted on. Every
// text colour keeps at least 4.5:1 against the surface it is drawn on.
export const lightTokens: ThemeTokens = {
  colorPrimary: '#4655e8',
  colorDanger: '#d92d20',
  colorSuccess: '#12875a',
  colorWarning: '#b45309',
  colorText: '#11141a',
  colorTextSecondary: '#5d6575',
  colorBg: '#f2f3f6',
  colorSurface: '#ffffff',
  colorBorder: '#e2e5eb',
  colorDimension: '#2f6fdf',
  colorMeasure: '#12875a',
  colorMetric: '#c2680c',
  codeKeyword: '#4655e8',
  codeString: '#b4461b',
  codeNumber: '#0b7a66',
  codeComment: '#808899',
  radius: 8,
  fontSize: 14,
  fontFamily,
  fontFamilyMono,
}

export const darkTokens: ThemeTokens = {
  colorPrimary: '#5e6af2',
  colorDanger: '#f0605a',
  colorSuccess: '#3dbf8a',
  colorWarning: '#e3a03a',
  colorText: '#eceef2',
  colorTextSecondary: '#9ba3b4',
  colorBg: '#0b0d11',
  colorSurface: '#15181e',
  colorBorder: '#272c35',
  colorDimension: '#6b9bf5',
  colorMeasure: '#3dbf8a',
  colorMetric: '#e3a03a',
  codeKeyword: '#9aa3ff',
  codeString: '#eba27c',
  codeNumber: '#5fcab3',
  codeComment: '#7c8496',
  radius: 8,
  fontSize: 14,
  fontFamily,
  fontFamilyMono,
}

export function tokensFor(scheme: ColorScheme): ThemeTokens {
  return scheme === 'dark' ? darkTokens : lightTokens
}

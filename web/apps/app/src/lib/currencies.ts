import type { SelectOption } from '@supabi/ui'

// What model providers price in most often comes first; the rest follow by code.
const common = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP']

/** The currency's symbol in the language of the interface, such as ¥ or US$; empty when it has none but its code. */
export function currencySymbol(code: string, locale: string): string {
  try {
    const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'symbol' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value
    return symbol && symbol !== code ? symbol : ''
  } catch {
    return ''
  }
}

/**
 * Every ISO 4217 currency the browser knows, each labelled with its code,
 * symbol and name, so that it can be found by any of them. A code the
 * browser does not know, kept from before, is listed as it is.
 */
export function currencyOptions(locale: string, keep?: string): SelectOption<string>[] {
  const names = new Intl.DisplayNames([locale], { type: 'currency' })
  const codes = [...new Set([...common, ...Intl.supportedValuesOf('currency'), ...(keep ? [keep] : [])])]
  return codes.map((code) => {
    const name = names.of(code)
    return { value: code, label: [code, currencySymbol(code, locale), name !== code ? name : ''].filter(Boolean).join(' · ') }
  })
}

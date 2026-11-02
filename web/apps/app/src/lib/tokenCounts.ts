// Numbers of tokens as model providers write them: 128K, 1M. K is a
// thousand and M a million, as most providers count; those that mean 1,024
// differ by a few percent, which the assistant's margins absorb.

const units = { k: 1_000, m: 1_000_000 } as const
// How many decimal places a unit takes: 1.5K is 1,500, and 1.5005K is not a whole number.
const places = { k: 3, m: 6 } as const

/**
 * Reads a number of tokens written plainly (128000, 128,000) or with a unit
 * (128K, 1.0M, 1.5m). Undefined unless it is a positive whole number of tokens.
 */
export function parseTokenCount(text: string): number | undefined {
  const match = /^(\d+)(?:\.(\d+))?([kKmM])?$/.exec(text.replace(/[,\s]/g, ''))
  if (!match) return undefined
  const [, whole = '', fraction = '', unit] = match
  const digits = unit ? places[unit.toLowerCase() as keyof typeof places] : 0
  if (fraction.replace(/0+$/, '').length > digits) return undefined
  // Shifting the decimal point in the text, so that 1.1M is exactly 1,100,000.
  const n = Number(whole + fraction.padEnd(digits, '0').slice(0, digits))
  return n > 0 && Number.isSafeInteger(n) ? n : undefined
}

const plain = new Intl.NumberFormat('en-US')

/** Writes a number of tokens the way providers do: 128K, 1M, 1.5M; plainly when no unit fits, as 131,072. */
export function formatTokenCount(n: number): string {
  if (n >= units.m && (n * 100) % units.m === 0) return `${n / units.m}M`
  if (n >= units.k && (n * 10) % units.k === 0) return `${n / units.k}K`
  return plain.format(n)
}

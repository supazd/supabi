export function timeZoneOptions(current: string) {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return [...new Set(['UTC', ...known, current].filter(Boolean))].map((zone) => ({ value: zone, label: zone }))
}

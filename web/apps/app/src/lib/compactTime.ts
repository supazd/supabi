/** Month, day, hour and minute, short enough for a list of saves; the full time goes in a tooltip. */
export const compactTime = (date: Date) => {
  const [month, day, hour, minute] = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].map((value) => String(value).padStart(2, '0'))
  return `${month}-${day} ${hour}:${minute}`
}

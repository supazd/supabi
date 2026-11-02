import { Tooltip } from '@supabi/ui'
import { Icon } from './Icon'

/** A label with a question mark that tells more about it; a hint of several lines is shown a line each. */
export function FieldLabel({ label, hint }: { label: string; hint: string | string[] }) {
  const lines = typeof hint === 'string' ? [hint] : hint
  return (
    <span className="field-label">
      <span>{label}</span>
      <Tooltip title={lines.length > 1 ? <span className="tooltip-lines">{lines.map((line) => <span key={line}>{line}</span>)}</span> : lines[0]}>
        <span className="field-help" tabIndex={0} role="img" aria-label={lines.join(' ')}><Icon name="help" size={14} /></span>
      </Tooltip>
    </span>
  )
}

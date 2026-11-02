/**
 * A line of the page's heading that is written where it is read: it looks
 * like text, and is changed by clicking on it unless the page is locked.
 */
export function TitleText({ className, label, placeholder, locked, value, onChange }: { className: string; label: string; placeholder: string; locked: boolean; value: string; onChange: (value: string) => void }) {
  return (
    <span className={`title-text ${className}`}>
      {/* Gives the input the width of what is written in it. */}
      <span aria-hidden>{value || placeholder}</span>
      <input aria-label={label} placeholder={placeholder} readOnly={locked} value={value} onChange={(event) => onChange(event.target.value)} />
    </span>
  )
}

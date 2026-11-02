import type { ReactNode } from 'react'

export interface FieldProps {
  label: ReactNode
  /** The id of the control inside, so clicking the label focuses it. */
  htmlFor?: string
  required?: boolean
  hint?: ReactNode
  children: ReactNode
}

/** A labelled form control. */
export function Field({ label, htmlFor, required, hint, children }: FieldProps) {
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 0, alignContent: 'start' }}>
      <label htmlFor={htmlFor} style={{ fontSize: 13, color: 'var(--lb-color-text-secondary)' }}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--lb-color-danger)' }}> *</span>}
      </label>
      {children}
      {hint && <div style={{ fontSize: 12, color: 'var(--lb-color-text-secondary)' }}>{hint}</div>}
    </div>
  )
}

/**
 * The product's mark: an S of two arcs, the lower one lighter like the second
 * slice of a ring chart, on a flat indigo tile. It is drawn rather than loaded
 * so it is there on the first paint, sharp at any size.
 */
export function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <svg className={size === 'lg' ? 'brand-mark brand-mark-lg' : 'brand-mark'} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="9" fill="#4655e8" />
      <g fill="none" strokeWidth="3.6" strokeLinecap="round">
        <path d="M20.11 9.375A4.75 4.75 0 1 0 16 16.5" stroke="#ffffff" />
        <path d="M16 16.5A4.75 4.75 0 1 1 11.89 23.625" stroke="#b4baff" />
      </g>
    </svg>
  )
}

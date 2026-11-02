import { cn } from 'cn'

/**
 * A field keeps its border when pointed at or focused: the caret says where
 * typing goes, and a coloured frame on every field is noise. A field that is
 * wrong still turns red.
 */
export const quietFocus =
  'tw:shadow-xs tw:hover:border-[color-mix(in_srgb,var(--foreground)_16%,var(--border))] tw:focus-visible:border-[color-mix(in_srgb,var(--foreground)_30%,var(--border))] tw:focus-visible:ring-0'

/** The heights the product's layouts were drawn for: 24, 32 and 40 pixels. */
export const heights = { sm: 'tw:h-6', md: 'tw:h-8', lg: 'tw:h-10' } as const
export type Size = keyof typeof heights

/** The box of a control that opens a list, drawn as shadcn draws its select. */
export function fieldClass(size: Size, { block, plain }: { block?: boolean; plain?: boolean } = {}) {
  return cn(
    'tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-1.5 tw:rounded-lg tw:border tw:border-input tw:bg-transparent tw:pr-2 tw:pl-2.5 tw:text-left tw:text-sm tw:whitespace-nowrap tw:transition-colors tw:outline-none tw:select-none',
    'tw:aria-disabled:pointer-events-none tw:aria-disabled:opacity-50 tw:disabled:cursor-not-allowed tw:disabled:opacity-50 tw:dark:bg-input/30 tw:[&_svg]:shrink-0',
    quietFocus,
    heights[size],
    size === 'sm' && 'tw:pr-1.5 tw:pl-2',
    block ? 'tw:w-full' : 'tw:w-fit tw:max-w-full',
    plain && 'tw:border-transparent tw:bg-transparent tw:px-1 tw:shadow-none tw:hover:border-transparent tw:dark:bg-transparent',
  )
}

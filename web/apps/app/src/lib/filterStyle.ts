/** Presentation shared by a chart's filters and dynamic selectors. */
export interface FilterStyle {
  layout: 'horizontal' | 'vertical'
  density: 'comfortable' | 'normal' | 'compact'
}

export const defaultFilterStyle: FilterStyle = { layout: 'horizontal', density: 'normal' }

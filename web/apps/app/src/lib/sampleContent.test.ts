import { describe, expect, it } from 'vitest'
import type { SpecField } from '../api/spec'
import { restore, type ChartSpec } from './builder'
import sample from '../../../../../dev/seedcontent/content.json'

// `make dev-seed-content` builds these charts to try things with; one the
// builder cannot write again opens read-only, and cannot be tried in the editor.
const content = sample as unknown as {
  datasets: { name: string; spec: { fields: SpecField[] } }[]
  charts: { name: string; spec: ChartSpec }[]
}

describe('sample charts', () => {
  const fields = Object.fromEntries(content.datasets.map((dataset) => [`@dataset/${dataset.name}`, dataset.spec.fields]))
  it.each(content.charts.map((chart) => [chart.name, chart.spec] as const))('%s opens in the editor', (_, spec) => {
    expect(restore(spec, fields[spec.query.dataset as string]!)).toBeDefined()
  })
})

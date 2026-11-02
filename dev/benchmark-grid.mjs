// Run with Node 24+: node dev/benchmark-grid.mjs
// Measures layout CPU only, excluding React, chart rendering, network and paint.
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { gridCompactor } from '../web/packages/ui/src/gridCompactor.ts'

const require = createRequire(new URL('../web/packages/ui/package.json', import.meta.url))
const { verticalCompactor, calcGridItemPosition } = require('react-grid-layout/core')
const results = []
for (const count of [20, 100, 500]) {
  for (const [name, columns, rowHeight, columnGap, rowGap, clearance, auto] of [
    ['baseline', 96, 8, 1.5, 1.5, 0, true],
    ['defaults', 96, 8, 1.5, 1.5, 0, true],
    ['configured', 192, 12, 3, 4, 3, true],
    ['free placement', 192, 12, 3, 4, 3, false],
  ]) {
    const compact = name === 'baseline' ? verticalCompactor : gridCompactor(auto, clearance)
    const input = Array.from({ length: count }, (_, i) => ({ i: String(i), x: i % 4 * columns / 4, y: Math.floor(i / 4) * 40, w: columns / 4, h: 32 }))
    const params = { cols: columns, containerWidth: 1440, rowHeight, margin: [columnGap, rowGap], containerPadding: [0, 0], maxRows: Infinity }
    const samples = []
    for (let repeat = 0; repeat < 220; repeat++) {
      // Include a moved item that can cause a collision; compactors receive fresh inputs.
      const next = input.map((item) => ({ ...item }))
      next[0].y = repeat % 40
      const start = performance.now()
      const layout = compact.compact(next, columns)
      for (const item of layout) calcGridItemPosition(params, item.x, item.y, item.w, item.h)
      const elapsed = performance.now() - start
      if (repeat >= 20) samples.push(elapsed)
    }
    samples.sort((a, b) => a - b)
    results.push({ count, mode: name, columns, medianMs: +samples[100].toFixed(3), p95Ms: +samples[190].toFixed(3) })
  }
}
console.table(results)

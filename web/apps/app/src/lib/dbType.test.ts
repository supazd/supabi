import { describe, expect, it } from 'vitest'
import { kindOf } from './dbType'

describe('the kind of a database type', () => {
  it.each([
    ['bigint', 'number'],
    ['integer', 'number'],
    ['numeric(12,2)', 'number'],
    ['double precision', 'number'],
    ['Int64', 'number'],
    ['UInt8', 'number'],
    ['Decimal(12, 2)', 'number'],
    ['Nullable(Float64)', 'number'],
    ['tinyint(4)', 'number'],
    ['text', 'text'],
    ['character varying(255)', 'text'],
    ['varchar(20)', 'text'],
    ['LowCardinality(String)', 'text'],
    ['uuid', 'text'],
    ['json', 'text'],
    ['Array(Int32)', 'text'],
    ['date', 'time'],
    ['timestamp without time zone', 'time'],
    ['timestamptz', 'time'],
    ['datetime', 'time'],
    ['Nullable(DateTime64(3))', 'time'],
    ['boolean', 'boolean'],
    ['Bool', 'boolean'],
    ['tinyint(1)', 'boolean'],
  ])('%s is %s', (dbType, kind) => {
    expect(kindOf(dbType)).toBe(kind)
  })
})

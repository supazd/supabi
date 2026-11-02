import { ApiError } from '../api/client'
import type { SqlParam } from './params'

/** SQL travels independently of the dataset editor's unsaved field changes. */
export interface SqlHandoff {
  sql: string
  datasourceId: string
  params?: SqlParam[]
}

interface Transfer {
  handoff: SqlHandoff
  datasetName?: string
  /** The original editor listens on this token while it remains open. */
  returnTo?: string
}

const prefix = 'supabi.sqlHandoff.'
const lifetime = 12 * 60 * 60 * 1000
const keyOf = (token: string) => `${prefix}${token}`

function validHandoff(value: unknown): value is SqlHandoff {
  if (!value || typeof value !== 'object') return false
  const handed = value as Partial<SqlHandoff>
  return typeof handed.sql === 'string' && typeof handed.datasourceId === 'string' && (handed.params === undefined || Array.isArray(handed.params))
}

function read(token: string): Transfer | undefined {
  if (!/^[\w-]+$/.test(token)) return undefined
  try {
    const stored = localStorage.getItem(keyOf(token))
    if (!stored) return undefined
    const value = JSON.parse(stored) as { expiresAt?: number; transfer?: Transfer }
    if (!value.expiresAt || value.expiresAt < Date.now() || !validHandoff(value.transfer?.handoff)) return undefined
    return value.transfer
  } catch {
    return undefined
  }
}

/** The address carries only an opaque token; SQL stays out of URLs and history. */
export function readSqlHandoff(search: string): Transfer | undefined {
  const token = new URLSearchParams(search).get('handoff')
  return token ? read(token) : undefined
}

function write(token: string, transfer: Transfer) {
  // Bound the temporary storage even when a browser tab was closed abruptly.
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix) || key.endsWith('.reply') || key.endsWith('.ack')) continue
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { expiresAt?: number } | null
      if (!value?.expiresAt || value.expiresAt < Date.now()) {
        localStorage.removeItem(key)
        localStorage.removeItem(`${key}.reply`)
        localStorage.removeItem(`${key}.ack`)
      }
    } catch {
      localStorage.removeItem(key)
    }
  }
  localStorage.setItem(keyOf(token), JSON.stringify({ expiresAt: Date.now() + lifetime, transfer }))
}

/** Opens SQL while keeping the dataset form mounted, and applies replies to that same form. */
export function openSqlEditor(handoff: SqlHandoff, options: { datasetName?: string; onApply: (next: SqlHandoff) => void | false }): () => void {
  const token = crypto.randomUUID()
  const key = keyOf(token)
  write(token, { handoff, datasetName: options.datasetName, returnTo: token })
  const receive = (event: StorageEvent) => {
    if (event.key !== `${key}.reply` || !event.newValue || read(token)?.returnTo !== token) return
    try {
      const reply = JSON.parse(event.newValue) as { id?: string; handoff?: unknown }
      if (!reply.id || !validHandoff(reply.handoff)) return
      if (options.onApply(reply.handoff) === false) return
      localStorage.setItem(`${key}.ack`, reply.id)
      window.focus()
    } catch {
      // A malformed or unavailable transfer cannot replace the editor's work.
    }
  }
  const close = () => {
    window.removeEventListener('storage', receive)
    window.removeEventListener('pagehide', close)
    try {
      localStorage.removeItem(key)
      localStorage.removeItem(`${key}.reply`)
      localStorage.removeItem(`${key}.ack`)
    } catch {
      // Listener cleanup still succeeds if browser storage becomes unavailable.
    }
  }
  window.addEventListener('storage', receive)
  window.addEventListener('pagehide', close)
  const search = new URLSearchParams({ handoff: token })
  const path = '/explore'
  const tab = reserveSqlDestination()
  if (!tab) {
    close()
    throw new ApiError(0, 'browser_popup_blocked', 'The browser blocked the new editor tab.')
  }
  tab.location.replace(`${path}?${search}`)
  return close
}

/** Reports success only after the original editor has accepted the SQL. */
export function returnSqlHandoff(token: string, handoff: SqlHandoff): Promise<boolean> {
  if (read(token)?.returnTo !== token) return Promise.resolve(false)
  return new Promise((resolve) => {
    const key = keyOf(token)
    const id = crypto.randomUUID()
    const done = (accepted: boolean) => {
      window.clearTimeout(timer)
      window.removeEventListener('storage', receive)
      resolve(accepted)
    }
    const receive = (event: StorageEvent) => {
      if (event.key === `${key}.ack` && event.newValue === id) done(true)
    }
    const timer = window.setTimeout(() => done(false), 2000)
    window.addEventListener('storage', receive)
    try {
      localStorage.setItem(`${key}.reply`, JSON.stringify({ id, handoff }))
    } catch {
      done(false)
    }
  })
}

/** Reserve during the click, before saving asynchronously, so popup blocking cannot lose the handoff. */
export function reserveSqlDestination(): Window | null {
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  return tab
}

export function openSqlDataset(handoff: SqlHandoff, options: { folderId?: string }, tab: Window) {
  const token = crypto.randomUUID()
  write(token, { handoff })
  const search = new URLSearchParams({ handoff: token })
  if (options.folderId) search.set('folder', options.folderId)
  tab.location.replace(`/workbench/datasets/new?${search}`)
}

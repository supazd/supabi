import createClient from 'openapi-fetch'
import type { components, paths } from './schema.gen'

export type Schemas = components['schemas']
export type Datasource = Schemas['Datasource']
export type DatasourceInput = Schemas['DatasourceInput']
export type DatasourceType = Schemas['DatasourceType']
export type DatasetSummary = Schemas['DatasetSummary']
export type Dataset = Schemas['Dataset']
export type LogicalType = Schemas['LogicalType']
export type SourceColumn = Schemas['SourceColumn']
export type QueryResult = Schemas['QueryResult']
export type ExpressionFunction = Schemas['ExpressionFunction']
export type ExpressionCheck = Schemas['ExpressionCheck']
export type VersionInfo = Schemas['Version']
export type ChartSummary = Schemas['ChartSummary']
export type Chart = Schemas['Chart']
export type ParamControl = Schemas['ParamControl']
export type DashboardSummary = Schemas['DashboardSummary']
export type Dashboard = Schemas['Dashboard']
export type Folder = Schemas['Folder']
export type FolderKind = Schemas['FolderKind']
export type Usage = Schemas['Usage']
export type Member = Schemas['Member']
export type User = Schemas['User']
export type Group = Schemas['Group']
export type GroupMember = Schemas['GroupMember']
export type Workspace = Schemas['Workspace']
export type AuditEvent = Schemas['AuditEvent']
export type AuditCategory = Schemas['AuditCategory']
export type AuditOutcome = Schemas['AuditOutcome']
export type Subject = Schemas['Subject']

/** The server's error object. `code` is what gets translated. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params: Record<string, string> = {},
    /** Where the problem is in SQL the caller wrote, in characters; see indexOfCharacter. */
    readonly position?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The index in text of its n-th character. The server counts characters;
 * a string is indexed in UTF-16 units, of which some characters take two.
 */
export function indexOfCharacter(text: string, n: number): number {
  let index = 0
  for (const character of text) {
    if (n-- <= 0) break
    index += character.length
  }
  return index
}

export const api = createClient<paths>({ baseUrl: '/api/v1' })

/** Fired on window when a call is refused because the session has ended. */
export const unauthenticatedEvent = 'supabi:unauthenticated'

interface Outcome<T> {
  data?: T
  error?: unknown
  response: Response
}

/** Returns the body of a successful call and throws ApiError otherwise. */
export async function unwrap<T>(call: Promise<Outcome<T>>): Promise<T> {
  let outcome: Outcome<T>
  try {
    outcome = await call
  } catch {
    throw new ApiError(0, 'network_error', 'the server cannot be reached')
  }
  if (outcome.response.ok) return outcome.data as T
  const body = outcome.error as Partial<Schemas['Error']> | undefined
  if (outcome.response.status === 401 && body?.code === 'unauthenticated') {
    window.dispatchEvent(new Event(unauthenticatedEvent))
  }
  throw new ApiError(outcome.response.status, body?.code ?? 'unexpected_response', body?.message ?? outcome.response.statusText, body?.params, body?.position)
}

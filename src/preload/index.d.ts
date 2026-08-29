import type {
  AiResult,
  AppSettings,
  ApplyResult,
  ChatMessage,
  ChatTurn,
  ConnectionConfig,
  ConnectionSummary,
  ConnectResult,
  DbSchema,
  HistoryEntry,
  PendingChange,
  QueryResult,
  SavedQuery,
  TableDetails
} from '../shared/types'

export interface SafetyCheck {
  needsConfirm: boolean
  isProduction: boolean
  unscoped: string[]
  connectionName: string
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none'; version: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; message: string }

declare global {
  interface Window {
    opentable: {
      connections: {
        list: () => Promise<ConnectionSummary[]>
        save: (cfg: ConnectionConfig) => Promise<ConnectionSummary[]>
        delete: (id: string) => Promise<ConnectionSummary[]>
        test: (cfg: ConnectionConfig) => Promise<ConnectResult>
      }
      db: {
        connect: (id: string) => Promise<ConnectResult>
        disconnect: (id: string) => Promise<void>
        query: (
          id: string,
          sql: string
        ) => Promise<{ ok: boolean; result?: QueryResult; error?: string }>
        cancel: (id: string) => Promise<{ ok: boolean; error?: string }>
        schema: (id: string) => Promise<{ ok: boolean; schema?: DbSchema; error?: string }>
        tableDetails: (
          id: string,
          schema: string,
          table: string
        ) => Promise<{ ok: boolean; details?: TableDetails; error?: string }>
        databases: (id: string) => Promise<{ ok: boolean; databases?: string[]; error?: string }>
        useDatabase: (id: string, database: string) => Promise<ConnectResult>
        applyChanges: (
          id: string,
          table: { schema: string; name: string },
          changes: PendingChange[]
        ) => Promise<ApplyResult>
        alterTable: (
          id: string,
          statements: string[]
        ) => Promise<{ ok: boolean; error?: string; applied: number }>
      }
      safety: {
        check: (id: string, sql: string) => Promise<SafetyCheck>
      }
      history: {
        list: (limit?: number, search?: string) => Promise<HistoryEntry[]>
        clear: () => Promise<void>
      }
      saved: {
        list: () => Promise<SavedQuery[]>
        save: (q: SavedQuery) => Promise<SavedQuery[]>
        delete: (id: string) => Promise<SavedQuery[]>
      }
      settings: {
        get: () => Promise<AppSettings>
        update: (patch: Partial<AppSettings> & { aiKey?: string }) => Promise<AppSettings>
      }
      ai: {
        generate: (id: string, question: string) => Promise<AiResult>
        explain: (id: string, sql: string) => Promise<AiResult>
        fix: (id: string, sql: string, errorText: string) => Promise<AiResult>
        chat: (id: string, transcript: ChatMessage[]) => Promise<ChatTurn>
        chatResolve: (
          id: string,
          transcript: ChatMessage[],
          sql: string,
          approved: boolean
        ) => Promise<ChatTurn>
      }
      ssh: {
        hosts: () => Promise<
          { alias: string; hostName: string; port: number; user: string; identityFile?: string }[]
        >
      }
      files: {
        pickSqlite: () => Promise<string | null>
        pickKey: () => Promise<string | null>
        export: (
          defaultName: string,
          contents: string,
          ext: string
        ) => Promise<{ ok: boolean; path?: string }>
      }
      updates: {
        check: () => Promise<UpdateState>
        state: () => Promise<UpdateState>
        install: () => Promise<void>
        onState: (cb: (state: UpdateState) => void) => () => void
      }
      platform: string
    }
  }
}

export {}

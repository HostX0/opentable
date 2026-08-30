import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  ConnectionConfig,
  PendingChange,
  SavedQuery
} from '../shared/types'

const api = {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:save', cfg),
    delete: (id: string) => ipcRenderer.invoke('connections:delete', id),
    test: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:test', cfg)
  },
  db: {
    connect: (id: string) => ipcRenderer.invoke('db:connect', id),
    disconnect: (id: string) => ipcRenderer.invoke('db:disconnect', id),
    query: (id: string, sql: string) => ipcRenderer.invoke('db:query', id, sql),
    cancel: (id: string) => ipcRenderer.invoke('db:cancel', id),
    schema: (id: string) => ipcRenderer.invoke('db:schema', id),
    tableDetails: (id: string, schema: string, table: string) =>
      ipcRenderer.invoke('db:tableDetails', id, schema, table),
    databases: (id: string) => ipcRenderer.invoke('db:databases', id),
    useDatabase: (id: string, database: string) =>
      ipcRenderer.invoke('db:useDatabase', id, database),
    applyChanges: (id: string, table: { schema: string; name: string }, changes: PendingChange[]) =>
      ipcRenderer.invoke('db:applyChanges', id, table, changes),
    alterTable: (id: string, statements: string[]) =>
      ipcRenderer.invoke('db:alterTable', id, statements)
  },
  safety: {
    check: (id: string, sql: string) => ipcRenderer.invoke('safety:check', id, sql)
  },
  history: {
    list: (limit?: number, search?: string) => ipcRenderer.invoke('history:list', limit, search),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  saved: {
    list: () => ipcRenderer.invoke('saved:list'),
    save: (q: SavedQuery) => ipcRenderer.invoke('saved:save', q),
    delete: (id: string) => ipcRenderer.invoke('saved:delete', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings> & { aiKey?: string }) =>
      ipcRenderer.invoke('settings:update', patch)
  },
  ai: {
    generate: (id: string, question: string) => ipcRenderer.invoke('ai:generate', id, question),
    explain: (id: string, sql: string) => ipcRenderer.invoke('ai:explain', id, sql),
    fix: (id: string, sql: string, errorText: string) =>
      ipcRenderer.invoke('ai:fix', id, sql, errorText),
    chat: (id: string, transcript: ChatMessage[]) => ipcRenderer.invoke('ai:chat', id, transcript),
    chatResolve: (id: string, transcript: ChatMessage[], sql: string, approved: boolean) =>
      ipcRenderer.invoke('ai:chatResolve', id, transcript, sql, approved),
    onChatDelta: (cb: (text: string) => void) => {
      const handler = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on('ai:chat-delta', handler)
      return () => ipcRenderer.removeListener('ai:chat-delta', handler)
    }
  },
  onDbState: (cb: (e: { id: string; state: string; detail?: string }) => void) => {
    const handler = (_e: unknown, payload: { id: string; state: string; detail?: string }): void =>
      cb(payload)
    ipcRenderer.on('db:state', handler)
    return () => ipcRenderer.removeListener('db:state', handler)
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    save: (session: ChatSession) => ipcRenderer.invoke('chats:save', session),
    delete: (id: string) => ipcRenderer.invoke('chats:delete', id)
  },
  ssh: {
    hosts: () => ipcRenderer.invoke('ssh:hosts')
  },
  files: {
    pickSqlite: () => ipcRenderer.invoke('file:pickSqlite'),
    pickKey: () => ipcRenderer.invoke('file:pickKey'),
    export: (defaultName: string, contents: string, ext: string) =>
      ipcRenderer.invoke('file:export', defaultName, contents, ext)
  },
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    state: () => ipcRenderer.invoke('update:state'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown): void => cb(state)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('opentable', api)

import type { TranscriptEntry } from './useRelay'

const DB_NAME = 'voice-multiplexer'
const DB_VERSION = 3
const TRANSCRIPTS_STORE = 'transcripts'
const SESSIONS_STORE = 'sessions'

export interface PersistedSession {
  session_id: string       // primary key — hash of directory path
  session_name: string     // default name from MCP server
  dir_name: string
  last_seen: number
  display_name?: string    // user-set override
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Recreate stores with session_id as primary key
      if (db.objectStoreNames.contains(TRANSCRIPTS_STORE)) {
        db.deleteObjectStore(TRANSCRIPTS_STORE)
      }
      db.createObjectStore(TRANSCRIPTS_STORE)

      if (db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.deleteObjectStore(SESSIONS_STORE)
      }
      db.createObjectStore(SESSIONS_STORE, { keyPath: 'session_id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// --- Transcripts (keyed by session_id) ---

export async function loadTranscripts(sessionId: string): Promise<TranscriptEntry[]> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readonly')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.get(sessionId)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function saveTranscripts(sessionId: string, entries: TranscriptEntry[]): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readwrite')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.put(entries, sessionId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore write errors
  }
}

export async function deleteTranscripts(sessionId: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readwrite')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.delete(sessionId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore
  }
}

// --- Sessions (keyed by session_id) ---

export async function loadPersistedSessions(): Promise<PersistedSession[]> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readonly')
      const store = tx.objectStore(SESSIONS_STORE)
      const req = store.getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function savePersistedSession(session: PersistedSession): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readwrite')
      const store = tx.objectStore(SESSIONS_STORE)
      const req = store.put(session)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore
  }
}

export async function deletePersistedSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readwrite')
      const store = tx.objectStore(SESSIONS_STORE)
      const req = store.delete(sessionId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore
  }
}

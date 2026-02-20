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
  hue_override?: number    // user-set color hue (0-360), overrides deterministic hue
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

// --- Cleanup: auto-delete data older than 30 days ---

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export async function pruneStaleData(): Promise<void> {
  try {
    const db = await openDB()
    const cutoff = Date.now() - MAX_AGE_MS

    // Prune sessions older than 30 days
    const sessions: PersistedSession[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readonly')
      const req = tx.objectStore(SESSIONS_STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })

    const staleIds = sessions
      .filter(s => s.last_seen * 1000 < cutoff)
      .map(s => s.session_id)

    if (staleIds.length === 0) return

    // Delete stale sessions and their transcripts
    const tx = db.transaction([SESSIONS_STORE, TRANSCRIPTS_STORE], 'readwrite')
    const sessStore = tx.objectStore(SESSIONS_STORE)
    const txStore = tx.objectStore(TRANSCRIPTS_STORE)
    for (const id of staleIds) {
      sessStore.delete(id)
      txStore.delete(id)
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // ignore cleanup errors
  }
}

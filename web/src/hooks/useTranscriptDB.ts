import type { TranscriptEntry } from './useRelay'

const DB_NAME = 'voice-multiplexer'
const DB_VERSION = 2
const TRANSCRIPTS_STORE = 'transcripts'
const SESSIONS_STORE = 'sessions'

export interface PersistedSession {
  session_name: string
  dir_name: string
  last_seen: number
  display_name?: string
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TRANSCRIPTS_STORE)) {
        db.createObjectStore(TRANSCRIPTS_STORE)
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'session_name' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// --- Transcripts ---

export async function loadTranscripts(sessionName: string): Promise<TranscriptEntry[]> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readonly')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.get(sessionName)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function saveTranscripts(sessionName: string, entries: TranscriptEntry[]): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readwrite')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.put(entries, sessionName)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore write errors
  }
}

export async function deleteTranscripts(sessionName: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPTS_STORE, 'readwrite')
      const store = tx.objectStore(TRANSCRIPTS_STORE)
      const req = store.delete(sessionName)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore
  }
}

// --- Sessions ---

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

export async function deletePersistedSession(sessionName: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, 'readwrite')
      const store = tx.objectStore(SESSIONS_STORE)
      const req = store.delete(sessionName)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // ignore
  }
}

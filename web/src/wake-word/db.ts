// IndexedDB storage for wake-word templates.
//
// We persist MFCC feature sequences (NOT raw audio) plus an auto-tuned
// distance threshold. MFCCs are lossy and non-invertible, so even if the
// DB is exfiltrated the user's voice can't be reconstructed.

const DB_NAME = 'vmux-wake-word'
const DB_VERSION = 1
const STORE = 'templates'
const RECORD_ID = 'default'

export interface WakeWordRecord {
  id: string
  phrase: string
  // Each template: array of MFCC frames stored as Float32Array bytes.
  templates: Float32Array[][]
  // Auto-tuned DTW distance threshold (max-similar value to accept).
  threshold: number
  enrolledAt: number
  numCoeffs: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadTemplates(): Promise<WakeWordRecord | null> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(RECORD_ID)
    req.onsuccess = () => resolve((req.result as WakeWordRecord) || null)
    req.onerror = () => reject(req.error)
  })
}

export async function saveTemplates(rec: Omit<WakeWordRecord, 'id'>): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ id: RECORD_ID, ...rec })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearTemplates(): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(RECORD_ID)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

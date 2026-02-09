import { useState, useRef, useEffect } from 'react'
import styles from './PairScreen.module.scss'

interface PairScreenProps {
  onPair: (code: string, deviceName: string) => Promise<string | null>
}

function getDefaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Device'
}

export function PairScreen({ onPair }: PairScreenProps) {
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(getDefaultDeviceName)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== 6 || !deviceName.trim()) return

    setError(null)
    setLoading(true)
    const err = await onPair(code, deviceName.trim())
    setLoading(false)
    if (err) {
      setError(err)
      setCode('')
      inputRef.current?.focus()
    }
  }

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6)
    setCode(val)
    setError(null)
  }

  return (
    <div className={styles.Container}>
      <div className={styles.Card}>
        <div className={styles.Header}>
          <h1 className={styles.Title}>Claude Voice Multiplexer</h1>
          <p className={styles.Subtitle}>Pair this device to get started</p>
        </div>

        <form onSubmit={handleSubmit} className={styles.Form}>
          <div className={styles.Field}>
            <label className={styles.Label}>Pairing Code</label>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={handleCodeChange}
              className={styles.CodeInput}
              autoComplete="one-time-code"
              disabled={loading}
            />
            <span className={styles.Hint}>
              Run <code>/voice-multiplexer:auth-code</code> in Claude Code to get a code
            </span>
          </div>

          <div className={styles.Field}>
            <label className={styles.Label}>Device Name</label>
            <input
              type="text"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              className={styles.TextInput}
              placeholder="My Phone"
              disabled={loading}
            />
          </div>

          {error && <div className={styles.Error}>{error}</div>}

          <button
            type="submit"
            disabled={code.length !== 6 || !deviceName.trim() || loading}
            className={styles.SubmitButton}
          >
            {loading ? 'Pairing...' : 'Pair Device'}
          </button>
        </form>
      </div>
    </div>
  )
}

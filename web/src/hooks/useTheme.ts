import { useEffect } from 'react'
import type { ThemeMode } from './useSettings'

export function useTheme(theme: ThemeMode) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')

    function apply() {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }

    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

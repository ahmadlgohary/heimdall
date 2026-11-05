import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'
const STORAGE_KEY = 'heimdall.theme'

interface ThemeContextValue {
  preference: ThemePreference
  resolved: 'dark' | 'light'
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* storage unavailable */
  }
  return 'dark'
}

function systemTheme(): 'dark' | 'light' {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<'dark' | 'light'>(systemTheme)

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!mq) return
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved = preference === 'system' ? system : preference

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('light', resolved === 'light')
    root.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: (p) => {
        setPreferenceState(p)
        try {
          localStorage.setItem(STORAGE_KEY, p)
        } catch {
          /* storage unavailable */
        }
      },
    }),
    [preference, resolved],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

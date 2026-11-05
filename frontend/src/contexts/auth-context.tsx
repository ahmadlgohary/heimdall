import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { refreshAccessToken } from '@/lib/api-client'
import { SESSION_EXPIRED_EVENT, tokenStore } from '@/lib/auth'
import { authService, type Credentials } from '@/services/auth.service'
import type { User } from '@/types/api'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

interface AuthContextValue {
  status: AuthStatus
  user: User | null
  login: (c: Credentials) => Promise<void>
  register: (c: Credentials) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const token = tokenStore.get() ?? (await refreshAccessToken())
      if (!token) {
        if (!cancelled) setStatus('anonymous')
        return
      }
      try {
        const me = await authService.me()
        if (cancelled) return
        setUser(me)
        setStatus('authenticated')
      } catch {
        if (!cancelled) setStatus('anonymous')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onExpired = () => {
      setUser(null)
      setStatus('anonymous')
      queryClient.clear()
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [queryClient])

  const login = useCallback(async (c: Credentials) => {
    const res = await authService.login(c)
    tokenStore.set(res.access_token)
    setUser(res.user)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (c: Credentials) => {
    const res = await authService.register(c)
    tokenStore.set(res.access_token)
    setUser(res.user)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    try {
      await authService.logout()
    } catch {
      /* the session is cleared locally regardless */
    }
    tokenStore.set(null)
    setUser(null)
    setStatus('anonymous')
    queryClient.clear()
  }, [queryClient])

  const value = useMemo(() => ({ status, user, login, register, logout }), [status, user, login, register, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

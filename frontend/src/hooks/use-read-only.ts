import { useAuth } from '@/contexts/auth-context'

/** The shared demo account is read-only: the API refuses every change it makes. */
export function useReadOnly(): boolean {
  return useAuth().user?.is_demo ?? false
}

export const READ_ONLY_HINT = 'The demo is read-only'

import { api } from '@/lib/api-client'
import type { AuthResponse, User } from '@/types/api'

export interface Credentials {
  email: string
  password: string
}

export const authService = {
  register: (body: Credentials) => api.post<AuthResponse>('/auth/register', body, { anonymous: true }),
  login: (body: Credentials) => api.post<AuthResponse>('/auth/login', body, { anonymous: true }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<User>('/auth/me'),
  changePassword: (body: { current_password: string; new_password: string }) =>
    api.post<void>('/auth/change-password', body),
}

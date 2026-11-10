import { api } from '@/lib/api-client'
import type { AuthResponse, DemoInfo, User } from '@/types/api'

export interface Credentials {
  email: string
  password: string
}

export const authService = {
  register: (body: Credentials) => api.post<AuthResponse>('/auth/register', body, { anonymous: true }),
  login: (body: Credentials) => api.post<AuthResponse>('/auth/login', body, { anonymous: true }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<User>('/auth/me'),
  demo: () => api.get<DemoInfo>('/demo'),
  changePassword: (body: { current_password: string; new_password: string }) =>
    api.post<void>('/auth/change-password', body),
}

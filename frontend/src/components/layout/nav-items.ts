import { Activity, BarChart3, Gauge, KeyRound, Radio, Settings } from 'lucide-react'

export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Overview', icon: Gauge },
  { to: '/endpoints', label: 'Endpoints', icon: Radio },
  { to: '/events', label: 'Events', icon: Activity },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { to: '/settings', label: 'Settings', icon: Settings, end: true },
] as const

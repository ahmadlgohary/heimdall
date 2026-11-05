import type { EventStatus, TimeRange } from '@/types/api'

export const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
]

export const RANGE_TEXT: Record<TimeRange, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
}

export const STATUS_OPTIONS: { value: EventStatus | ''; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'retrying', label: 'Retrying' },
  { value: 'delivering', label: 'Delivering' },
  { value: 'queued', label: 'Queued' },
]

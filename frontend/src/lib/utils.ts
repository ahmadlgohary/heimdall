import { clsx, type ClassValue } from 'clsx'
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const nf = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function formatNumber(n: number | null | undefined) {
  return n == null ? '—' : nf.format(n)
}

export function formatCompact(n: number) {
  return n >= 10_000 ? compact.format(n) : nf.format(n)
}

export function formatPercent(ratio: number | null | undefined, digits = 1) {
  if (ratio == null) return '—'
  const pct = ratio * 100
  if (pct === 100 || pct === 0) return `${pct.toFixed(0)}%`
  return `${pct.toFixed(digits)}%`
}

export function formatMs(ms: number | null | undefined) {
  if (ms == null) return '—'
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return format(new Date(iso), 'd MMM yyyy, HH:mm:ss')
}

/** Short timestamp tuned for tables: "14:02:11", "Yesterday 09:14", "10 Nov, 12:30". */
export function formatShortTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isToday(d)) return format(d, 'HH:mm:ss')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'd MMM, HH:mm')
}

export function formatRelative(iso: string | null | undefined) {
  if (!iso) return 'never'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (Math.abs(diff) < 5_000) return 'just now'
  const s = formatDistanceToNowStrict(d)
  return diff > 0 ? `${s} ago` : `in ${s}`
}

/** "evt_82fa19c0" style short id for display. Full id stays in title/copy. */
export function shortId(id: string, prefix = '') {
  const clean = id.replace(/-/g, '')
  return `${prefix}${clean.slice(0, 8)}`
}

export function httpStatusTone(status: number | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status == null) return 'neutral'
  if (status >= 200 && status < 300) return 'success'
  if (status === 408 || status === 425 || status === 429) return 'warning'
  if (status >= 400) return 'danger'
  return 'neutral'
}

export function downloadFile(filename: string, content: string, type = 'text/csv') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function toCsv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')
}

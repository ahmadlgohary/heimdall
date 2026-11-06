import { format } from 'date-fns'
import type { ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatMs, formatNumber } from '@/lib/utils'
import type { SeriesPoint, TimeRange } from '@/types/api'

const AXIS = { fontSize: 11, fill: 'var(--faint)', fontFamily: 'var(--font-sans)' }

function bucketLabel(iso: string, range: TimeRange) {
  const d = new Date(iso)
  if (range === '24h') return format(d, 'HH:mm')
  // sub-day buckets: label midnight with the date, the rest with the time
  if (range === '7d' && d.getHours() !== 0) return format(d, 'HH:mm')
  return format(d, 'd MMM')
}

function TooltipCard({ title, rows }: { title: string; rows: { label: string; value: ReactNode; swatch: string }[] }) {
  return (
    <div className="min-w-40 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm shadow-pop">
      <p className="mb-1.5 font-medium">{title}</p>
      <ul className="grid gap-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-1 rounded-full" style={{ background: r.swatch }} />
            <span className="text-muted">{r.label}</span>
            <span className="tabular ml-auto pl-3 font-medium">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ChartLegend({ items }: { items: { label: string; swatch: string; shape?: 'bar' | 'line' | 'dash' }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.shape === 'line' || i.shape === 'dash' ? (
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke={i.swatch} strokeWidth="2" strokeDasharray={i.shape === 'dash' ? '3 3' : undefined} />
            </svg>
          ) : (
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: i.swatch }} />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * Event volume as a diverging bar chart: delivered above the baseline,
 * failed below. Position separates the two, so the red/green pair never has
 * to carry the distinction alone.
 */
export function VolumeChart({ series, range, height = 240 }: { series: SeriesPoint[]; range: TimeRange; height?: number }) {
  const data = series.map((p) => ({ ...p, label: bucketLabel(p.bucket, range), failedNeg: -p.failed }))
  // Keep a modest band below the baseline even when failures are rare, but
  // never compress real failures: both directions share one scale.
  const maxUp = Math.max(1, ...data.map((d) => d.delivered))
  const maxDown = Math.max(0, ...data.map((d) => d.failed))
  const floor = -Math.max(maxDown, Math.ceil(maxUp * 0.12))
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} stackOffset="sign" barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={44}
            domain={[floor, 'auto']}
            tickFormatter={(v: number) => formatNumber(Math.abs(v))}
            allowDecimals={false}
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Tooltip
            cursor={{ fill: 'var(--surface-hover)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as (typeof data)[number]
              return (
                <TooltipCard
                  title={format(new Date(p.bucket), range === '24h' ? 'd MMM, HH:mm' : 'EEE d MMM')}
                  rows={[
                    { label: 'Events', value: formatNumber(p.total), swatch: 'var(--chart-1)' },
                    { label: 'Delivered', value: formatNumber(p.delivered), swatch: 'var(--chart-ok)' },
                    { label: 'Failed', value: formatNumber(p.failed), swatch: 'var(--chart-fail)' },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="delivered" stackId="v" fill="var(--chart-ok)" radius={[3, 3, 0, 0]} isAnimationActive={false} name="Delivered" />
          <Bar dataKey="failedNeg" stackId="v" fill="var(--chart-fail)" radius={[3, 3, 0, 0]} isAnimationActive={false} name="Failed" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Average and p95 response time. Same unit, so one axis. */
export function LatencyChart({ series, range, height = 240 }: { series: SeriesPoint[]; range: TimeRange; height?: number }) {
  const data = series.map((p) => ({ ...p, label: bucketLabel(p.bucket, range) }))
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={58} tickFormatter={(v: number) => formatMs(v)} />
          <Tooltip
            cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as (typeof data)[number]
              return (
                <TooltipCard
                  title={format(new Date(p.bucket), range === '24h' ? 'd MMM, HH:mm' : 'EEE d MMM')}
                  rows={[
                    { label: 'Average', value: formatMs(p.avg_ms), swatch: 'var(--chart-1)' },
                    { label: 'p95', value: formatMs(p.p95_ms), swatch: 'var(--chart-2)' },
                  ]}
                />
              )
            }}
          />
          <Line
            dataKey="p95_ms"
            stroke="var(--chart-2)"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
            connectNulls
            isAnimationActive={false}
            name="p95"
          />
          <Line
            dataKey="avg_ms"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
            connectNulls
            isAnimationActive={false}
            name="Average"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

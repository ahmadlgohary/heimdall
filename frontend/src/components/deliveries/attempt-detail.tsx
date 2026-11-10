import { PlugZap, ServerCrash } from 'lucide-react'
import { useMemo } from 'react'
import { JsonViewer, TextBlock } from '@/components/common/json-viewer'
import { HttpCode } from '@/components/common/status'
import { formatDateTime, formatMs } from '@/lib/utils'
import type { DeliveryAttempt } from '@/types/api'

function parseJson(body: string | null) {
  if (!body) return undefined
  try {
    const v = JSON.parse(body)
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

/** Explains a failed attempt as a problem at the destination, not in Heimdall. */
function DestinationNote({ attempt, final }: { attempt: DeliveryAttempt; final: boolean }) {
  const s = attempt.http_status
  if (s != null && s >= 200 && s < 300) return null
  const noResponse = s == null
  const retryable = noResponse || s === 408 || s === 425 || s === 429 || s >= 500
  return (
    <div className="flex gap-3 rounded-md border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm">
      {noResponse ? (
        <PlugZap className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      ) : (
        <ServerCrash className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      )}
      <div className="grid gap-0.5">
        <p className="font-medium text-foreground">
          {noResponse ? 'Your endpoint didn’t respond' : `Your endpoint responded with ${s}`}
        </p>
        <p className="text-muted">
          {attempt.error_message ? `${attempt.error_message}. ` : ''}
          {retryable
            ? final
              ? 'Heimdall retried on the backoff schedule, but every attempt failed. Fix the receiver, then replay the event.'
              : 'This counts as a temporary failure, so Heimdall retries it on the backoff schedule.'
            : s != null && s >= 300 && s < 400
              ? 'Redirects aren’t retried. Point the endpoint at the final URL, then replay the event.'
              : 'Client errors like this aren’t retried. Fix the receiver, then replay the event.'}
        </p>
      </div>
    </div>
  )
}

/** `final`: this was the delivery's last attempt and it failed, so nothing more will be retried. */
export function AttemptDetail({ attempt, final = false }: { attempt: DeliveryAttempt; final?: boolean }) {
  const json = useMemo(() => parseJson(attempt.response_body), [attempt.response_body])
  const headers = Object.entries(attempt.response_headers ?? {})

  return (
    <div className="grid gap-4">
      <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <div>
          <dt className="text-muted">Attempt</dt>
          <dd className="tabular text-lg font-semibold">#{attempt.attempt_number}</dd>
        </div>
        <div>
          <dt className="text-muted">Response</dt>
          <dd>
            <HttpCode status={attempt.http_status} className="text-lg" />
          </dd>
        </div>
        <div>
          <dt className="text-muted">Duration</dt>
          <dd className="tabular text-lg font-semibold">{formatMs(attempt.duration_ms)}</dd>
        </div>
        <div>
          <dt className="text-muted">Sent at</dt>
          <dd className="tabular pt-1 text-base">{formatDateTime(attempt.attempted_at)}</dd>
        </div>
      </dl>

      <DestinationNote attempt={attempt} final={final} />

      {headers.length > 0 && (
        <details className="group rounded-md border border-border" open>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2.5 text-sm font-medium select-none">
            Response headers
            <span className="text-faint group-open:rotate-90 transition-transform" aria-hidden>▸</span>
          </summary>
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 border-t border-border px-3.5 py-3 text-sm">
            {headers.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="mono-tight text-muted">{k}</dt>
                <dd className="mono-tight min-w-0 break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <div className="grid gap-1.5">
        <h4 className="text-sm font-medium">Response body</h4>
        {attempt.response_body == null || attempt.response_body === '' ? (
          <p className="rounded-md border border-dashed border-border px-3.5 py-3 text-sm text-muted">Empty response body.</p>
        ) : json !== undefined ? (
          <JsonViewer value={json} maxHeight={280} title="Response body" />
        ) : (
          <TextBlock text={attempt.response_body} />
        )}
      </div>
    </div>
  )
}

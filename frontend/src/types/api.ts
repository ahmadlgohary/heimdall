/**
 * API contract types. These mirror the FastAPI schemas described in
 * plan/PLAN.md §3–§5. Anything the spec left open is documented in
 * frontend/README.md under "API assumptions".
 */

export type UUID = string
export type ISODate = string

export interface Pagination {
  page: number
  limit: number
  total: number
  total_pages: number
}

export interface Paginated<T> {
  items: T[]
  pagination: Pagination
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details: unknown
  }
}

/* ---------- auth ---------- */

export interface User {
  id: UUID
  email: string
  created_at?: ISODate
}

export interface AuthResponse {
  user: User
  access_token: string
  token_type: 'bearer'
}

/* ---------- endpoints ---------- */

export interface EndpointStats {
  total_events: number
  /** 0–1, null when the endpoint has no completed deliveries */
  success_rate: number | null
  last_event_at: ISODate | null
}

export interface Endpoint {
  id: UUID
  name: string
  url: string
  description: string | null
  enabled: boolean
  created_at: ISODate
  updated_at: ISODate
  stats?: EndpointStats
}

export interface EndpointWithSecret extends Endpoint {
  signing_secret: string
}

export interface EndpointInput {
  name: string
  url: string
  description?: string | null
  enabled: boolean
}

export interface TestEventResponse {
  event_id: UUID
  status: EventStatus
  message: string
}

/* ---------- events & deliveries ---------- */

export type EventStatus = 'queued' | 'delivering' | 'retrying' | 'delivered' | 'failed'
export type DeliveryStatus = EventStatus
export type TriggerType = 'automatic' | 'manual'

export interface EventSummary {
  id: UUID
  event_type: string
  endpoint_id: UUID
  endpoint_name: string
  status: EventStatus
  attempts: number
  payload_size: number
  idempotency_key: string | null
  created_at: ISODate
}

export interface Delivery {
  id: UUID
  event_id: UUID
  execution_number: number
  trigger_type: TriggerType
  status: DeliveryStatus
  current_attempt: number
  max_attempts: number
  next_attempt_at: ISODate | null
  started_at: ISODate | null
  completed_at: ISODate | null
  created_at: ISODate
  last_http_status: number | null
  last_duration_ms: number | null
}

export interface EventDetail extends EventSummary {
  endpoint_url: string
  endpoint_enabled: boolean
  latest_delivery: Delivery | null
}

export interface DeliveryAttempt {
  id: UUID
  delivery_id: UUID
  attempt_number: number
  http_status: number | null
  response_body: string | null
  response_headers: Record<string, string> | null
  duration_ms: number | null
  error_message: string | null
  attempted_at: ISODate
}

export interface DeliveryDetail extends Delivery {
  event_type: string
  endpoint_id: UUID
  endpoint_name: string
  endpoint_url: string
}

export interface EventFilters {
  page?: number
  limit?: number
  status?: EventStatus | ''
  event_type?: string
  endpoint_id?: string
  from?: string
  to?: string
  search?: string
  sort?: 'created_at' | '-created_at'
}

/* ---------- dashboard & analytics ---------- */

export type TimeRange = '24h' | '7d' | '30d'

export interface SeriesPoint {
  bucket: ISODate
  total: number
  delivered: number
  failed: number
  avg_ms: number | null
  p95_ms: number | null
}

export interface DashboardStats {
  range: TimeRange
  total_events: number
  successful_deliveries: number
  failed_deliveries: number
  /** 0–1, null when nothing has completed */
  success_rate: number | null
  avg_response_ms: number | null
  series: SeriesPoint[]
}

export interface ActivityItem {
  event_id: UUID
  delivery_id: UUID | null
  event_type: string
  endpoint_id: UUID
  endpoint_name: string
  status: EventStatus
  http_status: number | null
  duration_ms: number | null
  created_at: ISODate
}

export interface DashboardActivity {
  items: ActivityItem[]
}

export type FailureReason = 'http_5xx' | 'http_4xx' | 'http_3xx' | 'http_429' | 'timeout' | 'connection'

export interface AnalyticsOverview {
  range: TimeRange
  total_events: number
  success_rate: number | null
  avg_latency_ms: number | null
  p95_latency_ms: number | null
  series: SeriesPoint[]
  failure_distribution: { reason: FailureReason; count: number }[]
  top_endpoints: { endpoint_id: UUID; name: string; total: number; success_rate: number | null }[]
  top_failed_event_types: { event_type: string; count: number }[]
}

/* ---------- api keys ---------- */

export interface ApiKey {
  id: UUID
  name: string
  key_prefix: string
  last_used_at: ISODate | null
  revoked_at: ISODate | null
  created_at: ISODate
}

export interface ApiKeyCreated extends ApiKey {
  key: string
}

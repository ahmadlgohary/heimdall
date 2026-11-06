import { Tabs } from 'radix-ui'
import { CopyButton } from '@/components/common/copy-button'

const NODE = `import crypto from 'node:crypto'

// Use the raw request body, exactly as received.
export function verify(rawBody, headers, secret) {
  const timestamp = headers['x-webhook-timestamp']
  const received = headers['x-webhook-signature'].replace('v1=', '')
  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest('hex')

  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300
  return fresh && crypto.timingSafeEqual(
    Buffer.from(received, 'hex'),
    Buffer.from(expected, 'hex'),
  )
}`

const PYTHON = `import hashlib, hmac, time

# Use the raw request body, exactly as received.
def verify(raw_body: bytes, headers, secret: str) -> bool:
    timestamp = headers["X-Webhook-Timestamp"]
    received = headers["X-Webhook-Signature"].removeprefix("v1=")
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    fresh = abs(time.time() - int(timestamp)) < 300
    return fresh and hmac.compare_digest(received, expected)`

const SAMPLES = [
  { id: 'node', label: 'Node.js', code: NODE },
  { id: 'python', label: 'Python', code: PYTHON },
]

/** How a receiver checks X-Webhook-Signature (plan §3.5). */
export function VerifySnippet() {
  return (
    <Tabs.Root defaultValue="node">
      <div className="flex items-center justify-between border-b border-border pr-2 pl-4 sm:pl-5">
        <Tabs.List aria-label="Language" className="flex gap-4">
          {SAMPLES.map((s) => (
            <Tabs.Trigger
              key={s.id}
              value={s.id}
              className="relative -mb-px border-b-2 border-transparent py-2.5 text-sm font-medium text-muted outline-none hover:text-foreground focus-visible:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
            >
              {s.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </div>
      {SAMPLES.map((s) => (
        <Tabs.Content key={s.id} value={s.id} className="relative outline-none">
          <CopyButton value={s.code} label={`Copy ${s.label} example`} className="absolute top-2 right-2" />
          <pre className="overflow-x-auto bg-sunken/60 px-4 py-4 pr-12 text-xs leading-relaxed text-foreground sm:px-5">
            <code>{s.code}</code>
          </pre>
        </Tabs.Content>
      ))}
    </Tabs.Root>
  )
}

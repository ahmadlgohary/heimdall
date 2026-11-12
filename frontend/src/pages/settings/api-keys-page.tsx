import { zodResolver } from '@hookform/resolvers/zod'
import { KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { CopyButton } from '@/components/common/copy-button'
import { PageHeader, Panel } from '@/components/common/page-header'
import { SecretReveal } from '@/components/common/secret-reveal'
import { EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, fieldA11y } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/use-api-keys'
import { API_BASE, errorMessage } from '@/lib/api-client'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { apiKeySchema } from '@/schemas/endpoint'
import type { ApiKey, ApiKeyCreated } from '@/types/api'

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateApiKey()
  const [created, setCreated] = useState<ApiKeyCreated | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ name: string }>({ resolver: zodResolver(apiKeySchema), defaultValues: { name: '' } })

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o)
      setTimeout(() => {
        setCreated(null)
        reset()
      }, 200)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      {created ? (
        <DialogContent title="API key created" description={created.name}>
          <DialogBody>
            <SecretReveal
              label="API key"
              value={created.key}
              notice="Copy this key now. We only store a hash, so it can’t be shown again."
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={() => close(false)}>
              I’ve saved the key
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent title="Create API key" description="Your application sends this key in the Authorization header when it submits events.">
          <form
            noValidate
            onSubmit={handleSubmit(async ({ name }) => {
              try {
                setCreated(await create.mutateAsync(name))
              } catch (err) {
                toast.error(errorMessage(err))
              }
            })}
          >
            <DialogBody>
              <Field id="key-name" label="Name" error={errors.name?.message} hint="For example, “Production backend” or “Staging”.">
                <Input autoFocus {...fieldA11y('key-name', errors.name?.message, true)} {...register('name')} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={isSubmitting}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}

const CURL = (base: string) => `curl -X POST ${base}/ingest/<endpoint_id> \\
  -H "Authorization: Bearer <api_key>" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"event_type":"order.created","data":{"order_id":"ORD-1001","amount":129.99}}'`

export default function ApiKeysPage() {
  const { data, isPending, isError, error, refetch } = useApiKeys()
  const revoke = useRevokeApiKey()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const keys = data?.items ?? []
  const base = API_BASE.startsWith('http') ? API_BASE : `${window.location.origin}${API_BASE}`
  const curl = CURL(base)

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys let your application send events to Heimdall. Keep them on your server."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> Create key
          </Button>
        }
      />

      <div className="grid gap-5">
        <Panel>
          {isPending ? (
            <div className="grid gap-3 p-5">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : isError ? (
            <ErrorState error={error} onRetry={() => refetch()} />
          ) : keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title="No API keys yet"
              description="Create a key to start sending events from your application."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> Create key
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {keys.map((k) => {
                const revoked = !!k.revoked_at
                return (
                  <li key={k.id} className={cn('flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-5', revoked && 'opacity-60')}>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="font-medium">
                        {k.name}
                        {revoked && <span className="ml-2 text-sm font-normal text-danger">Revoked</span>}
                      </p>
                      <code className="mono-tight text-sm text-muted">
                        {k.key_prefix}
                        {'•'.repeat(16)}
                      </code>
                    </div>
                    <dl className="flex gap-6 text-sm">
                      <div>
                        <dt className="text-faint">Last used</dt>
                        <dd className="tabular text-muted" title={formatDateTime(k.last_used_at)}>
                          {formatRelative(k.last_used_at)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-faint">Created</dt>
                        <dd className="tabular text-muted">{formatDateTime(k.created_at).split(',')[0]}</dd>
                      </div>
                    </dl>
                    {!revoked ? (
                      <Button variant="danger-ghost" size="sm" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
                        <Trash2 /> Revoke
                      </Button>
                    ) : (
                      <span className="w-[84px]" />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel id="usage" title="Send an event" description="Submit events with a POST. Heimdall replies 202 once the event is stored, then delivers it.">
          <div className="relative">
            <CopyButton value={curl} label="Copy curl example" className="absolute top-2 right-2" />
            <pre className="overflow-x-auto px-4 py-4 pr-12 text-xs leading-relaxed sm:px-5">
              <code>{curl}</code>
            </pre>
          </div>
        </Panel>
      </div>

      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Requests using this key are rejected immediately. Applications using it will stop sending events until you give them a new key."
        confirmLabel="Revoke key"
        loading={revoke.isPending}
        onConfirm={async () => {
          if (!revoking) return
          try {
            await revoke.mutateAsync(revoking.id)
            toast.success(`Revoked ${revoking.name}`)
            setRevoking(null)
          } catch (err) {
            toast.error(errorMessage(err))
          }
        }}
      />
    </>
  )
}

import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { SecretReveal } from '@/components/common/secret-reveal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, fieldA11y } from '@/components/ui/field'
import { Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useCreateEndpoint, useUpdateEndpoint } from '@/hooks/use-endpoints'
import { ApiError, errorMessage } from '@/lib/api-client'
import { endpointSchema, type EndpointFormValues } from '@/schemas/endpoint'
import type { Endpoint, EndpointWithSecret } from '@/types/api'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** edit mode when provided */
  endpoint?: Endpoint | null
}

export function EndpointFormDialog({ open, onOpenChange, endpoint }: Props) {
  const [created, setCreated] = useState<EndpointWithSecret | null>(null)
  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) setTimeout(() => setCreated(null), 200)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      {created ? (
        <DialogContent title="Endpoint added" description={`${created.name} is ready to receive events.`}>
          <DialogBody>
            <SecretReveal
              label="Signing secret"
              value={created.signing_secret}
              notice="Copy this secret now. It won’t be shown again. Your receiver uses it to verify the X-Webhook-Signature header."
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={() => close(false)}>
              I’ve saved the secret
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent
          title={endpoint ? 'Edit endpoint' : 'Add endpoint'}
          description={endpoint ? undefined : 'Events you send to this endpoint are delivered to the URL below as signed POST requests.'}
        >
          {/* key remounts the form with fresh defaults per endpoint */}
          <EndpointForm key={endpoint?.id ?? 'new'} endpoint={endpoint} onCreated={setCreated} onDone={() => close(false)} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function EndpointForm({
  endpoint,
  onCreated,
  onDone,
}: {
  endpoint?: Endpoint | null
  onCreated: (e: EndpointWithSecret) => void
  onDone: () => void
}) {
  const create = useCreateEndpoint()
  const update = useUpdateEndpoint()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EndpointFormValues>({
    resolver: zodResolver(endpointSchema),
    defaultValues: {
      name: endpoint?.name ?? '',
      url: endpoint?.url ?? '',
      description: endpoint?.description ?? '',
      enabled: endpoint?.enabled ?? true,
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    const body = { ...values, description: values.description || null }
    try {
      if (endpoint) {
        await update.mutateAsync({ id: endpoint.id, body })
        toast.success('Endpoint saved')
        onDone()
      } else {
        const res = await create.mutateAsync(body)
        onCreated(res)
      }
    } catch (err) {
      // map server-side URL validation (SSRF rules) onto the field
      if (err instanceof ApiError && (err.status === 422 || err.status === 400) && /url/i.test(err.code + err.message)) {
        setError('url', { message: err.message })
      } else {
        setFormError(errorMessage(err))
      }
    }
  })

  return (
    <form onSubmit={onSubmit} noValidate>
      <DialogBody>
        {formError && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {formError}
          </div>
        )}
        <Field id="ep-name" label="Name" error={errors.name?.message} hint="Shown in the dashboard. For example, “Production orders”.">
          <Input autoFocus placeholder="Production orders" {...fieldA11y('ep-name', errors.name?.message, true)} {...register('name')} />
        </Field>
        <Field id="ep-url" label="Destination URL" error={errors.url?.message} hint="Must be HTTPS and publicly reachable.">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://api.example.com/webhooks"
            className="mono-tight text-sm"
            {...fieldA11y('ep-url', errors.url?.message, true)}
            {...register('url')}
          />
        </Field>
        <Field id="ep-desc" label="Description" error={errors.description?.message} aside={<span className="text-sm text-faint">Optional</span>}>
          <Textarea rows={2} {...fieldA11y('ep-desc', errors.description?.message)} {...register('description')} />
        </Field>
        <Controller
          control={control}
          name="enabled"
          render={({ field }) => (
            <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3.5 py-3">
              <div>
                <label htmlFor="ep-enabled" className="text-base font-medium">
                  Deliver events
                </label>
                <p className="text-sm text-muted">When off, new events to this endpoint are rejected.</p>
              </div>
              <Switch id="ep-enabled" checked={field.value} onCheckedChange={field.onChange} />
            </div>
          )}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          {endpoint ? 'Save changes' : 'Add endpoint'}
        </Button>
      </DialogFooter>
    </form>
  )
}

import { useState } from 'react'
import { toast } from 'sonner'
import { SecretReveal } from '@/components/common/secret-reveal'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { useDeleteEndpoint, useRotateSecret } from '@/hooks/use-endpoints'
import { errorMessage } from '@/lib/api-client'
import type { Endpoint } from '@/types/api'
import { EndpointFormDialog } from './endpoint-form-dialog'

export type EndpointAction = 'edit' | 'rotate' | 'delete' | null

/**
 * The dialogs behind each endpoint action, shared by the table menu and the
 * detail page. Callers set `action` and `endpoint`; this renders the rest.
 */
export function EndpointActionDialogs({
  endpoint,
  action,
  onClose,
  afterDelete,
}: {
  endpoint: Endpoint | null
  action: EndpointAction
  onClose: () => void
  afterDelete?: () => void
}) {
  const rotate = useRotateSecret()
  const remove = useDeleteEndpoint()
  const [secret, setSecret] = useState<string | null>(null)

  return (
    <>
      <EndpointFormDialog open={action === 'edit'} onOpenChange={(o) => !o && onClose()} endpoint={endpoint} />

      <ConfirmDialog
        open={action === 'rotate' && !secret}
        onOpenChange={(o) => !o && onClose()}
        title="Rotate signing secret?"
        description={
          <>
            A new secret is generated for <strong className="text-foreground">{endpoint?.name}</strong> and the current one
            stops working immediately. Update your receiver right after rotating, or it will reject deliveries.
          </>
        }
        confirmLabel="Rotate secret"
        loading={rotate.isPending}
        onConfirm={async () => {
          if (!endpoint) return
          try {
            const res = await rotate.mutateAsync(endpoint.id)
            setSecret(res.signing_secret)
          } catch (err) {
            toast.error(errorMessage(err))
          }
        }}
      />

      <Dialog
        open={!!secret}
        onOpenChange={(o) => {
          if (!o) {
            setSecret(null)
            onClose()
          }
        }}
      >
        <DialogContent title="Secret rotated" description={`New signing secret for ${endpoint?.name ?? 'this endpoint'}.`}>
          <DialogBody>
            {secret && (
              <SecretReveal label="Signing secret" value={secret} notice="Copy this secret now. It won’t be shown again." />
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="primary"
              onClick={() => {
                setSecret(null)
                onClose()
              }}
            >
              I’ve saved the secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={action === 'delete'}
        onOpenChange={(o) => !o && onClose()}
        title={`Delete ${endpoint?.name ?? 'endpoint'}?`}
        description="The endpoint stops accepting events right away. Its event history is deleted with it. This can’t be undone."
        confirmLabel="Delete endpoint"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!endpoint) return
          try {
            await remove.mutateAsync(endpoint.id)
            toast.success(`Deleted ${endpoint.name}`)
            onClose()
            afterDelete?.()
          } catch (err) {
            toast.error(errorMessage(err))
          }
        }}
      />
    </>
  )
}

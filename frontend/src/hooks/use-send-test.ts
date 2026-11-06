import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useSendTest } from '@/hooks/use-endpoints'
import { errorMessage } from '@/lib/api-client'
import type { Endpoint } from '@/types/api'

/** Fires a test event and offers a link to watch it. */
export function useSendTestWithToast() {
  const send = useSendTest()
  const navigate = useNavigate()
  return {
    pending: send.isPending,
    variables: send.variables,
    run: async (endpoint: Endpoint) => {
      try {
        const res = await send.mutateAsync(endpoint.id)
        toast.success(`Test event sent to ${endpoint.name}`, {
          action: { label: 'View', onClick: () => navigate(`/events/${res.event_id}`) },
        })
      } catch (err) {
        toast.error(errorMessage(err))
      }
    },
  }
}

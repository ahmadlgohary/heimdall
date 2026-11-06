import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/api-client'
import { queryKeys } from '@/lib/query-client'
import { endpointService } from '@/services/endpoint.service'
import type { Endpoint, EndpointInput } from '@/types/api'

export function useEndpoints() {
  return useQuery({
    queryKey: queryKeys.endpoints,
    queryFn: () => endpointService.list(),
    placeholderData: keepPreviousData,
  })
}

export function useEndpoint(id: string) {
  return useQuery({ queryKey: queryKeys.endpoint(id), queryFn: () => endpointService.get(id) })
}

export function useCreateEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: EndpointInput) => endpointService.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.endpoints }),
  })
}

export function useUpdateEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<EndpointInput> }) => endpointService.update(id, body),
    // optimistic toggle so the switch responds instantly
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: queryKeys.endpoints })
      const prev = qc.getQueryData(queryKeys.endpoints)
      qc.setQueryData(queryKeys.endpoints, (old: { items: Endpoint[] } | undefined) =>
        old ? { ...old, items: old.items.map((e) => (e.id === id ? { ...e, ...body } : e)) } : old,
      )
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.endpoints, ctx.prev)
      toast.error(errorMessage(err))
    },
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: queryKeys.endpoints })
      qc.invalidateQueries({ queryKey: queryKeys.endpoint(id) })
    },
  })
}

export function useDeleteEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => endpointService.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.endpoints }),
  })
}

export function useRotateSecret() {
  return useMutation({ mutationFn: (id: string) => endpointService.rotateSecret(id) })
}

export function useSendTest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => endpointService.sendTest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

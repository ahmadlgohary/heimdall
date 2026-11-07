import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-client'
import { apiKeyService } from '@/services/api-key.service'

export function useApiKeys() {
  return useQuery({ queryKey: queryKeys.apiKeys, queryFn: apiKeyService.list })
}

export function useCreateApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => apiKeyService.create(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apiKeys }),
  })
}

export function useRevokeApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiKeyService.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apiKeys }),
  })
}

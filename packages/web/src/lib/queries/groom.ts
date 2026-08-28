'use client';

/**
 * React Query hooks for retention policies ("grooming") — the same
 * REST-client pattern `queries/lore.ts` uses, applied to `lib/api/groom.ts`.
 * Every read/write goes through the `memories` REST function; nothing here
 * touches supabase-js beyond resolving the caller's own access token.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserAccessToken } from '@/lib/api/session-browser';
import {
  createPolicyRequest,
  deletePolicyRequest,
  groomPreviewRequest,
  groomRunRequest,
  listPoliciesRequest,
  protectRequest,
  updatePolicyRequest,
} from '@/lib/api/groom';
import type {
  GroomPreviewResponse,
  GroomRequest,
  GroomRunResponse,
  PolicyCreateBody,
  PolicyUpdateBody,
  ProtectBody,
  RetentionPolicy,
} from '@lorekit/schemas/retention';

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

async function requireToken(): Promise<string> {
  const token = await browserAccessToken();
  if (!token) throw new NotAuthenticatedError();
  return token;
}

export const POLICIES_QUERY_KEY = ['retention-policies'] as const;

export function usePolicies() {
  return useQuery({
    queryKey: POLICIES_QUERY_KEY,
    queryFn: async (): Promise<RetentionPolicy[]> => {
      const token = await requireToken();
      const res = await listPoliciesRequest(token);
      return res.entries;
    },
  });
}

export function useCreatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: PolicyCreateBody) => {
      const token = await requireToken();
      return createPolicyRequest(token, body);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: POLICIES_QUERY_KEY }); },
  });
}

export function useUpdatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: PolicyUpdateBody }) => {
      const token = await requireToken();
      return updatePolicyRequest(token, id, body);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: POLICIES_QUERY_KEY }); },
  });
}

export function useDeletePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const token = await requireToken();
      return deletePolicyRequest(token, id);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: POLICIES_QUERY_KEY }); },
  });
}

/**
 * Live match-count preview. Not a `useQuery` with a keyed cache — the rule
 * builder calls this imperatively (debounced) as the form changes, and a
 * throwaway preview has no reason to persist in the query cache.
 */
export function useGroomPreview() {
  return useMutation({
    mutationFn: async (request: GroomRequest): Promise<GroomPreviewResponse> => {
      const token = await requireToken();
      return groomPreviewRequest(token, request);
    },
  });
}

export function useGroomRun() {
  return useMutation({
    mutationFn: async (request: GroomRequest): Promise<GroomRunResponse> => {
      const token = await requireToken();
      return groomRunRequest(token, request);
    },
  });
}

export function useProtect() {
  return useMutation({
    mutationFn: async (body: ProtectBody) => {
      const token = await requireToken();
      return protectRequest(token, body);
    },
  });
}

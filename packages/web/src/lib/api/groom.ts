/**
 * Typed wrappers over the retention-policy ("grooming") REST routes, which
 * hang off the `memories` edge function per the plan's Decisions —
 * `/memories/policies`, `/memories/groom/preview`, `/memories/groom/run`,
 * `/memories/protect` — the `memories.ts` pattern applied to the newer
 * surface. Types come from `@lorekit/schemas/retention`, the same package
 * that validates them server-side.
 */
import type {
  GroomPreviewResponse,
  GroomRequest,
  GroomRunResponse,
  PolicyCreateBody,
  PolicyListResponse,
  PolicyUpdateBody,
  ProtectBody,
  ProtectResponse,
  RetentionPolicy,
} from '@lorekit/schemas/retention';
import { restFetch } from './rest';

export function listPoliciesRequest(accessToken: string, signal?: AbortSignal): Promise<PolicyListResponse> {
  return restFetch<PolicyListResponse>('/memories/policies', { accessToken, ...(signal ? { signal } : {}) });
}

export function createPolicyRequest(accessToken: string, body: PolicyCreateBody): Promise<RetentionPolicy> {
  return restFetch<RetentionPolicy>('/memories/policies', { accessToken, method: 'POST', body });
}

export function updatePolicyRequest(
  accessToken: string,
  id: string,
  body: PolicyUpdateBody,
): Promise<RetentionPolicy> {
  return restFetch<RetentionPolicy>(`/memories/policies/${encodeURIComponent(id)}`, { accessToken, method: 'PATCH', body });
}

export function deletePolicyRequest(accessToken: string, id: string): Promise<{ deleted: boolean }> {
  return restFetch<{ deleted: boolean }>(`/memories/policies/${encodeURIComponent(id)}`, { accessToken, method: 'DELETE' });
}

export function groomPreviewRequest(
  accessToken: string,
  request: GroomRequest,
  signal?: AbortSignal,
): Promise<GroomPreviewResponse> {
  return restFetch<GroomPreviewResponse>('/memories/groom/preview', {
    accessToken,
    method: 'POST',
    body: request,
    ...(signal ? { signal } : {}),
  });
}

export function groomRunRequest(accessToken: string, request: GroomRequest): Promise<GroomRunResponse> {
  return restFetch<GroomRunResponse>('/memories/groom/run', { accessToken, method: 'POST', body: request });
}

export function protectRequest(accessToken: string, body: ProtectBody): Promise<ProtectResponse> {
  return restFetch<ProtectResponse>('/memories/protect', { accessToken, method: 'POST', body });
}

import type { z } from 'zod';
import { apiErrorSchema } from '@hostline/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { method?: string; body?: unknown; csrf?: string | null; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.csrf) headers['X-CSRF-Token'] = options.csrf;
  const response = await fetch(`/api${path}`, {
    method: options?.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options?.signal ?? AbortSignal.timeout(15000),
  });
  const raw: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(raw);
    throw new ApiError(
      error.success
        ? error.data.error.message
        : 'The request could not be completed. Please try again.',
      response.status,
      error.success ? error.data.error.code : 'REQUEST_FAILED',
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      'The server returned an unexpected response. Please refresh and try again.',
      502,
      'INVALID_RESPONSE',
    );
  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

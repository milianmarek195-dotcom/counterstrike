'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`${API_URL}/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `HTTP ${res.status}`, data?.details);
  return data as T;
}

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Fetches `path` (null = skip) and exposes reload(); stale responses of an older path are ignored. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ctl.signal })
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Server not reachable'));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Runs a mutation, reports errors through `onError` and reloads afterwards. */
export function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const done = useRef(onDone);
  done.current = onDone;
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      done.current?.();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${e.code ? ` (${e.code})` : ''}` : 'Unexpected error');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error };
}

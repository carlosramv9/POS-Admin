/**
 * TanStack Query configuration, persisted to MMKV for offline-first reads.
 *
 * `ApiError.isRetryable` decides retries, so a 401/403/422 fails immediately
 * (retrying is pointless and slows the error UI down) while a flaky network
 * gets three attempts with exponential backoff.
 */
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { QueryClient } from '@tanstack/react-query';

import { StorageKeys } from '@/constants/storage-keys';
import { ApiError } from '@/services/api';
import { querySyncStorage } from '@/services/storage/kv-storage';

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  if (error instanceof ApiError) return error.isRetryable;
  return false;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: FIVE_MINUTES,
      gcTime: ONE_DAY,
      retry: shouldRetry,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      // The app already refetches on reconnect; refetching on every screen
      // focus would hammer the API during wizard navigation.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryPersister = createSyncStoragePersister({
  storage: querySyncStorage,
  key: StorageKeys.queryCache,
  throttleTime: 1000,
});

export const persistOptions = {
  persister: queryPersister,
  maxAge: ONE_DAY,
  /** Bump when a cached shape changes, to discard incompatible caches. */
  // v2: `Product` ganó `variants`; los productos cacheados por v1 no lo traen.
  buster: 'v2',
} as const;

/**
 * Redis-backed debounce for the RAG indexer.
 *
 * Uses Upstash Redis SET NX EX to ensure only one indexing job runs per
 * (org, agent, event_type) burst window. Falls back to an in-memory Map when
 * Redis is not configured (NOT safe for multi-instance deploys — warns loudly).
 */

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// Redis client — lazy singleton
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
let _fallbackWarned = false;
let _redisFailureWarned = false;

function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (!_fallbackWarned) {
      console.warn(
        "[rag-debounce] Redis missing — using in-memory fallback (NOT safe for multi-instance)",
      );
      _fallbackWarned = true;
    }
    return null;
  }

  // Falhar rápido: o fallback local já existe e retries do SDK só prendem o worker.
  _redis = new Redis({ url, token, retry: false });
  return _redis;
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

const _memKeys = new Map<string, ReturnType<typeof setTimeout>>();

function memAcquire(key: string, ttlSec: number): boolean {
  if (_memKeys.has(key)) return false;
  const timer = setTimeout(() => {
    _memKeys.delete(key);
  }, ttlSec * 1000);
  _memKeys.set(key, timer);
  return true;
}

function memRelease(key: string): void {
  const timer = _memKeys.get(key);
  if (timer) {
    clearTimeout(timer);
    _memKeys.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to acquire a debounce lock for `key` with a TTL of `ttlSec`.
 *
 * Returns `true` if the lock was acquired (caller should process the event).
 * Returns `false` if another worker already holds the lock (caller should skip).
 */
export async function acquireDebounce(key: string, ttlSec: number): Promise<boolean> {
  const redis = getRedis();

  if (!redis) {
    return memAcquire(key, ttlSec);
  }

  // SET NX EX — returns "OK" if set, null if key already exists.
  try {
    const result = await redis.set(key, "1", { nx: true, ex: ttlSec });
    return result === "OK";
  } catch (error) {
    if (!_redisFailureWarned) {
      console.warn("[rag-debounce] Redis unavailable — using in-memory fallback (not safe for multi-instance)", {
        error: error instanceof Error ? error.message : String(error),
      });
      _redisFailureWarned = true;
    }
    return memAcquire(key, ttlSec);
  }
}

/**
 * Releases a debounce lock early (optional — TTL handles natural cleanup).
 */
export async function releaseDebounce(key: string): Promise<void> {
  const redis = getRedis();

  if (!redis) {
    memRelease(key);
    return;
  }

  try {
    await redis.del(key);
  } catch (error) {
    console.warn("[rag-debounce] Redis release failed; continuing with local state", {
      error: error instanceof Error ? error.message : String(error),
    });
    memRelease(key);
  }
}

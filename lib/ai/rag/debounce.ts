/**
 * Debounce da indexação, com Redis quando ele existe.
 *
 * `SET NX EX` garante que uma rajada de edições do mesmo material não dispare N
 * indexações. Sem Redis configurado, cai num Map em memória (NÃO seguro para
 * várias instâncias — avisa alto).
 *
 * ## POR QUE ISTO FALHA ABERTO, e por que a diferença é enorme
 *
 * Redis CONFIGURADO e INALCANÇÁVEL é um estado real de produção — VPS com o
 * contêiner do Redis caído, rede entre serviços, credencial rotacionada. Até
 * aqui, `redis.set()` era chamado sem timeout e sem `catch`: o SDK da Upstash
 * tenta de novo com backoff e a promise simplesmente não volta.
 *
 * O efeito NÃO é "a indexação demora". `drainEventLog` marca a linha como
 * `processing` ANTES de chamar o handler, e não existe reaper que devolva
 * `processing` para `pending` no `event_log` (existe para `job_queue`, não para
 * este). Um handler que não retorna deixa o evento preso para SEMPRE: o
 * material nunca é preparado, nada aparece na tela, e nem tentar de novo
 * resolve — a linha não volta para a fila.
 *
 * Medido na prova de tela desta frente: com o Redis do `.env.e2e` apontando
 * para uma porta sem ninguém escutando, o evento ficou `processing`,
 * `attempts=0`, `consumed_by` vazio, e a requisição do dreno estourou o tempo.
 *
 * Perder o debounce custa uma indexação a mais — centavos e alguns segundos.
 * Perder o evento custa o material inteiro, em silêncio. Entre os dois, falhar
 * ABERTO não é escolha difícil.
 */

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { validarConfigRedisRest } from "@/lib/redis-config";

// ---------------------------------------------------------------------------
// Redis client — lazy singleton
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
let _fallbackWarned = false;

/** Teto NOSSO para a ida ao Redis. Ver o cabeçalho: sem ele, a promise não volta. */
const TIMEOUT_MS = 2_000;

function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  // Conferir a FORMA antes de construir o cliente: com o valor malformado, cada
  // evento pagaria os 2s do `Promise.race` abaixo para chegar ao mesmo lugar em
  // que esta linha chega de graça. Ver `lib/redis-config.ts`.
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (!_fallbackWarned) {
      console.warn(
        `[rag-debounce] Redis ${config.reason} — using in-memory fallback (NOT safe for multi-instance)`,
      );
      _fallbackWarned = true;
    }
    return null;
  }

  _redis = new Redis({ url, token });
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

  try {
    // SET NX EX — "OK" quando gravou, null quando a chave já existia.
    //
    // O timeout é NOSSO e não do SDK: o cliente da Upstash tenta de novo com
    // backoff e, sem corrida contra um relógio, a promise não volta. Ver o
    // cabeçalho — handler que não retorna deixa o evento preso em `processing`
    // para sempre.
    const result = await Promise.race([
      redis.set(key, "1", { nx: true, ex: ttlSec }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("debounce_timeout")), TIMEOUT_MS),
      ),
    ]);
    return result === "OK";
  } catch (err) {
    console.warn(
      "[rag-debounce] Redis não respondeu — seguindo SEM debounce (pode indexar duas vezes):",
      err instanceof Error ? err.message : String(err),
    );
    return true;
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
    await Promise.race([
      redis.del(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("debounce_timeout")), TIMEOUT_MS),
      ),
    ]);
  } catch {
    // Soltar a trava cedo é otimização: o TTL a solta sozinho. Falhar aqui não
    // pode derrubar quem chamou.
  }
}

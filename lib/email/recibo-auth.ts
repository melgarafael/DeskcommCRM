import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { validarConfigRedisRest } from "@/lib/redis-config";

/** Recibo por destinatário: retentativa do segundo e-mail não duplica o primeiro.
 * Redis indisponível recusa envio (sem fallback em memória que perde recibos).
 * A janela de 24h excede a validade da assinatura e as retentativas do hook.
 */
export function criarRecibosAuth() {
  if (!validarConfigRedisRest(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN).ok) {
    throw new Error("recibos_indisponiveis");
  }
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
    signal: () => AbortSignal.timeout(2000),
  });
  return {
    async reservar(id: string, indice: number, corpo: string) {
      const chave = `auth-email:${createHash("sha256").update(`${id}:${indice}:${corpo}`).digest("hex")}`;
      const dono = randomUUID();
      const reservado = await redis.set(chave, dono, { nx: true, ex: 600 });
      if (!reservado) {
        const estado = await redis.get<string>(chave);
        return {
          estado: estado === "enviado" ? ("enviado" as const) : ("ocupado" as const),
          concluir: async () => {},
          liberar: async () => {},
        };
      }
      return {
        estado: "reservado" as const,
        async concluir() {
          const gravado = await redis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], 'enviado', 'EX', 86400); return 1 else return 0 end",
            [chave],
            [dono],
          );
          if (!gravado) throw new Error("recibo_perdido");
        },
        async liberar() {
          await redis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            [chave],
            [dono],
          );
        },
      };
    },
  };
}

import type pg from "pg";
import type { EventRow, EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import type { SupabaseClient } from "@supabase/supabase-js";
import { criarTransporteDoAviso } from "../aviso-ao-suporte.handler";
import { decidirEspacamento } from "@/lib/agent-engine/pacing/ledger-supabase";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import { carregarPassagem, criarBancoDaEntrega } from "./postgres";
import { configEntregaSchema, entregarPassagem, type DepsEntrega } from "./passagem";
export const ENTREGA_HANDLER_KEY = "handoff-delivery.v1";

/** Sessão, não transação: recibo requested precisa COMMIT antes da rede.
 * Usa a mesma chave do lock de envio nativo; transações de leads não dormem aqui. */
export async function comLockDoCanal<T>(
  pool: pg.Pool,
  channel: string,
  action: () => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("set lock_timeout='3s'");
    await c.query("select pg_advisory_lock(hashtext($1))", [channel]);
    try {
      return await action();
    } finally {
      await c.query("select pg_advisory_unlock(hashtext($1))", [channel]);
    }
  } finally {
    await c.query("reset lock_timeout");
    c.release();
  }
}
export async function depsDaEntrega(
  pool: pg.Pool,
  admin: SupabaseClient,
  urlPublica: string,
): Promise<DepsEntrega> {
  return {
    db: criarBancoDaEntrega(pool, admin),
    transporte: await criarTransporteDoAviso(admin),
    urlPublica,
    clock: () => new Date(),
    comLockDoCanal: (_org, channel, f) => comLockDoCanal(pool, channel, f),
    pacing: {
      async decide(org, channel, agora) {
        const { knobs, numberActivatedAt } = await loadChannelKnobs(pool, org, channel);
        const estado = await loadPacingState(pool, org, channel, {
          now: agora,
          timezone: knobs.timezone,
          numberActivatedAt,
        });
        const { rows } = await pool.query(
          "select daily_message_limit from channel_sessions where organization_id=$1 and id=$2",
          [org, channel],
        );
        if (!rows[0]) throw Error("handoff_channel_missing");
        return decidirEspacamento({
          agora,
          estado,
          throttleMs: knobs.throttleMs,
          jitterMaxMs: knobs.jitterMaxMs,
          timezone: knobs.timezone,
          warmupDailyCaps: knobs.warmupDailyCaps,
          crmDailyLimit: rows[0].daily_message_limit,
        });
      },
      registraEnvio: (org, channel, quando) => recordSend(pool, org, channel, quando),
    },
  };
}
/** Consumer real compartilhado com integração descartável; só transporte é substituído. */
export async function consumirEntrega(
  pool: pg.Pool,
  row: EventRow,
  deps: DepsEntrega,
): Promise<HandlerResult> {
  const result = (
    status: HandlerResult["status"],
    detail: string,
    retry_at?: string,
  ): HandlerResult => ({
    consumer_key: ENTREGA_HANDLER_KEY,
    status,
    detail,
    ...(retry_at ? { retry_at } : {}),
  });
  if (
    row.event_type !== "ai.handoff_delivery" ||
    typeof row.entity_id !== "string" ||
    row.payload.episode_id !== row.entity_id
  )
    return result("skipped", "invalid_event");
  const { rows } = await pool.query(
    "select status,settings->'handoff_delivery' config from organizations where id=$1",
    [row.organization_id],
  );
  if (rows[0]?.status !== "active") return result("skipped", "organization_inactive");
  const raw = rows[0]?.config;
  if (raw?.enabled !== true) return result("skipped", "disabled");
  const config = configEntregaSchema.safeParse(raw);
  if (!config.success) {
    await pool.query(
      "update handoff_delivery_episodes set status='blocked',reason='invalid_config',updated_at=now() where organization_id=$1 and id=$2",
      [row.organization_id, row.entity_id],
    );
    return result("error", "invalid_config");
  }
  const passage = await carregarPassagem(pool, row.organization_id, row.entity_id);
  if (!passage) return result("skipped", "episode_missing");
  const current = (
    await pool.query(
      "select status,attempts from handoff_delivery_episodes where organization_id=$1 and id=$2",
      [row.organization_id, row.entity_id],
    )
  ).rows[0];
  if (["delivered", "ambiguous", "cancelled", "blocked"].includes(current.status))
    return result("skipped", current.status);
  const delivered = await entregarPassagem(deps, passage, config.data);
  let state = "pending",
    reason: string = delivered.reason ?? delivered.status;
  if (delivered.status === "delivered") state = "delivered";
  else if (delivered.status === "ambiguous") state = "ambiguous";
  else if (["conflict", "stale", "disabled"].includes(delivered.status)) state = "cancelled";
  else if (delivered.status === "blocked") state = "blocked";
  const isSpacing = delivered.reason === "pacing" || delivered.reason === "busy";
  const attempts = Number(current.attempts) + (isSpacing ? 0 : 1);
  if (state === "pending" && attempts >= config.data.max_attempts) {
    state = "blocked";
    reason = "retry_exhausted";
  }
  await pool.query(
    "update handoff_delivery_episodes set status=$3,reason=$4,attempts=$5,updated_at=now() where organization_id=$1 and id=$2",
    [row.organization_id, row.entity_id, state, reason, attempts],
  );
  if (state === "pending")
    return result(
      "retry",
      reason,
      delivered.retryAt ?? new Date(Date.now() + config.data.retry_seconds * 1000).toISOString(),
    );
  // blocked/ambiguous ficam no episódio e na trilha de erro do dreno; nada de replay automático.
  if (state === "blocked" || state === "ambiguous")
    return result("error", `handoff_${state}:${reason}`);
  return result(state === "delivered" ? "ok" : "skipped", reason);
}
export const entregaHumanaHandler: EventHandler & { naOrgParada: "pula" } = {
  key: ENTREGA_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["ai.handoff_delivery"],
  async handle(row) {
    try {
      const [{ getRequestPool }, { createAdminClient }, { env }] = await Promise.all([
        import("@/lib/agent-engine/db/request-pool"),
        import("@/lib/supabase/admin"),
        import("@/lib/env"),
      ]);
      const pool = getRequestPool();
      return await consumirEntrega(
        pool,
        row,
        await depsDaEntrega(pool, createAdminClient(), env.NEXT_PUBLIC_APP_URL),
      );
    } catch {
      return {
        consumer_key: ENTREGA_HANDLER_KEY,
        status: "error",
        detail: "handoff_delivery_failed",
      };
    }
  },
};

import { ApiError } from "@/lib/api/types";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "../../queue/queue";

export type SendLedgerStatus = "requested" | "accepted" | "queued" | "vetoed" | "failed";
export type SendOutcome =
  | { kind: "sent"; idempotencyKey: string; crmMessageId: string }
  | {
      kind: "already_sent" | "queued" | "failed";
      idempotencyKey: string;
      crmMessageId: string | null;
    }
  | { kind: "blocked"; idempotencyKey: string };
export type Intent = { tenantId: string; leadId: string | null; jobId: string; seq: number; body: string };
export type Row = {
  id: string;
  status: SendLedgerStatus;
  crm_message_id: string | null;
  /**
   * Migration 9051. Opcional no TYPE (não no banco) de propósito: dublês de
   * teste existentes constroem este objeto sem o campo, e exigi-lo quebraria
   * cada um — a leitura trata ausência e `null` como a mesma coisa ("nada
   * sintetizado ainda").
   */
  media_storage_path?: string | null;
};
export interface LedgerStore {
  create(input: Intent, hash: string): Promise<string>;
  find(input: Intent): Promise<Row | null>;
  rotate(input: Intent, hash: string): Promise<string>;
  /** Pela PK primeiro: o envio grava `messages.id = chave` (`internalMessageId`). O
   * `metadata->>'idempotency_key'` não tem índice e só alcança linha gravada antes
   * dessa convenção, então fica de reserva para quando a PK não acha. */
  message(org: string, key: string): Promise<{ id: string; status: string } | null>;
  update(
    org: string,
    key: string,
    status: SendLedgerStatus,
    id: string | null,
    error: string | null,
  ): Promise<void>;
  /**
   * Grava o caminho da mídia JÁ sintetizada — só se a linha ainda não tiver
   * um (o `coalesce` é a defesa: duas tentativas correndo em paralelo nunca
   * deveriam acontecer, já que o job tem dono exclusivo, mas um UPDATE que só
   * escreve quando está vazio custa zero e fecha a dúvida).
   */
  setMediaPath(org: string, key: string, path: string): Promise<string>;
}

/** O hash que identifica o CORPO desta tentativa — nunca o corpo em si (PII) chega ao ledger. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
/**
 * A resolução de CHAVE — extraída de `sendWithLedger` para que a síntese de
 * voz (Fase 6a do plano de voz) possa resolver a MESMA identidade de linha
 * ANTES de decidir se precisa sintetizar, sem duplicar a lógica de
 * create/find/rotate num segundo lugar que pudesse divergir dela.
 *
 * Comportamento idêntico ao bloco que existia inline em `sendWithLedger` —
 * refactor puro, sem mudança de regra. Os cinco casos de
 * `tests/unit/followup-send-ledger.test.ts` são a prova de que a extração não
 * mudou nada.
 */
type ResolucaoDeChave =
  | { kind: "key"; key: string; row: Row | null }
  | { kind: "already_sent"; key: string; crmMessageId: string | null }
  | { kind: "blocked"; key: string };

export async function resolverChaveDoLedger(
  store: LedgerStore,
  input: Intent,
  hash: string,
): Promise<ResolucaoDeChave> {
  try {
    const key = await store.create(input, hash);
    return { kind: "key", key, row: null };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "23505"))
      throw error;
    const prior = await store.find(input);
    if (!prior) throw new Error("send_ledger_missing");
    if (prior.status === "accepted")
      return { kind: "already_sent", key: prior.id, crmMessageId: prior.crm_message_id };
    if (prior.status === "vetoed") return { kind: "blocked", key: prior.id };
    if (prior.status === "failed") return { kind: "key", key: await store.rotate(input, hash), row: null };
    return { kind: "key", key: prior.id, row: prior };
  }
}

/** Inline e daemon compartilham identidade (job,seq), reconciliação e mensagem.
 * Página/worker perdido não cria uma segunda intenção. queued é reavaliado pelo
 * handler com o MESMO id; somente sent/delivered/read confirmam entrega. */
export async function sendWithLedger(
  store: LedgerStore,
  input: Intent,
  send: (key: string, messageId: string) => Promise<{ id: string; status: string }>,
): Promise<SendOutcome> {
  const hash = bodyHash(input.body);
  const resolucao = await resolverChaveDoLedger(store, input, hash);
  if (resolucao.kind === "already_sent")
    return { kind: "already_sent", idempotencyKey: resolucao.key, crmMessageId: resolucao.crmMessageId };
  if (resolucao.kind === "blocked") return { kind: "blocked", idempotencyKey: resolucao.key };
  const key = resolucao.key;
  // Chave saída de `create` ou `rotate` é um uuid que acabou de nascer (`row`
  // null): nenhuma mensagem pode carregá-la ainda. Procurar seria uma leitura
  // sob o lock do número que só pode devolver vazio.
  const existing = resolucao.row ? await store.message(input.tenantId, key) : null;
  let message = existing;
  if (!message || message.status === "queued") {
    try {
      message = await send(key, existing?.id ?? key);
    } catch (error) {
      // Organização parada NÃO é veto do contato. Gravar `vetoed` faria o dono
      // do job ler `blocked` — e no agent-engine `blocked` cancela TODOS os
      // follow-ups do contato como opt-out irrevogável (`applySendOutcome`).
      // Sobe como está: `terminal: true` encerra o job sem tocar no contato.
      if (error instanceof OrgNaoOperanteError) throw error;
      if (error instanceof ApiError && error.status === 403) {
        await store.update(input.tenantId, key, "vetoed", null, "handler 403");
        return { kind: "blocked", idempotencyKey: key };
      }
      throw error;
    }
  }
  const status: SendLedgerStatus = ["sent", "delivered", "read"].includes(message.status)
    ? "accepted"
    : message.status === "failed"
      ? "failed"
      : "queued";
  await store.update(
    input.tenantId,
    key,
    status,
    message.id,
    status === "failed" ? "handler marcou a mensagem como failed" : null,
  );
  return status === "accepted"
    ? { kind: "sent", idempotencyKey: key, crmMessageId: message.id }
    : { kind: status, idempotencyKey: key, crmMessageId: message.id };
}
/** Reconcilia um recibo já existente sem criar intenção nem chamar o canal.
 * Consumidores determinísticos consultam isto antes dos gates de um NOVO envio. */
export async function reconcileAcceptedSend(
  db: Queryable, input: { tenantId: string; jobId: string; seq: number },
): Promise<boolean> {
  const store = pgSendLedger(db);
  const prior = await store.find({ ...input, leadId: null, body: "" });
  if (!prior) return false;
  if (prior.status === "accepted") return true;
  const message = await store.message(input.tenantId, prior.id);
  if (!message || !["sent", "delivered", "read"].includes(message.status)) return false;
  await store.update(input.tenantId, prior.id, "accepted", message.id, null);
  return true;
}
export function pgSendLedger(db: Queryable): LedgerStore {
  return {
    async create(i, hash) {
      const { rows } = await db.query<{ id: string }>(
        "insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash) values ($1, $2, $3, $4, $5) returning id",
        [i.tenantId, i.leadId, i.jobId, i.seq, hash],
      );
      if (!rows[0]) throw new Error("send_ledger_insert_missing");
      return rows[0].id;
    },
    async find(i) {
      const { rows } = await db.query<Row>(
        "select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3",
        [i.tenantId, i.jobId, i.seq],
      );
      return rows[0] ?? null;
    },
    async rotate(i, hash) {
      // `media_storage_path=null` É PARTE DA ROTAÇÃO, não um extra: rotate()
      // é uma tentativa lógica NOVA (a anterior falhou), e o áudio que a
      // tentativa anterior sintetizou — se houver — pode não corresponder ao
      // texto desta. Herdar o path antigo serviria o ÁUDIO ERRADO para a
      // mensagem nova, calado.
      const { rows } = await db.query<{ id: string }>(
        "update send_ledger set id=gen_random_uuid(),status='requested',body_hash=$4,crm_message_id=null,last_error=null,media_storage_path=null,updated_at=now() where organization_id=$1 and job_id=$2 and seq=$3 returning id",
        [i.tenantId, i.jobId, i.seq, hash],
      );
      if (!rows[0]) throw new Error("send_ledger_rotation_missing");
      return rows[0].id;
    },
    async message(org, key) {
      const { rows } = await db.query<{ id: string; status: string }>(
        "select id,status from messages where organization_id=$1 and id=$2",
        [org, key],
      );
      if (rows[0]) return rows[0];
      const legado = await db.query<{ id: string; status: string }>(
        "select id,status from messages where organization_id=$1 and metadata->>'idempotency_key'=$2 limit 1",
        [org, key],
      );
      return legado.rows[0] ?? null;
    },
    async update(org, key, status, id, error) {
      await db.query(
        "update send_ledger set status=$3,crm_message_id=coalesce($4,crm_message_id),last_error=$5,updated_at=now() where organization_id=$1 and id=$2",
        [org, key, status, id, error],
      );
    },
    async setMediaPath(org, key, path) {
      const { rows } = await db.query<{ media_storage_path: string }>(
        "update send_ledger set media_storage_path=coalesce(media_storage_path,$3),updated_at=now() where organization_id=$1 and id=$2 returning media_storage_path",
        [org, key, path],
      );
      if (!rows[0]) throw new Error("send_ledger_set_media_path_missing");
      return rows[0].media_storage_path;
    },
  };
}
export function supabaseSendLedger(db: SupabaseClient): LedgerStore {
  return {
    async create(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .insert({
          organization_id: i.tenantId,
          contact_id: i.leadId,
          job_id: i.jobId,
          seq: i.seq,
          body_hash: hash,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    async find(i) {
      const { data, error } = await db
        .from("send_ledger")
        .select("id,status,crm_message_id,media_storage_path")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async rotate(i, hash) {
      // Ver o comentário irmão em `pgSendLedger.rotate`: path antigo não pode
      // sobreviver a uma tentativa lógica nova.
      const { data, error } = await db
        .from("send_ledger")
        .update({
          id: crypto.randomUUID(),
          status: "requested",
          body_hash: hash,
          crm_message_id: null,
          last_error: null,
          media_storage_path: null,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    async message(org, key) {
      const porId = await db
        .from("messages")
        .select("id,status")
        .eq("organization_id", org)
        .eq("id", key)
        .maybeSingle();
      if (porId.error) throw porId.error;
      if (porId.data) return porId.data;
      const { data, error } = await db
        .from("messages")
        .select("id,status")
        .eq("organization_id", org)
        .eq("metadata->>idempotency_key", key)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async update(org, key, status, id, errorText) {
      const { error } = await db
        .from("send_ledger")
        .update({
          status,
          ...(id ? { crm_message_id: id } : {}),
          last_error: errorText,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", key);
      if (error) throw error;
    },
    async setMediaPath(org, key, path) {
      // `coalesce` não existe no builder do supabase-js para update — lê
      // primeiro, decide, grava; a janela é a mesma "concorrência não
      // realista" documentada em `pgSendLedger.setMediaPath`.
      const atual = await db
        .from("send_ledger")
        .select("media_storage_path")
        .eq("organization_id", org)
        .eq("id", key)
        .maybeSingle();
      if (atual.error) throw atual.error;
      if (atual.data?.media_storage_path) return atual.data.media_storage_path as string;
      const { data, error } = await db
        .from("send_ledger")
        .update({ media_storage_path: path, updated_at: new Date().toISOString() })
        .eq("organization_id", org)
        .eq("id", key)
        .select("media_storage_path")
        .single();
      if (error) throw error;
      return data.media_storage_path as string;
    },
  };
}
/** Resultado do turno sem importar runtime/env; ausência de envio é terminal explícito. */
export async function resultadoDoEnvioDoFollowup(
  db: Queryable,
  org: string,
  job: string,
): Promise<{ kind: "sent" } | { kind: "skipped"; reason: string }> {
  const { rows } = await db.query<{ status: string }>(
    "select status from send_ledger where organization_id=$1 and job_id=$2",
    [org, job],
  );
  if (!rows.length)
    return {
      kind: "skipped",
      reason: "O assistente concluiu este passo sem enviar uma mensagem. Revise o próximo passo.",
    };
  if (rows.every((row) => row.status === "vetoed"))
    return { kind: "skipped", reason: "O envio foi recusado pelas regras do atendimento." };
  if (rows.some((row) => row.status !== "accepted")) throw new Error("followup_message_not_sent");
  return { kind: "sent" };
}

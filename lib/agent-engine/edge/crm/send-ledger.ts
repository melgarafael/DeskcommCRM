import { ApiError } from "@/lib/api/types";
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
type Intent = { tenantId: string; leadId: string | null; jobId: string; seq: number; body: string };
type Row = { id: string; status: SendLedgerStatus; crm_message_id: string | null };
interface LedgerStore {
  create(input: Intent, hash: string): Promise<string>;
  find(input: Intent): Promise<Row | null>;
  rotate(input: Intent, hash: string): Promise<string>;
  message(org: string, key: string): Promise<{ id: string; status: string } | null>;
  update(
    org: string,
    key: string,
    status: SendLedgerStatus,
    id: string | null,
    error: string | null,
  ): Promise<void>;
}
/** Inline e daemon compartilham identidade (job,seq), reconciliação e mensagem.
 * Página/worker perdido não cria uma segunda intenção. queued é reavaliado pelo
 * handler com o MESMO id; somente sent/delivered/read confirmam entrega. */
export async function sendWithLedger(
  store: LedgerStore,
  input: Intent,
  send: (key: string, messageId: string) => Promise<{ id: string; status: string }>,
): Promise<SendOutcome> {
  const hash = createHash("sha256").update(input.body).digest("hex");
  let key: string;
  try {
    key = await store.create(input, hash);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "23505"))
      throw error;
    const prior = await store.find(input);
    if (!prior) throw new Error("send_ledger_missing");
    key = prior.id;
    if (prior.status === "accepted")
      return { kind: "already_sent", idempotencyKey: key, crmMessageId: prior.crm_message_id };
    if (prior.status === "vetoed") return { kind: "blocked", idempotencyKey: key };
    if (prior.status === "failed") key = await store.rotate(input, hash);
  }
  const existing = await store.message(input.tenantId, key);
  let message = existing;
  if (!message || message.status === "queued") {
    try {
      message = await send(key, existing?.id ?? key);
    } catch (error) {
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
      const { rows } = await db.query<{ id: string }>(
        "update send_ledger set id=gen_random_uuid(),status='requested',body_hash=$4,crm_message_id=null,last_error=null,updated_at=now() where organization_id=$1 and job_id=$2 and seq=$3 returning id",
        [i.tenantId, i.jobId, i.seq, hash],
      );
      if (!rows[0]) throw new Error("send_ledger_rotation_missing");
      return rows[0].id;
    },
    async message(org, key) {
      const { rows } = await db.query<{ id: string; status: string }>(
        "select id,status from messages where organization_id=$1 and metadata->>'idempotency_key'=$2 limit 1",
        [org, key],
      );
      return rows[0] ?? null;
    },
    async update(org, key, status, id, error) {
      await db.query(
        "update send_ledger set status=$3,crm_message_id=coalesce($4,crm_message_id),last_error=$5,updated_at=now() where organization_id=$1 and id=$2",
        [org, key, status, id, error],
      );
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
        .select("id,status,crm_message_id")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async rotate(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .update({
          id: crypto.randomUUID(),
          status: "requested",
          body_hash: hash,
          crm_message_id: null,
          last_error: null,
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

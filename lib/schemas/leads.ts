/**
 * Zod schemas for `/api/v1/leads/*` endpoints (EPIC-04 waves 1-3).
 *
 * Contracts:
 *  - moveLeadSchema   → POST /api/v1/leads/[id]/move (P-01, P-05, P-08)
 *  - winLeadSchema    → POST /api/v1/leads/[id]/win  (P-02, idempotent)
 *  - loseLeadSchema   → POST /api/v1/leads/[id]/lose (P-02, P-03)
 *  - bulkLeadActionSchema → POST /api/v1/leads/bulk  (AT-06, max 50)
 */
import { z } from "zod";

/**
 * Accept either ISO 8601 (e.g. "2026-04-29T03:15:54.000Z") or Postgres-style
 * timestamptz (e.g. "2026-04-29 03:15:54.123456+00") since Supabase returns
 * the latter and the client passes it through. Both parse to the same Date.
 */
const flexibleTimestamp = z
  .string()
  .min(10)
  .refine((s) => !Number.isNaN(Date.parse(s)), "expected_updated_at deve ser um timestamp válido");

export const moveLeadSchema = z.object({
  stage_id: z.string().uuid(),
  position_in_stage: z.number().finite(),
  expected_updated_at: flexibleTimestamp,
});
export type MoveLeadInput = z.infer<typeof moveLeadSchema>;

export const winLeadSchema = z.object({}).passthrough();
export type WinLeadInput = z.infer<typeof winLeadSchema>;

/**
 * Canonical lost reasons enforced by DB trigger fn_validate_lost_reason_required.
 * Pipeline.settings.lost_reasons (jsonb array) can extend this list per-tenant.
 */
export const CANONICAL_LOST_REASONS = [
  "requested_by_customer",
  "price",
  "no_response",
  "product_unavailable",
  "cancelled_by_store",
  "cancelled_by_customer",
  "payment_failed",
  "other",
] as const;
export type CanonicalLostReason = (typeof CANONICAL_LOST_REASONS)[number];

/**
 * loseLeadSchema accepts canonical reasons OR any string (pipeline-extended).
 * The server-side DB trigger is the source of truth; we keep the Zod schema
 * permissive here to not block tenant-specific extensions.
 */
export const loseLeadSchema = z.object({
  lost_reason: z.string().min(1, "lost_reason é obrigatório").max(500),
});
export type LoseLeadInput = z.infer<typeof loseLeadSchema>;

/**
 * createLeadSchema → POST /api/v1/leads
 * Status, source_metadata, custom_fields, position_in_stage are server-managed.
 */
export const createLeadSchema = z.object({
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  value_cents: z.coerce.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).default("BRL"),
  owner_user_id: z.string().uuid().nullable().optional(),
  /** Dono agente já na criação (0070) — mesma regra do update: os dois é 422. */
  owner_agent_id: z.string().uuid().nullable().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string()).default([]),
  source: z.string().min(1).default("manual"),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * updateLeadSchema → PATCH /api/v1/leads/[id]
 * Stage/pipeline transitions go through /move /win /lose endpoints.
 */
export const updateLeadSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  value_cents: z.coerce.number().int().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  owner_user_id: z.string().uuid().nullable().optional(),
  /**
   * Dono agente (0070). Exclusivo com owner_user_id — mandar os dois não-nulos
   * é 422. `owner_kind` NÃO entra aqui: é derivado no handler a partir de qual
   * dos dois veio, para a constraint crm_leads_owner_kind_coherence nunca
   * depender do que o cliente mandou.
   */
  owner_agent_id: z.string().uuid().nullable().optional(),
  expected_close_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const bulkLeadActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    // Sem `position_in_stage`: quem posiciona o lote é o banco
    // (`fn_mover_leads_em_lote`, migration 0209), porque N cards precisam de N
    // posições distintas e um campo escalar só sabe dizer uma. Um cliente antigo
    // que ainda o mande não quebra — `z.object` descarta chave desconhecida —,
    // e é melhor que ele suma do que ficar aceito e ignorado.
    params: z.object({
      stage_id: z.string().uuid(),
    }),
  }),
  z.object({
    action: z.literal("assign"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({ owner_user_id: z.string().uuid().nullable() }),
  }),
  z.object({
    action: z.literal("tag"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    action: z.literal("delete"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({}).optional(),
  }),
]);
export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;

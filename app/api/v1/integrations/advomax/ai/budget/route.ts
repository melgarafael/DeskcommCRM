import { randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { AVISO_CORPO, AVISO_TITULO, BLOQUEIO_TITULO, corpoDoBloqueio, decidirOrcamento, LIMIAR_PADRAO_PCT, normalizarChaveDeOrcamento, normalizarModoDeOrcamento } from "@/lib/agent-engine/edge/llm/orcamento";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const schema = z.object({ organizationId: z.string().uuid(), empresaCodigo: z.coerce.number().int().positive(), purpose: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(120), externalRequestId: z.string().uuid(), estimatedInputTokens: z.coerce.number().int().min(0).max(2_000_000), maxOutputTokens: z.coerce.number().int().min(1).max(100_000) });
function secret(value: string | null) { const expected = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim(); if (!expected || !value) return false; const a = Buffer.from(value), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!secret(req.headers.get("X-CRM-Integration-Key"))) return fail("unauthorized", "Credencial inválida.", 401, { requestId });
  const parsed = schema.safeParse({ organizationId: req.headers.get("X-CRM-Organization-Id"), empresaCodigo: req.headers.get("X-Advomax-Empresa-Codigo"), purpose: req.nextUrl.searchParams.get("purpose"), model: req.nextUrl.searchParams.get("model"), externalRequestId: req.nextUrl.searchParams.get("external_request_id"), estimatedInputTokens: req.nextUrl.searchParams.get("estimated_input_tokens"), maxOutputTokens: req.nextUrl.searchParams.get("max_output_tokens") });
  if (!parsed.success) return fail("validation_failed", "Escopo inválido.", 422, { requestId });
  const admin = createAdminClient(); const orgId = parsed.data.organizationId;
  const { data: org } = await admin.from("organizations" as never).select("id").eq("id", orgId).eq("status", "active").eq("advomax_empresa_codigo", parsed.data.empresaCodigo).maybeSingle();
  if (!org) return fail("forbidden", "Escritório sem vínculo ativo.", 403, { requestId });
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const [budget, spent, warned] = await Promise.all([
    admin.from("ai_budgets").select("monthly_limit_cents,alarm_threshold_pct,enforcement_mode,enforcement_effective_at").eq("organization_id", orgId).maybeSingle(),
    admin.rpc("fn_gasto_de_ia_do_mes", { p_org: orgId }),
    admin.from("agent_inbox_items").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("kind", "budget_warning").gte("created_at", month.toISOString()),
  ]);
  if (budget.error || spent.error || warned.error) return fail("budget_unavailable", "Não foi possível validar o orçamento de IA.", 503, { requestId });
  const row = budget.data as { monthly_limit_cents?: number; alarm_threshold_pct?: number; enforcement_mode?: string; enforcement_effective_at?: string | null } | null;
  const modo = normalizarModoDeOrcamento(row?.enforcement_mode);
  if (modo === "bloquear" && row?.enforcement_effective_at && new Date(row.enforcement_effective_at) <= new Date() && costCents(parsed.data.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) === null) {
    return ok({ allowed: false, reason: "unpriced_model" }, { requestId });
  }
  const verdict = decidirOrcamento({ modo, tetoCents: Number(row?.monthly_limit_cents ?? 0), gastoCents: Number(spent.data ?? 0), efetivoEm: row?.enforcement_effective_at ? new Date(row.enforcement_effective_at) : null, agora: new Date(), purpose: `advomax:${parsed.data.purpose}`, chave: normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT), limiarPct: Number(row?.alarm_threshold_pct ?? LIMIAR_PADRAO_PCT), avisadoNesteMes: (warned.count ?? 0) > 0 });
  if (verdict.acao === "avisar_e_seguir") await admin.from("agent_inbox_items").insert({ organization_id: orgId, kind: "budget_warning", severity: "warn", title: AVISO_TITULO, body: AVISO_CORPO } as never);
  if (verdict.acao === "bloquear") await admin.from("agent_inbox_items").insert({ organization_id: orgId, kind: "budget_exceeded", severity: "critical", title: BLOQUEIO_TITULO, body: corpoDoBloqueio(Number(spent.data ?? 0), Number(row?.monthly_limit_cents ?? 0)), ref_kind: "ai_budget", ref_id: orgId } as never);
  if (verdict.acao === "bloquear") return ok({ allowed: false, reason: verdict.porque }, { requestId });
  const estimatedCost = costCents(parsed.data.model, { inputTokens: parsed.data.estimatedInputTokens, outputTokens: parsed.data.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const { data: reservation, error: reservationError } = await admin.rpc("fn_reservar_orcamento_advomax_ia" as never, { p_org: orgId, p_external_request_id: parsed.data.externalRequestId, p_purpose: `advomax:${parsed.data.purpose}`, p_provider: "DEEPSEEK", p_model: parsed.data.model, p_estimated_cost_cents: estimatedCost } as never);
  if (reservationError) return fail("budget_unavailable", "Não foi possível reservar o orçamento de IA.", 503, { requestId });
  const result = (Array.isArray(reservation) ? reservation[0] : reservation) as { allowed?: boolean; reason?: string; idempotent?: boolean } | null;
  return ok({ allowed: result?.allowed === true, reason: result?.reason ?? "reservation_failed", idempotent: result?.idempotent === true, external_request_id: parsed.data.externalRequestId }, { requestId });
}

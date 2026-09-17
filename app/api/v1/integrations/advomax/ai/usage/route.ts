import { randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const headersSchema = z.object({ organizationId: z.string().uuid(), empresaCodigo: z.coerce.number().int().positive() });
const bodySchema = z.object({
  external_request_id: z.string().trim().min(8).max(180), purpose: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(180),
  input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0).default(0), cache_write_tokens: z.number().int().min(0).default(0),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
}).strict();

function segredoValido(value: string | null) {
  const expected = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim();
  if (!expected || !value) return false;
  const a = Buffer.from(value); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!segredoValido(req.headers.get("X-CRM-Integration-Key"))) return fail("unauthorized", "Credencial inválida.", 401, { requestId });
  const headers = headersSchema.safeParse({ organizationId: req.headers.get("X-CRM-Organization-Id"), empresaCodigo: req.headers.get("X-Advomax-Empresa-Codigo") });
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!headers.success || !body.success) return fail("validation_failed", "Escopo ou consumo inválido.", 422, { requestId });
  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin.from("organizations" as never).select("id").eq("id", headers.data.organizationId).eq("status", "active").eq("advomax_empresa_codigo", headers.data.empresaCodigo).maybeSingle();
  if (orgError) return fail("internal_error", "Não foi possível validar o escritório.", 500, { requestId });
  if (!org) return fail("forbidden", "Escritório sem vínculo ativo.", 403, { requestId });
  const usage = body.data;
  const cost = costCents(usage.model, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_tokens, cacheWriteTokens: usage.cache_write_tokens });
  const { data: inserted, error } = await admin.rpc("fn_finalizar_advomax_ia" as never, {
    p_org: headers.data.organizationId, p_external_request_id: usage.external_request_id,
    p_purpose: `advomax:${usage.purpose}`, p_provider: usage.provider, p_model: usage.model,
    p_input_tokens: usage.input_tokens, p_output_tokens: usage.output_tokens,
    p_cache_read_tokens: usage.cache_read_tokens, p_cache_write_tokens: usage.cache_write_tokens,
    p_latency_ms: usage.latency_ms ?? null, p_cost_cents: cost,
  } as never);
  if (error) return fail("internal_error", "Não foi possível finalizar o consumo reservado.", 500, { requestId });
  return ok({ recorded: true, idempotent: inserted !== true, cost_known: cost !== null }, { status: inserted === true ? 201 : 200, requestId });
}

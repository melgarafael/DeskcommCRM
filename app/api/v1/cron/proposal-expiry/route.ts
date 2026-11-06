/**
 * Cron diário: propostas ENVIADAS cujo valid_until passou sem decisão viram
 * VENCIDAS e abrem aviso na Central. Mesmo padrão de
 * recover-stuck-messages/route.ts (lógica pura separada do handler HTTP,
 * ok()/fail() como wrapper, audit() só quando houve efeito).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";
import { FUSO_PADRAO, fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

/**
 * O que roda DEPOIS do portão do piso ocioso (#3731), na ordem do arquivo.
 * `tests/unit/cron-passa-pelo-portao.test.ts` compara esta lista com o AST
 * deste arquivo e reprova, com linha, o passo que ninguém declarou.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let result",
  "try",
  "if (result.vencidas > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

interface PropostaParaVerificar {
  id: string; organization_id: string; lead_id: string; contact_id: string;
  status: string; valid_until: string | null;
}

export function encontrarPropostasVencidas(
  propostas: readonly PropostaParaVerificar[],
  agora: Date,
  fusoPorOrganizacao: ReadonlyMap<string, string>,
): PropostaParaVerificar[] {
  return propostas.filter((p) => {
    if (p.status !== "enviada" || p.valid_until === null) return false;
    const fuso = fusoPorOrganizacao.get(p.organization_id) ?? FUSO_PADRAO;
    const hoje = dataIsoNoFuso(agora, fuso);
    return p.valid_until < hoje;
  });
}

export interface VencimentoResult { vencidas: number }

async function rodarVencimento(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
): Promise<VencimentoResult> {
  const { data: candidatas, error: selErr } = await admin
    .from("crm_proposals")
    .select("id, organization_id, lead_id, contact_id, status, valid_until")
    .eq("status", "enviada")
    .not("valid_until", "is", null);
  if (selErr) throw new Error(`query_failed: ${selErr.message}`);

  const orgIds = [...new Set((candidatas ?? []).map((p) => p.organization_id))];
  const fusoPorOrganizacao = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs } = await admin.from("organizations").select("id, timezone").in("id", orgIds);
    for (const o of (orgs ?? []) as Array<{ id: string; timezone: string | null }>) {
      fusoPorOrganizacao.set(o.id, fusoUtilizavel(o.timezone));
    }
  }
  const vencidas = encontrarPropostasVencidas(candidatas ?? [], new Date(), fusoPorOrganizacao);
  if (vencidas.length === 0) return { vencidas: 0 };

  for (const p of vencidas) {
    const { error: updErr } = await admin
      .from("crm_proposals")
      .update({ status: "vencida" })
      .eq("organization_id", p.organization_id)
      .eq("id", p.id)
      .eq("status", "enviada"); // claim atomico — se ja decidiram entre o select e aqui, nao sobrescreve
    if (updErr) {
      logger.error("[proposal-expiry] update falhou", { error: updErr.message, proposal_id: p.id, requestId });
      continue;
    }

    await emitLeadActivity(admin, {
      organizationId: p.organization_id, leadId: p.lead_id, contactId: p.contact_id,
      type: "proposal_expired", sourceModule: "proposals", sourceId: p.id,
      actor: { type: "api_token", id: "cron:proposal-expiry" },
      reason: "Proposta venceu sem decisão do cliente",
    });

    // Dedupe: não abre um segundo aviso se já existe um aberto para esta proposta.
    const { data: existente } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", p.organization_id)
      .eq("kind", "proposal_expired_notice")
      .eq("ref_id", p.id)
      .eq("status", "open")
      .maybeSingle();
    if (!existente) {
      const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
        organization_id: p.organization_id,
        kind: "proposal_expired_notice",
        severity: "warn",
        title: "Uma proposta venceu sem decisão do cliente",
        body: "O prazo de validade passou e ninguém marcou aceite ou recusa. Reveja a proposta e decida os próximos passos com o cliente.",
        ref_kind: "proposal",
        ref_id: p.id,
      });
      if (inboxErr) {
        logger.error("[proposal-expiry] aviso na Central falhou", { error: inboxErr.message, proposal_id: p.id, requestId });
      }
    }
  }

  return { vencidas: vencidas.length };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // Sem proposta ENVIADA com validade não há vencimento a processar: a rodada
  // diária ia ao PostgREST varrer `enviada` para não achar nada.
  if (await recursoOcioso("propostas_a_vencer")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let result: VencimentoResult;
  try {
    result = await rodarVencimento(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[proposal-expiry] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to expire proposals.", 500, { requestId });
  }

  // Rodada que nao venceu nada NAO e mutacao e nao audita (CLAUDE.md, mesmo
  // criterio de recover-stuck-messages) — a que venceu, audita.
  if (result.vencidas > 0) {
    void audit({
      action: "proposal.expired_batch", organizationId: null, bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>, requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

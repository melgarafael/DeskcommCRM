import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { modulosLigados, type ModuloOpcional } from "@/lib/instalacao/modulos";
import { capacidadesLigadas } from "@/lib/organizacao/capacidades";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const PISO_DE_ACEITE = 0.3;
const MINIMO_DE_DECISOES = 5; // abaixo disso, 30% de 1 proposta não significa nada

export function calcularTaxaDeAceite(propostas: readonly { status: string }[]): number | null {
  const decididas = propostas.filter((p) => p.status === "aceita" || p.status === "recusada");
  if (decididas.length < MINIMO_DE_DECISOES) return null;
  const aceitas = decididas.filter((p) => p.status === "aceita").length;
  return aceitas / decididas.length;
}

export interface TaxaDeAceiteResult { organizacoes_avisadas: number }

/** Só as organizações que ligaram Propostas entram na rodada do laço de retorno. */
export function organizacoesComPropostas(
  orgs: { id: string; settings: unknown }[],
  modulos: readonly ModuloOpcional[],
): string[] {
  return orgs.filter((o) => capacidadesLigadas(o.settings, modulos).includes("propostas")).map((o) => o.id);
}

async function rodar(admin: ReturnType<typeof createAdminClient>, requestId: string): Promise<TaxaDeAceiteResult> {
  const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgs, error: orgsErr } = await admin.from("organizations").select("id, settings");
  if (orgsErr) throw new Error(`query_orgs_failed: ${orgsErr.message}`);

  let avisadas = 0;
  for (const orgId of organizacoesComPropostas(orgs ?? [], await modulosLigados(admin))) {
    const org = { id: orgId };
    const { data: propostas, error: propErr } = await admin
      .from("crm_proposals")
      .select("status")
      .eq("organization_id", org.id)
      .gte("sent_at", trintaDiasAtras)
      .not("sent_at", "is", null);
    if (propErr) {
      logger.error("[proposal-acceptance-rate] query falhou", { error: propErr.message, organization_id: org.id, requestId });
      continue;
    }

    const taxa = calcularTaxaDeAceite(propostas ?? []);
    if (taxa === null || taxa >= PISO_DE_ACEITE) continue;

    const { data: existente } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", org.id)
      .eq("kind", "proposal_acceptance_rate_drop")
      .eq("status", "open")
      .maybeSingle();
    if (!existente) {
      const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
        organization_id: org.id, kind: "proposal_acceptance_rate_drop", severity: "warn",
        title: "La tasa de aceptación de propuestas bajó",
        body: `El ${Math.round(taxa * 100)}% de las propuestas decididas en los últimos 30 días fueron aceptadas — por debajo del piso de ${Math.round(PISO_DE_ACEITE * 100)}%.`,
      });
      if (inboxErr) {
        logger.error("[proposal-acceptance-rate] aviso na Central falhou", { error: inboxErr.message, organization_id: org.id, requestId });
        continue;
      }
      avisadas++;
    }
  }
  return { organizacoes_avisadas: avisadas };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: TaxaDeAceiteResult;
  try {
    result = await rodar(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[proposal-acceptance-rate] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to check acceptance rate.", 500, { requestId });
  }

  if (result.organizacoes_avisadas > 0) {
    void audit({
      action: "proposal.acceptance_rate_batch", organizationId: null, bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>, requestId,
    });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> { return handle(req); }
export async function POST(req: NextRequest): Promise<Response> { return handle(req); }

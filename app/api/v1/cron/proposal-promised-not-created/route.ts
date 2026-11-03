/**
 * Fecha o sinal que originou a spec inteira: uma promessa de proposta
 * (Tarefa 1) vence sem que NENHUMA proposta tenha sido criada para aquele
 * negócio depois da promessa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { capacidadesLigadas } from "@/lib/organizacao/capacidades";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskSourceKind } from "@/lib/tarefas/vocabulario-de-origem";

export const dynamic = "force-dynamic";
const PROMISED_PROPOSAL: TaskSourceKind = "promised_proposal";

interface TarefaPromessa {
  id: string; organization_id: string; lead_id: string | null; source_kind: string | null;
  due_date: string | null; status: string; created_at: string;
}
interface PropostaMinima { id: string; organization_id: string; lead_id: string; created_at: string }

export function encontrarPromessasSemProposta(
  input: {
    tarefas: readonly TarefaPromessa[];
    propostas: readonly PropostaMinima[];
    /** Organizações com Propostas ligada — as outras não recebem aviso. */
    orgsLigadas: ReadonlySet<string>;
  },
  agora: Date,
): TarefaPromessa[] {
  return input.tarefas.filter((t) => {
    if (!input.orgsLigadas.has(t.organization_id)) return false;
    if (t.source_kind !== PROMISED_PROPOSAL) return false;
    if (t.status !== "pending") return false;
    if (t.lead_id === null) return false;
    if (t.due_date === null || new Date(t.due_date) >= agora) return false;
    const temProposta = input.propostas.some(
      (p) => p.lead_id === t.lead_id && p.organization_id === t.organization_id && p.created_at >= t.created_at,
    );
    return !temProposta;
  });
}

export interface PromessaSemPropostaResult { sinalizadas: number }

async function rodar(admin: ReturnType<typeof createAdminClient>, requestId: string): Promise<PromessaSemPropostaResult> {
  const { data: tarefas, error: tarefasErr } = await admin
    .from("crm_tasks")
    .select("id, organization_id, lead_id, source_kind, due_date, status, created_at")
    .eq("source_kind", PROMISED_PROPOSAL)
    .eq("status", "pending");
  if (tarefasErr) throw new Error(`query_tarefas_failed: ${tarefasErr.message}`);

  const { data: propostas, error: propostasErr } = await admin
    .from("crm_proposals")
    .select("id, organization_id, lead_id, created_at");
  if (propostasErr) throw new Error(`query_propostas_failed: ${propostasErr.message}`);

  const { data: orgs, error: orgsErr } = await admin.from("organizations").select("id, settings");
  if (orgsErr) throw new Error(`query_orgs_failed: ${orgsErr.message}`);
  const modulos = await modulosLigados(admin);
  const orgsLigadas = new Set(
    (orgs ?? []).filter((o) => capacidadesLigadas(o.settings, modulos).includes("propostas")).map((o) => o.id),
  );

  const achadas = encontrarPromessasSemProposta(
    { tarefas: tarefas ?? [], propostas: propostas ?? [], orgsLigadas },
    new Date(),
  );
  for (const t of achadas) {
    const { data: existente } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", t.organization_id)
      .eq("kind", "proposal_promised_not_created")
      .eq("ref_id", t.lead_id as string)
      .eq("status", "open")
      .maybeSingle();
    if (!existente) {
      const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
        organization_id: t.organization_id, kind: "proposal_promised_not_created", severity: "warn",
        title: "Una propuesta prometida no fue creada",
        body: "Un compromiso de enviar una propuesta venció y no se creó ninguna propuesta para este negocio.",
        ref_kind: "lead", ref_id: t.lead_id,
      });
      if (inboxErr) {
        logger.error("[proposal-promised-not-created] aviso na Central falhou", { error: inboxErr.message, task_id: t.id, requestId });
      }
    }
  }
  return { sinalizadas: achadas.length };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: PromessaSemPropostaResult;
  try {
    result = await rodar(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[proposal-promised-not-created] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to check promised proposals.", 500, { requestId });
  }

  if (result.sinalizadas > 0) {
    void audit({
      action: "proposal.promise_not_created_batch", organizationId: null, bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>, requestId,
    });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> { return handle(req); }
export async function POST(req: NextRequest): Promise<Response> { return handle(req); }

/**
 * GET/POST /api/v1/cron/proposta-travada — D3.
 *
 * Proposta entra em `enviando` ao ter o número alocado (send/route.ts). Se o
 * processo morrer entre a alocação e a resposta do WhatsApp, a linha fica
 * `enviando` para sempre — o mesmo defeito que `recover-stuck-messages`
 * (issue #129) resolveu para mensagem, aqui para proposta.
 *
 *   - volta `rascunho` toda proposta `enviando` mais velha que 5 min,
 *     RETENDO numero/ano (o número já foi reservado; devolver o abriria
 *     buraco na sequência) e gravando `ultima_falha_envio`;
 *   - abre UM aviso por organização por rodada (`agent_inbox_items`, kind
 *     `proposta_travada`, migration 0401);
 *   - não reenvia nada — mesma doutrina do `recover-stuck-messages`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { MOTIVO_DO_PULO, recursoLigado } from "@/lib/cron/recursos-ligados";

export const dynamic = "force-dynamic";

export const STUCK_AFTER_MS = 5 * 60 * 1000;
const SCAN_LIMIT = 500;

interface PropostaTravada {
  id: string;
  organization_id: string;
  message_id: string | null;
}

export interface RecuperarResult {
  scanned: number;
  revertidas: number;
  organizations: number;
}

export async function recuperarPropostasTravadas(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RecuperarResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

  const { data, error } = await admin
    .from("crm_proposals")
    .select("id, organization_id, message_id")
    .eq("status", "enviando")
    .lt("updated_at", cutoff)
    .limit(SCAN_LIMIT);
  if (error) throw new Error(`query_failed: ${error.message}`);

  const travadas = (data ?? []) as PropostaTravada[];
  if (travadas.length === 0) return { scanned: 0, revertidas: 0, organizations: 0 };

  // `queued` (canal sem credencial; o agent-engine reagenda por
  // SEND_QUEUED_RETRY_MS) NÃO é presa de verdade — a mensagem ainda vai sair
  // sozinha. Reverter aqui derrubaria um envio que só está demorando, e o
  // próximo clique em "Enviar" mandaria a mesma proposta duas vezes (I1).
  // Sem `message_id`: o processo morreu antes de sequer tentar — essa É a
  // presa de verdade, revertida sem checar mensagem nenhuma.
  const idsDeMensagem = travadas.map((p) => p.message_id).filter((id): id is string => id !== null);
  const statusPorMensagem = new Map<string, string>();
  if (idsDeMensagem.length > 0) {
    const { data: mensagens, error: msgErr } = await admin.from("messages").select("id, status").in("id", idsDeMensagem);
    if (msgErr) throw new Error(`query_messages_failed: ${msgErr.message}`);
    for (const m of (mensagens ?? []) as Array<{ id: string; status: string }>) statusPorMensagem.set(m.id, m.status);
  }
  const elegiveis = travadas.filter((p) => statusPorMensagem.get(p.message_id ?? "") !== "queued");

  const porOrg = new Map<string, PropostaTravada[]>();
  for (const p of elegiveis) porOrg.set(p.organization_id, [...(porOrg.get(p.organization_id) ?? []), p]);

  let revertidas = 0;
  let organizacoesComAviso = 0;

  for (const [orgId, props] of porOrg) {
    // `.eq("status", "enviando")` no UPDATE é o claim atômico: se a mensagem
    // confirmou entre o SELECT e o UPDATE, a linha já não está `enviando` e
    // não é tocada — sem isso, o cron reverteria um envio que na verdade
    // chegou ao cliente.
    const { data: updated, error: updErr } = await admin
      .from("crm_proposals")
      .update({
        status: "rascunho",
        ultima_falha_envio: `Envio não confirmado em ${STUCK_AFTER_MS / 60000} min — devolvida a rascunho por proposta-travada.`,
      })
      .in("id", props.map((p) => p.id))
      .eq("status", "enviando")
      .select("id");

    if (updErr) {
      logger.error("[proposta-travada] update falhou", { error: updErr.message, organization_id: orgId, requestId });
      continue;
    }
    const n = (updated ?? []).length;
    if (n === 0) continue;
    revertidas += n;
    organizacoesComAviso += 1;

    const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
      organization_id: orgId,
      kind: "proposta_travada",
      severity: "critical",
      title: n === 1 ? "Uma proposta não confirmou o envio" : `${n} propostas não confirmaram o envio`,
      body:
        `Ficaram mais de ${STUCK_AFTER_MS / 60000} minutos em envio e voltaram a rascunho, com o número mantido. ` +
        `Verifique a conexão do WhatsApp e reenvie manualmente — nada foi reenviado sozinho.`,
      // "proposal" é a chave de `REFERENCIAS_DE_AVISO` (lib/ai/inbox-destino.ts)
      // — não o nome da tabela. Errar aqui faz o botão "Abrir proposta" nunca
      // aparecer (falha fechada, sem erro visível).
      ref_kind: "proposal",
      ref_id: props[0]?.id ?? null,
    });
    if (inboxErr) {
      logger.error("[proposta-travada] aviso na Central falhou", { error: inboxErr.message, organization_id: orgId, requestId });
    }
  }

  return { scanned: travadas.length, revertidas, organizations: organizacoesComAviso };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();

  // #3694: instalação sem NENHUMA proposta em `enviando` saía vazia 117 de 117
  // vezes. A sonda é a mesma condição da consulta abaixo (`status = 'enviando'`)
  // — o corte de 5 min continua sendo da rodada real, porque a sonda sem ele é
  // mais larga (a proposta recém-enviada também a liga). Esperar o TTL de 45 s
  // aqui não custa nada: a proposta só é "presa" depois de 5 min.
  if (!(await recursoLigado(admin, "propostas"))) {
    return ok({ scanned: 0, revertidas: 0, organizations: 0, pulado: MOTIVO_DO_PULO }, { requestId });
  }

  let result: RecuperarResult;
  try {
    result = await recuperarPropostasTravadas(admin, new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[proposta-travada] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to recover stuck proposals.", 500, { requestId });
  }

  if (result.revertidas > 0) {
    void audit({
      action: "proposal.recovered_from_stuck", organizationId: null, bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>, requestId,
    });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> { return handle(req); }
export async function POST(req: NextRequest): Promise<Response> { return handle(req); }

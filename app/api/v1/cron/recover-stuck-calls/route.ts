/**
 * GET/POST /api/v1/cron/recover-stuck-calls — a ligação que ficou "tocando".
 *
 * Toda ligação nasce em `voice_calls` como `starting` (saída) ou `ringing`
 * (entrada) e só sai desse estado quando quem a acompanha registra o fim: a
 * ponte de eventos do WaCalls (`lib/wacalls/events-bridge.ts`) ou o worker de
 * voz SIP (`workers/voice-agent/index.ts`, `handleChannelDestroyed`). Quando esse
 * fim se perde — evento que não chegou, worker reiniciado no meio, ou o canal
 * SIP que caiu antes de o AudioSocket conectar (medido numa VPS em 2026-11-04,
 * cinco linhas presas) — a linha fica aberta PARA SEMPRE. O painel de voz
 * (`hooks/voice/useVoiceCallSession.ts`) adota no boot a mais recente que não
 * está `ended`, e quem abre o CRM vê o banner de "ligação chegando" sem ninguém
 * ligar.
 *
 * O que ele faz, e o que deliberadamente NÃO faz:
 *
 *   - encerra (`ended`, `end_reason = 'timeout'`) toda ligação `starting` ou
 *     `ringing` criada há mais de 5 min. Nenhum toque real dura isso: provedor
 *     SIP e WhatsApp desistem em cerca de um minuto. `timeout` é o mesmo motivo
 *     que o worker SIP grava quando o canal cai tocando, e o que
 *     `lib/cold-call/regras.ts` lê como "sem resposta";
 *   - **não toca em `connected`.** Ligação em andamento pode durar uma hora, e
 *     não há prazo que separe a longa da presa sem olhar o canal;
 *   - não abre aviso na Central. O aviso de ligação perdida
 *     (`voice_call_missed`) é aberto por quem encerra a ligação no caminho
 *     normal; abri-lo só aqui faria a mesma ligação perdida avisar ou não
 *     conforme o caminho que a fechou.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Agendado no serviço `scheduler`
 * (`docker/scheduler/entrypoint.sh`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Mesmo prazo do `recover-stuck-messages`; muito acima de qualquer toque real. */
export const STUCK_CALL_AFTER_MS = 5 * 60 * 1000;

/** Estados que só existem ANTES de alguém atender. */
export const STATUS_DE_TOQUE = ["starting", "ringing"] as const;

/** Teto por invocação — a rodada seguinte pega o resto. */
const SCAN_LIMIT = 500;

export interface RecoverCallsResult {
  scanned: number;
  ended: number;
  organizations: number;
}

/**
 * Separado do handler HTTP para o teste exercitar a REGRA sem montar
 * request/auth.
 */
export async function recoverStuckCalls(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RecoverCallsResult> {
  const cutoff = new Date(now.getTime() - STUCK_CALL_AFTER_MS).toISOString();

  // Corte por `created_at`, que ninguém reescreve. `started_at` da ponte do
  // WaCalls vem do relógio do upstream; medir pela coluna que outro código
  // escreve deixaria a idade da linha depender dele.
  const { data, error } = await admin
    .from("voice_calls")
    .select("id, organization_id")
    .in("status", [...STATUS_DE_TOQUE])
    .lt("created_at", cutoff)
    .limit(SCAN_LIMIT);

  if (error) throw new Error(`query_failed: ${error.message}`);

  const presas = (data ?? []) as { id: string; organization_id: string }[];
  if (presas.length === 0) return { scanned: 0, ended: 0, organizations: 0 };

  const porOrg = new Map<string, string[]>();
  for (const c of presas) porOrg.set(c.organization_id, [...(porOrg.get(c.organization_id) ?? []), c.id]);

  let encerradas = 0;
  let organizacoes = 0;

  for (const [orgId, ids] of porOrg) {
    // O filtro de status no UPDATE é o claim atômico: se a ligação foi
    // atendida (ou encerrada pelo caminho normal) entre o SELECT e o UPDATE,
    // ela já não está em toque e não é tocada.
    const { data: updated, error: updErr } = await admin
      .from("voice_calls")
      .update({ status: "ended", end_reason: "timeout", ended_at: now.toISOString() })
      .in("id", ids)
      .eq("organization_id", orgId)
      .in("status", [...STATUS_DE_TOQUE])
      .select("id");

    if (updErr) {
      logger.error("[recover-stuck-calls] update falhou", {
        error: updErr.message,
        organization_id: orgId,
        requestId,
      });
      continue;
    }

    const n = (updated ?? []).length;
    if (n === 0) continue;
    encerradas += n;
    organizacoes += 1;
    logger.info("[recover-stuck-calls] ligações presas encerradas", {
      organization_id: orgId,
      ended: n,
      requestId,
    });
  }

  return { scanned: presas.length, ended: encerradas, organizations: organizacoes };
}

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO, na ordem do arquivo.
 * `tests/unit/cron-passa-pelo-portao.test.ts` compara esta lista com o AST.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let result",
  "try",
  "if (result.ended > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // Sem ligação em toque antiga não há o que encerrar.
  if (await recursoOcioso("ligacao_presa")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let result: RecoverCallsResult;
  try {
    result = await recoverStuckCalls(createAdminClient(), new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[recover-stuck-calls] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to recover stuck calls.", 500, { requestId });
  }

  // Rodada que não encerrou nada não é mutação e não audita.
  if (result.ended > 0) {
    void audit({
      action: "voice.recover_stuck_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
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

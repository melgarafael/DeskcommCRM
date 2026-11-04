/**
 * GET/POST /api/v1/cron/snooze-watcher — Onda 5.3 (snooze por conversa).
 *
 * Varre conversas com `snooze_until` vencido (<= now). Para cada uma, limpa
 * o snooze SEMPRE (evita reprocessar no próximo tick). Se o lead NÃO
 * respondeu desde que o snooze foi criado (last_inbound_at <= snoozed_at, ou
 * nunca respondeu) e a conversa não está closed/archived, reabre
 * (status='open') e cria um aviso interno `snooze_expired` — nada é enviado
 * ao cliente.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O kit
 * self-host precisa agendar esta rota (ex.: a cada 5 min) no container
 * `scheduler` com o Bearer secret configurado — sem isso o snooze nunca
 * expira sozinho.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";

export const dynamic = "force-dynamic";

/** Max conversas processadas por invocação (safety cap). */
const SCAN_LIMIT = 200;

interface DueConversation {
  id: string;
  organization_id: string;
  snoozed_at: string | null;
  last_inbound_at: string | null;
  status: string;
}

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const admin",
  "const nowIso",
  "const {data, error}",
  "if (queryError)",
  "const conversations",
  "let reopened",
  "for (c of conversations)",
  "if (reopened > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): Uma conversa com soneca vencida é o único trabalho desta rodada.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("fila_de_soneca")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: due, error: queryError } = await admin
    .from("conversations")
    .select("id, organization_id, snoozed_at, last_inbound_at, status")
    .not("snooze_until", "is", null)
    .lte("snooze_until", nowIso)
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[snooze-watcher] query failed", { error: queryError.message, requestId });
    return fail("internal_error", "Failed to query conversations.", 500, { requestId });
  }

  const conversations = (due ?? []) as DueConversation[];
  let reopened = 0;

  for (const c of conversations) {
    // Comparar como Date, não string: dois timestamptz ISO com formatos sutilmente
    // diferentes (Z vs +00:00, frações de precisão distinta) quebrariam a ordem
    // lexicográfica — e esta comparação decide se a conversa reabre.
    const leadReplied = !!(
      c.last_inbound_at &&
      c.snoozed_at &&
      new Date(c.last_inbound_at).getTime() > new Date(c.snoozed_at).getTime()
    );
    const clear = { snooze_until: null, snoozed_at: null, snoozed_by_user_id: null };
    const willReopen = !leadReplied && c.status !== "closed" && c.status !== "archived";
    const fields = willReopen ? { ...clear, status: "open", last_message_at: nowIso } : clear;

    // O clear É o claim atômico: `.not("snooze_until","is",null)` garante que só
    // quem ainda vê o snooze não-nulo processa a row. Se dois ticks concorrentes
    // (double-schedule / curl manual durante o cron) leem a mesma row, só o
    // primeiro atualiza — o segundo recebe 0 linhas e pula, sem aviso duplicado.
    const { data: claimed } = await admin
      .from("conversations")
      .update(fields)
      .eq("id", c.id)
      .not("snooze_until", "is", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // outro tick já processou esta conversa

    if (willReopen) {
      await admin.from("agent_inbox_items").insert({
        organization_id: c.organization_id,
        kind: "snooze_expired",
        severity: "warn",
        title: "Lead não respondeu no prazo",
        ref_kind: "conversation",
        ref_id: c.id,
      });
      reopened++;
    }
  }

  // Ver comentário em followup-flow-worker: varredura que não reabriu nada não
  // é mutação, e não tem por que ocupar linha na auditoria.
  if (reopened > 0) {
    void audit({
      action: "conversation.snooze_watcher_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { scanned: conversations.length, reopened },
      requestId,
    });
  }

  return ok({ scanned: conversations.length, reopened }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

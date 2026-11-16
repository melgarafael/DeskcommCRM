/**
 * GET/POST /api/v1/cron/amigo-sync — o robô do módulo opcional `amigo` (#4227).
 *
 * A API do Amigo não tem webhook: a cada 5 minutos (agendado em
 * `docker/scheduler/entrypoint.sh`) uma conexão ativa por vez relê a agenda
 * (7 dias atrás até 90 à frente) e reconcilia as operações que ficaram incertas.
 * Nenhuma operação incerta é reenviada — só a evidência lá a conclui.
 *
 * ANTI-MORTE: a fila anda por `last_attempt_at`, então a conexão que falha vai
 * para o fim e tenta de novo na próxima volta, sem tirar a vez das outras; a
 * falha fica em `last_error`, que a tela de configuração mostra com o próximo
 * passo ("teste a conexão"), e vai ao log com a organização.
 *
 * Módulo desligado na instalação: a rodada sai antes de tocar em qualquer tabela.
 * Rodada que não mexeu em nada não audita (CLAUDE.md, seção de audit log).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { syncAmigo } from "@/lib/amigo/sync";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { STATUS_OPERANTE, ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const db = createAdminClient();
  if (!(await moduloLigado(db, "amigo"))) return ok({ pulado: "modulo_desligado" }, { requestId });

  const { data, error } = await db
    .from("amigo_connections")
    .select("organization_id,organizations!amigo_connections_organization_id_fkey!inner(status)")
    .eq("active", true)
    .eq("organizations.status", STATUS_OPERANTE)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${new Date(Date.now() - 240_000).toISOString()}`)
    .order("last_attempt_at", { nullsFirst: true })
    .limit(1);
  if (error) {
    logger.error("[amigo-sync] leitura das conexões falhou", { codigo: error.code, requestId });
    return fail("internal_error", "Failed to read Amigo connections.", 500, { requestId });
  }

  let examined = 0;
  let reconciled = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!ehOperante(org?.status)) continue;
    try {
      const result = await syncAmigo(row.organization_id, requestId);
      examined += result.examined;
      reconciled += result.reconciled;
      if (result.examined > 0 || result.reconciled > 0)
        void audit({
          action: "amigo.synced",
          organizationId: row.organization_id,
          bypassedRls: true,
          requestId,
          metadata: { examined: result.examined, reconciled: result.reconciled },
        });
    } catch {
      failed++;
      logger.warn("[amigo-sync] sincronização falhou; a conexão volta ao fim da fila", {
        organization_id: row.organization_id,
        requestId,
      });
    }
  }
  return ok({ examined, reconciled, failed }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

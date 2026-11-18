/**
 * GET/POST /api/v1/cron/media-leitura-adiada — a descrição volta para a foto
 * adiada quando a empresa ganha quem a leia.
 *
 * Com `MEDIA_VISION_WITHOUT_READER=defer` (o padrão), a foto de uma empresa sem
 * NENHUM leitor — nenhum agente com "ver as fotos" ligado, nenhuma integração —
 * fica guardada sem descrição (`metadata.derivacao_adiada`). O dreno do
 * turno a reabre na conversa em que um agente vai responder; quem lê FORA do
 * dreno — follow-up de silêncio, rascunho, caso, REST, MCP, valor para a Meta —
 * depende desta varredura. Uma empresa ganha leitor por muitos caminhos (agente,
 * token, fluxo, conexão de anúncio, modo, chave de venda); reabrir em cada um
 * seriam cinco ou mais pontos de chamada, e o primeiro esquecido perderia valor
 * em silêncio. Uma varredura cobre todos em até 5 min.
 *
 * Em `defer`, reabre só a foto dos últimos `JANELA_DO_CRON_DIAS` (7) dias: é até
 * onde um leitor fora do dreno alcança sozinho (o porquê está na constante).
 * Ligar a opção num agente não paga visão de meses de foto que ninguém abre; a
 * mais velha é descrita pelo dreno quando a conversa voltar.
 *
 * Com o knob em `always` (a válvula do operador), reabre TODA foto adiada, com ou
 * sem leitor e sem limite de idade: a volta atrás é completa. Até 100 por empresa
 * por rodada, das mais novas para as mais antigas, pelo MESMO worker (regra de
 * contato pessoal, teto de orçamento e linha de custo valem). Organização parada
 * fica de fora (`fn_org_operante`).
 *
 * Barata: uma consulta por rodada num índice parcial vazio na maioria das
 * instalações. Audita só a rodada que reabriu alguma foto.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET (fail-closed). Agendada
 * no `scheduler` (docker/scheduler/entrypoint.sh).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  adiarSemLeitorLigado,
  haLeitorDaDescricao,
  JANELA_DO_CRON_DIAS,
  LOTE_DE_REABERTURA,
  organizacoesComLeituraAdiada,
  reabrirLeituraAdiada,
} from "@/lib/messaging/media/leitura-adiada";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let pool: ReturnType<typeof getRequestPool>;
  let organizacoes: string[];
  try {
    pool = getRequestPool();
    organizacoes = await organizacoesComLeituraAdiada(pool);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[media-leitura-adiada] varredura falhou", { error: detalhe, requestId });
    return fail("internal_error", detalhe, 500, { requestId });
  }

  const travaLigada = adiarSemLeitorLigado(env.MEDIA_VISION_WITHOUT_READER);
  const porOrganizacao: Record<string, number> = {};
  let reabertas = 0;
  for (const organizationId of organizacoes) {
    // Uma empresa que falha não segura as outras: a rodada seguinte tenta de novo.
    try {
      if (travaLigada && !(await haLeitorDaDescricao(pool, organizationId))) continue;
      const n = await reabrirLeituraAdiada(pool, organizationId, {
        limite: LOTE_DE_REABERTURA,
        ...(travaLigada ? { maxIdadeDias: JANELA_DO_CRON_DIAS } : {}),
      });
      if (n > 0) {
        porOrganizacao[organizationId] = n;
        reabertas += n;
      }
    } catch (err) {
      logger.error("[media-leitura-adiada] reabertura falhou", {
        organization_id: organizationId,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  // Rodada que não reabriu nada não é mutação e não ocupa linha de auditoria.
  if (reabertas > 0) {
    void audit({
      action: "media.deferred_reading_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { reabertas, por_organizacao: porOrganizacao },
      requestId,
    });
  }

  return ok({ organizacoes: organizacoes.length, reabertas }, { requestId });
}

export const GET = handle;
export const POST = handle;

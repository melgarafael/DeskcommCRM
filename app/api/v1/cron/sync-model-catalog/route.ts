/**
 * GET/POST /api/v1/cron/sync-model-catalog — o catálogo que se atualiza sozinho.
 *
 * A OpenRouter publica ~400 modelos de ~58 fabricantes e a lista muda sozinha.
 * Até aqui, `ai_models` era semeada por migration: a cada modelo novo do
 * mercado, o self-hoster precisava esperar uma release do SonghaiCRM para
 * poder escolhê-lo — e o preço da tabela envelhecia junto, o que não é
 * cosmético: é o número que faz o teto de orçamento da organização disparar na
 * hora certa, ou não disparar.
 *
 * Este cron busca o catálogo público (sem chave — o endpoint de modelos da
 * OpenRouter é aberto), traduz e concilia. A regra da conciliação vive em
 * `lib/ai/catalogo/sincronizar.ts`; aqui é só borda e I/O.
 *
 * O que ele deliberadamente NÃO faz:
 *
 *  - **não apaga nada.** Modelo que sai da origem recebe `deprecated_at`. A
 *    linha continua referenciada pelo histórico de custo, e apagá-la faria o
 *    relatório do mês passado perder o preço com que a conta foi somada.
 *  - **não toca em linha de outra origem.** `source = 'manual'` é a curadoria
 *    que veio nas migrations; varrer a tabela inteira apagaria os defaults
 *    recomendados sem o operador nunca saber por quê.
 *  - **não aceita resposta suspeita.** Origem devolvendo menos da metade do que
 *    já conhecíamos aborta a rodada — ver o piso de sanidade. Catálogo
 *    desatualizado é recuperável; catálogo esvaziado por um soluço de rede
 *    custa a confiança na tela.
 *
 * Auth: mesmo contrato dos demais crons (Bearer `INTERNAL_CRON_SECRET` |
 * `INTERNAL_SECRET`, fail-closed).
 *
 * NOTA DE DEPLOY: o agendamento vive no serviço `scheduler` do
 * `docker-compose.prod.yml`, como os outros crons — não há `vercel.json` neste
 * repo. Cadência diária basta: modelo novo que demora um dia para aparecer no
 * seletor não quebra ninguém.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  FONTE_OPENROUTER,
  traduzirCatalogo,
  type ModeloDaOpenRouter,
} from "@/lib/ai/catalogo/openrouter";
import {
  CatalogoSuspeitoError,
  planejarSincronizacao,
  type ModeloExistente,
} from "@/lib/ai/catalogo/sincronizar";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ENDPOINT_DO_CATALOGO = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 20_000;

export interface ResultadoDaSincronizacao {
  fonte: string;
  recebidos: number;
  gravados: number;
  depreciados: number;
  ressuscitados: number;
}

/**
 * Separado do handler para o teste exercitar a REGRA sem montar request/auth —
 * mesmo padrão de `recover-stuck-messages`.
 */
export async function sincronizarCatalogo(
  admin: ReturnType<typeof createAdminClient>,
  buscar: () => Promise<ModeloDaOpenRouter[]>,
): Promise<ResultadoDaSincronizacao> {
  const daOrigem = traduzirCatalogo(await buscar());

  const { data: existentes, error: erroLeitura } = await admin
    .from("ai_models")
    .select("model_id, deprecated_at")
    .eq("source", FONTE_OPENROUTER);
  if (erroLeitura) throw new Error(`catalogo_leitura_falhou: ${erroLeitura.message}`);

  const plano = planejarSincronizacao(daOrigem, (existentes ?? []) as ModeloExistente[]);

  const agora = new Date().toISOString();

  if (plano.paraGravar.length > 0) {
    const { error } = await admin.from("ai_models").upsert(
      plano.paraGravar.map((l) => ({ ...l, synced_at: agora, deprecated_at: null })),
      { onConflict: "provider,model_id" },
    );
    if (error) throw new Error(`catalogo_upsert_falhou: ${error.message}`);
  }

  if (plano.paraDepreciar.length > 0) {
    const { error } = await admin
      .from("ai_models")
      .update({ deprecated_at: agora })
      .eq("source", FONTE_OPENROUTER)
      .in("model_id", plano.paraDepreciar);
    if (error) throw new Error(`catalogo_depreciacao_falhou: ${error.message}`);
  }

  // Ressuscitar é feito pelo upsert acima (`deprecated_at: null`); o número é
  // reportado para o log distinguir "voltou" de "entrou agora" — sem isso, um
  // catálogo que oscila pareceria estável.
  return {
    fonte: FONTE_OPENROUTER,
    recebidos: daOrigem.length,
    gravados: plano.paraGravar.length,
    depreciados: plano.paraDepreciar.length,
    ressuscitados: plano.paraRessuscitar.length,
  };
}

async function buscarDaOpenRouter(): Promise<ModeloDaOpenRouter[]> {
  const res = await fetch(ENDPOINT_DO_CATALOGO, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`catalogo_origem_status_${res.status}`);
  const json = (await res.json()) as { data?: ModeloDaOpenRouter[] };
  if (!Array.isArray(json.data)) {
    throw new Error("catalogo_origem_shape_inesperado — a resposta não trouxe `data` como lista");
  }
  return json.data;
}

function autorizado(req: NextRequest): boolean {
  const esperado = env.INTERNAL_CRON_SECRET || env.INTERNAL_SECRET;
  if (!esperado) return false; // fail-closed
  return req.headers.get("authorization") === `Bearer ${esperado}`;
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizado(req)) {
    return fail("unauthorized", "cron secret ausente ou inválido", 401, { requestId });
  }
  try {
    const resultado = await sincronizarCatalogo(createAdminClient(), buscarDaOpenRouter);
    logger.info("[sync-model-catalog] concluído", { ...resultado, request_id: requestId });
    return ok(resultado, { requestId });
  } catch (err) {
    if (err instanceof CatalogoSuspeitoError) {
      // Não é erro do servidor: a origem respondeu, e nós recusamos. 200 com o
      // motivo, para o agendador não tratar como incidente e ficar retentando
      // contra uma origem que está tendo problema.
      logger.warn("[sync-model-catalog] rodada recusada pelo piso de sanidade", {
        recebidos: err.recebidos,
        conhecidos: err.conhecidos,
        request_id: requestId,
      });
      return ok(
        { fonte: FONTE_OPENROUTER, recusado: true, motivo: err.message },
        { requestId },
      );
    }
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[sync-model-catalog] falhou", { error: detalhe, request_id: requestId });
    return fail("cron_failed", detalhe, 500, { requestId });
  }
}

export const GET = handler;
export const POST = handler;

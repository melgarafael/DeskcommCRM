/**
 * Enriquecimento de sites pendentes (spec 24, §3.2).
 *
 * Quem chama (B2): o PREPARO AUTOMÁTICO do tick (`preparo.ts`), FORA do bloqueio
 * da organização e sob bloqueio próprio, e o botão "Verificar agora" (rota
 * `verificar_sites`). Recebe qualquer cliente que fale `query` — não exige um
 * `PoolClient` inteiro, porque cada gravação aqui é um merge atômico de UMA chave
 * (`data || jsonb_build_object('site', …)`) e não depende de transação nem de lock.
 * Respeita o `deadline` recebido.
 *
 * Fail-open: erro aqui nunca pausa campanha, muda `status` ou atrasa
 * `next_send_at`. Candidato não enriquecido tenta de novo no próximo tick;
 * provisório só volta à fila depois do intervalo mínimo entre tentativas.
 */
import type pg from "pg";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { vereditoPuro } from "@/lib/prospecting/site-classify";
import {
  auditarSites,
  INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN,
  LIMITE_TENTATIVAS,
} from "@/lib/prospecting/site-fetch";

/** Teto por org/rodada: 6 paralelos × ~1s médio medido cabem no deadline. */
export const TETO_POR_RODADA = 30;

export interface ResumoEnriquecimento {
  enriquecidos: number;
  classes: Record<string, number>;
}

/**
 * Enriquece candidatos sem veredito e reverifica os provisórios
 * (`provisorio=true`, abaixo de `LIMITE_TENTATIVAS` e com `verificado_em`
 * mais antigo que o intervalo mínimo), qualquer status (`new`,
 * `queued` e `sent` — os já abordados ganham auditoria para a retomada).
 * Definitivo nunca é sobrescrito. Audita `prospecting.site_enriched` só quando
 * houve efeito.
 */
export async function enriquecerSitesPendentes(
  db: Pick<pg.PoolClient, "query">,
  org: string,
  requestId: string,
  deadline: number,
  campanhaId?: string,
  /** Teto de candidatos de rede nesta chamada (padrão: `TETO_POR_RODADA`, 30). */
  teto: number = TETO_POR_RODADA,
): Promise<ResumoEnriquecimento> {
  const vazio: ResumoEnriquecimento = { enriquecidos: 0, classes: {} };
  let curados = 0;
  try {
    // Cura das linhas ÓRFÃS: sem `website` não há rede a fazer, mas elas
    // também nunca passam pelo select de baixo (que exige website não-nulo).
    // Medido na VPS: 116 linhas assim ficavam em "A verificar" para sempre.
    // O veredito sem-site é determinístico: um UPDATE em lote resolve todas.
    const semSite = vereditoPuro(null, new Date().toISOString());
    if (semSite) {
      const curadas = await db.query(
        "update prospecting_candidates set data = data || jsonb_build_object('site', $3::jsonb), " +
          "updated_at = now() where organization_id = $1 " +
          "and ($2::uuid is null or campaign_id = $2::uuid) " +
          "and selected is not false " +
          "and data->'site' is null " +
          "and nullif(trim(data->>'website'), '') is null",
        [org, campanhaId ?? null, JSON.stringify(semSite)],
      );
      curados = curadas.rowCount ?? 0;
    }
  } catch (error) {
    logger.error("[prospecting.enriquecer-sites] cura de sem-site falhou", {
      organizationId: org,
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
  }
  let rows: Array<{ id: string; website: string; tentativas: number }>;
  try {
    const resultado = await db.query<{ id: string; website: string; tentativas: number }>(
      "select id, data->>'website' as website, " +
        "coalesce(nullif(data->'site'->>'tentativas', '')::int, 0) as tentativas " +
        "from prospecting_candidates " +
        "where organization_id=$1 " +
        // O botão da tela é POR CAMPANHA: sem este filtro, "Verificar sites" de
        // uma campanha gastava o lote da org inteira.
        "and ($5::uuid is null or campaign_id = $5::uuid) " +
        "and nullif(trim(data->>'website'), '') is not null " +
        // Desmarcado na preparação fica de fora: ele não vai ser abordado, e a
        // auditoria é para decidir QUEM abordar (retorna ao marcar de novo).
        "and selected is not false " +
        "and (data->'site' is null or (coalesce((data->'site'->>'provisorio')::boolean, false) " +
        "and coalesce(nullif(data->'site'->>'tentativas', '')::int, 0) < $3 " +
        "and coalesce(nullif(data->'site'->>'verificado_em','')::timestamptz, 'epoch'::timestamptz) <= now() - make_interval(mins => $4))) " +
        "order by created_at limit $2",
      [org, Math.min(Math.max(teto, 0), TETO_POR_RODADA), LIMITE_TENTATIVAS, INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN, campanhaId ?? null],
    );
    rows = resultado.rows;
  } catch (error) {
    // Nunca quebra o tick por causa do enriquecimento (fail-open, spec 24).
    logger.error("[prospecting.enriquecer-sites] seleção falhou", {
      organizationId: org,
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    return vazio;
  }
  const classes: Record<string, number> = {};
  let enriquecidos = 0;
  if (curados > 0) {
    enriquecidos += curados;
    classes["sem-site"] = (classes["sem-site"] ?? 0) + curados;
  }
  if (rows.length === 0 || Date.now() >= deadline) {    // A cura em lote pode ter rodado MESMO sem linha de rede: o resumo precisa
    // dela (o botão mostra "N verificadas") — o early return antigo devolvia 0
    // e o operador via trabalho feito sem número.
    if (enriquecidos > 0) {
      void audit({
        action: "prospecting.site_enriched",
        organizationId: org,
        bypassedRls: true,
        resourceType: "prospecting",
        resourceId: null,
        metadata: { enriquecidos, classes },
        requestId,
      });
    }
    return { enriquecidos, classes };
  }

  const agoraIso = new Date().toISOString();
  let veredictos: Awaited<ReturnType<typeof auditarSites>>;
  try {
    veredictos = await auditarSites(
      rows.map((r) => r.website),
      agoraIso,
      6,
      fetch,
      undefined,
      rows.map((r) => r.tentativas ?? 0),
    );
  } catch (error) {
    logger.error("[prospecting.enriquecer-sites] lote falhou", {
      organizationId: org,
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    return vazio;
  }
  for (let i = 0; i < rows.length; i++) {
    const veredito = veredictos[i]!;
    try {
      const result = await db.query(
        "update prospecting_candidates set data = data || jsonb_build_object('site', $3::jsonb), " +
          "updated_at = now() where organization_id = $1 and id = $2 " +
          "and (data->'site' is null or coalesce((data->'site'->>'provisorio')::boolean, false))",
        [org, rows[i]!.id, JSON.stringify(veredito)],
      );
      if ((result.rowCount ?? 0) > 0) {
        enriquecidos++;
        classes[veredito.classe] = (classes[veredito.classe] ?? 0) + 1;
      }
    } catch (error) {
      logger.error("[prospecting.enriquecer-sites] candidato falhou, seguindo", {
        organizationId: org,
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }
    if (Date.now() >= deadline) break;
  }

  if (enriquecidos > 0) {
    void audit({
      action: "prospecting.site_enriched",
      organizationId: org,
      bypassedRls: true,
      resourceType: "prospecting",
      resourceId: null,
      metadata: { enriquecidos, classes },
      requestId,
    });
  }
  return { enriquecidos, classes };
}

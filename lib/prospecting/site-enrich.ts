/**
 * Enriquecimento de sites pendentes dentro do `tickProspecting` (spec 24, §3.2).
 *
 * Posição proposital: depois de `synchronizeSearch` materializar os candidatos
 * e ANTES de `sendNextCandidate` consumir quota/LLM — a auditoria já está em
 * `data` quando a abordagem monta o prompt. Roda no lock por org já segurado,
 * reusa o `PoolClient`, e respeita o deadline do tick como `worker.ts:375`.
 *
 * Fail-open: erro aqui nunca pausa campanha, muda `status` ou atrasa
 * `next_send_at`. Candidato não enriquecido tenta de novo no próximo tick.
 */
import type pg from "pg";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { auditarSites, LIMITE_TENTATIVAS } from "@/lib/prospecting/site-fetch";

/** Teto por org/rodada: 6 paralelos × ~1s médio medido cabem no deadline. */
const TETO_POR_RODADA = 30;

export interface ResumoEnriquecimento {
  enriquecidos: number;
  classes: Record<string, number>;
}

/**
 * Enriquece candidatos sem veredito e reverifica os provisórios
 * (`provisorio=true`, abaixo de `LIMITE_TENTATIVAS`), qualquer status (`new`,
 * `queued` e `sent` — os já abordados ganham auditoria para a retomada).
 * Definitivo nunca é sobrescrito. Audita `prospecting.site_enriched` só quando
 * houve efeito.
 */
export async function enriquecerSitesPendentes(
  db: pg.PoolClient,
  org: string,
  requestId: string,
  deadline: number,
): Promise<ResumoEnriquecimento> {
  const vazio: ResumoEnriquecimento = { enriquecidos: 0, classes: {} };
  let rows: Array<{ id: string; website: string; tentativas: number }>;
  try {
    const resultado = await db.query<{ id: string; website: string; tentativas: number }>(
      "select id, data->>'website' as website, " +
        "coalesce(nullif(data->'site'->>'tentativas', '')::int, 0) as tentativas " +
        "from prospecting_candidates " +
        "where organization_id=$1 " +
        "and nullif(trim(data->>'website'), '') is not null " +
        "and (data->'site' is null or (coalesce((data->'site'->>'provisorio')::boolean, false) " +
        "and coalesce(nullif(data->'site'->>'tentativas', '')::int, 0) < $3)) " +
        "order by created_at limit $2",
      [org, TETO_POR_RODADA, LIMITE_TENTATIVAS],
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
  if (rows.length === 0 || Date.now() >= deadline) return vazio;

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

  const classes: Record<string, number> = {};
  let enriquecidos = 0;
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

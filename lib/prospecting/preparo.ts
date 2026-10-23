/**
 * O PREPARO AUTOMÁTICO DA PROSPECÇÃO (B2).
 *
 * Verificar o site de cada empresa e escrever a prévia da abordagem eram dois
 * gestos manuais — um botão e um clique POR LINHA. Com 100 empresas isso é
 * inviável, e o operador só descobria que faltava algo na hora de iniciar. Aqui o
 * sistema faz sozinho, aos poucos, em segundo plano, sempre que existe candidato
 * (campanha em rascunho, pausada ou rodando); a lista mostra o andamento.
 *
 * ═══ Por que FORA do bloqueio da organização ═══
 *
 * O bloqueio `prospecting:<org>` (`withProspectingLock`) serializa busca, início,
 * pausa e ENVIO. A verificação de site fazia fetch de até 30 sites seguida de
 * minutos de espera dentro dele, e a tela inteira respondia 409 ("operação em
 * andamento") — medido na VPS. Prévia é pior: cada uma é uma chamada de modelo.
 * Nenhum dos dois pode segurar a fila de envio. E nenhum dos dois precisa dela:
 * cada gravação é um merge de UMA chave de `data` (`site` / `previa`), atômico.
 *
 * ═══ O bloqueio PRÓPRIO ═══
 *
 * Fora do bloqueio da organização, dois ticks que se sobrepõem (o cron roda a
 * cada minuto e um tick pode durar até 180 s) prepararam a mesma organização ao
 * mesmo tempo e gastariam IA em dobro. Daí um `pg_try_advisory_lock` de CHAVE
 * DIFERENTE (`prospecting:<org>:preparo`), não-bloqueante: quem não consegue,
 * devolve `{pulou:true}` sem fazer nada. Ele vive num cliente dedicado do pool
 * (advisory lock é da SESSÃO) e é solto no `finally`.
 *
 * ═══ O que limita o gasto ═══
 *
 * - `TETO_PREVIAS_POR_RODADA` (8) por organização por rodada: o gasto máximo de
 *   uma organização é 8 prévias por minuto, qualquer que seja o tamanho da lista;
 * - no máximo 3 chamadas de modelo em paralelo, e o `deadline` é conferido antes
 *   de cada lote;
 * - cada candidato é tentado UMA vez por rodada; 3 falhas na rodada interrompem a
 *   geração (modelo fora do ar, agente despublicado: não adianta repetir 8 vezes
 *   a cada minuto);
 * - só gera para quem tem veredito de site DEFINITIVO (`previaPorGerar`):
 *   provisório ainda pode mudar e a copy escrita nele seria jogada fora.
 *
 * FAIL-OPEN: nada aqui derruba o tick. Falha vira log (sem o texto) e a próxima
 * rodada tenta de novo.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { configPadraoDaOrganizacao, type ConfigPadrao } from "./config-padrao";
import { personalizacaoDaOrganizacao } from "./personalizar";
import { gerarPreviaDoCandidato } from "./previa-gerar";
import { opcoesDoPreparo } from "./opcoes-do-preparo";
import { gravarPrevia, previaPorGerar } from "./previa";
import { campaignConfigSchema, type Prospect } from "./schema";
import { enriquecerSitesPendentes } from "./site-enrich";

/** Gasto máximo de IA por organização por rodada (a rodada é de 1 minuto). */
export const TETO_PREVIAS_POR_RODADA = 8;
const PREVIAS_EM_PARALELO = 3;
/** Falhas na rodada que interrompem a geração: evita laço de custo por minuto. */
const MAX_FALHAS_POR_RODADA = 3;
/** Candidatos de rede por organização por rodada, somadas as campanhas. */
const TETO_DE_SITES_POR_RODADA = 30;

export interface ResumoDoPreparo {
  /** Candidatos que ganharam veredito de site nesta rodada. */
  sites: number;
  /** Prévias geradas e gravadas nesta rodada. */
  previas: number;
  /** Outro tick já preparava esta organização: nada foi feito. */
  pulou: boolean;
}

type CampanhaDoPreparo = { id: string; config: unknown; search: ({ niche?: string } & Record<string, unknown>) | null };
type CandidatoDoPreparo = {
  id: string;
  data: Prospect;
  status: string;
  selected: boolean | null;
  contact_id: string | null;
};

/** A chave NÃO é a do `withProspectingLock` (`prospecting:<org>`): bloqueios independentes. */
const chaveDoBloqueio = (org: string) => `prospecting:${org}:preparo`;

/**
 * Pré-filtro em SQL do que `previaPorGerar` decide em TS. Sem ele, os primeiros
 * `limit` candidatos da fila podiam ser todos "ainda sem veredito" e a fila de
 * prévia ficava parada atrás deles; a decisão final continua sendo a do TS.
 */
const SQL_CANDIDATOS_PARA_PREVIA =
  "select id, data, status, selected, contact_id from prospecting_candidates " +
  "where organization_id=$1 and campaign_id=$2 " +
  "and selected is not false and status in ('new','queued') " +
  "and data->'previa' is null " +
  "and ((data->'site' is not null and not coalesce((data->'site'->>'provisorio')::boolean, false)) " +
  "or (data->'site' is null and nullif(trim(data->>'website'), '') is null)) " +
  "order by created_at, id limit $3";

const mensagemDe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * `_admin` acompanha a assinatura do tick (todo passo do worker recebe o cliente
 * de serviço), mas o preparo não o usa: a geração fala com o modelo pelo `pool`.
 */
export async function prepararCandidatos(
  pool: pg.Pool,
  _admin: SupabaseClient,
  org: string,
  requestId: string,
  deadline: number,
): Promise<ResumoDoPreparo> {
  const resumo: ResumoDoPreparo = { sites: 0, previas: 0, pulou: false };
  const db = await pool.connect();
  let locked = false;
  let erroNoUnlock: Error | undefined;
  try {
    locked =
      (
        await db.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [chaveDoBloqueio(org)],
        )
      ).rows[0]?.locked === true;
    if (!locked) {
      resumo.pulou = true;
      return resumo;
    }
    await trabalhar(db, pool, org, requestId, deadline, resumo);
  } catch (error) {
    logger.error("[prospecting.preparo] rodada falhou", {
      organization_id: org,
      request_id: requestId,
      error: mensagemDe(error),
    });
  } finally {
    try {
      if (locked)
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [chaveDoBloqueio(org)]);
    } catch (unlockErr) {
      // Como em `withProspectingLock` (#2624): o lock de sessão só morre com a
      // conexão. Devolver o cliente COM erro faz o pool derrubá-la em vez de
      // reemprestá-la com o bloqueio ainda preso.
      erroNoUnlock = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
    }
    db.release(erroNoUnlock);
  }
  return resumo;
}

async function trabalhar(
  db: pg.PoolClient,
  pool: pg.Pool,
  org: string,
  requestId: string,
  deadline: number,
  resumo: ResumoDoPreparo,
): Promise<void> {
  if (Date.now() >= deadline) return;
  const campanhas = (
    await db.query<CampanhaDoPreparo>(
      "select id, config, search from prospecting_campaigns where organization_id=$1 and status in ('draft','running','paused') order by created_at desc",
      [org],
    )
  ).rows;

  // Passo 1 — a rede: verifica os sites. De TODAS as campanhas, com ou sem agente
  // (o veredito serve à decisão de quem abordar, e a prévia só vem depois dele).
  // A campanha MAIS NOVA vem primeiro (`order by created_at desc` acima): é a que a pessoa
  // está olhando. Com as antigas na frente, uma busca nova esperava na fila atrás de
  // centenas de candidatos velhos (medido na VPS: 8 prévias/rodada, 370 pendentes).
  let restanteDeSites = TETO_DE_SITES_POR_RODADA;
  for (const c of campanhas) {
    if (restanteDeSites <= 0 || Date.now() >= deadline) break;
    // Interruptor da busca: "Avaliar o site" desligado = nenhuma rede automática.
    if (!opcoesDoPreparo(c.search).avaliarSite) continue;
    try {
      const r = await enriquecerSitesPendentes(db, org, requestId, deadline, c.id, restanteDeSites);
      resumo.sites += r.enriquecidos;
      restanteDeSites -= r.enriquecidos;
    } catch (error) {
      logger.error("[prospecting.preparo] verificação de sites falhou, seguindo", {
        organization_id: org,
        campaign_id: c.id,
        request_id: requestId,
        error: mensagemDe(error),
      });
    }
  }

  // Passo 2 — a IA: uma prévia por candidato. A campanha com agente usa o DELA; a que
  // ainda não escolheu (busca nova) usa o agente PADRÃO da organização — a prévia sai
  // junto com a avaliação, e o envio só a aproveita se o agente for o mesmo. Sem
  // nenhum dos dois, não há quem escreva: nada é gerado.
  let padrao: ConfigPadrao | null | undefined;
  const personalizacao = await personalizacaoDaOrganizacao(db, org);
  let vagas = TETO_PREVIAS_POR_RODADA;
  let falhas = 0;
  const porCampanha: Record<string, number> = {};

  for (const c of campanhas) {
    if (vagas <= 0 || falhas >= MAX_FALHAS_POR_RODADA || Date.now() >= deadline) break;
    // Interruptor da busca: "Gerar a prévia" desligado = nenhuma IA automática; o agente
    // escreve a mensagem na hora do envio.
    if (!opcoesDoPreparo(c.search).gerarPrevia) continue;
    const cfg = campaignConfigSchema.safeParse(c.config);
    let configDaPrevia: unknown = c.config;
    if (!cfg.success || !cfg.data.agent_id) {
      if (padrao === undefined) padrao = await configPadraoDaOrganizacao(db, org);
      if (!padrao) continue;
      configDaPrevia = padrao.config;
    }

    const agoraIso = new Date().toISOString();
    const candidatos = (
      await db.query<CandidatoDoPreparo>(SQL_CANDIDATOS_PARA_PREVIA, [org, c.id, vagas])
    ).rows
      .filter((x) => previaPorGerar(x, agoraIso))
      .slice(0, vagas);

    for (let i = 0; i < candidatos.length; ) {
      if (vagas <= 0 || falhas >= MAX_FALHAS_POR_RODADA || Date.now() >= deadline) break;
      const lote = candidatos.slice(i, i + Math.min(PREVIAS_EM_PARALELO, vagas));
      i += lote.length;
      // A vaga é gasta na TENTATIVA, não no sucesso: o teto limita o custo.
      vagas -= lote.length;
      await Promise.all(
        lote.map(async (x) => {
          try {
            const r = await gerarPreviaDoCandidato(
              pool,
              org,
              {
                id: x.id,
                data: x.data,
                status: x.status,
                contact_id: x.contact_id,
                config: configDaPrevia,
                search: c.search,
              },
              { personalizacao },
            );
            if (!r.ok) {
              falhas++;
              // Só o motivo — nunca texto gerado nem dado da empresa.
              logger.warn("[prospecting.preparo] prévia não saiu, seguindo", {
                organization_id: org,
                campaign_id: c.id,
                candidate_id: x.id,
                motivo: r.motivo,
                detalhe: r.detalhe,
              });
              return;
            }
            await gravarPrevia(db, {
              organizationId: org,
              campaignId: c.id,
              candidateId: x.id,
              previa: r.previa,
            });
            resumo.previas++;
            porCampanha[c.id] = (porCampanha[c.id] ?? 0) + 1;
          } catch (error) {
            falhas++;
            logger.warn("[prospecting.preparo] prévia falhou, seguindo", {
              organization_id: org,
              campaign_id: c.id,
              candidate_id: x.id,
              error: mensagemDe(error),
            });
          }
        }),
      );
    }
  }

  // Auditado quando houve EFEITO (prévia gravada) — nunca rodada vazia. Sem o texto:
  // o que ele guarda é o rastro de "quantas, em qual campanha", que explica o gasto.
  if (resumo.previas > 0) {
    void audit({
      action: "prospecting.previews_generated",
      organizationId: org,
      bypassedRls: true,
      resourceType: "prospecting",
      resourceId: null,
      metadata: {
        geradas: resumo.previas,
        falhas,
        campaign_ids: Object.keys(porCampanha),
        por_campanha: porCampanha,
      },
      requestId,
    });
  }
}

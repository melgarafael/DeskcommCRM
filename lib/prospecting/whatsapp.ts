/**
 * A EMPRESA TEM WHATSAPP? — conferido ANTES da abordagem.
 *
 * A busca de mapas devolve o telefone que a empresa publicou, e nada garante que
 * ele tenha WhatsApp: fixo sem WhatsApp Business, celular desativado, número de
 * outra pessoa. A prospecção escrevia a abordagem (uma chamada de modelo) e a
 * mandava assim mesmo — o envio cai no endereço cru quando a plataforma não
 * acha o número —, e a lista misturava, sem distinção, quem podia ser abordado e
 * quem nunca ia receber.
 *
 * Medido numa instalação real (02/11/2026, 14 empresas de uma busca): 8 com
 * WhatsApp, 2 sem, 4 sem telefone — e um dos 8 era um FIXO com WhatsApp Business.
 * Por isso a decisão é perguntar ao WhatsApp, número por número, e NUNCA adivinhar
 * pelo prefixo: o fixo que tem WhatsApp seria descartado, e o celular que não tem
 * seria abordado.
 *
 * ═══ Como ═══
 *
 * Só com o módulo opcional `conferir_whatsapp` ligado (`lib/instalacao/modulos.ts`,
 * desligado por padrão): quem pergunta é o número do cliente, e consulta em massa
 * a partir dele é risco de banimento que ninguém mediu.
 *
 * `numeroTemConta` do adapter do canal (`lib/channels/types.ts`), pela sessão de
 * uma conexão da organização que saiba perguntar (a da campanha, se ela já
 * escolheu — e SÓ ela; senão qualquer uma conectada — `provedoresQueConferemNumero`). Não
 * manda mensagem nenhuma: só pergunta se o número existe no WhatsApp. Sem
 * conexão capaz, nada acontece — o veredito fica ausente e a abordagem segue como
 * antes (o canal oficial não tem esta pergunta).
 *
 * ═══ O que limita ═══
 *
 * - `TETO_DE_WHATSAPP_POR_RODADA` números por organização por rodada (1 minuto),
 *   com `PAUSA_ENTRE_CONSULTAS_MS` entre um e outro: consulta em rajada é o tipo de
 *   padrão que a detecção de automação procura, e o número consultando é o do
 *   cliente;
 * - erro de transporte (servidor fora, sessão caindo) NÃO vira "sem WhatsApp": a
 *   rodada para, nada é gravado, e a próxima tenta de novo. Descartar uma empresa
 *   porque o servidor piscou seria pior do que abordá-la.
 *
 * ═══ O efeito ═══
 *
 * O veredito mora em `data.whatsapp` (merge de UMA chave, atômico, como `site` e
 * `previa`). Sem WhatsApp, a empresa sai da seleção: em rascunho ela fica
 * desmarcada (e a tela não deixa marcá-la de novo); já na fila, vai para "Não
 * abordado" com o motivo `MOTIVO_SEM_WHATSAPP`. Nos dois casos nenhuma prévia é
 * gerada para ela e nenhuma mensagem sai.
 */
import type pg from "pg";

import { audit } from "@/lib/audit";
import {
  getAdapter,
  provedoresQueConferemNumero,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { logger } from "@/lib/logger";
import type { Prospect, VereditoWhatsapp } from "./schema";

export type { VereditoWhatsapp };


/** Motivo de "Não abordado" de quem não tem WhatsApp. */
export const MOTIVO_SEM_WHATSAPP = "Sem WhatsApp neste número.";

/** Números consultados por organização por rodada do cron (1 por minuto). */
export const TETO_DE_WHATSAPP_POR_RODADA = 15;
/** Pausa entre duas consultas seguidas: nada de rajada a partir do número do cliente. */
export const PAUSA_ENTRE_CONSULTAS_MS = 2000;

/**
 * Pergunta se o telefone tem WhatsApp. `true`/`false` é resposta; `null` é "não deu
 * para saber" (transporte fora) — e quem chama não grava nada.
 */
export type ConsultaWhatsapp = (telefone: string) => Promise<boolean | null>;

/** O motivo de não abordar, quando o veredito já disse que não há WhatsApp. */
export function motivoSemWhatsapp(data: Pick<Prospect, "whatsapp"> | null | undefined): string | null {
  return data?.whatsapp?.existe === false ? MOTIVO_SEM_WHATSAPP : null;
}

/**
 * A consulta pela sessão de uma conexão CONECTADA da organização cujo canal sabe
 * perguntar (`numeroTemConta`). Campanha que escolheu a conexão pergunta só por
 * ela: se ela não sabe perguntar (o canal oficial) ou não está conectada, `null`
 * — nunca por outro número, que a campanha não usa. Sem conexão escolhida, a
 * mais antiga conectada. `null` quando não há conexão capaz conectada.
 */
export async function consultaPelaConexao(
  db: Pick<pg.PoolClient, "query">,
  org: string,
  canalPreferido: string | null,
): Promise<ConsultaWhatsapp | null> {
  const provedores = provedoresQueConferemNumero();
  if (provedores.length === 0) return null;
  const capazes = (
    await db.query<ChannelSessionRef & { id: string }>(
      "select * from channel_sessions where organization_id=$1 and provider = any($2::text[]) " +
        "and status='WORKING' and archived_at is null order by created_at",
      [org, provedores],
    )
  ).rows;
  const canal = canalPreferido ? capazes.find((c) => c.id === canalPreferido) : capazes[0];
  if (!canal) return null;
  const adapter = getAdapter(canal.provider);
  if (typeof adapter.numeroTemConta !== "function") return null;
  const sessionRef = resolveSessionRef(canal);
  // Exceção do adapter também é "não deu para saber", nunca "não tem".
  return (telefone) =>
    adapter.numeroTemConta!({ organizationId: org, sessionRef, phone: telefone }).catch(() => null);
}

const SQL_PENDENTES =
  "select id, data->>'phone' as phone from prospecting_candidates " +
  "where organization_id=$1 and campaign_id=$2 and status in ('new','queued') and selected is not false " +
  "and nullif(trim(data->>'phone'), '') is not null and data->'whatsapp' is null " +
  "order by created_at, id limit $3";

/**
 * Grava o veredito e, sem WhatsApp, tira a empresa da seleção. Só toca quem ainda
 * não foi tentado (`new`/`queued`) e ainda não tinha veredito: uma rodada
 * sobreposta não reescreve a outra.
 */
const SQL_GRAVAR =
  "update prospecting_candidates set " +
  "data = data || jsonb_build_object('whatsapp', $3::jsonb), " +
  "selected = case when $4 then selected else false end, " +
  "status = case when not $4 and status = 'queued' then 'skipped' else status end, " +
  "error = case when not $4 and status = 'queued' then $5 else error end, " +
  "updated_at = now() " +
  "where organization_id=$1 and id=$2 and status in ('new','queued') and data->'whatsapp' is null";

const dormirPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ResultadoDaVerificacao {
  verificados: number;
  semWhatsapp: number;
  /** A consulta falhou e a rodada parou (nada foi gravado para aquele número). */
  interrompida: boolean;
}

export async function verificarWhatsappPendentes(
  db: Pick<pg.PoolClient, "query">,
  org: string,
  requestId: string,
  deadline: number,
  campaignId: string,
  teto: number,
  consultar: ConsultaWhatsapp,
  dormir: (ms: number) => Promise<void> = dormirPadrao,
): Promise<ResultadoDaVerificacao> {
  const resultado: ResultadoDaVerificacao = { verificados: 0, semWhatsapp: 0, interrompida: false };
  if (teto <= 0) return resultado;
  const pendentes = (
    await db.query<{ id: string; phone: string }>(SQL_PENDENTES, [org, campaignId, teto])
  ).rows;
  for (let i = 0; i < pendentes.length; i++) {
    if (Date.now() >= deadline) break;
    if (i > 0) await dormir(PAUSA_ENTRE_CONSULTAS_MS);
    const p = pendentes[i]!;
    const existe = await consultar(p.phone);
    if (existe === null) {
      resultado.interrompida = true;
      logger.warn("[prospecting.whatsapp] consulta indisponível; a rodada parou e tenta de novo", {
        organization_id: org,
        campaign_id: campaignId,
        candidate_id: p.id,
      });
      break;
    }
    const veredito: VereditoWhatsapp = { existe, verificado_em: new Date().toISOString() };
    await db.query(SQL_GRAVAR, [org, p.id, JSON.stringify(veredito), existe, MOTIVO_SEM_WHATSAPP]);
    resultado.verificados++;
    if (!existe) resultado.semWhatsapp++;
  }
  // Auditado quando houve EFEITO — nunca rodada vazia. Só contagens: sem telefone.
  if (resultado.verificados > 0) {
    void audit({
      action: "prospecting.whatsapp_checked",
      organizationId: org,
      bypassedRls: true,
      resourceType: "prospecting_campaign",
      resourceId: campaignId,
      requestId,
      metadata: { verificados: resultado.verificados, sem_whatsapp: resultado.semWhatsapp },
    });
  }
  return resultado;
}

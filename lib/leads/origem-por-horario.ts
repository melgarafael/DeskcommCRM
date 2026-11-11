/**
 * A ORIGEM DA PÁGINA QUANDO O CÓDIGO NÃO VEIO — casada pelo HORÁRIO do clique.
 *
 * ─── O buraco ───────────────────────────────────────────────────────────────
 *
 * O link rastreável (`app/api/v1/rastreio/[id]`) grava o clique e abre o
 * WhatsApp com `[ref:XXXXXX]` no texto. Quem apaga o código ao editar a
 * mensagem chega sem nada: o clique fica órfão e o contato, sem origem — e
 * passa a parecer orgânico para quem mede a página.
 *
 * ─── A inferência ───────────────────────────────────────────────────────────
 *
 * Contato NOVO (primeira mensagem de entrada), ainda sem origem nenhuma (nem
 * anúncio, nem site), e um clique de link rastreável sem dono nos últimos
 * `JANELA_DO_CLIQUE_MINUTOS`, para o MESMO número que recebeu a mensagem:
 * quase certamente é quem clicou. A origem é estampada com
 * `origem_inferida_por: "horario"`, porque é inferência e quem lê a ficha
 * precisa saber disso.
 *
 * Com mais de um clique candidato vale o mais recente, mas só atravessam as
 * UTMs em que TODOS concordam: "veio do site" é certo; "de qual campanha", só
 * quando não há dúvida.
 *
 * ─── Opção da empresa, DESLIGADA de fábrica (doc de decisão 259) ────────────
 *
 * A "Origem" com prova é a resposta da #924. A dedução muda o que o número
 * significa — passa a ser prova OU palpite —, e esse número vai para relatório
 * e regra de webhook. Então só deduz quem pediu:
 * `organizations.settings.conversions.site_origin_by_click_time === true`.
 * Ausente é desligado, e desligada a dedução não consulta clique nenhum.
 *
 * ─── O código sempre vence ──────────────────────────────────────────────────
 *
 * A inferência grava `contact_id` no clique e deixa `matched_at` NULO. O
 * consumo pelo código (`casarClickRef`) exige `matched_at is null`, então quem
 * chegar depois COM o `[ref:]` daquele clique ainda o reivindica: a prova
 * vence a inferência. E a inferência só considera cliques com `contact_id`
 * nulo, então dois contatos novos não deduzem o mesmo clique.
 *
 * Quando a prova chega para OUTRO contato, o palpite estava errado: o
 * `casarClickRef` chama `desfazerOrigemDeduzida` para quem tinha reservado o
 * clique. Sem isso, o mesmo clique ficava como origem de dois contatos — e a
 * do palpite, travada pelo primeiro toque, nunca mais saía.
 *
 * ─── O que fica de fora, de propósito ───────────────────────────────────────
 *
 *   - O clique do Google (`google_ads_click_refs`): ele carrega `gclid`, que
 *     vira conversão enviada ao Google, e conversão não se manda por palpite.
 *   - O contato que já tem `ad_platform`: o anúncio de clique-para-WhatsApp é
 *     estampado pela ingestão ANTES deste passo (os três canais fazem isso), e
 *     a inferência nunca disputa com ele — é o dado que vira conversão na Meta.
 *   - A reentrega (`messageId` nulo): sem a linha nova, não há como saber se é
 *     a primeira mensagem.
 *
 * Falha aqui é LOG, nunca exceção — mesma postura de `pos-entrada.ts`: a
 * mensagem do cliente já está gravada quando este código roda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ORIGEM_DO_WHATSAPP } from "@/lib/channels/origem-do-negocio";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import {
  ehAPrimeiraMensagemDoContato,
  estamparOrigemDaPagina,
  normalizarUtm,
} from "./origem-do-site";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Quanto tempo depois do clique a primeira mensagem ainda é "de quem clicou".
 *
 * Clicar, abrir o WhatsApp, mexer no texto e mandar leva de segundos a poucos
 * minutos. Dez minutos cobrem quem demora sem juntar cliques de horas atrás.
 */
export const JANELA_DO_CLIQUE_MINUTOS = 10;

/** Mais que isso numa janela de minutos é tráfego que a inferência não resolve. */
const MAXIMO_DE_CANDIDATOS = 20;

/** A chave da empresa. AUSENTE É DESLIGADO, e isso é a decisão (doc 259). */
export function origemPorHorarioLigada(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const conversions = (settings as Record<string, unknown>).conversions;
  if (!conversions || typeof conversions !== "object") return false;
  return (conversions as Record<string, unknown>).site_origin_by_click_time === true;
}

/**
 * A chave é lida por mensagem sem código; o memo faz disso uma leitura a cada
 * 30 s por organização, e não uma por mensagem. Ligar na tela vale em até 30 s.
 */
const TTL_DA_CHAVE_MS = 30_000;
const memoDaChave = new Map<string, { at: number; ligada: boolean }>();

/** Esvazia o memo. Usado pelos testes. */
export function esquecerChaveDaOrigemPorHorario(): void {
  memoDaChave.clear();
}

/** LANÇA quando a leitura falha: quem chama trata como desligada (não deduz). */
async function chaveLigada(admin: Admin, organizationId: string): Promise<boolean> {
  const emMemo = memoDaChave.get(organizationId);
  if (emMemo && Date.now() - emMemo.at < TTL_DA_CHAVE_MS) return emMemo.ligada;
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`leitura da chave falhou: ${error.message}`);
  const ligada = origemPorHorarioLigada((data as { settings?: unknown } | null)?.settings);
  memoDaChave.set(organizationId, { at: Date.now(), ligada });
  return ligada;
}

export interface CliqueCandidato {
  id: string;
  utm: Record<string, string>;
  createdAt: string;
  /** O número de destino do link (E.164). */
  numeroDoLink: string | null;
}

export interface CliqueEscolhido {
  cliqueId: string;
  /** Só as UTMs em que todos os candidatos concordam. */
  utm: Record<string, string>;
  candidatos: number;
}

const soDigitos = (valor: string | null | undefined) => (valor ?? "").replace(/\D/g, "");

/**
 * Puro: decide qual clique é de quem acabou de escrever, ou nenhum.
 *
 * Número da sessão desconhecido não filtra (há instalação sem o número gravado
 * na sessão); conhecido, só passa o clique de link que aponta para ele — numa
 * organização com dois números, o clique para um não é de quem escreveu no
 * outro. A comparação é por dígitos: a sessão guarda com e sem `+`.
 */
export function escolherCliquePorHorario(
  candidatos: CliqueCandidato[],
  numeroDaSessao: string | null,
): CliqueEscolhido | null {
  const numero = soDigitos(numeroDaSessao);
  const doNumero = numero
    ? candidatos.filter((c) => soDigitos(c.numeroDoLink) === numero)
    : candidatos;
  if (doNumero.length === 0) return null;

  const ordenados = [...doNumero].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const maisRecente = ordenados[0];
  if (!maisRecente) return null;
  const outros = ordenados.slice(1);
  const utm = outros.reduce<Record<string, string>>(
    (comum, c) => Object.fromEntries(Object.entries(comum).filter(([k, v]) => c.utm[k] === v)),
    { ...maisRecente.utm },
  );
  return { cliqueId: maisRecente.id, utm, candidatos: ordenados.length };
}

export interface EntradaParaHorario {
  organizationId: string;
  contactId: string;
  messageId: string | null;
  channelSessionId: string;
}

/**
 * Tenta dar ao contato a origem de um clique cujo código não veio no texto.
 *
 * Desligada (o padrão), não consulta clique nenhum. Ligada, o caso comum —
 * nenhum clique pendente na janela — custa UMA consulta: as outras só rodam
 * quando há o que casar.
 */
export async function casarOrigemPorHorario(
  admin: Admin,
  entrada: EntradaParaHorario,
): Promise<void> {
  const { organizationId, contactId, messageId, channelSessionId } = entrada;
  if (!messageId) return;

  try {
    if (!(await chaveLigada(admin, organizationId))) return;

    const desde = new Date(Date.now() - JANELA_DO_CLIQUE_MINUTOS * 60_000).toISOString();
    const { data: cliques, error } = await admin
      .from("meta_ads_click_refs")
      .select("id, utm, created_at, tracking_link_id")
      .eq("organization_id", organizationId)
      .not("tracking_link_id", "is", null)
      .is("matched_at", null)
      .is("contact_id", null)
      .gte("created_at", desde)
      .order("created_at", { ascending: false })
      .limit(MAXIMO_DE_CANDIDATOS);
    if (error) throw new Error(error.message);
    if (!cliques || cliques.length === 0) return;

    if (!(await ehAPrimeiraMensagemDoContato(admin, organizationId, contactId, messageId))) return;

    // Quem já tem origem não é órfão: o anúncio foi estampado agora mesmo pela
    // ingestão, ou o contato veio do site por outro caminho.
    const { data: contato, error: erroDoContato } = await admin
      .from("contacts")
      .select("source, source_metadata")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (erroDoContato) throw new Error(erroDoContato.message);
    const sourceAnterior = (contato as { source?: string | null } | null)?.source ?? null;
    const metadata = (contato?.source_metadata ?? {}) as Record<string, unknown>;
    if (!contato || metadata.ad_platform != null) return;

    const linhas = cliques as Array<{
      id: string;
      utm: unknown;
      created_at: string;
      tracking_link_id: string;
    }>;
    const idsDosLinks = [...new Set(linhas.map((c) => c.tracking_link_id))];
    const [links, sessao] = await Promise.all([
      admin
        .from("ad_tracking_links")
        .select("id, whatsapp_e164")
        .eq("organization_id", organizationId)
        .in("id", idsDosLinks),
      admin
        .from("channel_sessions")
        .select("phone_number")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle(),
    ]);
    if (links.error) throw new Error(links.error.message);
    const numeroDoLink = new Map(
      ((links.data ?? []) as Array<{ id: string; whatsapp_e164: string }>).map((l) => [
        l.id,
        l.whatsapp_e164,
      ]),
    );

    const escolha = escolherCliquePorHorario(
      linhas.map((c) => ({
        id: c.id,
        utm: normalizarUtm(c.utm),
        createdAt: c.created_at,
        numeroDoLink: numeroDoLink.get(c.tracking_link_id) ?? null,
      })),
      (sessao.data as { phone_number: string | null } | null)?.phone_number ?? null,
    );
    if (!escolha) return;

    // Reserva com a MESMA trava da leitura: dois contatos novos ao mesmo tempo
    // não levam o mesmo clique — o segundo encontra `contact_id` preenchido.
    const { data: reservado, error: erroDaReserva } = await admin
      .from("meta_ads_click_refs")
      .update({ contact_id: contactId })
      .eq("organization_id", organizationId)
      .eq("id", escolha.cliqueId)
      .is("matched_at", null)
      .is("contact_id", null)
      .select("id")
      .maybeSingle();
    if (erroDaReserva) throw new Error(erroDaReserva.message);
    if (!reservado) return;

    const gravou = await estamparOrigemDaPagina(
      admin,
      organizationId,
      contactId,
      { utm: escolha.utm, capturadaEm: new Date().toISOString() },
      { inferidaPor: "horario", sourceAnterior },
    );
    if (!gravou) {
      // Sem a origem no contato, o clique volta a ser órfão em vez de contar
      // um contato que a ficha não mostra.
      await admin
        .from("meta_ads_click_refs")
        .update({ contact_id: null })
        .eq("organization_id", organizationId)
        .eq("id", escolha.cliqueId)
        .eq("contact_id", contactId)
        .is("matched_at", null);
      logger.warn("origem-por-horario: origem NÃO gravada (a mensagem entra assim mesmo)", {
        contactId,
      });
      return;
    }
    logger.info("origem-por-horario: origem inferida pelo horário do clique", {
      contactId,
      cliqueId: escolha.cliqueId,
      candidatos: escolha.candidatos,
      utm: Object.keys(escolha.utm),
    });
  } catch (erro) {
    logger.error("origem-por-horario: falhou (a mensagem entra assim mesmo)", {
      contactId,
      error: erro instanceof Error ? erro.message.slice(0, 160) : String(erro).slice(0, 160),
    });
  }
}

/**
 * A etiqueta que o card ganha ao nascer de contato com `source = "site"`
 * (`ROTULO_DE_ANUNCIO.site` em `nascimento-do-lead.ts`, que não é importado
 * aqui para este arquivo não puxar o nascimento do card inteiro).
 */
const ETIQUETA_DO_SITE = "Site";

/** O que a estampa do site grava, e que a dedução desfeita tem de tirar. */
const CHAVES_DA_ORIGEM_DO_SITE = new Set([
  "ad_platform",
  "ad_source_id",
  "origem",
  "origem_capturada_em",
  "origem_inferida_por",
  "origem_inferida_source_anterior",
]);

/**
 * As UTMs saem todas: a dedução só roda em contato SEM `ad_platform`, e nada
 * grava `utm_*` no contato sem gravar `ad_platform` junto — então toda UTM ali
 * veio do palpite.
 */
function semAOrigemDeduzida(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([chave]) => !CHAVES_DA_ORIGEM_DO_SITE.has(chave) && !chave.startsWith("utm_"),
    ),
  );
}

/**
 * O `[ref:]` provou que o clique é de OUTRO contato: a origem que este ganhou
 * pelo horário era palpite errado, e sai — do contato e do card que a copiou
 * ao nascer (`nascimento-do-lead.ts` copia `source`, metadata e a etiqueta).
 *
 * Só desfaz o que é DEDUÇÃO (`origem_inferida_por = 'horario'`, também no
 * filtro da escrita): uma origem provada nunca é tocada aqui. Falha é LOG.
 *
 * ponytail: o que já SAIU por causa do palpite (webhook do card que nasceu,
 * conversão) não volta; só o estado do contato e do card é corrigido.
 */
export async function desfazerOrigemDeduzida(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<void> {
  try {
    const { data: contato, error } = await admin
      .from("contacts")
      .select("source_metadata")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const metadata = ((contato as { source_metadata?: unknown } | null)?.source_metadata ??
      {}) as Record<string, unknown>;
    if (metadata.origem_inferida_por !== "horario") return;

    const sourceAnterior =
      typeof metadata.origem_inferida_source_anterior === "string"
        ? metadata.origem_inferida_source_anterior
        : ORIGEM_DO_WHATSAPP.source;

    const { error: erroDoContato } = await admin
      .from("contacts")
      .update({ source: sourceAnterior, source_metadata: semAOrigemDeduzida(metadata) })
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .eq("source_metadata->>origem_inferida_por", "horario");
    if (erroDoContato) throw new Error(erroDoContato.message);

    const { data: cards, error: erroDosCards } = await admin
      .from("crm_leads")
      .select("id, tags, source_metadata")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("source_metadata->>origem_inferida_por", "horario");
    if (erroDosCards) throw new Error(erroDosCards.message);
    for (const card of (cards ?? []) as Array<{
      id: string;
      tags: string[] | null;
      source_metadata: Record<string, unknown> | null;
    }>) {
      const { error: erroDoCard } = await admin
        .from("crm_leads")
        .update({
          source: sourceAnterior,
          source_metadata: semAOrigemDeduzida(card.source_metadata ?? {}),
          tags: (card.tags ?? []).filter((tag) => tag !== ETIQUETA_DO_SITE),
        })
        .eq("organization_id", organizationId)
        .eq("id", card.id);
      if (erroDoCard) throw new Error(erroDoCard.message);
    }
    logger.info("origem-por-horario: origem deduzida desfeita (o código provou outro dono)", {
      contactId,
      cards: (cards ?? []).length,
    });
  } catch (erro) {
    logger.error("origem-por-horario: desfazer a origem deduzida falhou", {
      contactId,
      error: erro instanceof Error ? erro.message.slice(0, 160) : String(erro).slice(0, 160),
    });
  }
}

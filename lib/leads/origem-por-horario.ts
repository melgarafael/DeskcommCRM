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
 * ─── O código sempre vence ──────────────────────────────────────────────────
 *
 * A inferência grava `contact_id` no clique e deixa `matched_at` NULO. O
 * consumo pelo código (`casarClickRef`) exige `matched_at is null`, então quem
 * chegar depois COM o `[ref:]` daquele clique ainda o reivindica: a prova
 * vence a inferência. E a inferência só considera cliques com `contact_id`
 * nulo, então um clique nunca é inferido para dois contatos.
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
 * O caso comum — nenhum clique pendente na janela — custa UMA consulta, e é a
 * primeira: as outras só rodam quando há o que casar.
 */
export async function casarOrigemPorHorario(
  admin: Admin,
  entrada: EntradaParaHorario,
): Promise<void> {
  const { organizationId, contactId, messageId, channelSessionId } = entrada;
  if (!messageId) return;

  try {
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
      .select("source_metadata")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (erroDoContato) throw new Error(erroDoContato.message);
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
      { inferidaPor: "horario" },
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

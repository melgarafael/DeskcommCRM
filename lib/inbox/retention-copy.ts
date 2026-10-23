/**
 * Tradução leiga (pt-br) dos vetos da cadeia before_send (Operação Visível F2-i).
 * Os códigos são contrato do engine (lib/agent-engine/guardrails/before-send.ts +
 * pacing/spinning/promise/disclosure) — a tela mostra POR QUE uma resposta do
 * assistente foi retida, sem jargão. Módulo puro: testável sem DOM.
 */

import { cidadeDoFuso } from "@/lib/tempo/fusos";
import { falhaTecnicaDaRevisaoDeAgenda } from '@/lib/agenda/falha-revisao';

/** Contexto dos knobs efetivos do número — interpola janela/horário na copy. */
export interface RetentionContext {
  window_start_hour: number;
  window_end_hour: number;
  allow_sunday: boolean;
  timezone: string;
}

export type RetentionKind = "protection" | "compliance" | "quality" | "review" | "window" | "neutral" | "handoff";

export interface RetentionCopy {
  kind: RetentionKind;
  title: string;
  description: string;
}

const TITLES: Record<RetentionKind, string> = {
  protection: "Resposta segurada pela proteção do número",
  compliance: "Resposta bloqueada por conformidade",
  quality: "Resposta retida para correção",
  review: "Resposta bloqueada pela revisão da IA",
  window: "Resposta retida pela janela de envio",
  neutral: "Resposta não enviada",
  // #3310: família própria porque as outras três mentem aqui. A resposta não foi
  // segurada por proteção do número, nem bloqueada por conformidade (nada de
  // LGPD aconteceu), nem retida para correção: o automático está PAUSADO porque
  // a conversa foi passada para a equipe.
  handoff: "Resposta pausada: a conversa está com a equipe",
};

/**
 * Copy por código de veto. Códigos de proteção (pacing/spinning) tranquilizam:
 * foi proteção anti-bloqueio, não erro. Conformidade (stop/LGPD) é definitivo.
 * Origem desconhecida é neutra. O aviso não promete recuperação automática.
 */
export function retentionCopy(
  code: string | null,
  ctx: RetentionContext,
  t: (texto: string) => string = (texto) => texto,
  gate?: string | null,
): RetentionCopy {
  // O fuso vai escrito: "22h" sem dizer DE ONDE foi o que escondeu, por meses,
  // uma janela avaliada em São Paulo numa operação de Manaus. É o fuso que o
  // motor usou (`fusoDaJanela`), nunca UTC.
  const janela = `${ctx.window_start_hour}h–${ctx.window_end_hour}h, ${t("horário de")} ${cidadeDoFuso(ctx.timezone)}${ctx.allow_sunday ? "" : `, ${t("sem domingo")}`}`;
  const make = (kind: RetentionKind, description: string): RetentionCopy => ({
    kind,
    title: t(TITLES[kind]),
    description,
  });

  const neutral = () => make("neutral", t("O envio foi interrompido, mas a origem do bloqueio não foi identificada. A resposta não foi enviada ao contato."));
  if ((!gate || gate === 'semantic_promise') && falhaTecnicaDaRevisaoDeAgenda(code)) {
    return { ...make('neutral', t('Uma falha técnica impediu concluir a revisão com as informações e a resposta corretas. A mensagem não foi enviada ao contato.')),
      title:t('Resposta não enviada por falha na revisão') };
  }
  // O gate é a origem registrada pelo servidor; não inferir pela prosa do modelo.
  if (["semantic_promise", "case_promise", "factual_claim"].includes(gate ?? "") ||
      (!gate && code === "agenda_request_mismatch")) {
    return make("review", code === "agenda_request_mismatch"
      ? t("A revisão não conseguiu validar a resposta sobre o agendamento. Ela não foi enviada ao contato.")
      : t("A revisão da IA não validou as informações ou os compromissos desta resposta. Ela não foi enviada ao contato."));
  }
  const origem: Record<string, string> = {
    outside_window:"pacing", warmup_cap:"pacing", daily_cap:"pacing", mass_identical:"spinning",
    contato_bloqueado:"stop", lgpd_anonymized:"lgpd", lgpd_missing_legal_basis:"lgpd",
    promise_out_of_table:"promise", promise_semantic:"semantic_promise", disclosure_required:"disclosure",
    messaging_window_closed:"messaging_window",
  };
  if (gate && origem[code ?? ""] !== gate) return neutral();
  switch (code) {
    case "outside_window":
      return make(
        "window",
        `${t("O envio foi retido fora da janela configurada")} (${janela}). ${t("A resposta não foi enviada ao contato.")}`,
      );
    case "messaging_window_closed":
      return make("window", t("A janela de atendimento permitida por este canal está encerrada. A resposta não foi enviada ao contato."));
    case "warmup_cap":
      return make(
        "protection",
        `${t("Este número ainda está em aquecimento e o limite diário de envios dele foi atingido. Enviar além disso arriscaria bloqueio pelo WhatsApp — libera de novo amanhã, a partir das")} ${ctx.window_start_hour}h.`,
      );
    case "daily_cap":
      return make(
        "protection",
        `${t("O limite diário de envios do número foi atingido — proteção contra bloqueio do WhatsApp. Libera de novo amanhã, a partir das")} ${ctx.window_start_hour}h.`,
      );
    case "mass_identical":
      return make(
        "protection",
        t(
          "A mesma mensagem estava se repetindo em massa por este número. O envio foi segurado para variar o texto e não parecer robô para o WhatsApp.",
        ),
      );
    case "contato_bloqueado":
      return make(
        "compliance",
        t("O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele."),
      );
    case "atendimento_com_humano":
      // #3310: este código é o `force_human` SOZINHO — a conversa foi passada
      // para a equipe (ou alguém a pausou à mão), e o contato NÃO pediu para
      // sair. A frase tem de dizer as duas coisas que a equipe precisa: por que
      // o automático está calado e como trazê-lo de volta — senão sobra o
      // caminho mais caro, que é ler o cliente vivo como descadastrado.
      return make(
        "handoff",
        t(
          "O atendimento automático está pausado porque a conversa foi passada para a equipe. Use “Devolver ao automático” para a IA voltar a responder.",
        ),
      );
    case "lgpd_anonymized":
      return make(
        "compliance",
        t("Este contato foi anonimizado (LGPD) — é proibido enviar qualquer mensagem a ele."),
      );
    case "lgpd_missing_legal_basis":
      return make(
        "compliance",
        t(
          "Não há base legal (LGPD) para o primeiro contato de prospecção com este lead. O time precisa regularizar o cadastro antes de abordar.",
        ),
      );
    case "promise_out_of_table":
      return make(
        "quality",
        t(
          "A resposta prometia um preço ou condição fora da tabela aprovada. O assistente foi orientado a corrigir antes de enviar.",
        ),
      );
    case "promise_semantic":
      return make("review", t("A revisão da IA não validou os compromissos desta resposta. Ela não foi enviada ao contato."));
    case "disclosure_required":
      return make(
        "quality",
        t(
          "A primeira mensagem a um contato novo precisa se apresentar como assistente virtual. O assistente foi orientado a corrigir antes de enviar.",
        ),
      );
    default:
      return neutral();
  }
}

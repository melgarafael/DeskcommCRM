/**
 * O CLIMA DA CONVERSA, MEDIDO PELO SYSTEM ONE.
 *
 * O ponto `sentiment_classify` foi o escolhido para estrear o caminho novo por três
 * razões, nesta ordem: roda FORA do caminho crítico (worker paralelo, o cliente não
 * espera por ele), já falha em silêncio por desenho, e é `score` puro — a primitiva
 * do fornecedor encaixa sem tradução conceitual.
 *
 * ═══ A NORMALIZAÇÃO É O RISCO, NÃO A CHAMADA ═══
 *
 * O worker grava `sentiment_score` de 0 a 1 e compara com um limiar configurável
 * (default 0.3) para abrir handoff. O System One devolve a POSIÇÃO numa escala de
 * níveis — com 5 níveis, um contínuo entre 0 e 4. Trocar a origem do número sem
 * acertar a régua moveria o limiar de toda instalação em silêncio: um 2.0 (neutro)
 * lido como 2.0 numa régua de 0..1 abriria handoff em toda conversa morna.
 *
 * Por isso a conversão tem teste próprio nos extremos e no meio, e por isso um
 * score FORA da escala devolve ausência em vez de nota: se o contrato do fornecedor
 * mudar (mais níveis, outra base), o número normalizaria para algo plausível e
 * errado, e ninguém veria.
 *
 * ═══ A AUSÊNCIA NÃO É ZERO ═══
 *
 * Toda ausência — sem credencial, disjuntor aberto, fornecedor fora do ar,
 * resposta ilegível, score fora da escala — volta como `{ ok: false }`, sem nota
 * nenhuma. Zero é "medi e o clima está péssimo", e é justamente a confusão que o
 * gate de handoff deste produto já pagou uma vez (ver `lib/kanban/card-state.ts`
 * e o conserto em `workers/ai-response-worker.ts`).
 *
 * A falha é discriminada, e não um `null`, porque quem chama precisa de três
 * respostas que o `null` apagava: se vale uma linha em Execuções (`tentouRede`),
 * se alguém precisa agir (`exigeAcao`) e por quê (`motivo`).
 *
 * ═══ SÓ A ÚLTIMA MENSAGEM, E LIMPA ═══
 *
 * O texto sai para um fornecedor estrangeiro (LGPD, D6): vai só a mensagem que
 * está sendo medida, passada pelo mesmo redator do Sentry — CPF, telefone,
 * e-mail e chave do Jev não saem. O clima não depende deles.
 */
import { scrubMessage } from "@/lib/sentry/scrub";

import type { MotivoComRede } from "./cliente";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { decidirNoPonto, type DependenciasDoPonto } from "./ponto";

/**
 * A escala, ORDENADA do pior ao melhor — a ordem É o contrato do `score`, porque o
 * fornecedor devolve a posição. Inverter os níveis inverteria a nota sem erro
 * nenhum aparecer, e é o que o teste da ordem vigia.
 *
 * Cinco níveis para dar resolução comparável à nota contínua que o worker já grava;
 * o fornecedor aceita de 2 a 10.
 */
export const NIVEIS_DE_CLIMA = [
  "cliente irritado, revoltado ou ameaçando sair",
  "cliente insatisfeito ou reclamando",
  "cliente neutro, apenas trocando informação",
  "cliente satisfeito ou colaborativo",
  "cliente entusiasmado, elogiando ou agradecendo",
] as const;

const INSTRUCAO =
  "Com base na ÚLTIMA mensagem do cliente, em que ponto está o clima da conversa?";

export interface EntradaDoClima {
  organizationId: string;
  mensagem: string;
}

export type ClimaMedido =
  | {
      ok: true;
      /** 0 = péssimo, 1 = ótimo — a mesma régua que `messages.metadata.sentiment_score` usa. */
      score01: number;
      /** Probabilidade calibrada do fornecedor. Guardada para a telemetria, não para decidir. */
      confianca: number;
      /** A versão que DE FATO respondeu — vai para `llm_calls.model` e para o preço. */
      modelo: string;
      tokensDeEntrada: number;
      tokensDeSaida: number;
      latenciaMs: number;
    }
  | {
      ok: false;
      /** A pergunta saiu para a rede — e é só nesse caso que a falha vira linha em Execuções. */
      tentouRede: true;
      motivo: MotivoComRede;
      exigeAcao: boolean;
      defeitoNosso: boolean;
      latenciaMs: number;
    }
  | {
      ok: false;
      /** Nada saiu: é configuração (sem chave) ou o disjuntor segurando, não incidente. */
      tentouRede: false;
      motivo: "sem_credencial" | "disjuntor_aberto";
      exigeAcao: false;
      defeitoNosso: false;
      latenciaMs: number;
    };

export async function medirClima(
  entrada: EntradaDoClima,
  deps: DependenciasDoPonto = {},
): Promise<ClimaMedido> {
  const inicio = Date.now();
  if (!podeTentar(entrada.organizationId, inicio)) {
    return { ok: false, motivo: "disjuntor_aberto", exigeAcao: false, defeitoNosso: false, tentouRede: false, latenciaMs: 0 };
  }

  const r = await decidirNoPonto(
    {
      ponto: "sentiment_classify",
      organizationId: entrada.organizationId,
      estado: scrubMessage(entrada.mensagem),
      perguntas: {
        clima: { tipo: "score", instrucao: INSTRUCAO, criterios: NIVEIS_DE_CLIMA },
      },
    },
    deps,
  );
  // A régua é a da chamada (`r.latenciaMs`), não a do relógio acima, que conta
  // também a busca da chave no banco — a IA de sempre, ao lado em Execuções,
  // cronometra só a chamada. O relógio acima só serve quando nada saiu.
  const latenciaMs = r.latenciaMs ?? Date.now() - inicio;

  if (!r.ok) {
    registrarFalha(entrada.organizationId, r.motivo, Date.now(), r.retryAfterMs);
    if (r.motivo === "sem_credencial" || r.motivo === "disjuntor_aberto") {
      return { ok: false, motivo: r.motivo, exigeAcao: false, defeitoNosso: false, tentouRede: false, latenciaMs };
    }
    return {
      ok: false,
      motivo: r.motivo,
      exigeAcao: r.exigeAcao,
      defeitoNosso: r.defeitoNosso,
      tentouRede: true,
      latenciaMs,
    };
  }

  const resposta = r.respostas["clima"];
  const teto = NIVEIS_DE_CLIMA.length - 1;
  if (
    resposta === undefined ||
    resposta.tipo !== "score" ||
    !Number.isFinite(resposta.score) ||
    resposta.score < 0 ||
    resposta.score > teto
  ) {
    // Fora da escala = contrato mudou. Normalizar assim mesmo produziria um número
    // plausível e errado, e o limiar de handoff passaria a disparar por régua trocada.
    registrarFalha(entrada.organizationId, "resposta_ilegivel", Date.now());
    return { ok: false, motivo: "resposta_ilegivel", exigeAcao: false, defeitoNosso: false, tentouRede: true, latenciaMs };
  }

  registrarSucesso(entrada.organizationId);
  return {
    ok: true,
    score01: resposta.score / teto,
    confianca: resposta.confianca,
    modelo: r.modelo,
    tokensDeEntrada: r.uso.tokensDeEntrada,
    tokensDeSaida: r.uso.tokensDeSaida,
    latenciaMs,
  };
}

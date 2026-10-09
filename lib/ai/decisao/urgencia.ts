/**
 * O SINAL DE URGÊNCIA QUE A REGRA NÃO VIU, PERGUNTADO AO JEV (#2232) — a
 * terceira tarefa em cascata dele, e a primeira no RAMO REPRESADO do turno
 * (`lib/agent-engine/agent/inbound-turn.ts`, bloco `pacingCapVeto`).
 *
 * ═══ A CASCATA É A MESMA DO #1747 ═══
 *
 * `lib/agent-engine/guardrails/sinal-de-urgencia.ts` é léxico PT e
 * conservador de propósito. Quando o `pacingCapVeto` adia o turno, ele abre o
 * alerta CRÍTICO da Central para um relato de risco no vocabulário dele — e só
 * nele. Um "minha mãe caiu", um "o pedal afundou, tô na estrada", um "the
 * battery is swelling" ou um "la estufa huele a gas" espera a mesma janela que
 * um "bom dia", às vezes 20h+.
 *
 * A REGRA continua decidindo. O Jev só é perguntado onde ela disse NÃO
 * (`urgenciaDaRegra` é falso em quem chama), e SÓ no ramo em que ela já roda:
 * mensagem represada pelo teto de envio. A pergunta que a regra já pegou nem
 * sai — por isso o rótulo gravado ao lado do dele é sempre `nao`, e o cartão
 * não mostra concordância: mostra em quantas MENSAGENS ele percebeu o risco
 * que a regra não reconheceu (a unidade é a mensagem, como na onda 3).
 *
 * ═══ O QUE ELE FAZ, EM CADA ESTADO ═══
 *
 *  - observando (toda tarefa nova começa assim): só se grava. Quem decide é a
 *    regra de hoje, e a linha em `jev_observacoes` é a matéria do cartão.
 *  - decidindo ("Avisar a equipe", atrás de confirmação, como no #1747): o
 *    risco passando dos limiares abre o MESMO alerta crítico que a regex abre
 *    (`kind='handoff'`), com a origem "percebido pelo modelo de decisão" — que
 *    só a equipe vê.
 *
 * Limiares, em código: `risco_agora > 0,8` E `hipotetico < 0,5`. Os dois
 * juntos: sem o segundo, "esse extintor serve para incêndio em cozinha?" ou
 * "morri de rir com o vídeo de vocês" seriam risco.
 *
 * ═══ O QUE ELE NUNCA FAZ (R3) ═══
 *
 * Não passa a conversa, não cala o agente, não responde e não fura o teto de
 * envio — ele roda DEPOIS que o teto vetou, e só para avisar. O alerta NÃO
 * copia a frase do cliente (mesma decisão 3 do #1747: a Central é lida pela
 * organização inteira, a conversa só por quem a enxerga). Grava uma linha por
 * resposta em `jev_observacoes` (sem texto) e uma por chamada em `llm_calls`
 * — só quando a chamada aconteceu: desligada, sem credencial ou com o
 * fornecedor falhando, zero linha, comportamento de hoje. Nunca lança.
 */
import type pg from "pg";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";
import { scrubMessage } from "@/lib/sentry/scrub";

import type { Pergunta, Resposta } from "./cliente";
import type { EstadoQuePergunta } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { estadoDaTarefaNoPool } from "./pool";
import { chaveDasTarefas, decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import { TAREFA_DA_URGENCIA } from "./tarefas";

/** Acima disso o Jev diz "há risco AGORA". `>` — igual não passa. */
export const LIMIAR_RISCO_AGORA = 0.8;
/** Abaixo disso o Jev não vê hipótese, fato passado nem figura de linguagem. `<` — igual não passa. */
export const LIMIAR_HIPOTETICO = 0.5;

/**
 * As duas perguntas tipadas, no estado `{ mensagem }` (a última, depois do
 * `scrubMessage` — o aceite em vigor: cada mensagem, sozinha). As duas vão
 * juntas numa chamada PRÓPRIA, separada da do clima e da dos pedidos: uma
 * recusa do fornecedor a uma pergunta nova não pode derrubar o que já decide
 * em produção.
 */
export const PERGUNTAS_DA_URGENCIA: Record<string, Pergunta> = {
  risco_agora: {
    tipo: "noul",
    instrucao:
      "A mensagem relata uma situação em que a segurança física ou a saúde de alguém está em risco AGORA (acidente, incêndio, gás, freio falhando, ferimento, desmaio), em qualquer idioma?",
    criterios: {
      true: "Alguém corre perigo agora: acidente, fogo ou fumaça, vazamento de gás, freio que não segura, ferimento, desmaio ou mal súbito.",
      false: "Qualquer outra coisa: pergunta sobre produto, preço, prazo, praga ou manutenção, sem ninguém em perigo agora.",
    },
  },
  hipotetico: {
    tipo: "noul",
    instrucao:
      "A mensagem é uma pergunta hipotética, um evento passado já resolvido ou uma figura de linguagem, e não uma situação que está acontecendo agora?",
    criterios: {
      true: "Fala como exemplo, chance teórica, fato que já passou ou brincadeira — não há nada acontecendo agora.",
      false: "Descreve algo que está acontecendo agora, como um relato do cliente sobre o que acabou de ocorrer.",
    },
  },
};

export interface UrgenciaDoJev {
  /** O estado da tarefa quando ele respondeu — é o que decide se o alerta abre. */
  estado: EstadoQuePergunta;
  risco_agora: number;
  hipotetico: number;
  /** Passou dos dois limiares: a regra não viu, e ele viu. */
  percebeu: boolean;
  /** A versão que DE FATO respondeu — vai para `llm_calls.model` e para o preço. */
  modelo: string;
  tokensDeEntrada: number;
  tokensDeSaida: number;
  latenciaMs: number;
}

/** A probabilidade de "sim" de uma pergunta, ou `null` quando a resposta não é uma. */
function noul(resposta: Resposta | undefined): number | null {
  if (resposta?.tipo !== "noul") return null;
  return Number.isFinite(resposta.noul) && resposta.noul >= 0 && resposta.noul <= 1 ? resposta.noul : null;
}

/** `risco_agora > 0,8` e `hipotetico < 0,5`, em código — a única porta do alerta. */
export function percebeuRisco(risco_agora: number, hipotetico: number): boolean {
  return risco_agora > LIMIAR_RISCO_AGORA && hipotetico < LIMIAR_HIPOTETICO;
}

export interface EntradaDaUrgencia {
  organizationId: string;
  conversationId: string | null;
  /** A mensagem que o cliente digitou — é ela que sai, depois do scrub. */
  mensagem: string;
  messageId: string | null;
  contactId: string | null;
  jobId: string | null;
}

/**
 * Pergunta ao Jev, só onde a regra disse não. `null` quando ele não opina:
 * tarefa desligada (ou interruptor, ou aceite), disjuntor aberto, sem chave,
 * falha do fornecedor ou resposta fora dos dois limiares de probabilidade — em
 * todos, o turno segue exatamente como seguia sem ele, e NENHUMA linha entra
 * em `llm_calls`.
 *
 * Quem chama garante as outras guardas: o ramo do `pacingCapVeto` (mensagem
 * represada pelo teto de envio) e `urgenciaDaRegra` falso (a regex de hoje não
 * disparou).
 */
export async function perguntarUrgenciaAoJev(
  pool: pg.Pool,
  entrada: EntradaDaUrgencia,
  deps: DependenciasDoPonto = {},
): Promise<UrgenciaDoJev | null> {
  if (entrada.mensagem.trim() === "") return null;
  const estado = await estadoDaTarefaNoPool(pool, entrada.organizationId, TAREFA_DA_URGENCIA);
  if (estado === "desligada") return null;

  const alvo = { organizationId: entrada.organizationId, tarefa: TAREFA_DA_URGENCIA.id };
  if (!podeTentar(alvo)) return null;

  const perguntas: Record<string, Pergunta> = PERGUNTAS_DA_URGENCIA;
  const r = await decidirNoPonto(
    { organizationId: entrada.organizationId, estado: { mensagem: scrubMessage(entrada.mensagem) }, perguntas },
    {
      ...deps,
      // A chave desta tarefa (e não a de um ponto — não há ponto no registro).
      // `decidirNoPonto` sem `ponto` só resolveria a chave se cada PERGUNTA
      // fosse id de tarefa, e aqui as duas perguntas são de UMA tarefa.
      buscarChave: deps.buscarChave ?? ((org: string) => chaveDasTarefas(org, [TAREFA_DA_URGENCIA])),
    },
  );
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    // Sem chave é configuração, não falha. As outras ficam no log sem o texto
    // da mensagem: a regra de hoje continuou decidindo, e ela não pede nada.
    if (r.motivo !== "sem_credencial") {
      logger.warn("Jev não respondeu sobre o risco da mensagem represada; vale só a regra de urgência", {
        organization_id: entrada.organizationId,
        motivo: r.motivo,
      });
    }
    return null;
  }

  const risco = noul(r.respostas["risco_agora"]);
  const hipotetico = noul(r.respostas["hipotetico"]);
  if (risco === null || hipotetico === null) {
    registrarFalha(alvo, "resposta_ilegivel", Date.now());
    logger.warn("Jev respondeu sobre o risco da mensagem represada fora de uma probabilidade", {
      organization_id: entrada.organizationId,
    });
    return null;
  }

  registrarSucesso(alvo);
  return {
    estado,
    risco_agora: risco,
    hipotetico,
    percebeu: percebeuRisco(risco, hipotetico),
    modelo: r.modelo,
    tokensDeEntrada: r.uso.tokensDeEntrada,
    tokensDeSaida: r.uso.tokensDeSaida,
    latenciaMs: r.latenciaMs,
  };
}

export interface RegistroDaUrgencia {
  organizationId: string;
  contactId: string | null;
  conversationId: string | null;
  messageId: string | null;
  jobId: string | null;
  urgencia: UrgenciaDoJev;
}

/**
 * Uma linha em `jev_observacoes` (sem texto: só rótulo, probabilidade e
 * ponteiros) e uma em `llm_calls` (o custo, em Execuções), no MESMO comando —
 * uma sem a outra contaria uma resposta que não custou, ou um custo sem
 * resposta.
 *
 * `rotulo_atual` é sempre `nao`: por construção a regra de urgência disse não
 * nesta mensagem — é o que faz do cartão "mensagens em que a regra não
 * reconheceu o risco", e não "alertas que o Jev abriu". A origem é
 * `jev_observacao` observando e `jev` decidindo (é a resposta dele que abre o
 * alerta).
 */
export async function registrarUrgenciaDoJev(pool: pg.Pool, r: RegistroDaUrgencia): Promise<void> {
  try {
    await pool.query(
      `with observacao as (
         insert into public.jev_observacoes
          (organization_id, tarefa, estado, conversation_id, message_id, job_id,
           rotulo_jev, probabilidade_jev, rotulo_atual, modelo, latencia_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         -- O retry do job pergunta de novo sobre a MESMA mensagem: a primeira
         -- resposta fica, e o custo da segunda entra em llm_calls, porque houve.
         on conflict (organization_id, tarefa, message_id) where message_id is not null do nothing
      )
      insert into public.llm_calls
        (organization_id, contact_id, job_id, purpose, provider, model,
         input_tokens, output_tokens, cost_cents, latency_ms, status, origem_da_escolha)
      values ($1, $12, $6, 'jev_sinal_de_urgencia', 'typesafe', $13, $14, $15, $16, $11, 'ok', $17)`,
      [
        r.organizationId,
        TAREFA_DA_URGENCIA.id,
        r.urgencia.estado,
        r.conversationId,
        r.messageId,
        r.jobId,
        r.urgencia.percebeu ? "sim" : "nao",
        r.urgencia.risco_agora,
        // Por construção a regra disse não: é a cascata do #1747.
        "nao",
        r.urgencia.modelo,
        r.urgencia.latenciaMs,
        r.contactId,
        `typesafe/${r.urgencia.modelo}`,
        r.urgencia.tokensDeEntrada,
        r.urgencia.tokensDeSaida,
        // Fracionário: a centavo por chamada, o Jev custaria ~600x o preço real.
        costCents(r.urgencia.modelo, {
          inputTokens: r.urgencia.tokensDeEntrada,
          outputTokens: r.urgencia.tokensDeSaida,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        r.urgencia.estado === "decidindo" ? "jev" : "jev_observacao",
      ],
    );
  } catch (erro) {
    // A observação é telemetria: perdê-la não pode derrubar o atendimento.
    logger.warn("observação do Jev sobre o risco represado não foi gravada", {
      organization_id: r.organizationId,
      erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
    });
  }
}
